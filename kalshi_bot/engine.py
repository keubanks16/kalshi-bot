"""The trading loop: settle old trades, look at the current market, maybe trade."""

from __future__ import annotations

import logging
import os
import time
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from . import risk
from .kalshi_client import KalshiClient, KalshiError, dollars
from .model import decide, taker_fee

log = logging.getLogger(__name__)

TZ = ZoneInfo(os.environ.get("BOT_TIMEZONE", "America/New_York"))


def parse_ts(s: str) -> float:
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


def trading_day(ts: float | None = None) -> str:
    return datetime.fromtimestamp(ts or time.time(), TZ).strftime("%Y-%m-%d")


class Engine:
    def __init__(self, settings, client: KalshiClient, feed, store, clock=time.time):
        self.s = settings
        self.client = client
        self.feed = feed
        self.store = store
        self.clock = clock

    # ------------------------------------------------------------ bankroll
    def bankroll(self) -> float:
        if self.s.places_orders:
            # Never size off more than the configured bankroll, even if the account holds more.
            return min(self.client.get_balance(), self.s.bankroll)
        summ = self.store.summary()
        return self.s.bankroll + summ["pnl"] - summ["open_cost"]

    # ---------------------------------------------------------- settlement
    def settle(self) -> None:
        for t in self.store.open_trades():
            try:
                m = self.client.get_market(t["ticker"])
            except KalshiError as e:
                log.warning("could not fetch %s for settlement: %s", t["ticker"], e)
                continue
            result = (m.get("result") or "").lower()
            if result not in ("yes", "no"):
                continue
            payout = t["contracts"] * 1.0 if result == t["side"] else 0.0
            pnl = round(payout - t["cost"], 4)
            self.store.settle_trade(t["id"], result, pnl)
            log.info("settled %s %s x%d -> %s, pnl %+.2f", t["ticker"], t["side"], t["contracts"], result, pnl)

    # -------------------------------------------------------------- market
    def current_market(self) -> dict | None:
        now = self.clock()
        markets = self.client.get_markets(series_ticker=self.s.series_ticker, status="open", limit=50)
        live = [
            m
            for m in markets
            if m.get("close_time") and parse_ts(m["close_time"]) > now and m.get("floor_strike") not in (None, "")
        ]
        return min(live, key=lambda m: parse_ts(m["close_time"])) if live else None

    # ---------------------------------------------------------------- tick
    def tick(self) -> None:
        self.store.set("heartbeat", self.clock())
        self.settle()

        if self.store.kill_switch_on():
            self.store.set("status", "paused (kill switch)")
            return

        m = self.current_market()
        if not m:
            self.store.set("status", "no open market with a strike yet")
            return

        now = self.clock()
        ticker = m["ticker"]
        strike = float(m["floor_strike"])
        seconds_left = parse_ts(m["close_time"]) - now
        seconds_elapsed = now - parse_ts(m["open_time"])
        yes_ask, no_ask = dollars(m, "yes_ask"), dollars(m, "no_ask")

        spot = self.feed.spot()
        vol = self.feed.volatility()
        bankroll = self.bankroll()

        d = decide(
            spot=spot,
            strike=strike,
            seconds_left=seconds_left,
            seconds_elapsed=seconds_elapsed,
            annual_vol=vol,
            yes_ask=yes_ask,
            no_ask=no_ask,
            bankroll=bankroll,
            settings=self.s,
        )

        reason = d.reason
        if d.side:
            reason = self.execute(m, d, spot=spot, strike=strike, seconds_left=seconds_left)

        self.store.add_decision(
            ts=now, ticker=ticker, spot=spot, strike=strike, seconds_left=seconds_left, vol=vol,
            p_fair=d.p_yes, yes_ask=yes_ask, no_ask=no_ask, action=d.action, reason=reason,
        )
        self.store.set("status", f"{ticker}: {d.action} — {reason}")

    # ------------------------------------------------------------- execute
    def execute(self, market: dict, d, *, spot: float, strike: float, seconds_left: float) -> str:
        ticker, side, price = market["ticker"], d.side, d.price
        day = trading_day(self.clock())

        chk = risk.check_order(store=self.store, settings=self.s, day=day, ticker=ticker, price=price, contracts=d.contracts)
        if not chk.ok:
            return f"{d.reason}; blocked: {chk.reason}"
        contracts = chk.contracts

        order_id = None
        if self.s.places_orders:
            try:
                order = self.client.create_order(ticker, side, contracts, price)
            except KalshiError as e:
                self.store.set("last_error", f"{time.strftime('%H:%M:%S')} order failed: {e}")
                return f"{d.reason}; order failed: {e.status}"
            order_id = order.get("order_id")
            filled = int(float(order.get("fill_count_fp") or order.get("fill_count") or 0))
            if filled < 1:
                return f"{d.reason}; IOC order did not fill"
            fee = float(order.get("taker_fees_dollars") or 0) or taker_fee(filled, price, self.s.taker_fee_rate)
        else:
            # Paper: assume we take the displayed ask, limited by the size showing there.
            size_field = "yes_ask_size_fp" if side == "yes" else "yes_bid_size_fp"  # NO ask mirrors YES bid
            shown = market.get(size_field)
            filled = min(contracts, int(float(shown))) if shown not in (None, "") else contracts
            if filled < 1:
                return f"{d.reason}; no size at the ask"
            fee = taker_fee(filled, price, self.s.taker_fee_rate)

        cost = round(filled * price + fee, 4)
        self.store.add_trade(
            ts=self.clock(), day=day, mode=self.s.mode, ticker=ticker, side=side, contracts=filled,
            price=price, fee=fee, cost=cost, p_fair=d.p_yes, edge=d.edge, spot=spot, strike=strike,
            seconds_left=seconds_left, order_id=order_id,
        )
        log.info("[%s] bought %d %s @ %.3f on %s (edge %+.3f)", self.s.mode, filled, side.upper(), price, ticker, d.edge)
        return f"{d.reason}; bought {filled} {side.upper()} @ ${price:.3f}"

    # ---------------------------------------------------------------- loop
    def run_forever(self) -> None:
        log.info("bot starting in %s mode on %s", self.s.mode.upper(), self.s.series_ticker)
        self.store.set("mode", self.s.mode)
        errors = 0
        while True:
            try:
                self.tick()
                errors = 0
            except Exception as e:  # keep running through network blips
                errors += 1
                log.exception("tick failed")
                self.store.set("last_error", f"{time.strftime('%H:%M:%S')} {type(e).__name__}: {e}")
            # back off when something keeps failing
            time.sleep(self.s.poll_seconds * min(2**errors, 12) if errors else self.s.poll_seconds)
