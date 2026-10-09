"""End-to-end paper trading against fake Kalshi + fake price feed."""

from datetime import datetime, timezone

import pytest

from kalshi_bot.config import Settings
from kalshi_bot.engine import Engine
from kalshi_bot.store import Store

NOW = datetime(2026, 10, 9, 14, 10, tzinfo=timezone.utc).timestamp()


def iso(ts):
    return datetime.fromtimestamp(ts, timezone.utc).isoformat().replace("+00:00", "Z")


class FakeClient:
    def __init__(self):
        self.market = {
            "ticker": "KXBTC15M-26OCT091015-15",
            "open_time": iso(NOW - 600),
            "close_time": iso(NOW + 300),
            "floor_strike": 80000.0,
            "yes_ask_dollars": "0.6000",
            "no_ask_dollars": "0.4200",
            "yes_ask_size_fp": "500.00",
            "yes_bid_size_fp": "500.00",
            "result": "",
        }

    def get_markets(self, **_):
        return [self.market]

    def get_market(self, ticker):
        return self.market

    def get_balance(self):
        raise AssertionError("paper mode must not touch the account")


class FakeFeed:
    def spot(self):
        return 80400.0

    def volatility(self):
        return 0.4


@pytest.fixture
def engine(tmp_path, monkeypatch):
    monkeypatch.setenv("BOT_MODE", "paper")
    s = Settings()
    s.db_path = str(tmp_path / "t.db")
    return Engine(s, FakeClient(), FakeFeed(), Store(s.db_path), clock=lambda: NOW)


def test_paper_trade_then_settle_win(engine):
    engine.tick()
    trades = engine.store.open_trades()
    assert len(trades) == 1
    t = trades[0]
    assert t["side"] == "yes" and t["contracts"] >= 1

    engine.client.market["result"] = "yes"
    engine.settle()
    settled = engine.store.recent_trades()[0]
    assert settled["pnl"] == pytest.approx(t["contracts"] - t["cost"])


def test_settle_loss(engine):
    engine.tick()
    t = engine.store.open_trades()[0]
    engine.client.market["result"] = "no"
    engine.settle()
    assert engine.store.recent_trades()[0]["pnl"] == pytest.approx(-t["cost"])


def test_kill_switch_blocks_trading(engine):
    engine.store.set("kill_switch", "on")
    engine.tick()
    assert engine.store.open_trades() == []


def test_per_market_order_cap(engine):
    for _ in range(10):
        engine.tick()
    _, n = engine.store.market_exposure(engine.client.market["ticker"])
    assert n <= engine.s.max_orders_per_market
    spent, _ = engine.store.market_exposure(engine.client.market["ticker"])
    assert spent <= engine.s.max_cost_per_market + 1e-9


def test_dashboard_renders(engine, monkeypatch):
    engine.tick()
    from kalshi_bot.dashboard import create_app

    app = create_app(engine.s)
    r = app.test_client().get("/")
    assert r.status_code == 200
    assert b"KXBTC15M" in r.data
