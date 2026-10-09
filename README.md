# Kalshi Bot

An automated Kalshi trader that runs on **Cloudflare Workers**. It scans every open Kalshi market and trades only where it has a real reason to think the price is wrong. A dashboard you can use from your phone shows what it's doing and lets you control it.

It starts in **paper mode**: real Kalshi prices, simulated trades, no money and no API keys.

## What it trades

A bot can only find a good trade when it has a source of truth that's better than the market price. For most Kalshi markets (politics, sports, culture) it has none, so it leaves them alone. It runs two strategies that do have an edge source:

**1. Crypto price markets** — BTC, ETH, SOL, XRP and DOGE, at any timeframe (15-minute, hourly, daily…) and any strike type: above, below, or between.

- It gets the coin's live price (the median of Coinbase, Kraken, Bitstamp and Gemini) and its recent volatility.
- It computes the probability the price finishes past the strike, accounting for Kalshi's 60-second settlement average.
- If YES or NO is cheaper than that probability by more than `MIN_EDGE` after fees, it buys. It sizes the bet with quarter-Kelly.
- It skips markets that depend on whether a price is touched at any time, since those can't be priced this way.

**2. Arbitrage on any market** — some events have outcomes where at most one can win, like which month the Fed cuts rates. If the YES bids across those outcomes add up to more than $1, buying NO on each one locks in a profit whatever happens.

- It only buys NO baskets, which pay off even if the outcome list isn't complete.
- It only trades when the locked-in profit after fees is at least `MIN_ARB_PROFIT` per set.
- These opportunities are rare. Most of the time it will find none.

**3. AI forecaster for slower markets** (economics, politics, weather, company news…). It needs an `ANTHROPIC_API_KEY` secret.

- Every 10 minutes it picks one liquid, undecided, non-crypto market that closes at least 2 hours out and inside your time limit.
- It asks Claude (Sonnet, with up to 3 web searches) for the probability of YES. Claude is never shown the market price, so its estimate is independent.
- It blends that estimate with the market price using the trust setting, and bets only if the gap is at least 10¢ after fees and Claude's confidence isn't "low".
- Every forecast is shown on the dashboard: Claude's probability, the market's, the decision, its reasoning, and what it cost.
- **Max AI spend per day** (default $2, editable with the other limits) caps the API bill. A forecast typically costs about $0.05–0.15.
- If settled AI bets win less often than Claude predicted, trust in the AI is cut automatically, down to half.

Everything is held to settlement and then marked as a win or loss.

## Time limit

On the dashboard you choose how soon a market must close for the bot to trade it:

| Setting | Trades markets closing… |
|---|---|
| 15 min | within 15 minutes (the 15-minute crypto markets) |
| 1 hour | within the next hour |
| 1 day | within 24 hours (default) |
| 1 week | within 7 days |
| 1 month | within 31 days |
| Any time | no limit |

A shorter limit means your money comes back sooner. Changing the limit applies on the next scan, and trades already open are kept.

## Safety

The dollar limits below can be changed any time from the dashboard's **Spending limits** card (sign in first). Changes apply on the next round, and **Reset to defaults** goes back to the values in `wrangler.jsonc`.

| Guard | Default |
|---|---|
| Max per trade | $5 |
| Mode | `paper`. Live needs `BOT_MODE=live` **and** `LIVE_TRADING_CONFIRM=yes` |
| Max contracts per order | 10 |
| Max spent per market | $10 |
| Max spent per event | $20 |
| Max total money in open trades | $50 |
| Daily loss limit (losses + money at risk) | $25 |
| Max orders per market | 1 (never adds to a position) |
| Bankroll used for sizing | $100, even if your account holds more |
| Orders | Limit at the ask, immediate-or-cancel. Never resting, never chasing |
| Kill switch | One button on the dashboard |

## How it runs on Cloudflare

- A **Durable Object** holds the bot and its own SQLite database. An alarm wakes it every 10 seconds to run one round.
- Each round scans one page of open markets, looking for arbitrage and new crypto markets. It then re-prices up to 3 crypto series that are due: short-dated ones every 10 seconds, long-dated ones every few minutes. The full market list is covered over several rounds.
- A **cron** runs once a minute only to make sure the loop is alive. That covers restarts after deploys.
- The **Worker** serves the dashboard at your `*.workers.dev` address.

**Cost:** the defaults are sized to fit Cloudflare's free plan, which allows 100k Durable Object requests and 100k rows written per day. If the dashboard shows errors about limits, switch to Workers Paid ($5/month).

## Deploy (no computer setup needed)

**1. Connect the repo.** In the Cloudflare dashboard go to **Workers & Pages → Create → Import a repository**. Pick `keubanks16/kalshi-bot` and keep the defaults (deploy command `npx wrangler deploy`). Cloudflare redeploys automatically every time the repo changes.

**2. Add secrets.** Open the Worker → **Settings → Variables and Secrets** → add as **Secret**:

| Name | Value |
|---|---|
| `DASHBOARD_PASSWORD` | any password; needed to change settings and use the kill switch |
| `KALSHI_API_KEY_ID` | needed for demo/live; **recommended even for paper** |
| `KALSHI_PRIVATE_KEY` | same. Paste the whole `.key`/`.pem` file, including the BEGIN/END lines |

Why add a key in paper mode: without one, Kalshi limits requests by IP address, and Cloudflare's IPs are shared with lots of other apps, so the bot can get "too many requests." With a key, the limit is your own account's. Paper mode never places orders, even with a key set. When rate-limited, the bot backs off automatically (15 seconds, then longer) and the dashboard says so.

**3. Open the dashboard** at `https://kalshi-bot.<your-subdomain>.workers.dev` and add it to your phone's home screen. Sign in at the bottom of the page to unlock the time-limit buttons and kill switch.

The plain settings (mode, limits, strategy knobs) live in `wrangler.jsonc` under `vars`. Edit that file on GitHub and Cloudflare redeploys with the new values.

## Going live

**From the dashboard (easiest):** sign in, open **Trading mode → Go live with real money**, re-enter your password, tick the confirmation box and tap **Go live**. It needs your Kalshi API key secrets in place. **Switch back to paper** (or the kill switch) stops real trading instantly.

Before you do, run paper for at least a few days. Check that its win rate beats the prices it paid, and set small spending limits.

Paper and live results are kept separate. The dashboard shows the current mode's P&L, win rate and trades, with tabs to look back at the other mode's history. Paper positions never count against live risk limits.

**Optional demo step:** Kalshi's [demo exchange](https://demo.kalshi.co) uses fake money with real order handling. Set `"BOT_MODE": "demo"` in `wrangler.jsonc` and use demo API keys, which are separate from your real ones.

**From config instead:** `"BOT_MODE": "live"` plus `"LIVE_TRADING_CONFIRM": "yes"` in `wrangler.jsonc` makes live the deployed default.

## Settings worth knowing

All are in `wrangler.jsonc` → `vars`.

- `MIN_EDGE` — the crypto edge needed after fees. Higher means fewer, more confident trades.
- `MIN_ARB_PROFIT` — the locked-in profit needed per arbitrage set.
- `CRYPTO_ENABLED` / `ARB_ENABLED` — turn either strategy off.
- `CRYPTO_ASSETS` — which coins to trade.
- `KELLY_FRACTION` — 0.25 is conservative; don't go above 0.5.
- `TRADE_HORIZON` — the starting time limit. The dashboard buttons override it.

## Project layout

```
src/
  index.ts        Worker: dashboard routes + once-a-minute cron
  bot.ts          Durable Object: alarm loop, storage, dashboard data
  engine.ts       one round: settle → scan → arbitrage → crypto → trade
  model.ts        probabilities, fees, sizing, arbitrage math (pure, tested)
  kalshi.ts       Kalshi API client + request signing (WebCrypto)
  prices.ts       crypto spot prices and volatility
  store.ts        SQLite tables for trades, decisions, settings
  dashboard.ts    phone-friendly HTML
  config.ts       every setting and its default
test/             model, signing and end-to-end paper-trading tests
```

## Run locally (optional)

```bash
npm install
npm test          # 25 tests, no network needed
npm run dev       # local Worker at http://localhost:8787
```

## Honest caveats

- **Most of the time the bot will do nothing.** Kalshi's prices are usually efficient. It only trades when the numbers clearly disagree, and that is intended.
- The crypto model assumes prices move randomly with no trend. Real crypto has sudden jumps, especially over days, so longer time limits carry more model risk.
- The exchange median isn't exactly CF Benchmarks' index. In fast moves they can differ slightly.
- **Arbitrage legs fill one at a time.** If a later leg fails to fill, the earlier ones are held as normal trades and are no longer risk-free. The per-event limit caps this.
- Fees use Kalshi's standard taker fee, `0.07 × contracts × price × (1 − price)` rounded up. Events with custom fees are skipped. Check Kalshi's current fee schedule.
- Paper fills assume you get the displayed ask; real fills can be worse.
- This is not financial advice. Only trade money you can afford to lose.
