"""
Trading engine -- breakout entry on either side, fixed TP/SL exit,
anti-martingale position sizing across windows.

See app/config.py for the full strategy write-up. Summary: watch both
sides' mid price from window open; the instant either reaches 0.70,
buy that side only (capped at 0.10 slippage above trigger -- skip the
trade entirely if the market's already past that). Once filled, exit
the whole position the instant that side's bid reaches 0.99 (TP) or
0.40 (SL), or force-close at window end if neither hit first. Size is
base * 2.1 ** martingale_step, where martingale_step persists across
windows: a win steps it up (reset to 0 if already at the cap), a loss
resets it to 0, a no-trade window leaves it untouched.
"""
import time
from dataclasses import dataclass, field
from typing import List, Optional

from . import config
from .models import Side, WindowMarket
from .paper_broker import PaperBroker


def _midpoint(bid: Optional[float], ask: Optional[float]) -> Optional[float]:
    if bid is not None and ask is not None:
        return (bid + ask) / 2
    return ask if ask is not None else bid


# ---------------------------------------------------------------------------
# Shared capital -- single balance the engine debits/credits.
# ---------------------------------------------------------------------------

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


# ---------------------------------------------------------------------------
# The single open position for a window, if any.
# ---------------------------------------------------------------------------

@dataclass
class Position:
    side: Side
    shares: float
    entry_price: float
    entry_fee: float
    entry_ts: float
    martingale_step: int   # the step this position's size was sized at (for the log/dashboard)

    @property
    def cost(self) -> float:
        return self.shares * self.entry_price + self.entry_fee


@dataclass
class EngineState:
    window: Optional[WindowMarket] = None
    up_bid: Optional[float] = None
    up_ask: Optional[float] = None
    down_bid: Optional[float] = None
    down_ask: Optional[float] = None

    # Full order-book depth for the current tick, when available. None
    # means "no depth data this tick" (fall back to the scalar price for
    # the whole size); an empty list means "book fetched fine, there is
    # genuinely nothing resting on this side" -- a real no-liquidity
    # signal, not a data gap. See Engine._realistic_fill_price.
    up_bid_levels: Optional[list] = None
    up_ask_levels: Optional[list] = None
    down_bid_levels: Optional[list] = None
    down_ask_levels: Optional[list] = None

    position: Optional[Position] = None
    trade_taken: bool = False    # this window's one entry slot has been used (filled or missed)
    done_for_window: bool = False   # position closed (or trade skipped) -- nothing left to watch

    total_triggers: int = 0          # times either side reached 0.70 and an entry was attempted
    total_missed_entries: int = 0    # triggers where price ran past the slippage cap before filling
    total_tp_hits: int = 0
    total_sl_hits: int = 0
    total_forced_closes: int = 0     # window closed before TP/SL was reached
    no_trade_windows: int = 0        # 0.70 was never reached at all
    wins: int = 0
    losses: int = 0
    total_pnl: float = 0.0
    last_window_pnl: float = 0.0


class Engine:
    """Breakout-entry / fixed-TP-SL engine with anti-martingale sizing,
    driven off its own capital pool. Kept as the class name `Engine` /
    constructed the same way (Engine(broker)) so app/state.py doesn't
    need structural changes."""

    name = "BREAKOUT"

    def __init__(self, broker: PaperBroker):
        self.broker = broker
        self.capital = CapitalPool(balance=config.STARTING_CAPITAL)
        self.s = EngineState()
        self.martingale_step = 0   # persists across windows -- NOT part of EngineState
        self.capital.record_equity_point(None)

    def _log(self, event, **kw):
        self.broker.log_event(self.name, self.s.window.slug if self.s.window else "", event,
                               balance_after=self.capital.balance, **kw)

    def _current_stake_shares(self) -> float:
        return config.BASE_ORDER_SHARES * (config.ANTI_MARTINGALE_MULTIPLIER ** self.martingale_step)

    def reset_for_window(self, window: WindowMarket):
        self.s = EngineState(window=window)

        if self.capital.halted:
            self._log("HALTED", note=f"engine halted (balance ${self.capital.balance:.2f} < $0) -- no trading")
            return

        stake = self._current_stake_shares()
        self._log("WINDOW_OPEN", shares=stake, note=(
            f"watching for either side's mid to reach {config.ENTRY_TRIGGER_PRICE} -- "
            f"stake this window: {stake:.0f}sh (martingale step {self.martingale_step}, "
            f"{config.ANTI_MARTINGALE_MULTIPLIER}x ladder, cap {config.MAX_MARTINGALE_STEPS}). "
            f"TP {config.TP_PRICE} / SL {config.SL_PRICE}, slippage cap {config.ENTRY_SLIPPAGE}"
        ))

    def on_tick(self, up_bid, up_ask, down_bid, down_ask, seconds_to_close: float = None, now: Optional[float] = None,
                up_bid_levels: Optional[list] = None, up_ask_levels: Optional[list] = None,
                down_bid_levels: Optional[list] = None, down_ask_levels: Optional[list] = None):
        if self.s.window is None or self.capital.halted:
            return
        now = now if now is not None else time.time()
        self.s.up_bid, self.s.up_ask = up_bid, up_ask
        self.s.down_bid, self.s.down_ask = down_bid, down_ask
        self.s.up_bid_levels, self.s.up_ask_levels = up_bid_levels, up_ask_levels
        self.s.down_bid_levels, self.s.down_ask_levels = down_bid_levels, down_ask_levels

        if self.s.done_for_window:
            return

        if self.s.position is None:
            if not self.s.trade_taken:
                self._check_entry_trigger(now)
        else:
            self._check_exit(now)

    # ---- price/level lookups ----------------------------------------------

    def _ask_for(self, side: Side) -> Optional[float]:
        return self.s.up_ask if side == Side.UP else self.s.down_ask

    def _bid_for(self, side: Side) -> Optional[float]:
        return self.s.up_bid if side == Side.UP else self.s.down_bid

    def _mid_for(self, side: Side) -> Optional[float]:
        return _midpoint(self._bid_for(side), self._ask_for(side))

    def _ask_levels_for(self, side: Side) -> Optional[list]:
        return self.s.up_ask_levels if side == Side.UP else self.s.down_ask_levels

    def _bid_levels_for(self, side: Side) -> Optional[list]:
        return self.s.up_bid_levels if side == Side.UP else self.s.down_bid_levels

    @staticmethod
    def _realistic_fill_price(levels: Optional[list], shares: float, fallback_price: Optional[float]) -> Optional[float]:
        """Volume-weighted average price to actually trade `shares`
        against a real order book, instead of assuming the whole size
        fills at the single best quote.

        - levels is None -> no depth data this tick; fall back to
          filling the whole size at `fallback_price`.
        - levels is [] -> book fetched fine, genuinely nothing resting
          on this side; return None, caller must not invent a fill.
        - levels is non-empty -> walk best-price-first; any shortfall
          in visible depth is priced at the worst level seen.
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

    # ---- entry: breakout trigger, one shot per window -----------------------

    def _check_entry_trigger(self, now: float):
        for side in (Side.UP, Side.DOWN):
            mid = self._mid_for(side)
            if mid is not None and mid >= config.ENTRY_TRIGGER_PRICE:
                self._attempt_entry(side, now)
                return   # window's one trade slot is spent, win or miss -- ignore the other side

    def _attempt_entry(self, side: Side, now: float):
        self.s.trade_taken = True
        self.s.total_triggers += 1
        shares = self._current_stake_shares()
        ask = self._ask_for(side)
        levels = self._ask_levels_for(side)
        fill_price = self._realistic_fill_price(levels, shares, ask)
        cap = round(config.ENTRY_TRIGGER_PRICE + config.ENTRY_SLIPPAGE, 6)

        if fill_price is None or fill_price > cap:
            self.s.total_missed_entries += 1
            self.s.done_for_window = True
            self._log("MISSED_ENTRY", side=side.value, price=fill_price,
                       note=(f"{side.value} reached {config.ENTRY_TRIGGER_PRICE} but real fill price "
                             f"({fill_price if fill_price is not None else 'no liquidity'}) is past the "
                             f"{cap} slippage cap -- skipping, no position taken, no capital risked"))
            return

        fee = self.broker.taker_fee_amount(shares, fill_price)
        cost = shares * fill_price + fee
        self.capital.balance -= cost
        self.s.position = Position(side=side, shares=shares, entry_price=fill_price, entry_fee=fee,
                                    entry_ts=now, martingale_step=self.martingale_step)
        self._log("ENTRY_FILL", side=side.value, price=round(fill_price, 4), shares=shares, fee=round(fee, 4),
                   note=(f"breakout buy filled (taker): {shares:.0f}sh @ {fill_price:.4f} "
                         f"(trigger {config.ENTRY_TRIGGER_PRICE}, cap {cap}, fee ${fee:.4f}) -- "
                         f"TP {config.TP_PRICE} / SL {config.SL_PRICE}"))
        self.capital.check_halt()

    # ---- exit: fixed TP/SL, one position at a time --------------------------

    def _check_exit(self, now: float):
        pos = self.s.position
        bid = self._bid_for(pos.side)
        if bid is None:
            return
        if bid >= config.TP_PRICE:
            self.s.total_tp_hits += 1
            self._close_position(now, reason="TP_HIT",
                                  note_prefix=f"take-profit hit ({config.TP_PRICE})")
        elif bid <= config.SL_PRICE:
            self.s.total_sl_hits += 1
            self._close_position(now, reason="SL_HIT",
                                  note_prefix=f"stop-loss hit ({config.SL_PRICE})")

    def _close_position(self, now: float, reason: str, note_prefix: str):
        pos = self.s.position
        bid = self._bid_for(pos.side)
        levels = self._bid_levels_for(pos.side)
        fill_price = self._realistic_fill_price(levels, pos.shares, bid)
        if fill_price is None:
            # confirmed empty book -- nobody bidding at all right now
            fill_price = 0.0
            self._log("NO_LIQUIDITY", side=pos.side.value, price=bid,
                       note=f"{reason} but book has zero bid depth on {pos.side.value} -- assuming worst case $0")

        fee = self.broker.taker_fee_amount(pos.shares, fill_price)
        proceeds = pos.shares * fill_price - fee
        pnl = proceeds - pos.cost
        self.capital.balance += proceeds
        self.s.total_pnl += pnl
        self.s.last_window_pnl += pnl
        win = pnl >= 0
        if win:
            self.s.wins += 1
        else:
            self.s.losses += 1

        self._log(reason, side=pos.side.value, price=round(fill_price, 4), shares=pos.shares,
                   fee=round(fee, 4), pnl=round(pnl, 4),
                   note=(f"{note_prefix} (taker, real fill @ {fill_price:.4f}): {pos.shares:.0f}sh sold "
                         f"(entry {pos.entry_price:.4f}, fee ${fee:.4f}, pnl ${pnl:.4f})"))
        self.capital.check_halt()
        self._advance_martingale(win)
        self.s.position = None
        self.s.done_for_window = True

    def _advance_martingale(self, win: bool):
        prev = self.martingale_step
        if win:
            if self.martingale_step >= config.MAX_MARTINGALE_STEPS:
                self.martingale_step = 0
            else:
                self.martingale_step += 1
        else:
            self.martingale_step = 0
        if self.martingale_step != prev:
            self._log("MARTINGALE_STEP", note=(
                f"{'win' if win else 'loss'} -- stake step {prev} -> {self.martingale_step} "
                f"for next window ({self._current_stake_shares():.0f}sh)"
            ))

    # ---- window close -------------------------------------------------------

    def finalize_window(self, winning_side: Optional[Side]):
        if self.s.window is None:
            return
        window_slug = self.s.window.slug

        if not self.capital.halted:
            if self.s.position is not None:
                self.s.total_forced_closes += 1
                self._close_position(time.time(), reason="FORCED_CLOSE",
                                      note_prefix="window closed before TP/SL, forced taker close")
            elif not self.s.trade_taken:
                self.s.no_trade_windows += 1
                self._log("NO_TRADE", note=f"neither side ever reached {config.ENTRY_TRIGGER_PRICE} this window")

        self.s.window = None
        self.capital.record_equity_point(window_slug)

    # ---- dashboard payload -------------------------------------------------

    def _position_payload(self) -> Optional[dict]:
        pos = self.s.position
        if pos is None:
            return None
        bid = self._bid_for(pos.side)
        mark = bid if bid is not None else pos.entry_price
        market_value = pos.shares * mark
        unrealized = market_value - pos.cost
        to_tp = round(config.TP_PRICE - mark, 4)
        to_sl = round(mark - config.SL_PRICE, 4)
        return {
            "side": pos.side.value,
            "shares": pos.shares,
            "entry_price": round(pos.entry_price, 4),
            "entry_fee": round(pos.entry_fee, 4),
            "entry_ts": pos.entry_ts,
            "martingale_step": pos.martingale_step,
            "mark_price": mark,
            "market_value": round(market_value, 4),
            "unrealized_pnl": round(unrealized, 4),
            "tp_price": config.TP_PRICE,
            "sl_price": config.SL_PRICE,
            "distance_to_tp": to_tp,
            "distance_to_sl": to_sl,
        }

    def snapshot(self) -> dict:
        position = self._position_payload()
        market_value = position["market_value"] if position else 0.0
        unrealized = position["unrealized_pnl"] if position else 0.0
        realized_pnl = round(self.s.total_pnl, 4)

        if self.capital.halted:
            status = "halted"
        elif position is not None:
            status = "in_position"
        elif self.s.done_for_window:
            status = "done"
        else:
            status = "watching"

        up_mid = self._mid_for(Side.UP)
        down_mid = self._mid_for(Side.DOWN)

        return {
            "engine": "BREAKOUT", "label": "Breakout entry, fixed TP/SL, anti-martingale",

            "balance": round(self.capital.balance, 2),
            "starting_capital": config.STARTING_CAPITAL,
            "halted": self.capital.halted,
            "equity_curve": self.capital.equity_curve,
            "equity": round(self.capital.balance + market_value, 4),

            "realized_pnl": realized_pnl,
            "unrealized_pnl": round(unrealized, 4),
            "open_market_value": round(market_value, 4),
            "last_window_pnl": round(self.s.last_window_pnl, 4),

            "up_mid": up_mid,
            "down_mid": down_mid,
            "trade_taken": self.s.trade_taken,
            "position": position,
            "done_for_window": self.s.done_for_window,

            "martingale_step": self.martingale_step,
            "martingale_cap": config.MAX_MARTINGALE_STEPS,
            "current_stake_shares": self._current_stake_shares(),
            "martingale_multiplier": round(config.ANTI_MARTINGALE_MULTIPLIER ** self.martingale_step, 4),

            "total_triggers": self.s.total_triggers,
            "total_missed_entries": self.s.total_missed_entries,
            "total_tp_hits": self.s.total_tp_hits,
            "total_sl_hits": self.s.total_sl_hits,
            "total_forced_closes": self.s.total_forced_closes,
            "no_trade_windows": self.s.no_trade_windows,
            "wins": self.s.wins,
            "losses": self.s.losses,
            "win_rate": round(100 * self.s.wins / (self.s.wins + self.s.losses), 1) if (self.s.wins + self.s.losses) else None,

            "status": status,

            "def": {
                "entry_trigger_price": config.ENTRY_TRIGGER_PRICE,
                "entry_slippage": config.ENTRY_SLIPPAGE,
                "entry_cap_price": round(config.ENTRY_TRIGGER_PRICE + config.ENTRY_SLIPPAGE, 4),
                "tp_price": config.TP_PRICE,
                "sl_price": config.SL_PRICE,
                "base_order_shares": config.BASE_ORDER_SHARES,
                "anti_martingale_multiplier": config.ANTI_MARTINGALE_MULTIPLIER,
                "max_martingale_steps": config.MAX_MARTINGALE_STEPS,
            },
        }
