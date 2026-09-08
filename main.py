import asyncio
import logging

import uvicorn

from app import config, server
from app.strategy import PoolBot

# Color-code each engine's log lines (cyan/magenta/green/yellow) so the
# 4 interleaved streams stay visually distinguishable in the console or
# Railway's log viewer. Every line still carries a timestamp and logger
# name regardless of whether the terminal renders ANSI color.
_ANSI = {
    "cyan": "\033[96m", "magenta": "\033[95m", "green": "\033[92m",
    "yellow": "\033[93m", "reset": "\033[0m",
}
_ENGINE_COLOR_BY_LABEL = {e.label: e.color for e in config.ENGINES}


class ColorFormatter(logging.Formatter):
    def format(self, record):
        base = super().format(record)
        msg = record.getMessage()
        for label, color in _ENGINE_COLOR_BY_LABEL.items():
            if label in msg:
                return f"{_ANSI.get(color, '')}{base}{_ANSI['reset']}"
        return base


def setup_logging():
    handler = logging.StreamHandler()
    handler.setFormatter(ColorFormatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.handlers = [handler]


log = logging.getLogger("main")


async def main():
    setup_logging()
    bot = PoolBot()
    server.bot = bot

    config_uv = uvicorn.Config(server.app, host="0.0.0.0", port=config.PORT, log_level="info")
    uv_server = uvicorn.Server(config_uv)

    log.info(
        "Starting 4-engine pooled bot in PAPER mode: $%.0f/engine, $%.0f total, "
        "$%.0f entry/window, TP=%.2f SL=%.2f",
        config.STARTING_CAPITAL_PER_ENGINE, config.STARTING_CAPITAL_PER_ENGINE * len(config.ENGINES),
        config.ENTRY_DOLLARS, config.TAKE_PROFIT_PRICE, config.STOP_LOSS_PRICE,
    )
    try:
        await asyncio.gather(
            bot.run_forever(),
            uv_server.serve(),
        )
    finally:
        await bot.close()


if __name__ == "__main__":
    asyncio.run(main())
