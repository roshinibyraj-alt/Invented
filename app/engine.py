"""
Nine-engine paper trading engine for Polymarket's btc-updown-5m-* markets.

Engines 1-5 (LIMIT): place resting buy-limit orders on BOTH sides at the
engine's price (0.10 / 0.20 / 0.30 / 0.40 / 0.50). Whichever side's best
ask crosses the limit first is filled at exactly the limit price (maker
fill: no slippage, no fee) and the other side's order is cancelled. No
stop loss. TP at 0.99 redeems at $1.00/share, fee-free; an open position
at window close settles at the inferred winner ($1.00) or $0.00. After
any win the engine skips the next `skip_windows` windows (5/4/3/2/1), but
keeps monitoring: each skipped window it notes which side WOULD have
filled first; at window end, if that side would have won, the skip
counter resets to the full count, otherwise it decrements. At zero it
trades normally again.

Engines 6-9 (TAKER): whichever side's mid first reaches the trigger
(0.60 / 0.70 / 0.80 / 0.90) is bought immediately as a taker at real ask
depth (VWAP fill + taker fee). Stop loss at 0.30 (uniform for all taker
engines). TP at 0.99 redeems at $1.00/share, fee-free. Open at close ->
settle at inferred winner. No skip logic, no re-entry after exit.

Sizing: Kelly-optimal shares per engine, recomputed each window from the
engine's current bankroll, entry price, estimated edge (config.EDGE),
stop-loss distance (taker only), and a fractional Kelly multiplier
(config.KELLY_FRACTION). Bet is capped at MAX_BET_PCT of bankroll.
"""
import time
from dataclasses import dataclass, field
from typing import List, Optional

from . import config
from .models import EngineSpec, Side, WindowMarket
from .paper_broker import PaperBroker


def _midpoint(bid: Optional[float], ask: Optional[float]) -> Optional[float]:
    if bid is not None and ask is not None:
        return (bid + ask) / 2
    return ask if ask is not None else bid


@dataclass
class Position:
    side: Side
    shares: float
    entry_price: float
    entry_fee: float
    entry_ts: float
    cost: float = 0.0
    tp_hit: bool = False


@dataclass
class EngineRunState:
    window: Optional[WindowMarket] = None
    position: Optional[Position] = None
    up_bid: Optional[float] = None
    up_ask: Optional[float] = None
    down_bid: Optional[float] = None
    down_ask: Optional[float] = None
    up_bid_levels: Optional[list] = None
    up_ask_levels: Optional[list] = None
    down_bid_levels: Optional[list] = None
    down_ask_levels: Optional[list] = None
    up_order_live: bool = False
    down_order_live: bool = False
    orders_placed: bool = False
    filled_side: Optional[Side] = None
    would_fill_side: Optional[Side] = None
    would_fill_logged: bool = False
    trigger_fired: bool = False
    done_for_window: bool = False


@dataclass
class EngineCapital:
    balance: float
    starting: float
    halted: bool = False


class Engine:
    def __init__(self, spec: EngineSpec, broker: PaperBroker):
        self.spec = spec
        self.broker = broker
        self.cap = EngineCapital(balance=spec.starting_capital, starting=spec.starting_capital)
        self.s = EngineRunState()
        self.current_shares: float = config.MIN_SHARES   # Kelly-computed, set in reset_for_window
        # Lifetime stats
        self.skip_remaining: int = 0
        self.skip_resets: int = 0
        self.total_entries: int = 0
        self.total_tp_hits: int = 0
        self.total_sl_hits: int = 0
        self.total_wins: int = 0
        self.total_losses: int = 0
        self.no_trade_windows: int = 0
        self.last_window_pnl: float = 0.0
        self.total_pnl: float = 0.0
        self.equity_curve: List[dict] = []

    # ---- Kelly sizing -----------------------------------------------------

    def _kelly_shares(self) -> float:
        """Kelly-optimal share count for this window.

        LIMIT (no SL): f* = edge / (1 - price)
        TAKER (SL at S): f* = p_est - q / b where b = (1-price)/(price-S),
            p_est = min(price + edge, 1), q = 1 - p_est

        Result = f* * KELLY_FRACTION * balance, capped at MAX_BET_PCT,
        converted to whole shares at the engine's entry price, floored
        to MIN_SHARES."""
        edge = config.EDGE_ESTIMATE
        price = self.spec.entry_price
        bal = self.cap.balance
        if price <= 0.0 or price >= 1.0 or bal <= 0:
            return config.MIN_SHARES

        p_est = min(price + edge, 0.999)
        q_est = 1.0 - p_est

        if self.spec.kind == "LIMIT":
            # Binary: buy at P, win pays $1, lose $0
            # f* = edge / (1 - P)
            f_star = edge / (1.0 - price) if price < 1.0 else 0.0
        else:
            # TAKER with stop loss at S
            s = self.spec.sl_price if self.spec.sl_price is not None else config.SL_PRICE_TAKER
            if price <= s:
                return config.MIN_SHARES
            b = (1.0 - price) / (price - s)      # net odds (win / loss)
            f_star = p_est - q_est / b if b > 0 else 0.0

        f_star = max(f_star, 0.0)
        f_scaled = f_star * config.KELLY_FRACTION
        f_scaled = min(f_scaled, config.MAX_BET_PCT)
        dollar_bet = f_scaled * bal
        shares = dollar_bet / price if price > 0 else config.MIN_SHARES
        shares = max(shares, config.MIN_SHARES)
        return round(shares)

    # ---- logging ----------------------------------------------------------

    def _log(self, event: str, **kw):
        self.broker.log_event(
            f"E{self.spec.engine_id}",
            self.s.window.slug if self.s.window else "",
            event,
            balance_after=round(self.cap.balance, 2),
            **kw,
        )

    # ---- window lifecycle --------------------------------------------------

    def reset_for_window(self, window: WindowMarket):
        if self.cap.halted:
            return
        self.s = EngineRunState(window=window)
        self.current_shares = self._kelly_shares()
        sl_note = f", SL {self.spec.sl_price:.2f}" if self.spec.kind == "TAKER" else ""

        if self.spec.kind == "LIMIT":
            self._log("WINDOW_OPEN", shares=self.current_shares, note=(
                f"Kelly {self.current_shares:.0f}sh @ {self.spec.entry_price:.2f} (edge "
                f"{config.EDGE_ESTIMATE:.0%}, kelly={config.KELLY_FRACTION:.0%}). "
                f"resting limits on BOTH sides -- first fill wins, other cancelled. "
                f"No SL, TP sell at {self.spec.tp_price:.2f}. "
                f"no skip, trades every window."
            ))
        else:
            sl = self.spec.sl_price if self.spec.sl_price is not None else config.SL_PRICE_TAKER
            self._log("WINDOW_OPEN", shares=self.current_shares, note=(
                f"Kelly {self.current_shares:.0f}sh @ {self.spec.entry_price:.2f} (edge "
                f"{config.EDGE_ESTIMATE:.0%}, kelly={config.KELLY_FRACTION:.0%}). "
                f"taker buy when mid reaches {self.spec.entry_price:.2f} -- SL {sl:.2f}, "
                f"TP {self.spec.tp_price:.2f}. No skip."
            ))

    # ---- per-tick drive ----------------------------------------------------

    def on_tick(self, up_bid, up_ask, down_bid, down_ask, seconds_to_close=None, now=None,
                up_bid_levels=None, up_ask_levels=None,
                down_bid_levels=None, down_ask_levels=None):
        if self.s.window is None or self.cap.halted or self.s.done_for_window:
            return
        now = now if now is not None else time.time()
        self.s.up_bid, self.s.up_ask = up_bid, up_ask
        self.s.down_bid, self.s.down_ask = down_bid, down_ask
        self.s.up_bid_levels = up_bid_levels
        self.s.up_ask_levels = up_ask_levels
        self.s.down_bid_levels = down_bid_levels
        self.s.down_ask_levels = down_ask_levels

        if self.spec.kind == "LIMIT":
            self._tick_limit(now)
        else:
            self._tick_taker(now)

    # ---- LIMIT engines -----------------------------------------------------

    def _tick_limit(self, now: float):
        if self.skip_remaining > 0:
            if self.s.would_fill_side is None:
                up_cross = self.s.up_ask is not None and self.s.up_ask <= self.spec.entry_price + 1e-9
                down_cross = self.s.down_ask is not None and self.s.down_ask <= self.spec.entry_price + 1e-9
                if up_cross and down_cross:
                    self.s.would_fill_side = Side.UP
                elif up_cross:
                    self.s.would_fill_side = Side.UP
                elif down_cross:
                    self.s.would_fill_side = Side.DOWN
                if self.s.would_fill_side is not None and not self.s.would_fill_logged:
                    self.s.would_fill_logged = True
                    self._log("SKIP_WOULD_FILL", side=self.s.would_fill_side.value,
                              price=round(self.spec.entry_price, 2), note=(
                        f"skipped window (monitor): would have filled {self.s.would_fill_side.value} "
                        f"@ {self.spec.entry_price:.2f} -- checking at close whether that side wins"))
            return

        if not self.s.orders_placed:
            self.s.orders_placed = True
            self.s.up_order_live = self.s.down_order_live = True
            self._log("ORDERS_PLACED", price=round(self.spec.entry_price, 2),
                      shares=self.current_shares, note=(
                f"resting buy limits on UP and DOWN @ {self.spec.entry_price:.2f} "
                f"({self.current_shares:.0f}sh each) -- first fill wins, other cancelled"))

        if self.s.position is None:
            up_fill = (self.s.up_order_live and self.s.up_ask is not None
                       and self.s.up_ask <= self.spec.entry_price + 1e-9)
            down_fill = (self.s.down_order_live and self.s.down_ask is not None
                         and self.s.down_ask <= self.spec.entry_price + 1e-9)
            if up_fill and down_fill:
                self._fill_limit(Side.UP, now)
            elif up_fill:
                self._fill_limit(Side.UP, now)
            elif down_fill:
                self._fill_limit(Side.DOWN, now)
        else:
            mark = self._mid_for(self.s.position.side)
            if mark is not None and mark >= self.spec.tp_price:
                self._tp_sell(now)

    def _fill_limit(self, side: Side, now: float):
        shares = self.current_shares
        price = self.spec.entry_price
        cost = shares * price
        self.cap.balance -= cost
        if self.cap.balance < 0:
            self.cap.halted = True
        self.s.position = Position(side=side, shares=shares, entry_price=price,
                                   entry_fee=0.0, entry_ts=now, cost=cost)
        self.s.up_order_live = self.s.down_order_live = False
        self.s.filled_side = side
        self.total_entries += 1
        self._log("ENTRY_FILL", side=side.value, price=round(price, 3), shares=shares, fee=0.0, note=(
            f"limit buy filled: {side.value} @ {price:.3f} ({shares:.0f}sh, cost ${cost:.2f}) -- "
            f"other side order cancelled. TP sell at {self.spec.tp_price:.2f}."))

    # ---- TAKER engines -------------------------------------------------------

    def _tick_taker(self, now: float):
        # Sleep for the first TAKER_WAKEUP_SECONDS of the window -- no
        # trigger watching until the wakeup moment.
        if self.s.window is not None and self.s.position is None:
            elapsed = now - self.s.window.open_ts
            if elapsed < config.TAKER_WAKEUP_SECONDS:
                if not self.s.trigger_fired and not self.s.done_for_window:
                    self.s.done_for_window = False
                return
        if self.s.position is None:
            up_mid = self._mid_for(Side.UP)
            down_mid = self._mid_for(Side.DOWN)
            up_hit = up_mid is not None and up_mid >= self.spec.entry_price
            down_hit = down_mid is not None and down_mid >= self.spec.entry_price
            if up_hit and down_hit:
                self._taker_buy(Side.UP, now)
            elif up_hit:
                self._taker_buy(Side.UP, now)
            elif down_hit:
                self._taker_buy(Side.DOWN, now)
        else:
            side = self.s.position.side
            mark = self._mid_for(side)
            if mark is None:
                return
            sl = self.spec.sl_price if self.spec.sl_price is not None else config.SL_PRICE_TAKER
            if mark <= sl:
                self._sl_sell(now)
            elif mark >= config.TP_PRICE:
                self._tp_redeem(now)

    def _taker_buy(self, side: Side, now: float):
        shares = self.current_shares
        ask = self._ask_for(side)
        levels = self._ask_levels_for(side)
        fill = self._realistic_fill_price(levels, shares, ask)
        if fill is None:
            self.s.done_for_window = True
            self._log("NO_LIQUIDITY", side=side.value, shares=shares,
                      note="no ask liquidity on trigger -- skipped this window")
            return
        fee = self.broker.taker_fee_amount(shares, fill)
        cost = shares * fill + fee
        self.cap.balance -= cost
        if self.cap.balance < 0:
            self.cap.halted = True
        self.s.position = Position(side=side, shares=shares, entry_price=fill,
                                   entry_fee=fee, entry_ts=now, cost=cost)
        self.s.trigger_fired = True
        self.total_entries += 1
        sl = self.spec.sl_price if self.spec.sl_price is not None else config.SL_PRICE_TAKER
        self._log("ENTRY_FILL", side=side.value, price=round(fill, 4), shares=shares,
                  fee=round(fee, 4), note=(
            f"taker entry: {side.value} mid reached {self.spec.entry_price:.2f} -> "
            f"{shares:.0f}sh @ {fill:.4f} (VWAP ask, fee ${fee:.4f}). "
            f"SL {sl:.2f}, TP {self.spec.tp_price:.2f} -> $1.00."))

    def _sl_sell(self, now: float):
        pos = self.s.position
        sl = self.spec.sl_price if self.spec.sl_price is not None else config.SL_PRICE_TAKER
        bid = self._bid_for(pos.side)
        levels = self._bid_levels_for(pos.side)
        fill = self._realistic_fill_price(levels, pos.shares, bid)
        if fill is None:
            return
        fee = self.broker.taker_fee_amount(pos.shares, fill)
        proceeds = pos.shares * fill - fee
        pnl = proceeds - pos.cost
        self.cap.balance += proceeds
        self.total_sl_hits += 1
        self.total_losses += 1
        self.last_window_pnl = pnl
        self.total_pnl += pnl
        self.s.done_for_window = True
        self._record_equity()
        self._log("SL_HIT", side=pos.side.value, price=round(fill, 4), shares=pos.shares,
                  fee=round(fee, 4), pnl=round(pnl, 2), note=(
            f"stop-loss: {pos.side.value} mid <= {sl:.2f} -> sold {pos.shares:.0f}sh @ "
            f"{fill:.4f} (bid depth, fee ${fee:.4f}). PnL ${pnl:.2f}."))
        self.s.position = None

    # ---- TP / settlement -----------------------------------------------------

    def _tp_sell(self, now: float):
        """Take-profit sell: sell at bid depth when position side's mid >= tp_price.
        Used by LIMIT engines (E1-E5) with tp_price=0.70."""
        pos = self.s.position
        bid = self._bid_for(pos.side)
        levels = self._bid_levels_for(pos.side)
        fill = self._realistic_fill_price(levels, pos.shares, bid)
        if fill is None:
            return
        fee = self.broker.taker_fee_amount(pos.shares, fill)
        proceeds = pos.shares * fill - fee
        pnl = proceeds - pos.cost
        self.cap.balance += proceeds
        pos.tp_hit = True
        self.total_tp_hits += 1
        self.total_wins += 1
        self.last_window_pnl = pnl
        self.total_pnl += pnl
        self.s.done_for_window = True
        if self.spec.skip_windows > 0:
            self.skip_remaining = self.spec.skip_windows
            self._log("SKIP_ARMED", note=f"skip armed: {self.spec.skip_windows} windows after this win")
        self._record_equity()
        self._log("TP_HIT", side=pos.side.value, price=round(fill, 4), shares=pos.shares,
                  fee=round(fee, 4), pnl=round(pnl, 2), note=(
            f"TP sell: {pos.side.value} mid >= {self.spec.tp_price:.2f} -> sold {pos.shares:.0f}sh @ "
            f"{fill:.4f} (bid depth, fee ${fee:.4f}). PnL ${pnl:.2f}."))
        self.s.position = None

    def _tp_redeem(self, now: float):
        pos = self.s.position
        proceeds = pos.shares * 1.0
        pnl = proceeds - pos.cost
        self.cap.balance += proceeds
        pos.tp_hit = True
        self.total_tp_hits += 1
        self.total_wins += 1
        self.last_window_pnl = pnl
        self.total_pnl += pnl
        self.s.done_for_window = True
        if self.spec.kind == "LIMIT" and self.spec.skip_windows > 0:
            self.skip_remaining = self.spec.skip_windows
            self._log("SKIP_ARMED", note=f"skip armed: {self.spec.skip_windows} windows after this win")
        self._record_equity()
        self._log("TP_HIT", side=pos.side.value, price=1.0, shares=pos.shares,
                  pnl=round(pnl, 2), note=(
            f"TP {self.spec.tp_price:.2f} -> redeemed {pos.shares:.0f}sh at $1.00/share, fee-free. "
            f"PnL ${pnl:.2f}."))
        self.s.position = None

    def finalize_window(self, winning_side: Optional[Side]):
        if self.cap.halted or self.s.window is None:
            return

        if self.spec.kind == "LIMIT" and self.skip_remaining > 0:
            if (self.s.would_fill_side is not None and winning_side is not None
                    and self.s.would_fill_side == winning_side):
                self.skip_remaining = self.spec.skip_windows
                self.skip_resets += 1
                self._log("SKIP_RESET", side=self.s.would_fill_side.value, note=(
                    f"skipped window WOULD have won ({self.s.would_fill_side.value} fills @ "
                    f"{self.spec.entry_price:.2f} and wins) -- skip reset to {self.spec.skip_windows}"))
            else:
                self.skip_remaining = max(0, self.skip_remaining - 1)
                self._log("SKIP_COUNTDOWN", side=self.s.would_fill_side.value if self.s.would_fill_side else None,
                          note=(f"skipped window would NOT have won -- "
                                f"skip now {self.skip_remaining}/{self.spec.skip_windows}"))
            self._record_equity()
            return

        if self.s.position is not None and not self.s.position.tp_hit:
            pos = self.s.position
            if winning_side is not None and winning_side == pos.side:
                proceeds = pos.shares * 1.0
                pnl = proceeds - pos.cost
                self.cap.balance += proceeds
                self.total_wins += 1
                self.last_window_pnl = pnl
                self.total_pnl += pnl
                if self.spec.kind == "LIMIT" and self.spec.skip_windows > 0:
                    self.skip_remaining = self.spec.skip_windows
                    self._log("SKIP_ARMED", note=f"skip armed: {self.spec.skip_windows} windows after this win")
                self._log("RESOLUTION_WIN", side=pos.side.value, price=1.0, shares=pos.shares,
                          pnl=round(pnl, 2), note=(
                    f"window won by {winning_side.value} -- {pos.shares:.0f}sh redeemed at $1.00. "
                    f"PnL ${pnl:.2f}."))
            else:
                pnl = -pos.cost
                self.total_losses += 1
                self.last_window_pnl = pnl
                self.total_pnl += pnl
                self._log("RESOLUTION_LOSS", side=pos.side.value, price=0.0, shares=pos.shares,
                          pnl=round(pnl, 2), note=(
                    f"window won by {winning_side.value if winning_side else 'unknown'} -- "
                    f"{pos.side.value} position expires worthless. PnL ${pnl:.2f}."))
            self.s.position = None
            self._record_equity()

        if (self.s.position is None and not self.s.done_for_window
                and self.spec.kind == "LIMIT" and self.skip_remaining == 0):
            self.no_trade_windows += 1

    # ---- helpers -----------------------------------------------------------

    def _ask_for(self, side):  return self.s.up_ask if side == Side.UP else self.s.down_ask
    def _bid_for(self, side):  return self.s.up_bid if side == Side.UP else self.s.down_bid
    def _mid_for(self, side):  return _midpoint(self._bid_for(side), self._ask_for(side))
    def _ask_levels_for(self, side): return self.s.up_ask_levels if side == Side.UP else self.s.down_ask_levels
    def _bid_levels_for(self, side): return self.s.up_bid_levels if side == Side.UP else self.s.down_bid_levels

    @staticmethod
    def _realistic_fill_price(levels, shares, fallback_price):
        if levels is None:
            return fallback_price
        if not levels:
            return None
        remaining = shares; cost = 0.0; worst = levels[-1][0]
        for px, sz in levels:
            if remaining <= 1e-9: break
            take = min(remaining, sz) if sz and sz > 0 else 0.0
            if take <= 0: continue
            cost += take * px; remaining -= take
        if remaining > 1e-9:
            cost += remaining * worst
        return cost / shares

    def _record_equity(self):
        self.equity_curve.append({"window": self.s.window.slug if self.s.window else "",
                                  "ts": time.time(), "balance": round(self.cap.balance, 2)})
        if len(self.equity_curve) > 500:
            self.equity_curve = self.equity_curve[-500:]

    # ---- dashboard snapshot -------------------------------------------------

    def snapshot(self):
        position = None
        if self.s.position is not None:
            pos = self.s.position
            mark = self._mid_for(pos.side) or pos.entry_price
            position = {"side": pos.side.value, "shares": pos.shares,
                        "entry_price": round(pos.entry_price, 4), "entry_fee": round(pos.entry_fee, 4),
                        "cost": round(pos.cost, 4), "mark": round(mark, 4),
                        "unrealized_pnl": round(pos.shares * mark - pos.cost, 2), "tp_hit": pos.tp_hit}

        sl = None
        if self.spec.kind == "TAKER":
            sl = self.spec.sl_price if self.spec.sl_price is not None else config.SL_PRICE_TAKER
        if self.cap.halted: status = "halted"
        elif self.skip_remaining > 0: status = "skipping"
        elif self.s.position is not None: status = "in_position"
        elif self.spec.kind == "LIMIT" and not self.s.orders_placed: status = "placing_orders"
        elif self.spec.kind == "TAKER" and not self.s.trigger_fired: status = "waiting_trigger"
        else: status = "done"

        kelly_f = self._kelly_shares() / (self.cap.balance / self.spec.entry_price) if self.cap.balance > 0 and self.spec.entry_price > 0 else 0

        return {
            "engine_id": self.spec.engine_id, "kind": self.spec.kind,
            "entry_price": self.spec.entry_price, "sl_price": sl,
            "skip_windows": self.spec.skip_windows,
            "tp_price": self.spec.tp_price,
            "kelly_shares": self.current_shares,
            "kelly_fraction": round(kelly_f, 4),
            "edge": config.EDGE_ESTIMATE,
            "balance": round(self.cap.balance, 2),
            "starting_capital": self.spec.starting_capital,
            "halted": self.cap.halted,
            "equity_curve": self.equity_curve,
            "position": position,
            "unrealized_pnl": position["unrealized_pnl"] if position else 0.0,
            "status": status,
            "filled_side": self.s.filled_side.value if self.s.filled_side else None,
            "would_fill_side": self.s.would_fill_side.value if self.s.would_fill_side else None,
            "skip_remaining": self.skip_remaining, "skip_resets": self.skip_resets,
            "total_entries": self.total_entries,
            "total_tp_hits": self.total_tp_hits, "total_sl_hits": self.total_sl_hits,
            "total_wins": self.total_wins, "total_losses": self.total_losses,
            "no_trade_windows": self.no_trade_windows,
            "last_window_pnl": round(self.last_window_pnl, 2),
            "total_pnl": round(self.total_pnl, 2),
            "win_rate": round(100 * self.total_wins / (self.total_wins + self.total_losses), 1)
            if (self.total_wins + self.total_losses) else None,
        }


class EngineManager:
    def __init__(self, broker: PaperBroker):
        self.engines: List[Engine] = [Engine(spec, broker) for spec in config.ENGINE_SPECS]

    def reset_for_window(self, window):
        for eng in self.engines:
            eng.reset_for_window(window)

    def on_tick(self, up_bid, up_ask, down_bid, down_ask, seconds_to_close=None, now=None,
                up_bid_levels=None, up_ask_levels=None, down_bid_levels=None, down_ask_levels=None):
        for eng in self.engines:
            eng.on_tick(up_bid, up_ask, down_bid, down_ask, seconds_to_close, now,
                        up_bid_levels, up_ask_levels, down_bid_levels, down_ask_levels)

    def finalize_window(self, winning_side):
        for eng in self.engines:
            eng.finalize_window(winning_side)

    def snapshot(self):
        return [eng.snapshot() for eng in self.engines]
