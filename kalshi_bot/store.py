"""SQLite storage shared by the bot loop and the dashboard."""

from __future__ import annotations

import sqlite3
import time
from contextlib import contextmanager

SCHEMA = """
CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL NOT NULL,
    day TEXT NOT NULL,
    mode TEXT NOT NULL,
    ticker TEXT NOT NULL,
    side TEXT NOT NULL,
    contracts INTEGER NOT NULL,      -- filled contracts
    price REAL NOT NULL,             -- dollars per contract
    fee REAL NOT NULL,
    cost REAL NOT NULL,              -- contracts*price + fee
    p_fair REAL,
    edge REAL,
    spot REAL,
    strike REAL,
    seconds_left REAL,
    order_id TEXT,
    result TEXT,                     -- 'yes' / 'no' once settled
    pnl REAL,                        -- set once settled
    settled_ts REAL
);
CREATE INDEX IF NOT EXISTS trades_open ON trades(result);
CREATE INDEX IF NOT EXISTS trades_day ON trades(day);

CREATE TABLE IF NOT EXISTS decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL NOT NULL,
    ticker TEXT,
    spot REAL,
    strike REAL,
    seconds_left REAL,
    vol REAL,
    p_fair REAL,
    yes_ask REAL,
    no_ask REAL,
    action TEXT,
    reason TEXT
);

CREATE TABLE IF NOT EXISTS state (
    key TEXT PRIMARY KEY,
    value TEXT
);
"""


class Store:
    def __init__(self, path: str):
        self.path = path
        with self.conn() as c:
            c.executescript(SCHEMA)

    @contextmanager
    def conn(self):
        c = sqlite3.connect(self.path, timeout=10)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA journal_mode=WAL")  # lets the dashboard read while the bot writes
        try:
            yield c
            c.commit()
        finally:
            c.close()

    # ---------------------------------------------------------------- state
    def get(self, key: str, default: str | None = None) -> str | None:
        with self.conn() as c:
            row = c.execute("SELECT value FROM state WHERE key=?", (key,)).fetchone()
        return row["value"] if row else default

    def set(self, key: str, value) -> None:
        with self.conn() as c:
            c.execute(
                "INSERT INTO state(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (key, str(value)),
            )

    def kill_switch_on(self) -> bool:
        return self.get("kill_switch", "off") == "on"

    # --------------------------------------------------------------- trades
    def add_trade(self, **t) -> int:
        cols = ", ".join(t)
        qs = ", ".join("?" for _ in t)
        with self.conn() as c:
            cur = c.execute(f"INSERT INTO trades({cols}) VALUES({qs})", tuple(t.values()))
            return cur.lastrowid

    def open_trades(self) -> list[sqlite3.Row]:
        with self.conn() as c:
            return c.execute("SELECT * FROM trades WHERE result IS NULL ORDER BY ts").fetchall()

    def settle_trade(self, trade_id: int, result: str, pnl: float) -> None:
        with self.conn() as c:
            c.execute(
                "UPDATE trades SET result=?, pnl=?, settled_ts=? WHERE id=?",
                (result, pnl, time.time(), trade_id),
            )

    def market_exposure(self, ticker: str) -> tuple[float, int]:
        """(dollars spent, number of orders) on one market."""
        with self.conn() as c:
            row = c.execute(
                "SELECT COALESCE(SUM(cost),0) AS cost, COUNT(*) AS n FROM trades WHERE ticker=?", (ticker,)
            ).fetchone()
        return float(row["cost"]), int(row["n"])

    def day_loss(self, day: str) -> float:
        """Realized losses today plus everything still at risk in open trades (worst case)."""
        with self.conn() as c:
            row = c.execute(
                """SELECT
                     COALESCE(SUM(CASE WHEN result IS NOT NULL THEN pnl END), 0) AS realized,
                     COALESCE(SUM(CASE WHEN result IS NULL THEN cost END), 0) AS at_risk
                   FROM trades WHERE day=?""",
                (day,),
            ).fetchone()
        return max(0.0, -float(row["realized"])) + float(row["at_risk"])

    def recent_trades(self, limit: int = 50) -> list[sqlite3.Row]:
        with self.conn() as c:
            return c.execute("SELECT * FROM trades ORDER BY ts DESC LIMIT ?", (limit,)).fetchall()

    def summary(self) -> dict:
        with self.conn() as c:
            row = c.execute(
                """SELECT COUNT(*) AS n,
                          COALESCE(SUM(pnl), 0) AS pnl,
                          COALESCE(SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END), 0) AS wins,
                          COALESCE(SUM(CASE WHEN result IS NOT NULL THEN 1 ELSE 0 END), 0) AS settled,
                          COALESCE(SUM(CASE WHEN result IS NULL THEN cost ELSE 0 END), 0) AS open_cost,
                          COALESCE(SUM(fee), 0) AS fees
                   FROM trades"""
            ).fetchone()
        return dict(row)

    def daily_pnl(self, days: int = 14) -> list[sqlite3.Row]:
        with self.conn() as c:
            return c.execute(
                """SELECT day, COALESCE(SUM(pnl),0) AS pnl, COUNT(*) AS n
                   FROM trades WHERE result IS NOT NULL GROUP BY day ORDER BY day DESC LIMIT ?""",
                (days,),
            ).fetchall()

    # ------------------------------------------------------------ decisions
    def add_decision(self, **d) -> None:
        cols = ", ".join(d)
        qs = ", ".join("?" for _ in d)
        with self.conn() as c:
            c.execute(f"INSERT INTO decisions({cols}) VALUES({qs})", tuple(d.values()))
            # keep the table small
            c.execute("DELETE FROM decisions WHERE id < (SELECT MAX(id) - 5000 FROM decisions)")

    def recent_decisions(self, limit: int = 30) -> list[sqlite3.Row]:
        with self.conn() as c:
            return c.execute("SELECT * FROM decisions ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
