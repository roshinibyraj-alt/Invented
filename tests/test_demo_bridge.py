"""Offline checks that real execution cannot change the restored demo."""
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

    async def buy(self, token_id, budget_usd, reference_ask):
        self.buys.append((token_id, budget_usd, reference_ask))
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
            time.time() - 1, time.time() + 300,
        )
        broker.on_event = lambda entry: mirror.on_demo_event(
            entry, window,
        )
        engine.record_candle({"color": "red", "open": 1, "close": 0})
        engine.reset_for_window(window)
        return engine, mirror, fake

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
        for _ in range(20):
            engine.s.position = entry
            engine.finalize_window(Side.DOWN)
        self.assertEqual(mirror.budget_usd, 8)
        engine.s.position = entry
        engine.finalize_window(Side.UP)
        self.assertEqual(mirror.budget_usd, 7)
        for _ in range(20):
            engine.s.position = entry
            engine.finalize_window(Side.UP)
        self.assertEqual(mirror.budget_usd, 1)

    async def test_missing_candle_does_not_repeat_the_previous_real_buy(self):
        engine, mirror, fake = self.setup_engine({"filled": False, "status": "rejected"})
        engine.on_tick(0.30, 0.40, 0.60, 0.70)
        await mirror._buy(mirror._queue.get_nowait())
        engine.finalize_window(Side.DOWN)
        next_window = WindowMarket(
            "btc-updown-5m-next", None, "up-next", "down-next",
            time.time() - 1, time.time() + 300,
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