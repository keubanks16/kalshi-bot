"""Settings, loaded from environment variables (or a .env file).

Every knob that affects money lives here so it can be changed without
touching code. Defaults are deliberately conservative.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:  # python-dotenv is optional at runtime
    pass


BASE_URLS = {
    "prod": "https://external-api.kalshi.com/trade-api/v2",
    "demo": "https://external-api.demo.kalshi.co/trade-api/v2",
}

VALID_MODES = ("paper", "demo", "live")


def _env(name: str, default: str) -> str:
    return os.environ.get(name, default).strip()


def _float(name: str, default: float) -> float:
    return float(_env(name, str(default)))


def _int(name: str, default: int) -> int:
    return int(_env(name, str(default)))


def _bool(name: str, default: bool) -> bool:
    return _env(name, "true" if default else "false").lower() in ("1", "true", "yes", "on")


@dataclass
class Settings:
    # --- how the bot trades -------------------------------------------------
    # paper: real Kalshi prices, simulated fills, no keys needed
    # demo:  real orders on Kalshi's demo exchange (fake money)
    # live:  real orders, real money. Also requires LIVE_TRADING_CONFIRM=yes
    mode: str = field(default_factory=lambda: _env("BOT_MODE", "paper").lower())
    live_confirm: bool = field(default_factory=lambda: _env("LIVE_TRADING_CONFIRM", "") == "yes")

    series_ticker: str = field(default_factory=lambda: _env("SERIES_TICKER", "KXBTC15M"))
    poll_seconds: float = field(default_factory=lambda: _float("POLL_SECONDS", 5))

    # --- credentials (not needed for paper mode) ---------------------------
    api_key_id: str = field(default_factory=lambda: _env("KALSHI_API_KEY_ID", ""))
    private_key_path: str = field(default_factory=lambda: _env("KALSHI_PRIVATE_KEY_PATH", "kalshi_private_key.pem"))

    # --- strategy ----------------------------------------------------------
    # Minimum expected profit per $1 contract, AFTER fees, before we trade.
    min_edge: float = field(default_factory=lambda: _float("MIN_EDGE", 0.04))
    # Don't open new trades with less than this many seconds left. The final
    # minute is the settlement averaging window, so stay out of it.
    min_seconds_left: int = field(default_factory=lambda: _int("MIN_SECONDS_LEFT", 120))
    # ...or in the first seconds, before the strike is set and books settle.
    min_seconds_elapsed: int = field(default_factory=lambda: _int("MIN_SECONDS_ELAPSED", 60))
    # Skip markets priced near-certain; there is little to gain and model error dominates.
    min_price: float = field(default_factory=lambda: _float("MIN_PRICE", 0.05))
    max_price: float = field(default_factory=lambda: _float("MAX_PRICE", 0.95))
    # Volatility floor/ceiling (annualized) so a quiet or noisy minute can't break the model.
    min_vol: float = field(default_factory=lambda: _float("MIN_VOL", 0.20))
    max_vol: float = field(default_factory=lambda: _float("MAX_VOL", 2.50))
    # Fraction of the Kelly bet to use. 0.25 = quarter Kelly.
    kelly_fraction: float = field(default_factory=lambda: _float("KELLY_FRACTION", 0.25))
    taker_fee_rate: float = field(default_factory=lambda: _float("TAKER_FEE_RATE", 0.07))

    # --- risk limits (dollars / contracts) ---------------------------------
    bankroll: float = field(default_factory=lambda: _float("BANKROLL", 100.0))
    max_contracts_per_order: int = field(default_factory=lambda: _int("MAX_CONTRACTS_PER_ORDER", 10))
    max_cost_per_market: float = field(default_factory=lambda: _float("MAX_COST_PER_MARKET", 10.0))
    max_daily_loss: float = field(default_factory=lambda: _float("MAX_DAILY_LOSS", 25.0))
    max_orders_per_market: int = field(default_factory=lambda: _int("MAX_ORDERS_PER_MARKET", 3))

    # --- storage / dashboard -----------------------------------------------
    db_path: str = field(default_factory=lambda: _env("DB_PATH", str(Path(__file__).resolve().parent.parent / "bot.db")))
    dashboard_password: str = field(default_factory=lambda: _env("DASHBOARD_PASSWORD", ""))
    secret_key: str = field(default_factory=lambda: _env("FLASK_SECRET_KEY", "change-me"))

    @property
    def base_url(self) -> str:
        override = _env("KALSHI_BASE_URL", "")
        if override:
            return override.rstrip("/")
        return BASE_URLS["demo" if self.mode == "demo" else "prod"]

    @property
    def places_orders(self) -> bool:
        return self.mode in ("demo", "live")

    def validate(self) -> None:
        if self.mode not in VALID_MODES:
            raise ValueError(f"BOT_MODE must be one of {VALID_MODES}, got {self.mode!r}")
        if self.mode == "live" and not self.live_confirm:
            raise ValueError("BOT_MODE=live also requires LIVE_TRADING_CONFIRM=yes. Run in paper or demo first.")
        if self.places_orders:
            if not self.api_key_id:
                raise ValueError("KALSHI_API_KEY_ID is required for demo/live mode.")
            if not Path(self.private_key_path).is_file():
                raise ValueError(f"Private key file not found: {self.private_key_path}")
        if not 0 < self.kelly_fraction <= 1:
            raise ValueError("KELLY_FRACTION must be between 0 and 1.")
