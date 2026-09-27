"""Offline checks for book requests crossing a five-minute window boundary."""
import sys
import unittest
from collections import deque
from types import ModuleType, SimpleNamespace
from unittest.mock import AsyncMock, patch

from app.engine import Engine
from app.models import Side, WindowMarket
from app.paper_broker import PaperBroker

try:
    from app.state import BotState
except ModuleNotFoundError as exc:
    if exc.name != "httpx":
        raise
    # The workspace's Python runtime lacks httpx. No HTTP client is created
    # here; these tests supply a fully mocked market client.
    with patch.dict(sys.modules, {"httpx": ModuleType("httpx")}):
        from app.state import BotState


class StateTimingTest(unittest.IsolatedAsyncioTestCase):
    def make_state(self):
        state = object.__new__(BotState)
        state.broker = PaperBroker()
        state.engine = Engine(state.broker)
        window = WindowMarket(
            "btc-updown-5m-crossing", None, "up-token", "down-token", 1000, 1300,
        )
        state.current_window = window
        state.engine.reset_for_window(window)
        state.client = SimpleNamespace(
            get_active_window=AsyncMock(return_value=window),
            get_book=AsyncMock(side_effect=[(0.30, 0.49), (0.60, 0.70)]),
        )
        state.price_history = deque(maxlen=300)
        state.last_up_bid, state.last_up_ask = 0.25, 0.75
        state.last_down_bid, state.last_down_ask = 0.25, 0.85
        state.error = None
        return state

    async def test_post_close_quotes_do_not_fire_or_replace_settlement_quotes(self):
        state = self.make_state()
        with patch("app.state.time.time", side_effect=[1299.9, 1300.1]):
            await state._tick()
        self.assertEqual(state.engine.s.fills, 0)
        self.assertIsNone(state.engine.s.position)
        self.assertEqual((state.last_up_ask, state.last_down_ask), (0.75, 0.85))
        self.assertEqual(len(state.price_history), 0)
        self.assertEqual(state.client.get_book.await_count, 2)

    async def test_quotes_completed_before_close_can_fire(self):
        state = self.make_state()
        with patch("app.state.time.time", side_effect=[1298.0, 1299.0, 1299.0]):
            await state._tick()
        self.assertEqual(state.engine.s.fills, 1)
        self.assertEqual(state.engine.s.position.side, Side.UP)
        self.assertEqual(state.engine.s.position.entry_price, 0.49)
        self.assertEqual(state.price_history[-1].ts, 1299.0)

    async def test_equal_midpoints_leave_skipped_signal_unscored(self):
        state = self.make_state()
        state.last_up_bid, state.last_up_ask = 0.40, 0.60
        state.last_down_bid, state.last_down_ask = 0.40, 0.60
        self.assertIsNone(state._infer_winner())
        state.engine.finalize_window(state._infer_winner())
        self.assertEqual(state.engine.s.price_skipped_windows, 1)
        self.assertEqual((state.engine.s.wins, state.engine.s.losses), (0, 0))
        self.assertEqual(state.engine.s.budget_usd, 100)


if __name__ == "__main__":
    unittest.main()