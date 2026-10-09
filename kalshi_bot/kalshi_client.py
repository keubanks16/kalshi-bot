"""Small Kalshi Trade API v2 client.

Auth follows Kalshi's docs: sign `timestamp_ms + METHOD + /trade-api/v2/path`
(no query string) with RSA-PSS/SHA-256 (or Ed25519), base64 the result, and
send it with the key id and timestamp headers.

Market data endpoints are public, so paper mode works without any keys.
"""

from __future__ import annotations

import base64
import logging
import time
import uuid
from typing import Any
from urllib.parse import urlparse

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

log = logging.getLogger(__name__)


class KalshiError(RuntimeError):
    def __init__(self, status: int, body: str):
        super().__init__(f"Kalshi API error {status}: {body[:300]}")
        self.status = status
        self.body = body


def load_private_key(path: str):
    from cryptography.hazmat.primitives import serialization

    with open(path, "rb") as f:
        return serialization.load_pem_private_key(f.read(), password=None)


def sign(private_key, timestamp_ms: str, method: str, path: str) -> str:
    """Return the base64 KALSHI-ACCESS-SIGNATURE for one request."""
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import padding
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    message = f"{timestamp_ms}{method.upper()}{path.split('?')[0]}".encode()
    if isinstance(private_key, Ed25519PrivateKey):
        sig = private_key.sign(message)
    else:
        sig = private_key.sign(
            message,
            padding.PSS(mgf=padding.MGF1(hashes.SHA256()), salt_length=padding.PSS.DIGEST_LENGTH),
            hashes.SHA256(),
        )
    return base64.b64encode(sig).decode()


class KalshiClient:
    def __init__(self, base_url: str, api_key_id: str = "", private_key=None, timeout: float = 10.0):
        self.base_url = base_url.rstrip("/")
        self.api_key_id = api_key_id
        self.private_key = private_key
        self.timeout = timeout
        self._base_path = urlparse(self.base_url).path  # e.g. /trade-api/v2
        self.session = requests.Session()
        retry = Retry(
            total=3,
            backoff_factor=0.5,
            status_forcelist=(429, 500, 502, 503, 504),
            allowed_methods=("GET",),  # never auto-retry order placement
        )
        self.session.mount("https://", HTTPAdapter(max_retries=retry))

    # ------------------------------------------------------------------ core
    def _headers(self, method: str, path: str) -> dict[str, str]:
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if self.private_key is not None and self.api_key_id:
            ts = str(int(time.time() * 1000))
            headers.update(
                {
                    "KALSHI-ACCESS-KEY": self.api_key_id,
                    "KALSHI-ACCESS-TIMESTAMP": ts,
                    "KALSHI-ACCESS-SIGNATURE": sign(self.private_key, ts, method, self._base_path + path),
                }
            )
        return headers

    def request(self, method: str, path: str, params: dict | None = None, json: dict | None = None) -> dict[str, Any]:
        resp = self.session.request(
            method,
            self.base_url + path,
            params=params,
            json=json,
            headers=self._headers(method, path),
            timeout=self.timeout,
        )
        if resp.status_code >= 400:
            raise KalshiError(resp.status_code, resp.text)
        return resp.json() if resp.content else {}

    # ---------------------------------------------------------- market data
    def get_markets(self, **params) -> list[dict]:
        return self.request("GET", "/markets", params=params).get("markets", [])

    def get_market(self, ticker: str) -> dict:
        return self.request("GET", f"/markets/{ticker}").get("market", {})

    def get_orderbook(self, ticker: str, depth: int = 10) -> dict:
        return self.request("GET", f"/markets/{ticker}/orderbook", params={"depth": depth}).get("orderbook", {})

    # ------------------------------------------------------------- account
    def get_balance(self) -> float:
        """Available cash in dollars."""
        data = self.request("GET", "/portfolio/balance")
        if "balance_dollars" in data:
            return float(data["balance_dollars"])
        return data.get("balance", 0) / 100.0

    def get_positions(self, **params) -> list[dict]:
        return self.request("GET", "/portfolio/positions", params=params).get("market_positions", [])

    def create_order(
        self,
        ticker: str,
        side: str,
        count: int,
        price: float,
        action: str = "buy",
        time_in_force: str = "immediate_or_cancel",
    ) -> dict:
        """Place a limit order. `price` is in dollars for the chosen side."""
        if side not in ("yes", "no"):
            raise ValueError("side must be 'yes' or 'no'")
        body = {
            "ticker": ticker,
            "side": side,
            "action": action,
            "count": int(count),
            "type": "limit",
            f"{side}_price_dollars": f"{price:.4f}",
            "time_in_force": time_in_force,
            "client_order_id": str(uuid.uuid4()),
        }
        log.info("Placing order %s", body)
        return self.request("POST", "/portfolio/orders", json=body).get("order", {})

    def cancel_order(self, order_id: str) -> dict:
        return self.request("DELETE", f"/portfolio/orders/{order_id}")


def dollars(market: dict, field: str) -> float | None:
    """Read a price from a market object, preferring the `_dollars` field."""
    v = market.get(f"{field}_dollars")
    if v not in (None, ""):
        return float(v)
    v = market.get(field)
    if v not in (None, ""):
        return float(v) / 100.0
    return None
