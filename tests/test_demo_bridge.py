"""Offline checks for previous-candle signals and separate live execution."""
import asyncio
import time
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from unittest.mock import AsyncMock, patch

from app.broker import Broker
from app.engine import Engine
from app.live_bridge import LiveBridge
from app.live_order_guard import LiveOrderGuard
from app.models import Side, WindowMarket
from app.paper_broker import PaperBroker


class FakeLiveBroker:
    def __init__(self, buy_result):
        self.buy_result = buy_result
        self.buys = []
        self.buy_deadlines = []
        self.sells = []
        self.events = []
        self.verifications = []
        self.balance = 12.34
        self.balance_updated_at = time.time()
        self.balance_refreshes = 0

    async def start(self):
        pass

    async def close(self):
        pass

    async def refresh_balance(self):
        self.balance_refreshes += 1
        self.balance_updated_at = time.time()
        return self.balance

    async def buy(self, token_id, budget_usd, reference_ask, close_ts=None):
        self.buys.append((token_id, budget_usd, reference_ask))
        self.buy_deadlines.append(close_ts)
        return self.buy_result

    async def sell(self, token_id, shares, reference_bid):
        raise AssertionError("real sells must never be sent")

    async def verify_buy(self, token_id, open_ts, order_id=None):
        self.verifications.append((token_id, open_ts, order_id))
        return {"matchingTrades": 1}

    def log_event(self, event, note="", **fields):
        self.events.append((event, note, fields))


class DemoBridgeTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.guard_path = f"{self.temp.name}/attempts.sqlite"

    def setup_engine(self, buy_result):
        broker = PaperBroker()
        engine = Engine(broker)
        mirror = LiveBridge()
        mirror.enabled = True
        mirror._guard = LiveOrderGuard(self.guard_path)
        fake = FakeLiveBroker(buy_result)
        mirror.broker = fake
        window = WindowMarket(
            "btc-updown-5m-test", None, "up-token", "down-token",
            time.time() - 5, time.time() + 300,
        )
        broker.on_event = lambda entry: mirror.on_demo_event(
            entry, window,
        )
        engine.seed_history(
            [{"color": "red", "open": 1, "close": 0}] * 9
            + [{"color": "green", "open": 0, "close": 1}]
        )
        engine.record_candle({"color": "green", "open": 0, "close": 1})
        engine.reset_for_window(window)
        return engine, mirror, fake

    async def test_previous_candle_selects_side_and_doji_is_void(self):
        for color, expected_side in (
            ("red", Side.DOWN),
            ("green", Side.UP),
            ("doji", None),
        ):
            with self.subTest(color=color):
                engine = Engine(PaperBroker())
                window = WindowMarket(
                    f"btc-updown-5m-{color}", None, "up", "down",
                    time.time() - 5, time.time() + 300,
                )
                engine.record_candle({
                    "color": color,
                    "open": 100,
                    "close": 100 if color == "doji" else (
                        99 if color == "red" else 101
                    ),
                })
                engine.reset_for_window(window)
                self.assertEqual(engine.s.entry_side_this_window, expected_side)
                engine.on_tick(0.3, 0.4, 0.3, 0.4)
                if expected_side is None:
                    self.assertIsNone(engine.s.position)
                    self.assertEqual(engine.s.fills, 0)
                    self.assertIn(
                        "PREVIOUS_CANDLE_VOID",
                        [event.event for event in engine.broker.log],
                    )
                else:
                    self.assertEqual(engine.s.position.side, expected_side)
                    self.assertEqual(engine.s.fills, 1)

    async def test_demo_entry_waits_three_seconds_after_window_open(self):
        engine = Engine(PaperBroker())
        open_ts = time.time()
        window = WindowMarket(
            "btc-updown-5m-entry-delay", None, "up", "down",
            open_ts, open_ts + 300,
        )
        engine.record_candle({"color": "green"})
        engine.reset_for_window(window)
        engine.on_tick(0.3, 0.4, 0.6, 0.7, now=open_ts + 2.99)
        self.assertEqual(engine.s.fills, 0)
        self.assertIsNone(engine.s.position)
        engine.on_tick(0.3, 0.4, 0.6, 0.7, now=open_ts + 3.0)
        self.assertEqual(engine.s.fills, 1)
        self.assertEqual(engine.s.position.side, Side.UP)

    async def test_red_signal_mirrors_down_token(self):
        engine, mirror, _ = self.setup_engine({"filled": False, "status": "rejected"})
        engine.record_candle({"color": "red"})
        engine.reset_for_window(engine.s.window)
        engine.on_tick(0.30, 0.40, 0.30, 0.49)
        intent = mirror._queue.get_nowait()
        self.assertEqual((intent.token_id, intent.budget_usd), ("down-token", 1))

    async def test_price_filter_waits_and_only_checks_signaled_ask(self):
        engine, mirror, _ = self.setup_engine({})
        open_ts = engine.s.window.open_ts
        engine.on_tick(0.49, 0.50, 0.10, 0.20, now=open_ts + 3)
        self.assertEqual(engine.s.fills, 0)
        self.assertTrue(mirror._queue.empty())
        engine.on_tick(0.50, 0.51, 0.10, 0.20, now=open_ts + 10)
        self.assertEqual(engine.s.fills, 0)
        engine.on_tick(0.48, 0.49, 0.10, 0.20, now=open_ts + 20)
        self.assertEqual(engine.s.fills, 1)
        self.assertEqual(engine.s.position.side, Side.UP)
        self.assertEqual(engine.s.position.entry_price, 0.49)
        intent = mirror._queue.get_nowait()
        self.assertEqual((intent.token_id, intent.reference_price), ("up-token", 0.49))
        engine.on_tick(0.20, 0.30, 0.10, 0.20, now=open_ts + 21)
        self.assertEqual(engine.s.fills, 1)
        self.assertTrue(mirror._queue.empty())

    async def test_price_skip_loss_moves_both_ladders_without_a_trade(self):
        engine, mirror, fake = self.setup_engine({})
        starting_balance = engine.capital.balance
        engine.on_tick(0.55, 0.60, 0.30, 0.35)
        engine.finalize_window(Side.DOWN)
        self.assertEqual(engine.s.price_skipped_windows, 1)
        self.assertEqual((engine.s.skipped_signal_wins, engine.s.skipped_signal_losses), (0, 1))
        self.assertEqual((engine.s.wins, engine.s.losses), (0, 1))
        self.assertEqual((engine.s.current_shares, mirror.budget_usd), (600, 2))
        self.assertEqual((engine.capital.balance, engine.s.total_pnl), (starting_balance, 0))
        self.assertEqual(engine.s.fills, 0)
        self.assertIsNone(engine.s.position)
        self.assertTrue(mirror._queue.empty())
        self.assertEqual(fake.buys, [])
        self.assertIn("PRICE_FILTER_SKIPPED_LOSS", [event.event for event in engine.broker.log])
        engine.finalize_window(Side.DOWN)
        self.assertEqual(engine.s.price_skipped_windows, 1)

    async def test_price_skip_win_moves_both_ladders_without_a_trade(self):
        engine, mirror, _ = self.setup_engine({})
        engine.s.current_shares = 600
        mirror.budget_usd = 2
        starting_balance = engine.capital.balance
        engine.on_tick(0.60, 0.70, 0.30, 0.35)
        engine.finalize_window(Side.UP)
        self.assertEqual(engine.s.price_skipped_windows, 1)
        self.assertEqual((engine.s.skipped_signal_wins, engine.s.skipped_signal_losses), (1, 0))
        self.assertEqual((engine.s.wins, engine.s.losses), (1, 0))
        self.assertEqual((engine.s.current_shares, mirror.budget_usd), (500, 1))
        self.assertEqual((engine.capital.balance, engine.s.total_pnl), (starting_balance, 0))
        self.assertEqual(engine.s.fills, 0)
        self.assertTrue(mirror._queue.empty())

    async def test_price_skip_with_unknown_winner_has_no_size_change(self):
        engine, mirror, _ = self.setup_engine({})
        engine.on_tick(0.55, 0.60, 0.30, 0.35)
        engine.finalize_window(None)
        self.assertEqual(engine.s.price_skipped_windows, 1)
        self.assertEqual((engine.s.wins, engine.s.losses), (0, 0))
        self.assertEqual((engine.s.current_shares, mirror.budget_usd), (500, 1))
        self.assertIn("PRICE_FILTER_SKIPPED_UNKNOWN", [event.event for event in engine.broker.log])
        self.assertTrue(mirror._queue.empty())

    async def test_open_position_with_unknown_winner_is_not_a_win(self):
        engine, mirror, _ = self.setup_engine({})
        initial_balance = engine.capital.balance
        engine.on_tick(0.30, 0.40, 0.60, 0.70)
        mirror._queue.get_nowait()
        engine.finalize_window(None)
        self.assertEqual((engine.s.wins, engine.s.losses), (0, 0))
        self.assertEqual((engine.s.current_shares, mirror.budget_usd), (500, 1))
        self.assertEqual((engine.capital.balance, engine.s.total_pnl), (initial_balance, 0))
        self.assertIn("SETTLE_UNKNOWN", [event.event for event in engine.broker.log])

    async def test_price_below_limit_after_close_cannot_enter(self):
        engine, mirror, _ = self.setup_engine({})
        close_ts = engine.s.window.close_ts
        engine.on_tick(0.30, 0.49, 0.30, 0.49, now=close_ts)
        self.assertEqual(engine.s.fills, 0)
        self.assertTrue(mirror._queue.empty())
        engine.finalize_window(Side.DOWN)
        self.assertEqual(engine.s.price_skipped_windows, 1)

    async def test_doji_void_does_not_queue_a_real_buy(self):
        engine, mirror, fake = self.setup_engine({})
        engine.record_candle({"color": "doji"})
        engine.reset_for_window(engine.s.window)
        engine.on_tick(0.30, 0.40, 0.60, 0.70)
        self.assertEqual(engine.s.fills, 0)
        self.assertTrue(mirror._queue.empty())
        self.assertEqual(fake.buys, [])
        engine.finalize_window(Side.UP)
        self.assertEqual(engine.s.price_skipped_windows, 0)
        self.assertEqual((engine.s.wins, engine.s.losses, mirror.budget_usd), (0, 0, 1))

    async def test_real_buy_expired_before_reservation_is_not_sent(self):
        engine, mirror, fake = self.setup_engine({})
        engine.on_tick(0.30, 0.40, 0.60, 0.70)
        intent = mirror._queue.get_nowait()
        await mirror._buy(replace(intent, close_ts=time.time() - 1))
        self.assertEqual(fake.buys, [])
        self.assertIn("LIVE_ORDER_EXPIRED", [event[0] for event in fake.events])

    async def test_real_buy_expired_during_reservation_is_not_sent(self):
        engine, mirror, fake = self.setup_engine({})
        engine.on_tick(0.30, 0.40, 0.60, 0.70)
        intent = mirror._queue.get_nowait()

        class SlowGuard:
            def __init__(self):
                self.records = []

            def reserve(self, *args):
                return True

            def record(self, slug, status, order_id=None):
                self.records.append((slug, status))

        guard = SlowGuard()
        mirror._guard = guard
        with patch("app.live_bridge.time.time", side_effect=[
            intent.close_ts - 0.1, intent.close_ts + 0.1,
        ]):
            await mirror._buy(intent)
        self.assertEqual(fake.buys, [])
        self.assertEqual(guard.records, [(intent.slug, "expired")])
        self.assertIn("LIVE_ORDER_EXPIRED", [event[0] for event in fake.events])

    async def test_startup_does_not_count_backfilled_candle_twice(self):
        engine = Engine(PaperBroker())
        candles = [
            {"color": color, "close_time_ms": index * 300000 + 299999}
            for index, color in enumerate(
                ["green"] + ["red"] * 4 + ["green"] * 4 + ["red"]
            )
        ]
        engine.seed_history(candles)
        engine.record_candle(candles[-1])
        window = WindowMarket(
            "btc-updown-5m-first", None, "up", "down",
            time.time() - 5, time.time() + 300,
        )
        engine.reset_for_window(window)
        engine.on_tick(0.3, 0.4, 0.3, 0.49)
        self.assertEqual(engine.s.entry_side_this_window, Side.DOWN)
        self.assertEqual(engine.s.fills, 1)
        self.assertEqual(len(engine.candle_history), 10)
        self.assertEqual(len(engine.candle_records), 10)

    async def test_strategy_continues_after_over_500_demo_profit(self):
        engine = Engine(PaperBroker())
        engine.seed_history([{"color": "red"}] * 10)
        for index in range(3):
            window = WindowMarket(
                f"btc-updown-5m-profit-{index}", None, "up", "down",
                time.time() - 5, time.time() + 300,
            )
            engine.record_candle({"color": "green"})
            engine.reset_for_window(window)
            engine.on_tick(0.1, 0.2, 0.7, 0.8)
            self.assertEqual(engine.s.fills, index + 1)
            engine.on_tick(0.99, 0.995, 0.01, 0.02)
            engine.finalize_window(None)
        self.assertGreater(engine.s.total_pnl, 500)
        self.assertEqual(engine.s.tp_fills, 3)

    async def test_rejected_real_order_does_not_change_demo_or_ladder(self):
        engine, mirror, fake = self.setup_engine(
            {"filled": False, "status": "minimum size"}
        )
        engine.on_tick(0.30, 0.40, 0.60, 0.70)
        intent = mirror._queue.get_nowait()
        self.assertEqual((intent.token_id, intent.budget_usd), ("up-token", 1))
        self.assertEqual(engine.s.position.shares, 500)
        demo_balance = engine.capital.balance

        await mirror._buy(intent)
        self.assertEqual(fake.buys, [("up-token", 1, 0.40)])
        self.assertEqual(fake.buy_deadlines, [intent.close_ts])
        self.assertEqual(engine.capital.balance, demo_balance)
        self.assertEqual(engine.s.position.shares, 500)
        self.assertEqual(mirror.budget_usd, 1)

        engine.finalize_window(Side.DOWN)
        self.assertEqual(mirror.budget_usd, 2)
        self.assertEqual(engine.s.settled_losses, 1)

    async def test_demo_take_profit_never_sends_real_sell(self):
        engine, mirror, fake = self.setup_engine({
            "filled": True, "shares": 5.2, "status": "matched",
        })
        engine.on_tick(0.30, 0.40, 0.60, 0.70)
        await mirror._buy(mirror._queue.get_nowait())
        engine.on_tick(0.99, 0.995, 0.01, 0.02)
        self.assertIsNone(engine.s.position)
        self.assertEqual(engine.s.tp_fills, 1)
        self.assertEqual(mirror.budget_usd, 1)
        self.assertTrue(mirror._queue.empty())
        self.assertEqual(fake.sells, [])
        self.assertEqual(engine.s.tp_fills, 1)

    async def test_real_balance_is_separate_and_refreshes_after_buy(self):
        engine, mirror, fake = self.setup_engine({
            "filled": True, "shares": 2, "status": "matched",
        })
        demo_balance = engine.capital.balance
        self.assertEqual(mirror.snapshot()["balance_usdc"], 12.34)
        engine.on_tick(0.30, 0.40, 0.60, 0.70)
        demo_after_buy = engine.capital.balance
        self.assertLess(demo_after_buy, demo_balance)
        mirror._queue.put_nowait(None)
        await mirror._run()
        self.assertEqual(fake.balance_refreshes, 1)
        self.assertEqual(engine.capital.balance, demo_after_buy)
        self.assertEqual(mirror.snapshot()["balance_usdc"], 12.34)
        self.assertIsNotNone(mirror.snapshot()["balance_updated_at"])

    async def test_balance_failure_never_displays_demo_or_stale_balance(self):
        broker = Broker()
        broker.live = True
        broker.request = AsyncMock(return_value=14.25)
        self.assertEqual(await broker.refresh_balance(), 14.25)
        self.assertIsNotNone(broker.balance_updated_at)
        broker.request = AsyncMock(side_effect=TimeoutError("exchange unavailable"))
        self.assertIsNone(await broker.refresh_balance())
        self.assertIsNone(broker.balance)
        self.assertIsNone(broker.balance_updated_at)
        self.assertIn("LIVE_BALANCE_UNAVAILABLE", [x["event"] for x in broker.events])
        broker.request = AsyncMock(return_value=0)
        self.assertEqual(await broker.refresh_balance(), 0)
        self.assertIsNone(broker._balance_error)

    async def test_live_buy_passes_window_deadline_to_worker(self):
        broker = Broker()
        broker.live = True
        broker.request = AsyncMock(return_value={"filled": False})
        await broker.buy("up-token", 2, 0.49, close_ts=1234)
        command, args = broker.request.await_args.args
        self.assertEqual(command, "buy")
        self.assertEqual((args["tokenId"], args["budgetUsd"], args["referenceAsk"], args["closeTs"]), (
            "up-token", 2, 0.49, 1234,
        ))

    async def test_balance_refreshes_while_no_trade_signal(self):
        _, mirror, fake = self.setup_engine({})
        with patch("app.live_bridge.BALANCE_REFRESH_SECONDS", 0.01):
            task = asyncio.create_task(mirror._run())
            await asyncio.sleep(0.04)
            mirror._queue.put_nowait(None)
            await task
        self.assertGreaterEqual(fake.balance_refreshes, 1)
        self.assertEqual(fake.buys, [])

    async def test_ladder_steps_from_one_to_eight_and_back_on_demo_results(self):
        engine, mirror, _ = self.setup_engine({"filled": False, "status": "rejected"})
        engine.on_tick(0.30, 0.40, 0.60, 0.70)
        entry = engine.s.position
        for expected in range(2, 9):
            engine.s.position = entry
            engine.finalize_window(Side.DOWN)
            self.assertEqual(mirror.budget_usd, expected)
            self.assertEqual(engine.s.current_shares, min(1200, 500 + 100 * (expected - 1)))
        for _ in range(20):
            engine.s.position = entry
            engine.finalize_window(Side.DOWN)
        self.assertEqual(mirror.budget_usd, 8)
        self.assertEqual(engine.s.current_shares, 1200)
        engine.s.position = entry
        engine.finalize_window(Side.UP)
        self.assertEqual(mirror.budget_usd, 7)
        self.assertEqual(engine.s.current_shares, 1100)
        for _ in range(20):
            engine.s.position = entry
            engine.finalize_window(Side.UP)
        self.assertEqual(mirror.budget_usd, 1)
        self.assertEqual(engine.s.current_shares, 500)

    async def test_next_window_uses_demo_size_and_real_budget(self):
        engine, bridge, _ = self.setup_engine({"filled": False, "status": "rejected"})
        engine.on_tick(0.30, 0.40, 0.60, 0.70)
        bridge._queue.get_nowait()
        engine.finalize_window(Side.DOWN)
        self.assertEqual(engine.s.current_shares, 600)
        self.assertEqual(bridge.budget_usd, 2)
        next_window = WindowMarket(
            "btc-updown-5m-next", None, "up-next", "down-next",
            time.time() - 5, time.time() + 300,
        )
        engine.record_candle({"color": "green", "open": 0, "close": 1})
        engine.reset_for_window(next_window)
        engine.on_tick(0.30, 0.40, 0.60, 0.70)
        self.assertEqual(engine.s.position.shares, 600)
        next_intent = bridge._queue.get_nowait()
        self.assertEqual((next_intent.slug, next_intent.budget_usd), (
            next_window.slug, 2,
        ))

    async def test_missing_candle_is_void_and_does_not_reuse_old_signal(self):
        engine, mirror, fake = self.setup_engine({"filled": False, "status": "rejected"})
        engine.on_tick(0.30, 0.40, 0.60, 0.70)
        await mirror._buy(mirror._queue.get_nowait())
        engine.finalize_window(Side.DOWN)
        next_window = WindowMarket(
            "btc-updown-5m-next", None, "up-next", "down-next",
            time.time() - 5, time.time() + 300,
        )
        engine.record_candle(None)
        engine.reset_for_window(next_window)
        engine.on_tick(0.30, 0.40, 0.60, 0.70)
        self.assertIsNone(engine.s.entry_side_this_window)
        self.assertEqual(len(fake.buys), 1)
        self.assertTrue(mirror._queue.empty())

    async def test_restart_and_second_instance_never_resubmit_same_window(self):
        engine, first, fake = self.setup_engine(
            {"filled": True, "shares": 5.2, "status": "matched", "orderId": "abc"}
        )
        engine.on_tick(0.30, 0.40, 0.60, 0.70)
        intent = first._queue.get_nowait()
        await first._buy(intent)
        second = LiveBridge()
        second._guard = LiveOrderGuard(self.guard_path)
        second.broker = fake
        await second._buy(intent)
        self.assertEqual(len(fake.buys), 1)
        self.assertEqual(fake.verifications, [("up-token", intent.open_ts, "abc")])
        self.assertIn("LIVE_BUY_DUPLICATE_BLOCKED", [event[0] for event in fake.events])

    async def test_uncertain_outcome_and_verification_failure_still_block_retry(self):
        engine, bridge, fake = self.setup_engine({})
        engine.on_tick(0.30, 0.40, 0.60, 0.70)
        intent = bridge._queue.get_nowait()

        async def uncertain(*args):
            fake.buys.append(args)
            raise TimeoutError("worker response lost")

        fake.buy = uncertain
        await bridge._buy(intent)
        self.assertEqual(bridge._guard.get(intent.slug)[2], "uncertain")
        self.assertTrue(bridge.snapshot()["buy_halted"])
        await bridge._buy(replace(intent, slug="next-window"))
        self.assertEqual(len(fake.buys), 1)
        self.assertIn("LIVE_BUY_SKIPPED", [event[0] for event in fake.events])

        async def verification_error(*args):
            raise TimeoutError("exchange unavailable")

        fake.verify_buy = verification_error
        restarted = LiveBridge()
        restarted._guard = LiveOrderGuard(self.guard_path)
        restarted.broker = fake
        await restarted._buy(intent)
        self.assertEqual(len(fake.buys), 1)
        self.assertIn("LIVE_BUY_VERIFICATION_ERROR", [event[0] for event in fake.events])

    async def test_guard_unavailable_blocks_buy(self):
        engine, bridge, fake = self.setup_engine({})
        engine.on_tick(0.30, 0.40, 0.60, 0.70)
        bridge._guard = None
        await bridge._buy(bridge._queue.get_nowait())
        self.assertEqual(fake.buys, [])
        self.assertIn("LIVE_GUARD_ERROR", [event[0] for event in fake.events])

    async def test_missing_persistent_path_uses_temporary_guard(self):
        bridge = LiveBridge()
        bridge.enabled = True
        bridge.broker = FakeLiveBroker({})
        with patch.dict("os.environ", {"LIVE_ORDER_GUARD_DB": ""}), \
             patch("app.live_bridge.EPHEMERAL_GUARD_DB", self.guard_path):
            await bridge.start()
        self.assertFalse(bridge._failed)
        self.assertIsNotNone(bridge._guard)
        self.assertTrue(bridge._ephemeral_guard)
        self.assertIn("LIVE_GUARD_EPHEMERAL", [event[0] for event in bridge.broker.events])
        await bridge.close()

    async def test_temporary_guard_skips_partial_window_but_allows_full_window(self):
        engine, bridge, fake = self.setup_engine({})
        bridge._ephemeral_guard = True
        bridge._started_at = time.time()
        engine.on_tick(0.30, 0.40, 0.60, 0.70)
        self.assertEqual(engine.s.position.shares, 500)
        self.assertTrue(bridge._queue.empty())
        self.assertIn("LIVE_BUY_SKIPPED", [event[0] for event in fake.events])
        engine.finalize_window(Side.DOWN)
        self.assertEqual(bridge.budget_usd, 2)

        next_engine, next_bridge, _ = self.setup_engine({})
        next_bridge._ephemeral_guard = True
        next_bridge._started_at = time.time() - 30
        next_engine.on_tick(0.30, 0.40, 0.60, 0.70)
        self.assertEqual(next_bridge._queue.get_nowait().budget_usd, 1)

    async def test_competing_instances_reserve_only_once(self):
        first = LiveOrderGuard(self.guard_path)
        second = LiveOrderGuard(self.guard_path)
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [
                pool.submit(guard.reserve, "same-window", "up-token", time.time())
                for guard in (first, second)
            ]
            self.assertEqual(sorted(f.result() for f in futures), [False, True])


if __name__ == "__main__":
    unittest.main()