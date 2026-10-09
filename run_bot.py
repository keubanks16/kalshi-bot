"""Start the trading loop.  Usage:  python run_bot.py   (or: python run_bot.py --once)"""

import argparse
import logging
import sys

from kalshi_bot.config import Settings
from kalshi_bot.engine import Engine
from kalshi_bot.kalshi_client import KalshiClient, load_private_key
from kalshi_bot.price_feed import PriceFeed
from kalshi_bot.store import Store


def build_engine(settings: Settings) -> Engine:
    key = load_private_key(settings.private_key_path) if settings.places_orders else None
    client = KalshiClient(settings.base_url, settings.api_key_id, key)
    return Engine(settings, client, PriceFeed(), Store(settings.db_path))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--once", action="store_true", help="run a single tick and print the result")
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    settings = Settings()
    try:
        settings.validate()
    except ValueError as e:
        print(f"Config error: {e}", file=sys.stderr)
        return 2

    engine = build_engine(settings)
    if args.once:
        engine.tick()
        print(engine.store.get("status"))
        return 0
    engine.run_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
