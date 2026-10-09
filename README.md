# Kalshi BTC 15-Minute Bot

An automated trader for Kalshi's **"BTC price up in next 15 mins?"** markets (`KXBTC15M`), with a dashboard you can check from your phone.

It starts in **paper mode** — real Kalshi prices, simulated trades, no money and no API keys — so you can watch how it would have done before risking anything.

## How it decides

Each KXBTC15M market resolves YES if the 60-second average of the CF Benchmarks BTC index at the end of the 15 minutes is at or above the average at the start (the "target price").

Every few seconds the bot:

1. **Finds the live market** and its target price (strike).
2. **Gets BTC's price now** — the median of Coinbase, Kraken and Bitstamp, a close stand-in for the CF Benchmarks index.
3. **Measures volatility** from the last two hours of 1-minute candles (recent minutes weighted more).
4. **Computes a fair probability** that BTC finishes above the strike, treating price as a random walk and accounting for the 60-second settlement average. See `kalshi_bot/model.py`.
5. **Compares it to Kalshi's prices.** If YES (or NO) is cheaper than fair by more than `MIN_EDGE` *after Kalshi's taker fee*, it buys.
6. **Sizes the bet** with quarter-Kelly on your bankroll, then shrinks it to fit every risk limit.
7. **Holds to settlement**, then records the win or loss.

It stays out of the first minute (strike just set, thin books), the last two minutes (the settlement averaging window), and any price below 5¢ or above 95¢.

## Safety built in

| Guard | Default |
|---|---|
| Mode | `paper` — live trading needs `BOT_MODE=live` **and** `LIVE_TRADING_CONFIRM=yes` |
| Max contracts per order | 10 |
| Max spent per market | $10 |
| Max orders per market | 3 |
| Daily loss limit (losses + money at risk) | $25 |
| Bankroll used for sizing | $100, even if your account holds more |
| Orders | Limit at the ask, immediate-or-cancel — never resting, never chasing |
| Kill switch | One button on the dashboard |

## Project layout

```
run_bot.py              start the trading loop
wsgi.py                 the dashboard (Flask)
kalshi_bot/
  config.py             every setting, from .env
  kalshi_client.py      Kalshi API client + request signing
  price_feed.py         BTC spot price and volatility
  model.py              fair probability, fees, sizing (pure math)
  risk.py               limits checked before every order
  engine.py             the loop: settle → look → decide → trade
  store.py              SQLite shared by bot and dashboard
  dashboard.py          phone-friendly status page
tests/                  model, signing and paper-trading tests
```

## Run it on PythonAnywhere

You need a paid account (for unrestricted internet and an always-on task).

**1. Get the code.** Open a Bash console:

```bash
git clone https://github.com/keubanks16/kalshi-bot.git
cd kalshi-bot
python3.11 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
nano .env        # set DASHBOARD_PASSWORD and FLASK_SECRET_KEY at least
```

**2. Try one tick.**

```bash
python run_bot.py --once
```

It prints what it sees, e.g. `KXBTC15M-…: hold — best edge +0.012 on yes < 0.040`.

**3. Run the bot all the time.** Tasks tab → *Always-on tasks* → add:

```
/home/YOURUSERNAME/kalshi-bot/venv/bin/python /home/YOURUSERNAME/kalshi-bot/run_bot.py
```

and set the working directory to `/home/YOURUSERNAME/kalshi-bot`.

**4. Add the dashboard.** Web tab → *Add a new web app* → Manual configuration → Python 3.11. Then:

- **Virtualenv:** `/home/YOURUSERNAME/kalshi-bot/venv`
- **WSGI file** — replace its contents with:

  ```python
  import sys
  path = "/home/YOURUSERNAME/kalshi-bot"
  if path not in sys.path:
      sys.path.insert(0, path)
  import os
  os.chdir(path)
  from wsgi import application
  ```

- Click **Reload**, open `YOURUSERNAME.pythonanywhere.com` on your phone, and add it to your home screen.

The bot and the dashboard share `bot.db` in the project folder.

## Going from paper → demo → live

1. **Paper** for at least a few hundred trades. Watch the win rate against the prices paid. A model that wins 60% while paying 62¢ is losing money.
2. **Demo:** make an account and API key at [demo.kalshi.co](https://demo.kalshi.co), save the private key as `kalshi_private_key.pem` in the project folder, then set:
   ```
   BOT_MODE=demo
   KALSHI_API_KEY_ID=your-demo-key-id
   ```
   This checks that real orders, fills and signing all work.
3. **Live:** create a key on kalshi.com (different from demo), keep the limits small, and set:
   ```
   BOT_MODE=live
   LIVE_TRADING_CONFIRM=yes
   KALSHI_API_KEY_ID=your-live-key-id
   ```

Restart the always-on task after any `.env` change.

Never commit `.env` or the `.pem` file; `.gitignore` already blocks them.

## Tuning

All settings are in `.env` (see `.env.example`). The ones that matter most:

- `MIN_EDGE` — higher means fewer, more confident trades.
- `KELLY_FRACTION` — 0.25 is conservative; don't go above 0.5.
- `MIN_SECONDS_LEFT` / `MIN_SECONDS_ELAPSED` — which part of the 15 minutes it trades.

## Tests

```bash
pip install -r requirements-dev.txt
pytest
```

## Honest caveats

- The model assumes BTC moves randomly with no drift. Its edge comes from the market mispricing that randomness, not from predicting direction. If Kalshi's prices are already efficient, the bot will mostly sit out — that's working as intended.
- The exchange median isn't exactly the CF Benchmarks index; in a fast move the two can differ by a few dollars.
- Paper fills assume you get the displayed ask. Real fills can be worse.
- Fees are modeled as Kalshi's standard taker fee (`0.07 × contracts × price × (1 − price)`, rounded up). Check Kalshi's current fee schedule and adjust `TAKER_FEE_RATE` if it differs.
- This is not financial advice. Only trade money you can afford to lose.
