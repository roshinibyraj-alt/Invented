from __future__ import annotations
import asyncio
import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from .engine import Engine

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")

engine = Engine()


@asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(engine.run_forever())
    yield
    task.cancel()
    await engine.client.close()

app = FastAPI(title="Polymarket 5m BTC Rung Bot", lifespan=lifespan)


@app.get("/api/snapshot")
async def snapshot():
    return JSONResponse(engine.snapshot())


@app.get("/healthz")
async def healthz():
    return {"ok": True}


@app.websocket("/ws")
async def ws_feed(ws: WebSocket):
    await ws.accept()
    q = engine.subscribe()
    try:
        await ws.send_json(engine.snapshot())
        while True:
            snap = await q.get()
            await ws.send_json(snap)
    except WebSocketDisconnect:
        pass
    finally:
        engine.unsubscribe(q)


static_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), "static")
app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")
