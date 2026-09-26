"""Paper/live broker facade.

Live mode delegates signing and order submission to trader_worker.js, which
uses the uploaded Polymarket trader implementation pattern. The private key
is passed only through the process environment.
"""
import asyncio
import json
import os
from pathlib import Path
from typing import Optional

from . import config


class Broker:
    def __init__(self):
        self.live = config.TRADING_MODE == "live"
        self.balance = config.STARTING_CAPITAL
        self.events: list[dict] = []
        self._process: Optional[asyncio.subprocess.Process] = None
        self._request_id = 0
        self._lock = asyncio.Lock()

    async def start(self):
        if not self.live:
            return
        if not config.POLYMARKET_PRIVATE_KEY:
            raise RuntimeError(
                "TRADING_MODE=live requires the POLYMARKET_PRIVATE_KEY secret"
            )
        root = Path(__file__).resolve().parent.parent
        env = os.environ.copy()
        env["POLYMARKET_PRIVATE_KEY"] = config.POLYMARKET_PRIVATE_KEY
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
        self.balance = await self.get_balance()

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
        item = {
            "ts": __import__("time").time(),
            "event": event,
            "note": note,
            **fields,
        }
        self.events.append(item)
        if len(self.events) > config.LOG_MAX_ENTRIES:
            self.events.pop(0)

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
        self.balance = float(result or 0)
        return self.balance

    async def get_book(self, token_id: str):
        if not self.live:
            return None, None
        result = await self.request("book", {"tokenId": token_id})
        return result.get("bestBid"), result.get("bestAsk")

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

    async def sell(self, token_id: str, shares: float, reference_bid: float) -> dict:
        if self.live:
            return await self.request(
                "sell",
                {
                    "tokenId": token_id,
                    "shares": shares,
                    "referenceBid": reference_bid,
                    "slippage": config.SLIPPAGE_CEILING,
                },
            )
        price = max(float(reference_bid), 0.01)
        fee = self.taker_fee_amount(shares, price)
        return {
            "filled": True,
            "shares": shares,
            "avgPrice": price,
            "proceeds": shares * price - fee,
            "fee": fee,
            "orderId": "paper",
        }
