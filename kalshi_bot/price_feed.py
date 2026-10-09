"""Bitcoin spot price and short-term volatility.

Kalshi settles KXBTC15M on CF Benchmarks' BRTI, an index built from several
large USD exchanges. We approximate it with the median of a few public
exchange tickers, which is close enough for a 15-minute probability model.
Volatility comes from Coinbase 1-minute candles.
"""

from __future__ import annotations

import logging
import math
import statistics
import time

import requests

log = logging.getLogger(__name__)

SECONDS_PER_YEAR = 365 * 24 * 3600


def _coinbase(s: requests.Session) -> float:
    r = s.get("https://api.exchange.coinbase.com/products/BTC-USD/ticker", timeout=5)
    r.raise_for_status()
    return float(r.json()["price"])


def _kraken(s: requests.Session) -> float:
    r = s.get("https://api.kraken.com/0/public/Ticker", params={"pair": "XBTUSD"}, timeout=5)
    r.raise_for_status()
    result = r.json()["result"]
    return float(next(iter(result.values()))["c"][0])


def _bitstamp(s: requests.Session) -> float:
    r = s.get("https://www.bitstamp.net/api/v2/ticker/btcusd/", timeout=5)
    r.raise_for_status()
    return float(r.json()["last"])


SOURCES = {"coinbase": _coinbase, "kraken": _kraken, "bitstamp": _bitstamp}


def ewma_vol(closes: list[float], seconds_per_bar: int = 60, halflife_bars: float = 20) -> float:
    """Annualized volatility from closing prices using an exponentially weighted variance."""
    if len(closes) < 3:
        raise ValueError("need at least 3 prices")
    rets = [math.log(b / a) for a, b in zip(closes, closes[1:]) if a > 0 and b > 0]
    lam = 0.5 ** (1 / halflife_bars)
    var, weight = 0.0, 0.0
    for i, r in enumerate(reversed(rets)):  # newest gets the most weight
        w = lam**i
        var += w * r * r
        weight += w
    var /= weight
    return math.sqrt(var * SECONDS_PER_YEAR / seconds_per_bar)


class PriceFeed:
    def __init__(self, vol_refresh_seconds: int = 60):
        self.session = requests.Session()
        self.session.headers["User-Agent"] = "kalshi-bot/0.1"
        self.vol_refresh_seconds = vol_refresh_seconds
        self._vol: float | None = None
        self._vol_at = 0.0
        self.last_sources: dict[str, float] = {}

    def spot(self) -> float:
        """Median of the exchanges that answer. Raises if fewer than two do."""
        prices = {}
        for name, fn in SOURCES.items():
            try:
                prices[name] = fn(self.session)
            except Exception as e:  # one exchange being down is normal
                log.debug("price source %s failed: %s", name, e)
        self.last_sources = prices
        if len(prices) < 2:
            raise RuntimeError(f"only {len(prices)} BTC price source(s) available: {list(prices)}")
        vals = sorted(prices.values())
        if (vals[-1] - vals[0]) / vals[0] > 0.005:
            log.warning("BTC sources disagree by >0.5%%: %s", prices)
        return statistics.median(vals)

    def volatility(self) -> float:
        """Annualized vol from the last ~2 hours of 1-minute candles, cached for a minute."""
        now = time.time()
        if self._vol is not None and now - self._vol_at < self.vol_refresh_seconds:
            return self._vol
        r = self.session.get(
            "https://api.exchange.coinbase.com/products/BTC-USD/candles",
            params={"granularity": 60},
            timeout=5,
        )
        r.raise_for_status()
        candles = sorted(r.json(), key=lambda c: c[0])[-120:]  # [time, low, high, open, close, volume]
        self._vol = ewma_vol([c[4] for c in candles])
        self._vol_at = now
        return self._vol
