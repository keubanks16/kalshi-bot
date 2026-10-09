# Kalshi Bot

An automated Kalshi trader that runs on **Cloudflare Workers**. It scans every open Kalshi market and trades only where it has a real reason to think the price is wrong. A dashboard you can use from your phone shows what it's doing and lets you control it.

It starts in **paper mode**: real Kalshi prices, simulated trades, no money and no API keys.

## What it trades

A bot can only find a good trade when it has a source of truth that's better than the market price. For most Kalshi markets (politics, sports, culture) it has none, so it leaves them alone. It runs two strategies that do have an edge source:

**1. Crypto price markets** — BTC, ETH, SOL, XRP and DOGE, at any timeframe (15-minute, hourly, daily…) and any strike type: above, below, or between.

- It rebuilds the coin's price the way CF Benchmarks builds the index Kalshi settles on: **order-book mid-prices** from six of the seven constituent exchanges (Coinbase, Kraken, Bitstamp, Gemini, Crypto.com, Bullish; LMAX has no public API), combined as a volume-weighted median. With `LIVE_STREAMS` on, Coinbase and Kraken stream live over websockets; the rest are polled each round.
- It also measures the coin's recent volatility.
- It computes the probability the price finishes past the strike, accounting for Kalshi's 60-second settlement average.
- If YES or NO is cheaper than that probability by more than `MIN_EDGE` after fees, it buys. It sizes the bet with quarter-Kelly.
- It only buys contracts priced 15¢–85¢ by default (editable on the dashboard), skipping long shots and near-sure things where the model is least reliable and fees bite hardest.
- It skips markets with an empty or one-sided book, or a YES spread wider than 10¢ (`CRYPTO_MAX_SPREAD`). There's no real price to compare against there.
- Contracts under 30¢ (`CRYPTO_CHEAP_BELOW`) need at least 8¢ of edge (`CRYPTO_CHEAP_MIN_EDGE`) instead of `MIN_EDGE`. Cheap long shots were losing more often than the model expected, so they need a bigger cushion.
- It skips markets that depend on whether a price is touched at any time, since those can't be priced this way.

**2. Arbitrage on any market** — some events have outcomes where at most one can win, like which month the Fed cuts rates. If the YES bids across those outcomes add up to more than $1, buying NO on each one locks in a profit whatever happens.

- It only buys NO baskets, which pay off even if the outcome list isn't complete.
- It only trades when the locked-in profit after fees is at least `MIN_ARB_PROFIT` per set.
- These opportunities are rare. Most of the time it will find none.

**3. AI forecaster for slower markets** (economics, politics, weather, company news…). It needs an `ANTHROPIC_API_KEY` secret.

- Every 30 minutes it picks one liquid, undecided, non-crypto market that closes at least 2 hours out and inside your time limit.
- It asks Claude (Sonnet, with up to 3 web searches) for the probability of YES. Claude is never shown the market price, so its estimate is independent.
- It blends that estimate with the market price using the trust setting, and bets only if the gap is at least 5¢ after fees and Claude's confidence isn't "low".
- Every forecast is shown on the dashboard: Claude's probability, the market's, the decision, its reasoning, and what it cost.
- **Max AI spend per day** (default $2, editable with the other limits) caps the API bill. A forecast typically costs about $0.05–0.15.
- If settled AI bets win less often than Claude predicted, trust in the AI is cut automatically, down to half.

**4. Sports vs sportsbooks** (college football only by default; set `SPORTS_LIST` to add MLB, NFL, NBA, NHL and others). It needs an `ODDS_API_KEY` secret from [the-odds-api.com](https://the-odds-api.com).

- Every 30 minutes it reads Kalshi's single-game markets (`KXNCAAFGAME`) and the sportsbooks' moneyline odds for the same games.
- It removes each book's margin to get fair win probabilities. It uses Pinnacle (the sharpest book) when available, otherwise the median of the books.
- It bets on the team (YES or NO) when Kalshi's price is at least 3¢ better than fair after fees. It only bets before the game starts, and only once per game.
- Odds API credits are capped per day (`SPORTS_DAILY_CREDITS`, default 16, about 480 a month, which fits the free plan). The dashboard shows what's used and what's left.

**PrizePicks finder** (its own dashboard tab, college football by default). It only finds picks; you place them yourself in the PrizePicks app.

- PrizePicks' lines come from The Odds API (bookmaker `prizepicks` in the `us_dfs` region), the same `ODDS_API_KEY`, so the bot never touches PrizePicks' own site. Each request returns PrizePicks' lines and the sportsbooks' player-prop odds for one game.
- It removes the books' margin to get the chance each More/Less hits. If no book has PrizePicks' exact line, a book line further out gives a safe minimum, shown as "≥". Only standard lines are used (goblins and demons are left out).
- It lists the top picks and the best 2–6 pick power plays (one pick per game), with the expected profit per $1 from `PRIZEPICKS_POWER_PAYOUTS`.
- It only checks when you tap **Check now** on the tab (`PRIZEPICKS_INTERVAL_MINUTES` = 0), so credits are spent only when you're looking. Set it to e.g. 120 to check every 2 hours instead. A second tap within 10 minutes reuses the last results for free.
- Each game costs stat types × regions credits (3 × 2 = 6 by default), soonest games first, with `PRIZEPICKS_DAILY_CREDITS` (default 300) as a daily safety ceiling.

**Check a screenshot** (top of the PrizePicks tab, needs `ANTHROPIC_API_KEY` and `ODDS_API_KEY`). Upload a PrizePicks screenshot: Claude reads each card (player, stat, line, goblin/demon, teams, which buttons it offers) and nothing else. The chances come from sportsbook odds for the same player, stat and line, priced like the finder, with a plain verdict per pick. Only the games in the screenshot are fetched, from sportsbooks only, so a check costs about 1 credit per stat type per game plus a cent or two of AI. When the books don't have PrizePicks' exact line, the chance is shown as a range or an "at least"/"at most" from the nearest book lines.

**Strategy switches:** the dashboard's **Strategies** card turns Crypto, AI forecaster, Sports and Arbitrage on or off instantly. Open bets stay open and settle normally.

Everything is held to settlement and then marked as a win or loss.

## How it places orders

Crypto, sports and AI bets are placed as **maker orders**: a post-only limit bid 1¢ above the best bid (never at or through the ask), instead of buying at the ask. That avoids Kalshi's taker fee, about 7% × P × (1−P) per contract, which can eat a third or more of a 4–5¢ edge. Edges are worked out at the bid price with the maker fee (`MAKER_FEE_RATE`, 0.0175, for markets that charge one).

- A resting bid's unfilled part counts against every risk limit as if it had filled.
- Crypto bids are cancelled after 2 minutes (`MAKER_TTL_SECONDS`), and sooner if a re-check finds the edge at our price is gone. Sports and AI bids rest up to 30 minutes (`MAKER_SLOW_TTL_SECONDS`), and sports bids always cancel before the game starts. Nothing rests into a market's final 2 minutes.
- Every live order carries Kalshi's own expiry time, so Kalshi cancels it even if the bot stops.
- The kill switch cancels all resting orders.
- Paper bids fill only when the market's ask falls to our price. Resting bids tend to fill just as the price turns against them, so paper results include that cost.
- Arbitrage still takes the ask, because all its legs must fill together.
- Set `MAKER_STRATEGIES` to `none` to go back to taking the ask everywhere.

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

The card has separate **Live** and **Paper** sections, so practice can run with a big bankroll while real money stays small. Each mode has its own bankroll, per-trade, per-market, per-event, open-at-once and daily-loss limits. Any field you haven't set falls back to the shared default. Max AI spend is one shared setting, because Claude costs real money in either mode. A strategy trading in demo uses the live limits.

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

Each strategy has its own **PAPER / LIVE** setting in the dashboard's **Strategies** card. Crypto can trade real money while the AI forecaster, sports and arbitrage keep paper-trading, or any other mix.

- **Go live with [strategy]:** sign in, open that strategy's link, re-enter your password, tick the confirmation box and tap the red button. It needs your Kalshi API key secrets.
- **Switch [strategy] to paper**, **Switch everything back to paper**, or the kill switch stop real trading instantly.
- The header shows which strategies are live, for example "LIVE: Crypto".
- Paper and live results are kept apart. Tabs above the stats switch between **Live results** and **Paper results**, and spending limits are counted separately for each.

Run paper for at least a few days first, check the model-check cards, and set small spending limits.

**Optional demo step:** Kalshi's [demo exchange](https://demo.kalshi.co) uses fake money with real order handling. Set `"BOT_MODE": "demo"` in `wrangler.jsonc` with demo API keys.

## Settings worth knowing

All are in `wrangler.jsonc` → `vars`.

- `MIN_EDGE` — the crypto edge needed after fees. Higher means fewer, more confident trades.
- `CRYPTO_CHEAP_BELOW` / `CRYPTO_CHEAP_MIN_EDGE` — crypto contracts priced under the first (default 0.30) need at least the second as edge (default 0.08).
- `MIN_ARB_PROFIT` — the locked-in profit needed per arbitrage set.
- `CRYPTO_ENABLED` / `ARB_ENABLED` — turn either strategy off.
- `CRYPTO_ASSETS` — which coins to trade.
- `KELLY_FRACTION` — 0.25 is conservative; don't go above 0.5.
- `MIN_ONE_CONTRACT` — on by default. When a bet clears the edge bar but sizes to under one contract (common with a small bankroll), it buys one contract anyway, still within every limit. Set `false` to skip those bets instead.
- Live bets are checked against the cash available in your Kalshi account. An order is shrunk to fit, or skipped with "not enough cash in Kalshi" in the log. While anything trades live, the dashboard's **Now** card shows the available cash as the bot sees it.
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
