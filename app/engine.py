"""
ALPHASTRIKE trading engine -- one entry per window. Direction is decided by
the multi-timeframe prediction engine (app/mtf_engine.py), and the bot
trades WITH that signal (buys the side it predicts), always as a taker.

See app/config.py for the full strategy write-up. Summary: at each window
open, snapshot 1D/4H/1H/15m indicators, match them against the situations
that were right in the last 7 days, and get UP or DOWN plus the reasons.
ENTRY_DELAY_SECONDS (2s) after the window opens, buy that side at market
(taker, depth-walked, with fee) as long as its best ask is below
ENTRY_MAX_PRICE (0.60) -- otherwise keep checking every tick until the
window closes. No SL. TP 0.99, real taker exit. One entry/trade max per
window. Every resolved window is added to the engine's history (whether
or not a trade happened) so the situations stay current.
"""
import time
from dataclasses import dataclass, field
from typing import Optional

from . import config
from .models import Side, WindowMarket
from .mtf_engine import MTFPredictor, Prediction, prepare_frames, window_tokens
from .paper_broker import PaperBroker


def _realistic_fill_price(levels: Optional[list], shares: float, fallback_price: Optional[float]) -> Optional[float]:
    """Volume-weighted average price to actually trade `shares` against a
    real order book, instead of assuming the whole size fills at the
    single best quote. Used for every fill: the taker entry, the TP exit
    and the forced window-end close.

    - levels is None -> no depth data this tick; fall back to filling
      the whole size at `fallback_price`.
    - levels is [] -> book fetched fine, genuinely nothing resting on
      this side; return None, caller must not invent a fill.
    - levels is non-empty -> walk best-price-first; any shortfall in
      visible depth is priced at the worst level seen.
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
    signal_side: Optional[Side] = None
    entry_type: str = "taker"


@dataclass
class EngineState:
    """Per-window transient state -- fully replaced by reset_for_window()
    at the start of every window. Cumulative stats live on the Engine
    itself, below, so they survive across windows instead of getting
    wiped every 5 minutes."""
    window: Optional[WindowMarket] = None
    up_bid: Optional[float] = None
    up_ask: Optional[float] = None
    down_bid: Optional[float] = None
    down_ask: Optional[float] = None
    up_bid_levels: Optional[list] = None
    up_ask_levels: Optional[list] = None
    down_bid_levels: Optional[list] = None
    down_ask_levels: Optional[list] = None

    position: Optional[Position] = None
    decision_made: bool = False     # True once the signal has been decided (a side, or no-trade)
    prepared: Optional[dict] = None       # per-timeframe candles + indicator series for THIS window (from state.py)
    price_now: Optional[float] = None     # BTC price at window open (open of the 5m candle)
    tokens: Optional[frozenset] = None    # market snapshot at window open, kept for the history append at close
    prediction: Optional[Prediction] = None   # the engine's call + the reasons behind it
    predicted_side: Optional[Side] = None     # the side traded
    confidence: Optional[float] = None
    skip_reason: Optional[str] = None      # "no_data" | "no_match" when the window was decided as no-trade
    entry_pending: bool = False     # signal decided, entry not made yet (waiting for +2s or for ask < cap)
    entry_wait_logged: bool = False # so the "ask still >= cap" note is logged once, not every tick

    last_window_pnl: float = 0.0


class Engine:
    """Multi-timeframe-signal engine, driven off a single shared capital
    pool. Constructed as Engine(broker, predictor) -- app/state.py owns
    the MTFPredictor and feeds each window's candle data in via
    set_frames()."""

    name = "MTF"

    def __init__(self, broker: PaperBroker, predictor: MTFPredictor):
        self.broker = broker
        self.predictor = predictor
        self.capital = CapitalPool(balance=config.STARTING_CAPITAL)
        self.s = EngineState()
        self.capital.record_equity_point(None)

        # ---- cumulative stats, survive across windows ----------------------
        self.total_entries = 0
        self.total_tp_fills = 0
        self.total_forced_closes = 0
        self.total_entry_skips = 0           # signal fired but the ask never got below the cap
        self.total_no_signal_windows = 0     # market data unavailable / incomplete
        self.total_no_match_windows = 0      # data fine, but the engine had nothing at all (no history) -- rare
        self.tier_counts = {"validated": 0, "candidate": 0, "baseline": 0}   # signals fired, by evidence tier
        self.total_illiquid_skips = 0
        self.total_pnl = 0.0
        self.wins = 0
        self.losses = 0

    def _record_trade_result(self, pnl: float):
        if pnl >= 0:
            self.wins += 1
        else:
            self.losses += 1

    def _log(self, event, **kw):
        self.broker.log_event(self.name, self.s.window.slug if self.s.window else "", event,
                               balance_after=self.capital.balance, **kw)

    def reset_for_window(self, window: WindowMarket):
        self.s = EngineState(window=window)
        if self.capital.halted:
            self._log("HALTED", note=f"engine halted (balance ${self.capital.balance:.2f} < $0) -- no trading")
            return
        st = self.predictor.status()
        self._log("WINDOW_OPEN", note=(
            f"ALPHASTRIKE: multi-timeframe engine (1D/4H/1H/15m), {st['n_rules']} noise-validated + "
            f"{st['n_candidates']} weak-pattern situations from {st['history_windows']} backtested windows. Trades WITH the signal: taker buy of the predicted side "
            f"{config.ENTRY_DELAY_SECONDS:g}s after window open, {config.ORDER_SHARES:.0f}sh, while ask < "
            f"{config.ENTRY_MAX_PRICE} (checked every tick until close). No SL, TP {config.TP_PRICE}"
        ))

    # ---- market data hand-off (called by state.py) ---------------------------------

    def needs_frames(self) -> bool:
        return (self.s.window is not None and not self.capital.halted
                and not self.s.decision_made and self.s.prepared is None)

    def set_frames(self, frames: dict, price_now: Optional[float]):
        """frames: raw candles per timeframe from marketdata.fetch_live_frames()."""
        prepared = prepare_frames(frames)
        if prepared is None or price_now is None:
            return False
        self.s.prepared, self.s.price_now = prepared, price_now
        return True

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

        if self.s.position is not None:
            self._check_exit(now)
            return

        if not self.s.decision_made:
            self._check_signal(now)
            if not self.s.entry_pending:
                return       # no data yet, or no trade this window
            # signal just armed -- fall through so a late signal (data arrived after +2s) buys THIS tick

        if self.s.entry_pending:
            self._check_entry(now)

    # ---- price/level lookups ----------------------------------------------

    def _ask_for(self, side: Side) -> Optional[float]:
        return self.s.up_ask if side == Side.UP else self.s.down_ask

    def _bid_for(self, side: Side) -> Optional[float]:
        return self.s.up_bid if side == Side.UP else self.s.down_bid

    def _bid_levels_for(self, side: Side) -> Optional[list]:
        return self.s.up_bid_levels if side == Side.UP else self.s.down_bid_levels

    def _ask_levels_for(self, side: Side) -> Optional[list]:
        return self.s.up_ask_levels if side == Side.UP else self.s.down_ask_levels

    # ---- signal: multi-timeframe prediction ---------------------------------------

    def _check_signal(self, now: float):
        if self.s.prepared is None:
            return   # candle data not in yet -- state.py keeps retrying the fetch every few seconds
        window = self.s.window
        self.s.decision_made = True

        res = window_tokens(self.s.prepared, window.open_ts, self.s.price_now)
        if res is None:
            self.total_no_signal_windows += 1
            self.s.skip_reason = "no_data"
            self._log("NO_TRADE", note=(
                "market snapshot unavailable -- a timeframe is missing candles / indicators not converged "
                "(data gap, not a strategy choice)"))
            return
        tokens, readings = res
        self.s.tokens = tokens
        self._log("SNAPSHOT", price=self.s.price_now, note=self._snapshot_text(readings))

        pred = self.predictor.predict(tokens, readings)
        if pred is None:
            self.total_no_match_windows += 1
            self.s.skip_reason = "no_match"
            self._log("NO_TRADE", note=(
                ("no noise-validated situation matches this snapshot (strict mode, MTF_ALLOW_FALLBACK=0) -- skipping"
                 if not config.MTF_ALLOW_FALLBACK else
                 "engine has no usable history/models yet (pre-backtest not finished or failed) -- skipping")))
            return

        self.s.prediction = pred
        self.s.predicted_side = pred.side
        self.s.confidence = pred.confidence
        self.tier_counts[pred.tier] = self.tier_counts.get(pred.tier, 0) + 1
        self._log("MTF_SIGNAL", side=pred.side.value, price=self.s.price_now,
                   note=self.predictor.explain(pred))

        # Trade WITH the signal. The buy itself fires from _check_entry() once
        # ENTRY_DELAY_SECONDS have passed since the window opened.
        self.s.entry_pending = True
        self._log("SIGNAL_ARMED", side=pred.side.value,
                   note=(f"{pred.side.value} ({pred.confidence:.0%}) -> taker buy {config.ORDER_SHARES:.0f}sh at "
                         f"window open +{config.ENTRY_DELAY_SECONDS:g}s if ask < {config.ENTRY_MAX_PRICE}"))

    @staticmethod
    def _snapshot_text(readings: dict) -> str:
        parts = []
        for tf, r in readings.items():
            parts.append(f"{tf}: RSI {r['rsi']} {r['macd_state']} trend {r['trend']} ADX {r['adx']}")
        return " | ".join(parts)

    # ---- entry: taker buy of the predicted side ------------------------------------

    def _check_entry(self, now: float):
        """Runs every tick once the signal is armed. From window open +
        ENTRY_DELAY_SECONDS it buys at market (taker) the first tick the
        predicted side's best ask is strictly below ENTRY_MAX_PRICE. The
        gate is the best ask; the fill itself is priced by walking real ask
        depth for the full size, and pays the taker fee."""
        side = self.s.predicted_side
        if side is None or self.s.position is not None:
            return
        if now < self.s.window.open_ts + config.ENTRY_DELAY_SECONDS:
            return
        ask = self._ask_for(side)
        if ask is None or ask >= config.ENTRY_MAX_PRICE:
            if not self.s.entry_wait_logged:
                self.s.entry_wait_logged = True
                self._log("ENTRY_WAIT", side=side.value, price=ask,
                           note=(f"{side.value} ask {ask} is not below {config.ENTRY_MAX_PRICE} -- "
                                 f"checking every tick until window close"))
            return
        levels = self._ask_levels_for(side)
        fill_price = _realistic_fill_price(levels, config.ORDER_SHARES, ask)
        if fill_price is None:
            # Book fetched fine but nothing resting on the ask side -- can't buy, keep trying.
            self.total_illiquid_skips += 1
            self._log("NO_LIQUIDITY", side=side.value, price=ask,
                       note=f"entry triggered @ ask {ask} but zero ask depth -- retrying next tick")
            return
        shares = config.ORDER_SHARES
        fee = self.broker.taker_fee_amount(shares, fill_price)
        cost = shares * fill_price + fee
        self.capital.balance -= cost
        self.total_entries += 1
        self.s.entry_pending = False
        self._log("TAKER_ENTRY", side=side.value, price=fill_price, shares=shares, fee=fee,
                   note=(f"taker buy filled @ {fill_price:.4f} (best ask {ask} < {config.ENTRY_MAX_PRICE}), "
                         f"{shares:.0f}sh, fee ${fee:.4f}, total cost ${cost:.4f}, "
                         f"{now - self.s.window.open_ts:.1f}s after window open"))
        if self.capital.check_halt():
            self._log("HALTED", note=f"balance ${self.capital.balance:.2f} < $0 -- bankrupt")
            return
        self.s.position = Position(side=side, entry_price=fill_price, shares=shares, cost=cost,
                                    entry_ts=now, signal_side=side, entry_type="taker")

    # ---- exit: TP only, no SL ------------------------------------------------

    def _check_exit(self, now: float):
        pos = self.s.position
        bid = self._bid_for(pos.side)
        if bid is None or bid < config.TP_PRICE:
            return
        levels = self._bid_levels_for(pos.side)
        fill_price = _realistic_fill_price(levels, pos.shares, bid)
        if fill_price is None:
            self.total_illiquid_skips += 1
            self._log("NO_LIQUIDITY", side=pos.side.value, price=bid, note=f"TP triggered @ {bid} but zero bid depth -- waiting")
            return
        fee = self.broker.taker_fee_amount(pos.shares, fill_price)
        proceeds = pos.shares * fill_price - fee
        pnl = proceeds - pos.cost
        self.capital.balance += proceeds
        self.total_pnl += pnl
        self.s.last_window_pnl += pnl
        self._record_trade_result(pnl)
        self.total_tp_fills += 1
        self._log("TP_FILL", side=pos.side.value, price=pos.entry_price, shares=pos.shares, pnl=pnl, fee=fee,
                   note=(f"TP hit, real fill @ {fill_price:.4f} (triggered @ {bid}) "
                         f"(entry {pos.entry_price}, fee ${fee:.4f}, pnl ${pnl:.4f})"))
        self.capital.check_halt()
        self.s.position = None

    # ---- window close -------------------------------------------------------

    def finalize_window(self, winning_side: Optional[Side]):
        if self.s.window is None:
            return
        window_slug = self.s.window.slug

        # Add this window (snapshot + true outcome) to the engine's history --
        # whether or not a trade was placed -- so the situations stay current
        # (they are re-mined periodically by state.py).
        if self.s.tokens is not None and winning_side is not None:
            actual_up = (winning_side == Side.UP)
            self.predictor.add_record(self.s.window.open_ts, self.s.tokens, actual_up)
            self.predictor.record_result(self.s.predicted_side, actual_up,
                                         self.s.prediction.tier if self.s.prediction else None)
            verdict = ""
            if self.s.predicted_side is not None:
                verdict = f"; signal {self.s.predicted_side.value} was {'RIGHT' if (self.s.predicted_side == winning_side) else 'WRONG'}"
            self._log("MTF_LEARN", note=(
                f"window resolved {winning_side.value}{verdict} -- added to history "
                f"({len(self.predictor.records)} windows)"))

        if not self.capital.halted:
            if self.s.position is not None:
                pos = self.s.position
                bid = self._bid_for(pos.side)
                levels = self._bid_levels_for(pos.side)
                fill_price = _realistic_fill_price(levels, pos.shares, bid)
                if fill_price is None:
                    fill_price = 0.0
                    self._log("NO_LIQUIDITY", side=pos.side.value, price=bid,
                               note="window closed with zero bid depth -- assuming worst case $0")
                fee = self.broker.taker_fee_amount(pos.shares, fill_price)
                proceeds = pos.shares * fill_price - fee
                pnl = proceeds - pos.cost
                self.capital.balance += proceeds
                self.total_pnl += pnl
                self.s.last_window_pnl += pnl
                self.total_forced_closes += 1
                self._record_trade_result(pnl)
                self._log("FORCED_CLOSE", side=pos.side.value, price=pos.entry_price, shares=pos.shares,
                           pnl=pnl, fee=fee,
                           note=(f"window closed, forced taker close @ {fill_price:.4f} "
                                 f"(entry {pos.entry_price}, fee ${fee:.4f}, pnl ${pnl:.4f})"))
                self.capital.check_halt()
                self.s.position = None
            elif self.s.entry_pending:
                self.total_entry_skips += 1
                self._log("ENTRY_SKIPPED", side=self.s.predicted_side.value if self.s.predicted_side else "",
                           note=(f"window closed and the ask never got below {config.ENTRY_MAX_PRICE} "
                                 f"(or had no depth) -- no trade this window"))
            elif not self.s.decision_made:
                self.total_no_signal_windows += 1
                self._log("NO_TRADE", note="candle data never arrived for this window")

        self.s.window = None
        self.capital.record_equity_point(window_slug)

    # ---- dashboard payload -------------------------------------------------

    def snapshot(self) -> dict:
        pos = self.s.position
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
                "seconds_since_entry": round(time.time() - pos.entry_ts, 1),
                "signal_side": pos.signal_side.value if pos.signal_side else None,
                "entry_type": pos.entry_type,
            }

        entry_payload = None
        if self.s.entry_pending and self.s.predicted_side is not None and self.s.window is not None:
            entry_payload = {
                "side": self.s.predicted_side.value, "shares": config.ORDER_SHARES,
                "seconds_until_entry": round(max(0.0, self.s.window.open_ts + config.ENTRY_DELAY_SECONDS - time.time()), 1),
                "ask": self._ask_for(self.s.predicted_side),
            }

        if self.capital.halted:
            status = "halted"
        elif pos is not None:
            status = "open"
        elif self.s.entry_pending:
            status = "entry_pending"
        elif self.s.decision_made:
            status = "done"
        else:
            status = "awaiting_signal"

        win_rate = round(100 * self.wins / (self.wins + self.losses), 1) if (self.wins + self.losses) else None

        return {
            "engine": "MTF", "label": "ALPHASTRIKE",

            "balance": round(self.capital.balance, 2),
            "starting_capital": config.STARTING_CAPITAL,
            "halted": self.capital.halted,
            "equity_curve": self.capital.equity_curve,
            "equity": round(self.capital.balance + open_market_value, 4),

            "realized_pnl": round(self.total_pnl, 4),
            "unrealized_pnl": round(unrealized, 4),
            "open_market_value": round(open_market_value, 4),
            "last_window_pnl": round(self.s.last_window_pnl, 4),

            "position": pos_payload,
            "entry": entry_payload,
            "decision_made": self.s.decision_made,
            "skip_reason": self.s.skip_reason,
            "predicted_side": self.s.predicted_side.value if self.s.predicted_side else None,
            "confidence": round(self.s.confidence, 3) if self.s.confidence is not None else None,
            "prediction": None if self.s.prediction is None else {
                "side": self.s.prediction.side.value,
                "p_up": round(self.s.prediction.p_up, 3),
                "confidence": round(self.s.prediction.confidence, 3),
                "tier": self.s.prediction.tier,
                "n_matched": self.s.prediction.n_matched,
                "n_for": self.s.prediction.n_for,
                "n_against": self.s.prediction.n_against,
                "reasons": self.s.prediction.reasons,
                "readings": self.s.prediction.readings,
            },
            "predictor": self.predictor.status(),

            "total_entries": self.total_entries,
            "total_tp_fills": self.total_tp_fills,
            "total_forced_closes": self.total_forced_closes,
            "total_entry_skips": self.total_entry_skips,
            "total_no_signal_windows": self.total_no_signal_windows,
            "total_no_match_windows": self.total_no_match_windows,
            "tier_counts": self.tier_counts,
            "total_illiquid_skips": self.total_illiquid_skips,

            "wins": self.wins,
            "losses": self.losses,
            "win_rate": win_rate,

            "status": status,

            "def": {
                "shares": config.ORDER_SHARES,
                "entry_delay_s": config.ENTRY_DELAY_SECONDS,
                "entry_max_price": config.ENTRY_MAX_PRICE,
                "tp_price": config.TP_PRICE,
            },
        }
