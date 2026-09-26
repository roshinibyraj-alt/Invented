"""Atomic, durable one-attempt-per-market guard for real buys."""
import sqlite3
import time
from contextlib import closing
from pathlib import Path


class LiveOrderGuard:
    def __init__(self, path: str):
        if not path or path == ":memory:":
            raise ValueError("LIVE_ORDER_GUARD_DB must name a persistent shared SQLite file")
        self.path = Path(path)
        if not self.path.is_absolute():
            raise ValueError("LIVE_ORDER_GUARD_DB must be an absolute path on persistent shared storage")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with closing(self._connect()) as db:
            with db:
                db.execute("""
                    CREATE TABLE IF NOT EXISTS live_buy_attempts (
                        slug TEXT PRIMARY KEY, token_id TEXT NOT NULL,
                        open_ts REAL NOT NULL, created_ts REAL NOT NULL,
                        status TEXT NOT NULL, order_id TEXT
                    )
                """)

    def _connect(self):
        db = sqlite3.connect(self.path, timeout=5)
        db.execute("PRAGMA synchronous=FULL")
        return db

    def reserve(self, slug: str, token_id: str, open_ts: float) -> bool:
        # SQLite's unique constraint serializes competing processes on the
        # same shared file. Never remove a reservation, even after rejection.
        with closing(self._connect()) as db:
            with db:
                cursor = db.execute(
                    """INSERT OR IGNORE INTO live_buy_attempts
                       (slug, token_id, open_ts, created_ts, status)
                       VALUES (?, ?, ?, ?, 'pending')""",
                    (slug, token_id, open_ts, time.time()),
                )
                return cursor.rowcount == 1

    def record(self, slug: str, status: str, order_id: str | None = None):
        with closing(self._connect()) as db:
            with db:
                db.execute(
                    "UPDATE live_buy_attempts SET status=?, order_id=? WHERE slug=?",
                    (status, order_id, slug),
                )

    def get(self, slug: str):
        with closing(self._connect()) as db:
            row = db.execute(
                "SELECT token_id, open_ts, status, order_id FROM live_buy_attempts WHERE slug=?",
                (slug,),
            ).fetchone()
        return row