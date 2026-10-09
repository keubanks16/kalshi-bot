"""Hard limits checked before every order. Any failure means no trade."""

from __future__ import annotations

from dataclasses import dataclass

from .model import taker_fee


@dataclass
class RiskCheck:
    ok: bool
    contracts: int
    reason: str = ""


def check_order(*, store, settings, day: str, ticker: str, price: float, contracts: int) -> RiskCheck:
    s = settings
    if store.kill_switch_on():
        return RiskCheck(False, 0, "kill switch is on")

    loss_today = store.day_loss(day)
    if loss_today >= s.max_daily_loss:
        return RiskCheck(False, 0, f"daily loss limit reached (${loss_today:.2f} at risk/lost)")

    spent, n_orders = store.market_exposure(ticker)
    if n_orders >= s.max_orders_per_market:
        return RiskCheck(False, 0, f"already {n_orders} orders on this market")

    # Shrink the order until it fits every dollar limit.
    room = min(s.max_cost_per_market - spent, s.max_daily_loss - loss_today)
    while contracts > 0 and contracts * price + taker_fee(contracts, price, s.taker_fee_rate) > room:
        contracts -= 1
    if contracts < 1:
        return RiskCheck(False, 0, f"no room left under limits (${room:.2f})")
    return RiskCheck(True, contracts)
