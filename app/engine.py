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
depth (VWAP fill + taker fee). No stop loss. TP 0.99 -> $1.00/share
redemption, fee-free. Open at close -> settle at inferred winner. No
skip logic, no re-entry after exit.

All engines: flat BASE_ORDER_SHARES (100), no martingale, isolated
$500 bankroll each ($4,500 total demo capital).
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


# ---------------------------------------------------------------------------
# Per-engine state for the window currently trading.
# ---------------------------------------------------------------------------

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
    # LIMIT engines
    up_order_live: bool = False
    down_order_live: bool = False
    orders_placed: bool = False
    filled_side: Optional[Side] = None     # side that actually filled this window (LIMIT)
    # Skip monitor (LIMIT): would-have-filled side during a skipped window
    would_fill_side: Optional[Side] = None
    would_fill_logged: bool = False
    # TAKER engines
    trigger_fired: bool = False
    done_for_window: bool = False


@dataclass
class EngineCapital:
    balance: float
    starting: float
    halted: bool = False


# ---------------------------------------------------------------------------
# One engine instance (of nine). Fully independent except for the shared
# CLOB book ticks fed in by the state loop.
# ---------------------------------------------------------------------------

class Engine:
    def __init__(self, spec: EngineSpec, broker: PaperBroker):
        self.spec = spec
        self.broker = broker
        self.cap = EngineCapital(balance=spec.starting_capital, starting=spec.starting_capital)
        self.s = EngineRunState()
        # Lifetime (persist across windows)
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

        if self.spec.kind == "LIMIT":
            self._log("WINDOW_OPEN", note=(
                f"placing resting buy limits @ {self.spec.entry_price:.2f} on BOTH sides -- "
                f"first side whose ask crosses fills at limit price (no slippage, no fee), other cancelled. "
                f"No SL, TP {config.TP_PRICE} -> $1.00. flat {self.spec.base_shares:.0f}sh. "
                f"Skip state: {self.skip_remaining}/{self.spec.skip_windows} windows."
            ))
        else:
            self._log("WINDOW_OPEN", note=(
                f"watching both mids -- whichever side first reaches {self.spec.entry_price:.2f} is bought "
                f"as taker (real ask depth + fee). No SL. TP {config.TP_PRICE} -> $1.00. "
                f"flat {self.spec.base_shares:.0f}sh. No skip."
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

    # ---- LIMIT engines ------------------------------------------------------

    def _tick_limit(self, now: float):
        # Skip mode: don't place real orders -- just monitor which side
        # would have filled first (its ask would have crossed the limit).
        if self.skip_remaining > 0:
            if self.s.would_fill_side is None:
                up_cross = self.s.up_ask is not None and self.s.up_ask <= self.spec.entry_price + 1e-9
                down_cross = self.s.down_ask is not None and self.s.down_ask <= self.spec.entry_price + 1e-9
                if up_cross and down_cross:
                    self.s.would_fill_side = Side.UP  # deterministic tie-break (same tick)
                elif up_cross:
                    self.s.would_fill_side = Side.UP
                elif down_cross:
                    self.s.would_fill_side = Side.DOWN
                if self.s.would_fill_side is not None and not self.s.would_fill_logged:
                    self.s.would_fill_logged = True
                    self._log("SKIP_WOULD_FILL", side=self.s.would_fill_side.value,
                              price=round(self.spec.entry_price, 2), note=(
                        f"skipped window (monitor): would have filled {self.s.would_fill_side.value} @ "
                        f"{self.spec.entry_price:.2f} -- checking at close whether that side wins "
                        f"(if yes, skip resets to {self.spec.skip_windows})"
                    ))
            return

        # Active window: place both orders on first tick, then watch fills.
        if not self.s.orders_placed:
            self.s.orders_placed = True
            self.s.up_order_live = True
            self.s.down_order_live = True
            self._log("ORDERS_PLACED", price=round(self.spec.entry_price, 2), note=(
                f"resting buy limits placed on UP and DOWN @ {self.spec.entry_price:.2f} "
                f"({self.spec.base_shares:.0f}sh each) -- first fill wins, other cancelled"
            ))

        if self.s.position is None:
            up_fill = self.s.up_order_live and self.s.up_ask is not None and self.s.up_ask <= self.spec.entry_price + 1e-9
            down_fill = self.s.down_order_live and self.s.down_ask is not None and self.s.down_ask <= self.spec.entry_price + 1e-9
            if up_fill and down_fill:
                self._fill_limit(Side.UP, now)  # deterministic tie-break
            elif up_fill:
                self._fill_limit(Side.UP, now)
            elif down_fill:
                self._fill_limit(Side.DOWN, now)
        else:
            mark = self._mid_for(self.s.position.side)
            if mark is not None and mark >= config.TP_PRICE:
                self._tp_redeem(now)

    def _fill_limit(self, side: Side, now: float):
        shares = self.spec.base_shares
        price = self.spec.entry_price          # maker: exact limit price, no fee, no slippage
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
            f"other side order cancelled. No SL, TP {config.TP_PRICE} -> $1.00."
        ))

    # ---- TAKER engines -------------------------------------------------------

    def _tick_taker(self, now: float):
        if self.s.position is None:
            up_mid = self._mid_for(Side.UP)
            down_mid = self._mid_for(Side.DOWN)
            up_hit = up_mid is not None and up_mid >= self.spec.entry_price
            down_hit = down_mid is not None and down_mid >= self.spec.entry_price
            if up_hit and down_hit:
                self._taker_buy(Side.UP, now)   # deterministic tie-break
            elif up_hit:
                self._taker_buy(Side.UP, now)
            elif down_hit:
                self._taker_buy(Side.DOWN, now)
        else:
            side = self.s.position.side
            mark = self._mid_for(side)
            if mark is None:
                return
            if mark >= config.TP_PRICE:
                self._tp_redeem(now)

    def _taker_buy(self, side: Side, now: float):
        shares = self.spec.base_shares
        ask = self._ask_for(side)
        levels = self._ask_levels_for(side)
        fill = self._realistic_fill_price(levels, shares, ask)
        if fill is None:
            self.s.done_for_window = True
            self._log("NO_LIQUIDITY", side=side.value, note="no ask liquidity on trigger -- skipped this window")
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
        self._log("ENTRY_FILL", side=side.value, price=round(fill, 4), shares=shares, fee=round(fee, 4), note=(
            f"taker entry: {side.value} mid reached {self.spec.entry_price:.2f} -> bought {shares:.0f}sh @ "
            f"{fill:.4f} (VWAP ask depth, fee ${fee:.4f}). No SL. TP {config.TP_PRICE} -> $1.00."
        ))

    # ---- TP / settlement -----------------------------------------------------

    def _tp_redeem(self, now: float):
        pos = self.s.position
        proceeds = pos.shares * 1.0          # TP = redeem at $1.00/share, fee-free
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
        self._log("TP_HIT", side=pos.side.value, price=1.0, shares=pos.shares, pnl=round(pnl, 2), note=(
            f"TP {config.TP_PRICE} -> redeemed {pos.shares:.0f}sh at $1.00/share, fee-free. PnL ${pnl:.2f}."
        ))
        self.s.position = None

    def finalize_window(self, winning_side: Optional[Side]):
        """Called at window roll before reset_for_window(). Settles any open
        position by the inferred winner, and runs the LIMIT skip monitor
        (would-have-win resets the skip counter, otherwise decrements)."""
        if self.cap.halted:
            return
        if self.s.window is None:
            return

        # LIMIT skip monitor for skipped windows
        if self.spec.kind == "LIMIT" and self.skip_remaining > 0:
            if (self.s.would_fill_side is not None and winning_side is not None
                    and self.s.would_fill_side == winning_side):
                self.skip_remaining = self.spec.skip_windows
                self.skip_resets += 1
                self._log("SKIP_RESET", side=self.s.would_fill_side.value, note=(
                    f"skipped window WOULD have won ({self.s.would_fill_side.value} fills @ "
                    f"{self.spec.entry_price:.2f} and wins) -- skip reset back to {self.spec.skip_windows}"
                ))
                self._record_equity()
            else:
                self.skip_remaining = max(0, self.skip_remaining - 1)
                self._log("SKIP_COUNTDOWN", side=self.s.would_fill_side.value if self.s.would_fill_side else None,
                          note=(f"skipped window would NOT have won (fill={self.s.would_fill_side}, "
                                f"winner={winning_side}) -- skip now {self.skip_remaining}/{self.spec.skip_windows}"))
            return

        # Settlement of an open position at window close
        if self.s.position is not None:
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
                    f"window won by {winning_side.value} -- {pos.shares:.0f}sh redeemed at $1.00. PnL ${pnl:.2f}."
                ))
            else:
                pnl = -pos.cost
                self.total_losses += 1
                self.last_window_pnl = pnl
                self.total_pnl += pnl
                self._log("RESOLUTION_LOSS", side=pos.side.value, price=0.0, shares=pos.shares,
                          pnl=round(pnl, 2), note=(
                    f"window won by {winning_side.value if winning_side else 'unknown'} -- "
                    f"{pos.side.value} position expires worthless. PnL ${pnl:.2f}."
                ))
            self.s.position = None
            self._record_equity()

        if (self.s.position is None and not self.s.done_for_window
                and self.spec.kind == "LIMIT" and self.skip_remaining == 0):
            self.no_trade_windows += 1

    # ---- helpers -----------------------------------------------------------

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
        """Volume-weighted average price to actually trade `shares` against
        a real order book instead of assuming the whole size fills at the
        single best quote. levels None -> fallback price; empty -> None;
        else walk best-price-first, pricing any shortfall at the worst
        level seen."""
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

    def _record_equity(self):
        self.equity_curve.append({
            "window": self.s.window.slug if self.s.window else "",
            "ts": time.time(),
            "balance": round(self.cap.balance, 2),
        })
        if len(self.equity_curve) > 500:
            self.equity_curve = self.equity_curve[-500:]

    # ---- dashboard payload ---------------------------------------------------

    def snapshot(self) -> dict:
        position = None
        if self.s.position is not None:
            pos = self.s.position
            mark = self._mid_for(pos.side) or pos.entry_price
            position = {
                "side": pos.side.value,
                "shares": pos.shares,
                "entry_price": round(pos.entry_price, 4),
                "entry_fee": round(pos.entry_fee, 4),
                "cost": round(pos.cost, 4),
                "mark": round(mark, 4),
                "unrealized_pnl": round(pos.shares * mark - pos.cost, 2),
                "tp_hit": pos.tp_hit,
            }

        if self.cap.halted:
            status = "halted"
        elif self.skip_remaining > 0:
            status = "skipping"
        elif self.s.position is not None:
            status = "in_position"
        elif self.spec.kind == "LIMIT" and not self.s.orders_placed:
            status = "placing_orders"
        elif self.spec.kind == "TAKER" and not self.s.trigger_fired:
            status = "waiting_trigger"
        else:
            status = "done"

        return {
            "engine_id": self.spec.engine_id,
            "kind": self.spec.kind,
            "entry_price": self.spec.entry_price,
            "sl_price": self.spec.sl_price,
            "skip_windows": self.spec.skip_windows,
            "base_shares": self.spec.base_shares,
            "balance": round(self.cap.balance, 2),
            "starting_capital": self.spec.starting_capital,
            "halted": self.cap.halted,
            "equity_curve": self.equity_curve,
            "position": position,
            "unrealized_pnl": position["unrealized_pnl"] if position else 0.0,
            "status": status,
            "filled_side": self.s.filled_side.value if self.s.filled_side else None,
            "would_fill_side": self.s.would_fill_side.value if self.s.would_fill_side else None,
            "skip_remaining": self.skip_remaining,
            "skip_resets": self.skip_resets,
            "total_entries": self.total_entries,
            "total_tp_hits": self.total_tp_hits,
            "total_sl_hits": self.total_sl_hits,
            "total_wins": self.total_wins,
            "total_losses": self.total_losses,
            "no_trade_windows": self.no_trade_windows,
            "last_window_pnl": round(self.last_window_pnl, 2),
            "total_pnl": round(self.total_pnl, 2),
            "win_rate": round(100 * self.total_wins / (self.total_wins + self.total_losses), 1)
            if (self.total_wins + self.total_losses) else None,
        }


# ---------------------------------------------------------------------------
# Manager: drives all nine engines off one shared book tick.
# ---------------------------------------------------------------------------

class EngineManager:
    def __init__(self, broker: PaperBroker):
        self.engines: List[Engine] = [Engine(spec, broker) for spec in config.ENGINE_SPECS]

    def reset_for_window(self, window: WindowMarket):
        for eng in self.engines:
            eng.reset_for_window(window)

    def on_tick(self, up_bid, up_ask, down_bid, down_ask, seconds_to_close=None, now=None,
                up_bid_levels=None, up_ask_levels=None,
                down_bid_levels=None, down_ask_levels=None):
        for eng in self.engines:
            eng.on_tick(up_bid, up_ask, down_bid, down_ask, seconds_to_close, now,
                        up_bid_levels, up_ask_levels, down_bid_levels, down_ask_levels)

    def finalize_window(self, winning_side: Optional[Side]):
        for eng in self.engines:
            eng.finalize_window(winning_side)

    def snapshot(self) -> list:
        return [eng.snapshot() for eng in self.engines]
