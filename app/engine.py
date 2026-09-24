"""
DIPHUNTER trading engine -- "follow the last window".

Signal : the side that won the PREVIOUS window (winner = the side priced 0.95+ in the last
         second of that window, read from the CLOB -- see state.py) is traded in the next one.

Entry  : on the traded side, size = current base (in dollars). TWO phases:
         Phase 1, 0s-LIMIT_ENTRY_TIMEOUT_SECONDS (30s) after open: a resting limit buy at
           LIMIT_ENTRY_PRICE (0.40). Fills the instant the ask reaches 0.40 or below -- maker
           fill, no fee, full base spent at exactly 0.40.
         Phase 2, after 30s: limit is cancelled. From then to window close, buys at market
           (taker, depth-walked fill, taker fee) the instant the ask is at/below MARKET_ENTRY_CAP
           (0.50) -- immediately if already there, or whenever it comes back down to it. Never
           reaching the cap before close means no trade that window.
Exit   : none. Held to the window end and settled by the 0.95 rule: winner $1/share, loser $0.

Size   : ONE shared base, in DOLLARS, starts at BASE_DOLLARS (500). Each win -DOLLARS_STEP (100),
         floor 0. Any loss resets to 500. At 0, same-direction signals are skipped; the first
         opposite-direction signal trades 500 and restarts the base. A no-fill window still moves
         the ladder as a "paper" win/loss if the signalled side is later decided (won -> -100,
         lost -> reset to 500, no cash moved either way) -- only a genuinely undecided window, a
         no-signal window, or a floor-skip leaves the base untouched. Shares bought = dollars
         spent / actual fill price, so dollar risk is fixed but share count scales with price.
"""
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Optional

from . import config
from .models import Side, WindowMarket
from .paper_broker import PaperBroker


def _realistic_fill_price(levels: Optional[list], shares: float, fallback_price: Optional[float]) -> Optional[float]:
    """Volume-weighted average price to actually trade `shares` against a real order book,
    instead of assuming the whole size fills at the single best quote.

    - levels is None -> no depth data this tick; fall back to filling the whole size at
      `fallback_price`.
    - levels is [] -> book fetched fine, genuinely nothing resting on this side; return None,
      the caller must not invent a fill.
    - levels is non-empty -> walk best-price-first; any shortfall in visible depth is priced at
      the worst level seen.
    """
    if levels is None:
        return fallback_price
    if not levels:
        return None
    remaining = shares
    cost = 0.0
    worst_price = levels[-1][0]
    for price, size in levels:
        if remaining <= 1e-9:
            break
        take = min(remaining, size) if size and size > 0 else 0.0
        if take <= 0:
            continue
        cost += take * price
        remaining -= take
    if remaining > 1e-9:
        cost += remaining * worst_price
    return cost / shares


def _fill_by_dollars(levels: Optional[list], dollars: float, fallback_price: Optional[float]):
    """Walk real ask depth spending exactly `dollars`, returning (avg_price, shares) -- the
    dollar-sizing counterpart to _realistic_fill_price (which is sized by shares). Cost is always
    exactly `dollars` (fee is added separately by the caller); shares scale with price.

    - levels is None -> no depth data this tick; fall back to spending it all at fallback_price.
    - levels is [] or fallback_price is None/0 with no levels -> None, no fill invented.
    - levels is non-empty -> walk best-price-first; any shortfall in visible depth is priced at
      the worst level seen.
    """
    if levels is None:
        if not fallback_price or fallback_price <= 0:
            return None
        return fallback_price, dollars / fallback_price
    if not levels:
        return None
    remaining_dollars = dollars
    shares = 0.0
    worst_price = levels[-1][0]
    for price, size in levels:
        if remaining_dollars <= 1e-9:
            break
        if not size or size <= 0 or price <= 0:
            continue
        level_dollars = price * size
        take_dollars = min(remaining_dollars, level_dollars)
        shares += take_dollars / price
        remaining_dollars -= take_dollars
    if remaining_dollars > 1e-9:
        if worst_price <= 0:
            return None
        shares += remaining_dollars / worst_price
        remaining_dollars = 0.0
    if shares <= 0:
        return None
    return dollars / shares, shares


@dataclass
class CapitalPool:
    balance: float
    halted: bool = False
    equity_curve: list = field(default_factory=list)

    def record_equity_point(self, window_slug: Optional[str]):
        self.equity_curve.append({
            "window": window_slug, "ts": time.time(), "balance": round(self.balance, 2),
        })
        if len(self.equity_curve) > 500:
            self.equity_curve = self.equity_curve[-500:]

    def check_halt(self) -> bool:
        if not self.halted and self.balance < 0:
            self.halted = True
        return self.halted


@dataclass
class Position:
    side: Side
    entry_price: float
    shares: float
    cost: float
    entry_ts: float


@dataclass
class EngineState:
    """Per-window transient state -- fully replaced by reset_for_window() at the start of every
    window. The size ladder and cumulative stats live on the Engine so they survive windows."""
    window: Optional[WindowMarket] = None
    up_bid: Optional[float] = None
    up_ask: Optional[float] = None
    down_bid: Optional[float] = None
    down_ask: Optional[float] = None
    up_bid_levels: Optional[list] = None
    up_ask_levels: Optional[list] = None
    down_bid_levels: Optional[list] = None
    down_ask_levels: Optional[list] = None

    # plan: no_signal (nothing to follow) | floor_skip (base is 0 and the signal is the same side
    # as the streak that emptied it) | trading | halted
    plan: str = "no_signal"
    plan_note: str = ""
    side: Optional[Side] = None      # the side being followed this window (also set for floor_skip)
    dollars: float = 0.0             # size for this window, in dollars (the base at window open)
    entered: bool = False            # the window's single entry has happened
    limit_placed_logged: bool = False    # so the phase-1 "limit placed" note logs once
    limit_cancelled_logged: bool = False  # so the phase-1->2 transition note logs once
    waiting_logged: bool = False     # so "waiting for price to drop to cap" logs once, not every tick
    entry_wait_logged: bool = False  # so the "no ask / no depth" note logs once, not every tick
    position: Optional[Position] = None
    window_pnl: float = 0.0


class Engine:
    name = "BOT"

    def __init__(self, broker: PaperBroker):
        self.broker = broker
        self.capital = CapitalPool(balance=config.STARTING_CAPITAL)
        self.s = EngineState()
        self.capital.record_equity_point(None)
        self.history = deque(maxlen=30)      # one row per finished window, for the dashboard

        # ---- size ladder (shared across both sides), in dollars ------------------
        self.base: float = config.BASE_DOLLARS
        self.floor_side: Optional[Side] = None   # side of the winning streak that emptied the base

        # ---- last finished window: the signal for the next one -----------------
        self.prev: Optional[dict] = None         # {slug, open_ts, winner: Side|None, up, down, age}

        # ---- cumulative stats -------------------------------------------------
        self.total_entries = 0
        self.total_no_fills = 0              # armed, but never filled (no ask / no depth all window)
        self.total_floor_skips = 0
        self.total_no_signal = 0
        self.total_undecided = 0             # finished windows where neither side was 0.95+
        self.total_illiquid_skips = 0
        self.follow_right = 0                # windows with a followed side where it won...
        self.follow_wrong = 0                # ...and where it lost (traded or not)
        self.total_pnl = 0.0
        self.wins = 0
        self.losses = 0

    def _log(self, event, **kw):
        self.broker.log_event(self.name, self.s.window.slug if self.s.window else "", event,
                               balance_after=self.capital.balance, **kw)

    # ---- window lifecycle --------------------------------------------------------

    def reset_for_window(self, window: WindowMarket, now: Optional[float] = None):
        """A new window has opened: decide what to follow."""
        now = now if now is not None else time.time()
        self.s = EngineState(window=window)
        if self.capital.halted:
            self.s.plan = "halted"
            self._log("HALTED", note=f"engine halted (balance ${self.capital.balance:.2f} < $0) -- no trading")
            return

        prev = self.prev
        if prev is None:
            return self._no_signal("no previous window observed yet -- watching this one to read its result")
        if window.open_ts - prev["open_ts"] != config.WINDOW_SECONDS:
            return self._no_signal("missed a window (no consecutive previous result) -- no signal")
        if prev["winner"] is None:
            return self._no_signal("previous window undecided (no side at "
                                   f"{config.WIN_PRICE:.2f}+ in its last second) -- no signal")

        side: Side = prev["winner"]
        self.s.side = side

        if self.base <= 0:
            if side == self.floor_side:
                self.s.plan = "floor_skip"
                self.s.plan_note = f"base is 0 -- skipping {side.value} signals until {side.other().value} wins"
                self.total_floor_skips += 1
                self._log("SKIP_BASE_ZERO", side=side.value, note=self.s.plan_note)
                return
            self.base = config.BASE_DOLLARS
            self.floor_side = None
            self._log("BASE_RESTART", side=side.value,
                       note=f"{side.value} signal after the {side.other().value} run emptied the base -- base back to ${self.base:.0f}")

        self.s.plan = "trading"
        self.s.dollars = float(self.base)
        self._log("SIGNAL", side=side.value,
                   note=(f"previous window {side.value} won (UP {_fmt(prev['up'])} / DOWN {_fmt(prev['down'])}) "
                         f"-> follow {side.value}, ${self.s.dollars:.0f}. Resting limit buy @ "
                         f"{config.LIMIT_ENTRY_PRICE:.2f} for {config.LIMIT_ENTRY_TIMEOUT_SECONDS:g}s, then market "
                         f"buy whenever price is at/below {config.MARKET_ENTRY_CAP:.2f}"))

    def _no_signal(self, why: str):
        self.s.plan = "no_signal"
        self.s.plan_note = why
        self.total_no_signal += 1
        self._log("NO_TRADE", note=why)

    def on_tick(self, up_bid, up_ask, down_bid, down_ask, now: Optional[float] = None,
                up_bid_levels: Optional[list] = None, up_ask_levels: Optional[list] = None,
                down_bid_levels: Optional[list] = None, down_ask_levels: Optional[list] = None):
        if self.s.window is None or self.capital.halted:
            return
        now = now if now is not None else time.time()
        self.s.up_bid, self.s.up_ask = up_bid, up_ask
        self.s.down_bid, self.s.down_ask = down_bid, down_ask
        self.s.up_bid_levels, self.s.up_ask_levels = up_bid_levels, up_ask_levels
        self.s.down_bid_levels, self.s.down_ask_levels = down_bid_levels, down_ask_levels

        if self.s.position is not None or self.s.entered:
            return                                   # no exits: held to the window end
        if self._entry_due(now):
            self._try_entry(now)

    # ---- price/level lookups ----------------------------------------------

    def _ask_for(self, side: Side) -> Optional[float]:
        return self.s.up_ask if side == Side.UP else self.s.down_ask

    def _bid_for(self, side: Side) -> Optional[float]:
        return self.s.up_bid if side == Side.UP else self.s.down_bid

    def _bid_levels_for(self, side: Side) -> Optional[list]:
        return self.s.up_bid_levels if side == Side.UP else self.s.down_bid_levels

    def _ask_levels_for(self, side: Side) -> Optional[list]:
        return self.s.up_ask_levels if side == Side.UP else self.s.down_ask_levels

    # ---- entry: resting limit @ LIMIT_ENTRY_PRICE, then capped market buy -------

    def _entry_due(self, now: float) -> bool:
        s = self.s
        if s.plan != "trading" or s.entered or s.side is None:
            return False
        w = s.window
        return w.open_ts <= now < w.close_ts

    def _fill_entry(self, side: Side, price: float, shares: float, dollars: float, fee: float,
                     now: float, event: str, note: str):
        cost = dollars + fee
        self.s.entered = True
        self.total_entries += 1
        self._log(event, side=side.value, price=price, shares=shares, fee=fee, note=note)
        self.capital.balance -= cost
        if self.capital.check_halt():
            self._log("HALTED", note=f"balance ${self.capital.balance:.2f} < $0 -- bankrupt")
            return
        self.s.position = Position(side=side, entry_price=price, shares=shares, cost=cost, entry_ts=now)

    def _try_entry(self, now: float):
        """Phase 1 (0-LIMIT_ENTRY_TIMEOUT_SECONDS after open): resting limit buy at
        LIMIT_ENTRY_PRICE -- fills the instant the ask reaches it or below, maker fill, no fee,
        full dollar base spent at exactly that price.
        Phase 2 (after the timeout): limit is cancelled; buys at market (taker, depth-walked,
        taker fee) the instant the ask is at/below MARKET_ENTRY_CAP -- immediately if already
        there, or whenever it comes back down to it. No ask/no depth just means keep waiting;
        nothing is invented."""
        s = self.s
        side, dollars = s.side, s.dollars
        elapsed = now - s.window.open_ts
        ask = self._ask_for(side)

        if elapsed < config.LIMIT_ENTRY_TIMEOUT_SECONDS:
            if not s.limit_placed_logged:
                s.limit_placed_logged = True
                self._log("LIMIT_PLACED", side=side.value, price=config.LIMIT_ENTRY_PRICE,
                           note=(f"resting limit buy @ {config.LIMIT_ENTRY_PRICE:.2f} on {side.value}, "
                                 f"${dollars:.0f} notional, up to {config.LIMIT_ENTRY_TIMEOUT_SECONDS:g}s"))
            if ask is not None and ask <= config.LIMIT_ENTRY_PRICE:
                price = config.LIMIT_ENTRY_PRICE
                shares = dollars / price
                self._fill_entry(side, price, shares, dollars, fee=0.0, now=now, event="LIMIT_FILLED",
                                  note=(f"limit filled @ {price:.2f} (maker, no fee), ${dollars:.0f} -> "
                                        f"{shares:.2f}sh, {elapsed:.1f}s after open"))
            return

        if not s.limit_cancelled_logged:
            s.limit_cancelled_logged = True
            self._log("LIMIT_CANCELLED", side=side.value,
                       note=(f"unfilled after {config.LIMIT_ENTRY_TIMEOUT_SECONDS:g}s -- cancelling limit, "
                             f"switching to market buy whenever price <= {config.MARKET_ENTRY_CAP:.2f}"))

        if ask is None:
            if not s.entry_wait_logged:
                s.entry_wait_logged = True
                self.total_illiquid_skips += 1
                self._log("NO_LIQUIDITY", side=side.value,
                           note=f"no ask on {side.value} -- retrying every tick until window close")
            return

        if ask > config.MARKET_ENTRY_CAP:
            if not s.waiting_logged:
                s.waiting_logged = True
                self._log("WAITING_FOR_PRICE", side=side.value, price=ask,
                           note=(f"{side.value} ask {ask:.4f} above {config.MARKET_ENTRY_CAP:.2f} cap -- "
                                 f"waiting for it to come back down"))
            return

        fill = _fill_by_dollars(self._ask_levels_for(side), dollars, ask)
        if fill is None:
            if not s.entry_wait_logged:
                s.entry_wait_logged = True
                self.total_illiquid_skips += 1
                self._log("NO_LIQUIDITY", side=side.value, price=ask,
                           note=f"ask at/below cap but zero visible depth on {side.value} -- retrying every tick")
            return
        avg_price, shares = fill
        fee = self.broker.taker_fee_amount(shares, avg_price)
        self._fill_entry(side, avg_price, shares, dollars, fee=fee, now=now, event="MARKET_ENTRY",
                          note=(f"market buy @ {avg_price:.4f} (best ask {ask}), ${dollars:.0f} -> "
                                f"{shares:.2f}sh, fee ${fee:.4f}, {elapsed:.1f}s after open"))

    # ---- window close: settle, update the ladder, remember the result --------------

    def finalize_window(self, result: dict):
        """`result` comes from state.py: {winner: Side|None, up, down, age, reason}. Settles any
        open position, moves the size ladder, and stores this window's result as the next
        window's signal."""
        if self.s.window is None:
            return
        window = self.s.window
        winner: Optional[Side] = result.get("winner")
        self.prev = {"slug": window.slug, "open_ts": window.open_ts, "winner": winner,
                     "up": result.get("up"), "down": result.get("down"), "age": result.get("age")}
        if winner is None:
            self.total_undecided += 1

        # Did following the previous window pay off this time? (counted whether or not we traded)
        if self.s.side is not None and winner is not None:
            if self.s.side == winner:
                self.follow_right += 1
            else:
                self.follow_wrong += 1

        result_txt = {"no_signal": "no signal", "floor_skip": f"skipped (base 0, {self.s.side.value if self.s.side else ''})",
                      "halted": "halted"}.get(self.s.plan)
        traded = False
        filled_shares = None
        filled_price = None
        if self.s.position is not None:
            traded = True
            pos = self.s.position
            filled_shares, filled_price = pos.shares, pos.entry_price
            if winner is not None:
                won = pos.side == winner
                proceeds = pos.shares * (1.0 if won else 0.0)
                how = (f"window resolved {winner.value} (UP {_fmt(result.get('up'))} / DOWN {_fmt(result.get('down'))}): "
                       f"{pos.side.value} {'WON, pays $1/share' if won else 'LOST, worth $0'}")
            else:
                # undecided: nothing to redeem -- get out at the last bid as a taker. This isn't a
                # real win/loss against the 0.95 rule, so it doesn't move the size ladder.
                bid = self._bid_for(pos.side)
                fill_price = _realistic_fill_price(self._bid_levels_for(pos.side), pos.shares, bid)
                if fill_price is None:
                    fill_price = 0.0
                fee = self.broker.taker_fee_amount(pos.shares, fill_price)
                proceeds = pos.shares * fill_price - fee
                how = f"window undecided -- closed at the last bid {fill_price:.4f} (fee ${fee:.4f})"
            pnl = proceeds - pos.cost
            self.capital.balance += proceeds
            self.total_pnl += pnl
            self.s.window_pnl = pnl
            self.capital.check_halt()
            if winner is not None:
                self._log("SETTLED_WIN" if won else "SETTLED_LOSS", side=pos.side.value, price=pos.entry_price,
                           shares=pos.shares, pnl=pnl,
                           note=f"{how} (entry {pos.entry_price:.4f}, cost ${pos.cost:.2f}, pnl ${pnl:.2f})")
                self._update_ladder(won, pos.side)
                result_txt = "won (taker)" if won else "lost (taker)"
            else:
                self._log("SETTLED_UNDECIDED", side=pos.side.value, price=pos.entry_price,
                           shares=pos.shares, pnl=pnl,
                           note=f"{how} (entry {pos.entry_price:.4f}, cost ${pos.cost:.2f}, pnl ${pnl:.2f}) -- base unchanged")
                result_txt = "undecided (closed at market)"
            self.s.position = None
        elif self.s.plan == "trading" and not self.capital.halted:
            self.total_no_fills += 1
            base_note = (f"limit never reached {config.LIMIT_ENTRY_PRICE:.2f} in the first "
                         f"{config.LIMIT_ENTRY_TIMEOUT_SECONDS:g}s, and price never came back to "
                         f"{config.MARKET_ENTRY_CAP:.2f} after -- no trade, no money at risk")
            if winner is not None:
                won = self.s.side == winner
                self._log("ENTRY_MISSED", side=self.s.side.value,
                           note=(f"window closed without a fill: {base_note}. But the signal "
                                 f"{'won' if won else 'lost'} anyway -- treating this as a paper "
                                 f"{'win' if won else 'loss'} for the size ladder only (no cash moved)"))
                self._update_ladder(won, self.s.side)
                result_txt = "no fill -- signal won (paper)" if won else "no fill -- signal lost (paper)"
            else:
                self._log("ENTRY_MISSED", side=self.s.side.value,
                           note=f"window closed without a fill: {base_note}, and the window was undecided "
                                f"-- base stays ${self.base:.0f}")
                result_txt = "no fill"

        self.history.appendleft({
            "slug": window.slug, "open_ts": window.open_ts,
            "followed": self.s.side.value if self.s.side else None,
            "winner": winner.value if winner else None,
            "up": result.get("up"), "down": result.get("down"),
            "dollars": self.s.dollars if traded else None,
            "shares": filled_shares, "entry_price": filled_price,
            "result": result_txt or "—", "pnl": round(self.s.window_pnl, 2) if traded else None,
            "base_after": self.base,
        })
        self.s.window = None
        self.capital.record_equity_point(window.slug)

    def _update_ladder(self, won: bool, side: Side):
        before = self.base
        if won:
            self.wins += 1
            self.base = max(0.0, self.base - config.DOLLARS_STEP)
            if self.base == 0:
                self.floor_side = side
            note = f"win -> base ${before:.0f} -> ${self.base:.0f}" + (
                f" (floor: skipping {side.value} signals until {side.other().value} wins)" if self.base == 0 else "")
        else:
            self.losses += 1
            self.base = config.BASE_DOLLARS
            self.floor_side = None
            note = f"loss -> base reset ${before:.0f} -> ${self.base:.0f}"
        self._log("LADDER", side=side.value, note=note)

    # ---- dashboard payload -------------------------------------------------

    def snapshot(self) -> dict:
        now = time.time()
        s = self.s
        pos = s.position
        pos_payload = None
        open_market_value = 0.0
        unrealized = 0.0
        if pos is not None:
            bid = self._bid_for(pos.side)
            mark = bid if bid is not None else pos.entry_price
            open_market_value = pos.shares * mark
            unrealized = open_market_value - pos.cost
            pos_payload = {
                "side": pos.side.value, "entry_price": pos.entry_price, "shares": pos.shares,
                "cost": round(pos.cost, 4), "mark_price": mark, "unrealized_pnl": round(unrealized, 4),
                "seconds_since_entry": round(now - pos.entry_ts, 1),
                "payout_if_win": round(pos.shares - pos.cost, 4), "loss_if_lose": round(-pos.cost, 4),
            }

        # Armed and waiting to fire: which phase the entry is in and what it's about to buy.
        entry_payload = None
        w = s.window
        if (w is not None and not self.capital.halted and s.plan == "trading"
                and not s.entered and s.side is not None):
            elapsed = now - w.open_ts
            ask = self._ask_for(s.side)
            if elapsed < config.LIMIT_ENTRY_TIMEOUT_SECONDS:
                phase = "limit"
                phase_note = f"resting limit @ {config.LIMIT_ENTRY_PRICE:.2f}"
                seconds_left = round(config.LIMIT_ENTRY_TIMEOUT_SECONDS - elapsed, 1)
            elif ask is not None and ask <= config.MARKET_ENTRY_CAP:
                phase = "market_armed"
                phase_note = f"market buy armed (ask {ask:.4f} <= {config.MARKET_ENTRY_CAP:.2f} cap)"
                seconds_left = 0.0
            else:
                phase = "market_wait"
                phase_note = f"waiting for ask <= {config.MARKET_ENTRY_CAP:.2f}"
                seconds_left = 0.0
            entry_payload = {
                "side": s.side.value, "dollars": s.dollars, "phase": phase, "phase_note": phase_note,
                "seconds_left": seconds_left, "ask": ask,
            }

        if self.capital.halted:
            status = "halted"
        elif pos is not None:
            status = "open"
        elif entry_payload is not None:
            status = "entry_pending"
        elif s.plan == "floor_skip":
            status = "floor_skip"
        elif s.plan == "no_signal":
            status = "no_signal"
        else:
            status = "done"

        prev = self.prev
        prev_payload = None
        if prev is not None:
            prev_payload = {"slug": prev["slug"], "winner": prev["winner"].value if prev["winner"] else None,
                            "up": prev["up"], "down": prev["down"], "age": prev["age"]}

        win_rate = round(100 * self.wins / (self.wins + self.losses), 1) if (self.wins + self.losses) else None
        judged = self.follow_right + self.follow_wrong
        follow_acc = round(100 * self.follow_right / judged, 1) if judged else None
        steps_taken = int((config.BASE_DOLLARS - self.base) // config.DOLLARS_STEP) if config.DOLLARS_STEP else 0

        return {
            "engine": "BOT", "label": "DIPHUNTER",

            "balance": round(self.capital.balance, 2),
            "starting_capital": config.STARTING_CAPITAL,
            "halted": self.capital.halted,
            "equity_curve": self.capital.equity_curve,
            "equity": round(self.capital.balance + open_market_value, 4),

            "realized_pnl": round(self.total_pnl, 4),
            "unrealized_pnl": round(unrealized, 4),
            "open_market_value": round(open_market_value, 4),
            "last_window_pnl": round(s.window_pnl, 4),

            "status": status,
            "plan": s.plan, "plan_note": s.plan_note,
            "side": s.side.value if s.side else None,
            "window_dollars": s.dollars,
            "entry": entry_payload, "position": pos_payload,

            "prev": prev_payload,
            "sizing": {
                "base": self.base, "start": config.BASE_DOLLARS, "step": config.DOLLARS_STEP,
                "wins_in_run": steps_taken,
                "floor_side": self.floor_side.value if self.floor_side else None,
            },
            "history": list(self.history),

            "total_entries": self.total_entries,
            "total_no_fills": self.total_no_fills,
            "total_floor_skips": self.total_floor_skips,
            "total_no_signal": self.total_no_signal,
            "total_undecided": self.total_undecided,
            "total_illiquid_skips": self.total_illiquid_skips,
            "follow_right": self.follow_right, "follow_wrong": self.follow_wrong, "follow_accuracy": follow_acc,
            "wins": self.wins, "losses": self.losses, "win_rate": win_rate,

            "def": {
                "limit_price": config.LIMIT_ENTRY_PRICE, "limit_timeout_s": config.LIMIT_ENTRY_TIMEOUT_SECONDS,
                "market_cap": config.MARKET_ENTRY_CAP, "base_dollars": config.BASE_DOLLARS,
                "step": config.DOLLARS_STEP, "win_price": config.WIN_PRICE,
            },
        }


def _fmt(v) -> str:
    return "—" if v is None else f"{v:.3f}"
