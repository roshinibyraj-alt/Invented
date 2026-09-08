"""
Main trading loop for the 4-engine pooled bot.

Every POLL_INTERVAL_SECONDS:
  1. Make sure we have the current 5-min window's market data for BTC & ETH
     (rolling to the next window at each boundary; any engine position
     still open when its window ends moves to "awaiting resolution").
  2. Fetch live order books for all tokens currently in play.
  3. Each of the 4 engines fires EXACTLY ONE entry per window,
     unconditionally, at $ENTRY_DOLLARS notional -- no price threshold,
     entry happens as soon as the window's market is discovered (as close
     to window-open, i.e. closest to a $0.50 coin-flip price, as the poll
     cadence allows).
  4. Every open position is watched for the same TAKE_PROFIT_PRICE /
     STOP_LOSS_PRICE (default 0.70 / 0.30). If neither hits before the
     window closes, the position is held and resolved via "time decay" --
     Polymarket's own official resolution (Gamma), falling back to the
     CLOB's last-traded price if Gamma hasn't confirmed in time.
  5. Once ALL FOUR engines' positions for a given window are finalized
     (via TP, SL, or resolution), that window's "cohort" is redistributed:
     each engine is made whole on its own principal, and its actual P&L
     (profit or loss) is split three ways across the OTHER three engines.
     This happens once per window, whenever all four legs finish -- which
     may span into a later window given resolution can lag.
"""
import asyncio
import logging
import time
from typing import Dict, List, Optional

from . import config, fees, fills, storage
from .clobbook import ClobClient, OrderBook
from .engine import EnginePosition, PoolLedger, WindowCohort
from .gamma import GammaClient, MarketWindow, current_window_start


class PoolBot:
    def __init__(self):
        self.log = logging.getLogger("strategy")
        self.gamma = GammaClient(log=self.log)
        self.clob = ClobClient()

        engine_labels = [e.label for e in config.ENGINES]
        self.ledger = PoolLedger(engine_labels, config.STARTING_CAPITAL_PER_ENGINE, log=self.log)
        self.ledger.balances = storage.load_balances(engine_labels, config.STARTING_CAPITAL_PER_ENGINE)

        self.windows: Dict[str, MarketWindow] = {}          # asset -> current MarketWindow
        self.current_window_start: Optional[int] = None
        self.last_books: Dict[str, OrderBook] = {}
        self.cohorts: Dict[int, WindowCohort] = {}          # window_start -> WindowCohort
        self.open_positions: Dict[str, EnginePosition] = {}  # engine_label -> its one open position
        self.awaiting_resolution: List[EnginePosition] = []
        self.awaiting_since: Dict[int, float] = {}
        self._warned_stale_ids: set = set()

        self.tick_count = 0
        self.status_note = "starting"

    # ---------------------------------------------------------------- windows
    async def _ensure_windows(self):
        ws = current_window_start(config.WINDOW_SECONDS)
        for asset in config.ASSETS:
            win = self.windows.get(asset)
            if win is None or win.window_start != ws:
                new_win = await self.gamma.get_window(asset, ws, config.WINDOW_SECONDS, config.WINDOW_LABEL)
                if new_win is None:
                    self.log.warning("could not load %s window for %s (will retry)", asset, ws)
                    continue
                if win is not None:
                    self._roll_window(asset, win)
                self.windows[asset] = new_win
        self.current_window_start = ws

    def _roll_window(self, asset: str, old_win: MarketWindow):
        for label, pos in list(self.open_positions.items()):
            if pos.window_start == old_win.window_start and pos.asset == asset:
                self.open_positions.pop(label, None)
                self.awaiting_resolution.append(pos)
                self.awaiting_since[pos.id] = time.time()
                self.log.info("window %s rolled; moving %s position to awaiting_resolution (time decay)",
                              old_win.slug, label)

    def _get_cohort(self, window_start: int) -> WindowCohort:
        c = self.cohorts.get(window_start)
        if c is None:
            c = WindowCohort(window_start=window_start)
            self.cohorts[window_start] = c
        return c

    # ------------------------------------------------------------------ books
    async def _fetch_all_books(self) -> Dict[str, OrderBook]:
        token_ids = set()
        for win in self.windows.values():
            for tok in win.tokens.values():
                token_ids.add(tok.token_id)
        for pos in self.awaiting_resolution:
            token_ids.add(pos.token_id)
        for pos in self.open_positions.values():
            token_ids.add(pos.token_id)

        results = await asyncio.gather(
            *[self.clob.get_book(t) for t in token_ids], return_exceptions=True
        )
        books = {}
        for tok, res in zip(token_ids, results):
            if isinstance(res, Exception):
                self.log.warning("book fetch failed for %s: %s", tok, res)
                continue
            books[tok] = res
        self.last_books.update(books)
        return books

    def _fee_rate_for_asset(self, asset: str) -> float:
        win = self.windows.get(asset)
        return win.taker_fee_rate if win else config.FALLBACK_TAKER_FEE_RATE

    # -------------------------------------------------------------- one tick
    async def tick(self):
        self.tick_count += 1
        await self._ensure_windows()
        if len(self.windows) < len(config.ASSETS):
            self.status_note = "waiting for market discovery"
            return

        books = await self._fetch_all_books()

        # --- 1. entries: each engine fires exactly once per window, flat $ENTRY_DOLLARS ---
        for eng in config.ENGINES:
            if eng.label in self.open_positions:
                continue  # already holding a position right now
            win = self.windows.get(eng.asset)
            if win is None:
                continue
            tok = win.tokens.get(eng.outcome)
            if tok is None:
                continue
            cohort = self._get_cohort(win.window_start)
            if eng.label in cohort.positions:
                continue  # already fired this window (may be closed, awaiting redistribution)

            book = books.get(tok.token_id)
            if book is None or not book.asks:
                continue  # no ask liquidity yet -- retry next tick
            fr = fills.simulate_buy_dollars(book.asks, config.ENTRY_DOLLARS)
            if fr.filled_shares <= 0:
                self.log.warning("%s: 0 fill on entry attempt (book too thin) -- retrying next tick", eng.label)
                continue
            if not fr.fully_filled:
                self.log.warning("%s: entry partially filled -- spent $%.2f of $%.2f requested",
                                 eng.label, fr.notional, config.ENTRY_DOLLARS)
            fee = fees.fee_for_lots(fr.lots, self._fee_rate_for_asset(eng.asset))
            pos = self.ledger.open_position(
                eng.label, win.window_start, eng.asset, eng.outcome, tok.token_id,
                fr.filled_shares, fr.avg_price, fr.notional, fee,
            )
            self.open_positions[eng.label] = pos
            cohort.positions[eng.label] = pos
            storage.save_balances(self.ledger.balances)

        # --- 2. TP / SL monitoring for every open position ---
        for label, pos in list(self.open_positions.items()):
            book = books.get(pos.token_id)
            if book is None or book.best_bid is None:
                continue
            bid = book.best_bid
            if bid >= config.TAKE_PROFIT_PRICE:
                self._close_market(pos, "CLOSED_TP", book)
            elif bid <= config.STOP_LOSS_PRICE:
                self._close_market(pos, "CLOSED_SL", book)

        # --- 3. redistribute any window cohort that's now fully finalized ---
        self._try_redistribute_cohorts()

        self.status_note = "running"

    def _close_market(self, pos: EnginePosition, status: str, book: OrderBook):
        fr = fills.simulate_sell(book.bids, pos.shares)
        if fr.filled_shares <= 0:
            self.log.warning("%s: %s triggered but got 0 fill on sell -- retrying next tick",
                             pos.engine_label, status)
            return
        fee = fees.fee_for_lots(fr.lots, self._fee_rate_for_asset(pos.asset))
        self.ledger.close_position_market(pos, status, fr.avg_price, fr.notional, fee)
        self.open_positions.pop(pos.engine_label, None)
        storage.record_position(pos)

    def _try_redistribute_cohorts(self):
        for ws, cohort in list(self.cohorts.items()):
            if cohort.redistributed:
                continue
            record = self.ledger.redistribute_cohort(cohort)
            if record:
                storage.save_balances(self.ledger.balances)
                storage.record_cohort(record)

        # prune old, fully-redistributed cohorts so memory doesn't grow forever
        if len(self.cohorts) > 100:
            for ws in sorted(self.cohorts.keys())[:-100]:
                if self.cohorts[ws].redistributed:
                    del self.cohorts[ws]

    # --------------------------------------------------------- resolver task
    async def resolver_loop(self):
        while True:
            await asyncio.sleep(config.RESOLUTION_POLL_SECONDS)
            if not self.awaiting_resolution:
                continue
            still_waiting = []
            for pos in self.awaiting_resolution:
                resolved = await self._try_resolve(pos)
                if resolved:
                    self.awaiting_since.pop(pos.id, None)
                    self._warned_stale_ids.discard(pos.id)
                else:
                    still_waiting.append(pos)
                    elapsed = time.time() - self.awaiting_since.get(pos.id, time.time())
                    if elapsed > config.RESOLUTION_POLL_TIMEOUT_SECONDS and pos.id not in self._warned_stale_ids:
                        self._warned_stale_ids.add(pos.id)
                        self.log.warning(
                            "position %s (%s, window %s) has been awaiting resolution for %.0fs",
                            pos.id, pos.engine_label, pos.window_start, elapsed,
                        )
            self.awaiting_resolution = still_waiting
            self._try_redistribute_cohorts()

    async def _official_outcome(self, asset: str, window_start: int) -> Optional[str]:
        """Polymarket's own official resolution via Gamma -- see the
        cross-market-bot project's notes on why this is preferred over
        any CLOB-derived signal."""
        win = await self.gamma.get_window(asset, window_start, config.WINDOW_SECONDS, config.WINDOW_LABEL)
        if win is None:
            self.log.debug("gamma: no event data yet for %s window %s", asset, window_start)
            return None
        if not win.closed:
            self.log.debug("gamma: %s window %s not closed yet", asset, window_start)
            return None
        if not win.outcome_prices:
            self.log.debug("gamma: %s window %s closed but outcomePrices missing", asset, window_start)
            return None
        names = list(win.tokens.keys())
        try:
            prices = [float(p) for p in win.outcome_prices]
        except (TypeError, ValueError) as e:
            self.log.warning("gamma: %s window %s outcomePrices malformed: %r (%s)",
                             asset, window_start, win.outcome_prices, e)
            return None
        if len(prices) != len(names):
            return None
        idx_max = max(range(len(prices)), key=lambda i: prices[i])
        if prices[idx_max] < config.GAMMA_RESOLUTION_CONFIDENCE:
            self.log.debug("gamma: %s window %s closed but not confident yet: %s", asset, window_start, prices)
            return None
        return names[idx_max]

    async def _clob_fallback_outcome(self, token_id: str) -> Optional[bool]:
        """Liveness safety net, used only after GAMMA_RESOLUTION_TIMEOUT_SECONDS.
        Uses the CLOB's actual last-traded price -- never bid/ask/midpoint."""
        try:
            price = await self.clob.get_last_trade_price(token_id)
        except Exception as e:
            self.log.debug("clob fallback: last-trade-price fetch failed for %s: %s", token_id, e)
            return None
        if price is None:
            return None
        if price >= config.CLOB_FALLBACK_PRICE_THRESHOLD:
            return True
        if price <= (1.0 - config.CLOB_FALLBACK_PRICE_THRESHOLD):
            return False
        return None

    async def _try_resolve(self, pos: EnginePosition) -> bool:
        window_end = pos.window_start + config.WINDOW_SECONDS
        if time.time() < window_end:
            return False
        elapsed_since_close = time.time() - window_end

        won = None
        source = None
        try:
            winning_outcome = await self._official_outcome(pos.asset, pos.window_start)
        except Exception as e:
            self.log.warning("resolve: gamma fetch failed for %s window %s: %s",
                             pos.asset, pos.window_start, e)
            winning_outcome = None

        if winning_outcome is not None:
            won = (pos.outcome == winning_outcome)
            source = "gamma_official"
        elif elapsed_since_close > config.GAMMA_RESOLUTION_TIMEOUT_SECONDS:
            fallback = await self._clob_fallback_outcome(pos.token_id)
            if fallback is not None:
                won = fallback
                source = "clob_fallback (last_trade_price)"
                self.log.warning(
                    "%s has had no Gamma confirmation for %.0fs -- resolved via CLOB fallback instead",
                    pos.engine_label, elapsed_since_close,
                )

        if won is None:
            return False

        self.log.info("%s resolved via %s -> won=%s", pos.engine_label, source, won)
        self.ledger.resolve_position(pos, won)
        storage.record_position(pos)
        return True

    # ----------------------------------------------------------------- loop
    async def run_forever(self):
        asyncio.create_task(self.resolver_loop())
        while True:
            try:
                await self.tick()
            except Exception:
                self.log.exception("tick failed")
                self.status_note = "error (see logs)"
            await asyncio.sleep(config.POLL_INTERVAL_SECONDS)

    async def close(self):
        await self.gamma.close()
        await self.clob.close()

    # ----------------------------------------------------------- status view
    def _market_snapshot(self) -> dict:
        now = time.time()
        out = {}
        for asset, win in self.windows.items():
            outcomes = {}
            for name, tok in win.tokens.items():
                b = self.last_books.get(tok.token_id)
                best_bid = b.best_bid if b else None
                best_ask = b.best_ask if b else None
                mid = round((best_bid + best_ask) / 2, 4) if (best_bid is not None and best_ask is not None) else None
                outcomes[name] = {"best_bid": best_bid, "best_ask": best_ask, "mid": mid}
            out[asset] = {
                "slug": win.slug,
                "window_start": win.window_start,
                "window_end": win.window_end,
                "seconds_left": max(0, round(win.window_end - now)),
                "outcomes": outcomes,
            }
        return out

    def _engine_snapshot(self) -> dict:
        out = {}
        for eng in config.ENGINES:
            pos = self.open_positions.get(eng.label)
            book = self.last_books.get(pos.token_id) if pos else None
            live_price = book.best_bid if book else None

            state = "ARMED (about to fire)"
            unrealized = None
            settled_raw_pnl = None

            if pos is not None:
                state = "HOLDING"
                if live_price is not None:
                    unrealized = pos.shares * live_price - pos.entry_cost - pos.entry_fee
            else:
                # look for a closed-but-not-yet-redistributed position for this engine
                for ws in sorted(self.cohorts.keys(), reverse=True):
                    cohort = self.cohorts[ws]
                    if cohort.redistributed:
                        continue
                    p = cohort.positions.get(eng.label)
                    if p is not None and p.raw_pnl is not None:
                        state = f"SETTLED ({p.status}) -- awaiting pool redistribution"
                        settled_raw_pnl = p.raw_pnl
                        break
                    elif p is not None:
                        state = "AWAITING RESOLUTION (time decay)"
                        break

            out[eng.label] = {
                "asset": eng.asset,
                "outcome": eng.outcome,
                "balance": round(self.ledger.balances.get(eng.label, 0.0), 2),
                "state": state,
                "entry_price": pos.avg_entry_price if pos else None,
                "live_price": live_price,
                "unrealized_pnl": round(unrealized, 4) if unrealized is not None else None,
                "settled_raw_pnl": round(settled_raw_pnl, 4) if settled_raw_pnl is not None else None,
                "take_profit": config.TAKE_PROFIT_PRICE,
                "stop_loss": config.STOP_LOSS_PRICE,
            }
        return out

    def status(self) -> dict:
        recent_positions = sorted(self.ledger.history, key=lambda p: p.closed_at or 0, reverse=True)[:25]
        recent_trades = [{
            "id": p.id, "engine_label": p.engine_label, "asset": p.asset, "outcome": p.outcome,
            "status": p.status, "window_start": p.window_start,
            "raw_pnl": round(p.raw_pnl, 4) if p.raw_pnl is not None else None,
            "closed_at": p.closed_at,
        } for p in recent_positions]

        recent_cohorts = sorted(self.ledger.cohort_history, key=lambda c: c.window_start, reverse=True)[:15]
        cohorts_out = [{
            "window_start": c.window_start,
            "completed_at": c.completed_at,
            "per_engine_raw_pnl": {k: round(v, 4) for k, v in c.per_engine_raw_pnl.items()},
            "per_engine_balance_delta": {k: round(v, 4) for k, v in c.per_engine_balance_delta.items()},
        } for c in recent_cohorts]

        pending_cohorts = [{
            "window_start": ws,
            "engines_settled": [lbl for lbl, p in c.positions.items() if p.raw_pnl is not None],
            "engines_fired": list(c.positions.keys()),
        } for ws, c in sorted(self.cohorts.items()) if not c.redistributed]

        return {
            "status": self.status_note,
            "tick": self.tick_count,
            "server_time": time.time(),
            "total_capital": round(self.ledger.total_capital(), 2),
            "starting_total_capital": round(self.ledger.starting_capital * len(config.ENGINES), 2),
            "balances": {k: round(v, 2) for k, v in self.ledger.balances.items()},
            "windows": {a: {"slug": w.slug, "window_end": w.window_end} for a, w in self.windows.items()},
            "markets": self._market_snapshot(),
            "engines": self._engine_snapshot(),
            "pending_cohorts": pending_cohorts,
            "recent_cohorts": cohorts_out,
            "recent_trades": recent_trades,
            "config": {
                "entry_dollars": config.ENTRY_DOLLARS,
                "take_profit_price": config.TAKE_PROFIT_PRICE,
                "stop_loss_price": config.STOP_LOSS_PRICE,
                "starting_capital_per_engine": config.STARTING_CAPITAL_PER_ENGINE,
            },
        }
