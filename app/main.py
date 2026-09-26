from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Response
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .state import BotState

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"

bot_state = BotState()


@asynccontextmanager
async def lifespan(app: FastAPI):
    await bot_state.start()
    yield
    await bot_state.stop()


app = FastAPI(title="Polymarket BTC 5m Bot", lifespan=lifespan)


@app.get("/api/state")
async def get_state(response: Response):
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
    response.headers["Pragma"] = "no-cache"
    return bot_state.snapshot()


@app.get("/")
async def dashboard():
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
