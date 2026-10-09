"""The math: fair probability, fees, and bet sizing. No I/O, fully unit-tested.

KXBTC15M asks: will the 60-second average of BRTI at the END of the
15 minutes be at least the 60-second average at the START (the strike)?

Model: BTC log price is a driftless random walk with volatility sigma.
Variance of the final log price, seen from now with `t` seconds to close:
  - the part before the averaging window:  sigma^2 * (t - 60)
  - the 60-second average itself:           sigma^2 * 60 / 3
(an average of a random walk over a window of length W has variance W/3).
Then P(yes) = Phi( ln(S/K) / sqrt(variance) ).
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from .price_feed import SECONDS_PER_YEAR

AVG_WINDOW = 60  # seconds of BRTI averaged at settlement


def norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def prob_yes(spot: float, strike: float, seconds_left: float, annual_vol: float) -> float:
    """Probability the settlement average finishes >= strike."""
    if spot <= 0 or strike <= 0:
        raise ValueError("prices must be positive")
    sigma2 = annual_vol**2 / SECONDS_PER_YEAR  # variance per second
    t = max(seconds_left, 0.0)
    if t >= AVG_WINDOW:
        var = sigma2 * ((t - AVG_WINDOW) + AVG_WINDOW / 3)
    else:
        # Inside the window some of the average is already fixed; treat the
        # remainder conservatively. The bot doesn't trade here by default.
        var = sigma2 * t / 3
    x = math.log(spot / strike)
    if var <= 0:
        return 1.0 if x >= 0 else 0.0
    return norm_cdf(x / math.sqrt(var))


def taker_fee(contracts: int, price: float, rate: float = 0.07) -> float:
    """Kalshi taker fee in dollars: rate * C * P * (1-P), rounded up to the cent."""
    raw = rate * contracts * price * (1 - price)
    return math.ceil(round(raw * 100, 6)) / 100


def kelly_fraction(p: float, price: float) -> float:
    """Full-Kelly share of bankroll to spend on a $1 binary costing `price` that wins with prob `p`."""
    if not 0 < price < 1:
        return 0.0
    return max(0.0, (p - price) / (1 - price))


@dataclass
class Decision:
    action: str  # "buy_yes", "buy_no", or "hold"
    reason: str
    p_yes: float | None = None
    price: float | None = None
    contracts: int = 0
    edge: float = 0.0  # expected profit per contract after fees

    @property
    def side(self) -> str | None:
        return {"buy_yes": "yes", "buy_no": "no"}.get(self.action)


def decide(
    *,
    spot: float,
    strike: float,
    seconds_left: float,
    seconds_elapsed: float,
    annual_vol: float,
    yes_ask: float | None,
    no_ask: float | None,
    bankroll: float,
    settings,
) -> Decision:
    """Pick the better side if its after-fee edge clears the bar, and size it."""
    s = settings
    if seconds_left < s.min_seconds_left:
        return Decision("hold", f"too close to close ({seconds_left:.0f}s left)")
    if seconds_elapsed < s.min_seconds_elapsed:
        return Decision("hold", f"window just opened ({seconds_elapsed:.0f}s in)")

    vol = min(max(annual_vol, s.min_vol), s.max_vol)
    p = prob_yes(spot, strike, seconds_left, vol)

    candidates = []
    for side, prob, ask in (("yes", p, yes_ask), ("no", 1 - p, no_ask)):
        if ask is None or not (s.min_price <= ask <= s.max_price):
            continue
        fee_per = taker_fee(100, ask, s.taker_fee_rate) / 100  # per-contract fee at scale
        candidates.append((prob - ask - fee_per, side, prob, ask))

    if not candidates:
        return Decision("hold", "no tradable price in range", p_yes=p)
    edge, side, prob, ask = max(candidates)
    if edge < s.min_edge:
        return Decision("hold", f"best edge {edge:+.3f} on {side} < {s.min_edge:.3f}", p_yes=p, price=ask, edge=edge)

    spend = s.kelly_fraction * kelly_fraction(prob, ask) * bankroll
    contracts = min(int(spend // ask), s.max_contracts_per_order)
    if contracts < 1:
        return Decision("hold", f"edge {edge:+.3f} but size rounds to 0", p_yes=p, price=ask, edge=edge)
    return Decision(f"buy_{side}", f"edge {edge:+.3f}", p_yes=p, price=ask, contracts=contracts, edge=edge)
