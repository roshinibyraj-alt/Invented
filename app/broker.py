"""Paper/live broker facade.

Live mode delegates signing and order submission to trader_worker.js, which
uses the uploaded Polymarket trader implementation pattern. The private key
is passed only through the process environment.
"""
import asyncio
import json
import math
import os
import time
from pathlib import Path
from typing import Optional

from . import config


class Broker:
    def __init__(self):
        self.live = config.TRADING_MODE == "live"
        self.balance: Optional[float] = None if self.live else config.STARTING_CAPITAL
        self.balance_updated_at: Optional[float] = None
        self._balance_error: Optional[str] = None
        self.events: list[dict] = []
        self._process: Optional[asyncio.subprocess.Process] = None
        self._request_id = 0
        self._lock = asyncio.Lock()

    async def start(self):
        if not self.live:
            return
        if not config.PRIVATE_KEY:
            raise RuntimeError(
                "TRADING_MODE=live requires the PRIVATE_KEY secret"
            )
        root = Path(__file__).resolve().parent.parent
        env = os.environ.copy()
        env["PRIVATE_KEY"] = config.PRIVATE_KEY
        self._process = await asyncio.create_subprocess_exec(
            "node",
            "trader_worker.js",
            cwd=str(root),
            env=env,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        ready = await asyncio.wait_for(self._process.stdout.readline(), timeout=30)
        if not ready:
            error = await self._process.stderr.read()
            raise RuntimeError(f"Trader worker exited during authentication: {error.decode()[-1000:]}")
        payload = json.loads(ready.decode())
        if payload.get("event") != "ready":
            raise RuntimeError(f"Trader worker failed authentication: {payload}")
        await self.refresh_balance()

    async def close(self):
        if not self._process:
            return
        try:
            await self.request("shutdown", {})
        except Exception:
            pass
        if self._process.returncode is None:
            self._process.terminate()
            try:
                await asyncio.wait_for(self._process.wait(), timeout=5)
            except asyncio.TimeoutError:
                self._process.kill()
        self._process = None

    def log_event(self, event: str, note: str = "", **fields):
        safe_note = str(note)
        if config.PRIVATE_KEY:
            safe_note = safe_note.replace(config.PRIVATE_KEY, "[redacted]")
            raw_key = config.PRIVATE_KEY.removeprefix("0x")
            if raw_key:
                safe_note = safe_note.replace(raw_key, "[redacted]")
        item = {
            "ts": __import__("time").time(),
            "event": event,
            "note": safe_note,
            **fields,
        }
        self.events.append(item)
        if len(self.events) > config.LOG_MAX_ENTRIES:
            self.events.pop(0)
        # Railway users may have no dashboard; keep trade attempts and
        # rejections visible in the service's standard output as well.
        print(json.dumps({
            "event": event,
            "window": fields.get("window"),
            "side": fields.get("side"),
            "trade_usd": fields.get("trade_usd"),
            "note": safe_note,
        }), flush=True)

    def taker_fee_amount(self, shares: float, price: float) -> float:
        # This is only used for paper-mode estimates. Live fills report the
        # actual average price and wallet balance through the trader worker.
        return shares * price * 0.07 * (price * (1 - price))

    async def request(self, command: str, args: dict):
        if not self._process or not self._process.stdin or not self._process.stdout:
            raise RuntimeError("Trader worker is not running")
        async with self._lock:
            self._request_id += 1
            request_id = self._request_id
            self._process.stdin.write(
                (json.dumps({"id": request_id, "command": command, "args": args}) + "\n").encode()
            )
            await self._process.stdin.drain()
            while True:
                line = await asyncio.wait_for(self._process.stdout.readline(), timeout=30)
                if not line:
                    raise RuntimeError("Trader worker closed its output")
                response = json.loads(line.decode())
                if response.get("id") == request_id:
                    if not response.get("ok"):
                        raise RuntimeError(response.get("error", "Trader worker request failed"))
                    return response.get("result")

    async def get_balance(self) -> float:
        if not self.live:
            return self.balance
        result = await self.request("balance", {})
        balance = float(result)
        if not math.isfinite(balance) or balance < 0:
            raise ValueError("Exchange returned an invalid USDC balance")
        self.balance = balance
        self.balance_updated_at = time.time()
        self._balance_error = None
        return self.balance

    async def refresh_balance(self) -> Optional[float]:
        try:
            return await self.get_balance()
        except Exception as exc:
            self.balance = None
            self.balance_updated_at = None
            error = str(exc)
            if error != self._balance_error:
                self.log_event("LIVE_BALANCE_UNAVAILABLE", note=error)
            self._balance_error = error
            return None

    async def get_book(self, token_id: str):
        if not self.live:
            return None, None
        result = await self.request("book", {"tokenId": token_id})
        return result.get("bestBid"), result.get("bestAsk")

    async def verify_buy(self, token_id: str, open_ts: float, order_id: Optional[str] = None):
        return await self.request("verify_buy", {
            "tokenId": token_id, "openTs": open_ts, "orderId": order_id,
        })

    async def buy(self, token_id: str, budget_usd: float, reference_ask: float) -> dict:
        if self.live:
            return await self.request(
                "buy",
                {
                    "tokenId": token_id,
                    "budgetUsd": budget_usd,
                    "referenceAsk": reference_ask,
                    "slippage": config.SLIPPAGE_CEILING,
                },
            )
        price = max(float(reference_ask), 0.01)
        shares = round(budget_usd / price, 4)
        fee = self.taker_fee_amount(shares, price)
        return {
            "filled": True,
            "shares": shares,
            "avgPrice": price,
            "cost": shares * price + fee,
            "fee": fee,
            "orderId": "paper",
        }
