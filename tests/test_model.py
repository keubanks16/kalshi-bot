import math
from types import SimpleNamespace

import pytest

from kalshi_bot.model import decide, kelly_fraction, prob_yes, taker_fee


def settings(**kw):
    base = dict(
        min_seconds_left=120, min_seconds_elapsed=60, min_price=0.05, max_price=0.95,
        min_vol=0.2, max_vol=2.5, min_edge=0.04, kelly_fraction=0.25, taker_fee_rate=0.07,
        max_contracts_per_order=10,
    )
    base.update(kw)
    return SimpleNamespace(**base)


def test_at_the_money_is_coin_flip():
    assert prob_yes(80000, 80000, 600, 0.5) == pytest.approx(0.5)


def test_above_strike_favors_yes_and_is_monotonic():
    p1 = prob_yes(80100, 80000, 600, 0.5)
    p2 = prob_yes(80300, 80000, 600, 0.5)
    assert 0.5 < p1 < p2 < 1


def test_less_time_means_more_certain():
    assert prob_yes(80100, 80000, 180, 0.5) > prob_yes(80100, 80000, 800, 0.5)


def test_symmetry():
    up = prob_yes(80100, 80000, 600, 0.5)
    down = prob_yes(80000 ** 2 / 80100, 80000, 600, 0.5)
    assert up + down == pytest.approx(1.0)


def test_fee_formula_rounds_up():
    # 0.07 * 10 * 0.5 * 0.5 = 0.175 -> 0.18
    assert taker_fee(10, 0.50) == pytest.approx(0.18)
    # 0.07 * 1 * 0.5 * 0.5 = 0.0175 -> 0.02
    assert taker_fee(1, 0.50) == pytest.approx(0.02)
    # exact cents stay put: 0.07 * 100 * 0.5 * 0.5 = 1.75
    assert taker_fee(100, 0.50) == pytest.approx(1.75)


def test_kelly():
    assert kelly_fraction(0.6, 0.5) == pytest.approx(0.2)
    assert kelly_fraction(0.4, 0.5) == 0.0


def test_holds_without_edge():
    d = decide(spot=80000, strike=80000, seconds_left=600, seconds_elapsed=300, annual_vol=0.5,
               yes_ask=0.51, no_ask=0.51, bankroll=100, settings=settings())
    assert d.action == "hold"


def test_buys_yes_when_cheap():
    d = decide(spot=80400, strike=80000, seconds_left=300, seconds_elapsed=600, annual_vol=0.4,
               yes_ask=0.60, no_ask=0.42, bankroll=100, settings=settings())
    assert d.action == "buy_yes"
    assert 1 <= d.contracts <= 10
    assert d.edge >= 0.04


def test_buys_no_when_cheap():
    d = decide(spot=79600, strike=80000, seconds_left=300, seconds_elapsed=600, annual_vol=0.4,
               yes_ask=0.42, no_ask=0.60, bankroll=100, settings=settings())
    assert d.action == "buy_no"


def test_respects_time_windows():
    kw = dict(spot=80400, strike=80000, annual_vol=0.4, yes_ask=0.6, no_ask=0.42, bankroll=100, settings=settings())
    assert decide(seconds_left=90, seconds_elapsed=810, **kw).action == "hold"
    assert decide(seconds_left=880, seconds_elapsed=20, **kw).action == "hold"


def test_skips_extreme_prices():
    d = decide(spot=81000, strike=80000, seconds_left=300, seconds_elapsed=600, annual_vol=0.4,
               yes_ask=0.97, no_ask=0.04, bankroll=100, settings=settings())
    assert d.action == "hold"
