"""
Lightweight SQLite persistence so the bot survives a Railway restart
without losing balances/history. Railway's filesystem is ephemeral on
redeploys unless you attach a Volume -- see README for mounting one at
/data so this actually persists.
"""
import json
import logging
import sqlite3
from pathlib import Path

from . import config

log = logging.getLogger("storage")


def _connect():
    Path(config.DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(config.DB_PATH)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS kv (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS positions (
            id INTEGER PRIMARY KEY,
            engine_label TEXT,
            window_start INTEGER,
            status TEXT,
            asset TEXT,
            outcome TEXT,
            opened_at REAL,
            closed_at REAL,
            entry_cost REAL,
            entry_fee REAL,
            exit_proceeds REAL,
            exit_fee REAL,
            raw_pnl REAL,
            raw_json TEXT
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS cohorts (
            window_start INTEGER PRIMARY KEY,
            completed_at REAL,
            raw_json TEXT
        )
        """
    )
    conn.commit()
    return conn


def save_balances(balances: dict):
    conn = _connect()
    conn.execute(
        "INSERT INTO kv(key, value) VALUES('balances', ?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (json.dumps(balances),),
    )
    conn.commit()
    conn.close()


def load_balances(engine_labels, default: float) -> dict:
    conn = _connect()
    row = conn.execute("SELECT value FROM kv WHERE key='balances'").fetchone()
    conn.close()
    if row:
        try:
            saved = json.loads(row[0])
            return {lbl: float(saved.get(lbl, default)) for lbl in engine_labels}
        except Exception:
            pass
    return {lbl: default for lbl in engine_labels}


def record_position(pos):
    conn = _connect()
    raw = {
        "id": pos.id, "engine_label": pos.engine_label, "window_start": pos.window_start,
        "status": pos.status, "asset": pos.asset, "outcome": pos.outcome, "token_id": pos.token_id,
        "opened_at": pos.opened_at, "closed_at": pos.closed_at,
        "shares": pos.shares, "avg_entry_price": pos.avg_entry_price,
        "entry_cost": pos.entry_cost, "entry_fee": pos.entry_fee,
        "exit_price": pos.exit_price, "exit_proceeds": pos.exit_proceeds, "exit_fee": pos.exit_fee,
        "raw_pnl": pos.raw_pnl, "resolution_won": pos.resolution_won,
    }
    conn.execute(
        """
        INSERT OR REPLACE INTO positions
        (id, engine_label, window_start, status, asset, outcome, opened_at, closed_at,
         entry_cost, entry_fee, exit_proceeds, exit_fee, raw_pnl, raw_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """,
        (
            pos.id, pos.engine_label, pos.window_start, pos.status, pos.asset, pos.outcome,
            pos.opened_at, pos.closed_at, pos.entry_cost, pos.entry_fee,
            pos.exit_proceeds, pos.exit_fee, pos.raw_pnl, json.dumps(raw),
        ),
    )
    conn.commit()
    conn.close()


def record_cohort(record):
    conn = _connect()
    raw = {
        "window_start": record.window_start,
        "completed_at": record.completed_at,
        "per_engine_raw_pnl": record.per_engine_raw_pnl,
        "per_engine_balance_delta": record.per_engine_balance_delta,
    }
    conn.execute(
        "INSERT OR REPLACE INTO cohorts (window_start, completed_at, raw_json) VALUES (?,?,?)",
        (record.window_start, record.completed_at, json.dumps(raw)),
    )
    conn.commit()
    conn.close()


def load_recent_cohorts(limit: int = 50):
    conn = _connect()
    rows = conn.execute(
        "SELECT raw_json FROM cohorts ORDER BY window_start DESC LIMIT ?", (limit,)
    ).fetchall()
    conn.close()
    return [json.loads(r[0]) for r in rows]
