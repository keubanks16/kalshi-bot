// The trading loop. Each tick it:
//   1. settles finished trades (once a minute),
//   2. scans one page of all open Kalshi markets inside your time limit —
//      looking for arbitrage and discovering crypto price markets,
//   3. re-prices the crypto series that are due and trades any real edge.
//
// Work per tick is capped so it fits Cloudflare's per-invocation subrequest
// limit; the full market list is covered over several ticks.

import { HORIZONS, MODE_LIMIT_FIELDS, cleanLimits, cleanPriceRange, cleanStrategyModes, cleanSwitches, limitSetOf, type Limits, type Mode, type Settings, type Strategy } from "./config.ts";
import { KalshiClient, KalshiError, askSize, dollars, makerQuotes, orderFilled, seriesOf, ts, type Market, type Order } from "./kalshi.ts";
import { decideBinary, fitToRoom, fmtEdge, planNoArb, probYesForStrike, requiredEdge, sideOf, takerFee, SUPPORTED_STRIKES } from "./model.ts";
import type { PriceFeed } from "./prices.ts";
import type { OrderRow, Store } from "./store.ts";
import { AiError, forecast as aiForecast, type Forecast } from "./ai.ts";
import { SPORTS, fairOdds, fetchOdds, matchGame, tickerDate, easternTickerDate, type OddsResult } from "./sports.ts";

const MAX_EVENT_LOOKUPS_PER_TICK = 5;
const EVENT_CACHE_SECONDS = 3600;
const DECISION_LOG_SECONDS = 300;

// Markets whose outcome depends on the path (touching a level at any time,
// the high or low of a period) can't be priced from where the price ends up.
const PATH_DEPENDENT = /any time|at any point|reach|touch|\bhit\b|highest|lowest|\bhigh\b|\blow\b|maximum|minimum/i;

interface SeriesState {
  asset: string;
  nextCheck: number;
  lastLogged: number;
}

interface BuyOrder {
  strategy: Strategy;
  market: Market;
  side: "yes" | "no";
  contracts: number;
  price: number;
  pFair?: number | null;
  edge?: number | null;
  note?: string;
  /** Maker orders only: cancel by this time (unix seconds) even if the usual expiry is later. */
  expiresAt?: number;
}

export function tradingDay(epochSeconds: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(epochSeconds * 1000));
}

export class Engine {
  s: Settings;
  base: Settings; // settings from wrangler.jsonc, before dashboard overrides
  client: KalshiClient;
  feed: PriceFeed;
  store: Store;
  clock: () => number; // epoch seconds

  // in-memory state (rebuilt automatically if the object restarts)
  series = new Map<string, SeriesState>();
  // Sports state
  oddsKey = "";
  sportsStatus = "starting";
  lastSportsAt = 0;
  oddsRemaining: number | null = null;
  sportsView: { game: string; start: string; books: string; kalshi: string; action: string; source: string }[] = [];
  oddsFetchFn: (key: string, sport: string, regions: string) => Promise<OddsResult> = (k, sp, r) => fetchOdds(k, sp, r);
  // AI forecaster state
  aiKey = "";
  aiCandidates = new Map<string, Market>();
  aiStatus = "starting";
  lastAiAt = 0;
  aiForecastFn: typeof aiForecast = aiForecast;
  eventInfo = new Map<string, { exclusive: boolean; standardFees: boolean; at: number }>();
  cursor = "";
  useTsFilter = true;
  lastSettle = 0;
  pagesThisCycle = 0;
  lastCycleMarkets = 0;
  cycleMarkets = 0;
  arbEventsChecked = 0;
  status = "starting";
  lastError: string | null = null;
  heartbeat = 0;
  private bankrollCache = new Map<string, { value: number; at: number }>();
  private modeLimits: Partial<Record<"paper" | "live", Partial<Limits>>> = {};
  private modeLimitsPrev: Partial<Record<"paper" | "live", Partial<Limits>>> = {};
  /** Spending limits in force for a mode: its own saved set, else the shared/default ones. */
  limitsFor(mode: Mode): Limits {
    const own = this.modeLimits[limitSetOf(mode)] ?? {};
    const s = this.s;
    return {
      bankroll: own.bankroll ?? s.bankroll,
      maxCostPerOrder: own.maxCostPerOrder ?? s.maxCostPerOrder,
      maxCostPerMarket: own.maxCostPerMarket ?? s.maxCostPerMarket,
      maxCostPerEvent: own.maxCostPerEvent ?? s.maxCostPerEvent,
      maxOpenRisk: own.maxOpenRisk ?? s.maxOpenRisk,
      maxDailyLoss: own.maxDailyLoss ?? s.maxDailyLoss,
      aiDailyBudget: s.aiDailyBudget,
    };
  }
  /** Per-strategy paper/live choice from the dashboard. */
  strategyModes: Partial<Record<Strategy, Mode>> = {};
  private eventLookups = 0;

  constructor(s: Settings, client: KalshiClient, feed: PriceFeed, store: Store, clock: () => number = () => Date.now() / 1000) {
    this.base = s;
    this.s = s;
    this.client = client;
    this.feed = feed;
    this.store = store;
    this.clock = clock;
  }

  horizon(): string {
    const h = this.store.get("horizon") ?? this.s.defaultHorizon;
    return HORIZONS[h] ? h : "day";
  }

  /** Latest close time the bot will trade, or null for no limit. */
  maxClose(now: number): number | null {
    const secs = HORIZONS[this.horizon()].seconds;
    return secs === null ? null : now + secs;
  }

  private inWindow(m: Market, now: number, maxClose: number | null): boolean {
    const close = ts(m.close_time);
    return close - now >= this.s.minSecondsLeft && (maxClose === null || close <= maxClose);
  }

  // ------------------------------------------------------------------ tick
  /** Spending limits saved from the dashboard override the deployed defaults. */
  applyOverrides(): void {
    let saved: Record<string, unknown> = {};
    try {
      saved = JSON.parse(this.store.get("limits") ?? "{}");
    } catch {}
    const w = Number(this.store.get("model_weight"));
    // Mode chosen on the dashboard (paper <-> live) overrides the deployed one.
    const mode = this.store.get("mode_override");
    const modeOverride = mode === "paper" || (mode === "live" && this.base.mode !== "demo") ? { mode: mode as Settings["mode"] } : {};
    const prevMode = this.s?.mode;
    let range = null;
    try {
      range = cleanPriceRange(JSON.parse(this.store.get("price_range") ?? "null"));
    } catch {}
    let switches = {};
    try {
      switches = cleanSwitches(JSON.parse(this.store.get("strategies") ?? "{}"));
    } catch {}
    this.s = { ...this.base, ...cleanLimits(saved), ...(w > 0 && w <= 1 ? { modelWeight: w } : {}), ...modeOverride, ...(range ?? {}), ...switches };
    if (prevMode && prevMode !== this.s.mode) this.bankrollCache.clear();
    // Paper and live each have their own spending limits on top of the shared ones.
    this.modeLimits = {};
    for (const set of ["paper", "live"] as const) {
      let raw: Record<string, unknown> = {};
      try {
        raw = JSON.parse(this.store.get(`limits_${set}`) ?? "{}");
      } catch {}
      const clean = cleanLimits(raw);
      const own = Object.fromEntries(MODE_LIMIT_FIELDS.filter((f) => clean[f.key] !== undefined).map((f) => [f.key, clean[f.key]]));
      this.modeLimits[set] = own;
    }
    // A changed bankroll should take effect now, not after the cache expires.
    if (JSON.stringify(this.modeLimits) !== JSON.stringify(this.modeLimitsPrev)) this.bankrollCache.clear();
    this.modeLimitsPrev = this.modeLimits;
    try {
      this.strategyModes = cleanStrategyModes(JSON.parse(this.store.get("strategy_modes") ?? "{}"), this.base.mode);
    } catch {
      this.strategyModes = {};
    }
  }

  async tick(): Promise<void> {
    this.applyOverrides();
    const now = this.clock();
    this.heartbeat = now;
    this.eventLookups = 0;
    for (const [k, v] of this.bankrollCache) if (now - v.at >= 60) this.bankrollCache.delete(k);

    if (now < this.cooldownUntil) {
      this.status = `Kalshi asked the bot to slow down — resuming in ${Math.ceil(this.cooldownUntil - now)}s.`;
      return;
    }
    const started = Date.now();
    try {
      await this.round(now);
      this.rateLimitStrikes = 0;
      this.rounds++;
      this.lastRoundMs = Date.now() - started;
      this.phase = "idle";
    } catch (e) {
      const where = this.phase;
      this.phase = "idle";
      if (!(e instanceof KalshiError && e.status === 429)) {
        (e as Error).message = `while ${where}: ${(e as Error).message}`;
        throw e;
      }
      // Back off 15s, 30s, 60s… up to 5 minutes, instead of hammering Kalshi.
      const wait = Math.min(300, 15 * 2 ** this.rateLimitStrikes++);
      this.cooldownUntil = now + wait;
      this.status = `Kalshi asked the bot to slow down (while ${where}) — resuming in ${wait}s.`;
    }
  }

  cooldownUntil = 0;
  rateLimitStrikes = 0;
  // diagnostics shown on /health
  phase = "idle";
  rounds = 0;
  lastRoundMs = 0;

  private async round(now: number): Promise<void> {
    if (now - this.lastSettle >= 60) {
      this.phase = "settling trades";
      await this.settle();
      this.lastSettle = now;
    }
    if (this.store.killSwitchOn()) {
      if (this.store.restingOrders().length) {
        this.phase = "cancelling resting orders";
        for (const o of this.store.restingOrders()) await this.cancelResting(o, now);
      }
      this.status = "Paused — kill switch is on";
      return;
    }
    this.phase = "checking resting orders";
    await this.manageOrders(now);
    if (this.s.cryptoEnabled && this.s.liveStreams) {
      this.phase = "connecting price streams";
      await this.feed.ensureStreams?.(this.s.cryptoAssets);
    } else if (this.feed.sockets?.size) {
      this.feed.closeStreams();
    }
    const maxClose = this.maxClose(now);
    this.phase = "scanning markets";
    await this.scanPage(now, maxClose);
    this.phase = "pricing crypto";
    if (this.s.cryptoEnabled) await this.runCrypto(now, maxClose);
    this.phase = "checking sports";
    await this.runSports(now, maxClose);

    const label = HORIZONS[this.horizon()].label.toLowerCase();
    this.status =
      `Watching markets closing ${label}: ${this.series.size} crypto series, ` +
      `${this.lastCycleMarkets || this.cycleMarkets} markets per full scan, ${this.arbEventsChecked} events checked for arbitrage` +
      (this.s.cryptoEnabled && this.feed.describe ? ` · prices from ${this.feed.describe()}.` : ".");
  }

  // ------------------------------------------------------------ settlement
  async settle(): Promise<void> {
    const open = this.store.openTrades();
    if (!open.length) return;
    const tickers = [...new Set(open.map((t) => t.ticker))].slice(0, 100);
    const markets = new Map((await this.client.getMarketsByTicker(tickers)).map((m) => [m.ticker, m]));
    const now = this.clock();
    for (const t of open) {
      const result = String(markets.get(t.ticker)?.result ?? "").toLowerCase();
      if (result !== "yes" && result !== "no") continue;
      const payout = result === t.side ? t.contracts : 0;
      this.store.settleTrade(t.id, result, Math.round((payout - t.cost) * 10000) / 10000, now);
    }
  }

  // ---------------------------------------------------------------- scan
  async scanPage(now: number, maxClose: number | null): Promise<void> {
    const params: Record<string, string | number | undefined> = { status: "open", limit: 500, cursor: this.cursor || undefined };
    if (this.useTsFilter) {
      params.min_close_ts = Math.floor(now + this.s.minSecondsLeft);
      if (maxClose !== null) params.max_close_ts = Math.floor(maxClose);
    }
    let page;
    try {
      page = await this.client.getMarketsPage(params);
    } catch (e) {
      if (e instanceof KalshiError && e.status === 400 && this.useTsFilter) {
        this.useTsFilter = false; // fall back to filtering here
        return;
      }
      throw e;
    }

    const markets = page.markets.filter((m) => this.inWindow(m, now, maxClose));
    this.cycleMarkets += markets.length;
    this.pagesThisCycle++;
    this.cursor = page.cursor;
    if (!this.cursor) {
      this.lastCycleMarkets = this.cycleMarkets;
      this.cycleMarkets = 0;
      this.pagesThisCycle = 0;
    }

    const byEvent = new Map<string, Market[]>();
    for (const m of markets) {
      const list = byEvent.get(m.event_ticker) ?? [];
      list.push(m);
      byEvent.set(m.event_ticker, list);
      const asset = this.cryptoAsset(m);
      const series = seriesOf(m.event_ticker);
      if (asset && !this.series.has(series)) this.series.set(series, { asset, nextCheck: now, lastLogged: 0 });
      if (!asset && !this.isCryptoSeries(series) && this.aiWorthy(m, now)) {
        this.aiCandidates.set(m.ticker, m);
        if (this.aiCandidates.size > 1000) this.aiCandidates.delete(this.aiCandidates.keys().next().value!); // drop oldest
      }
    }

    if (this.s.arbEnabled) {
      for (const [eventTicker, ms] of byEvent) {
        if (ms.length >= 2) await this.tryArb(eventTicker, ms, now);
      }
    }
  }

  /** The crypto asset a market is priced on, if it's one we can model. */
  cryptoAsset(m: Market): string | null {
    const series = seriesOf(m.event_ticker);
    const asset = this.s.cryptoAssets.find((a) => series.startsWith(`KX${a}`));
    if (!asset) return null;
    if (!SUPPORTED_STRIKES.has(String(m.strike_type ?? ""))) return null;
    const rules = String(m.rules_primary ?? "");
    if (!/CF Benchmarks/i.test(rules) || PATH_DEPENDENT.test(rules)) return null;
    return asset;
  }

  // ------------------------------------------------------------ arbitrage
  async tryArb(eventTicker: string, markets: Market[], now: number): Promise<void> {
    const active = markets.filter((m) => !m.status || m.status === "active");
    if (active.length < 2) return;

    // Cheap pre-check before spending a request on the event: a NO basket
    // only pays if the YES bids add up to more than $1.
    const yesBids = active.reduce((sum, m) => sum + (dollars(m, "yes_bid") ?? 0), 0);
    if (yesBids <= 1) return;

    let info = this.eventInfo.get(eventTicker);
    if (!info || now - info.at > EVENT_CACHE_SECONDS) {
      if (this.eventLookups >= MAX_EVENT_LOOKUPS_PER_TICK) return;
      this.eventLookups++;
      this.phase = `looking up event ${eventTicker}`;
      const ev = await this.client.getEvent(eventTicker);
      info = {
        exclusive: ev.mutually_exclusive === true,
        standardFees: !ev.fee_type_override && !ev.fee_multiplier_override,
        at: now,
      };
      this.eventInfo.set(eventTicker, info);
    }
    this.arbEventsChecked++;
    if (!info.exclusive || !info.standardFees) return;

    const legs = active.flatMap((m) => {
      const noAsk = dollars(m, "no_ask");
      const size = askSize(m, "no");
      return noAsk === null || size === null ? [] : [{ ticker: m.ticker, noAsk, size }];
    });
    const room = this.room(eventTicker, null, this.modeFor("arb"));
    const plan = planNoArb(legs, this.s.takerFeeRate, this.s.minArbProfit, this.s.maxContractsPerOrder, room);
    if (!plan) return;

    // Every leg has to fit its own market limit too, or we skip the whole thing.
    const byTicker = new Map(active.map((m) => [m.ticker, m]));
    for (const l of plan.legs) {
      const legCost = plan.sets * l.noAsk + takerFee(plan.sets, l.noAsk, this.s.takerFeeRate);
      if (this.room(eventTicker, l.ticker, this.modeFor("arb")) < legCost) return;
    }

    const note = `arb ${eventTicker}: ${plan.legs.length} NO legs x${plan.sets}, locks in +$${plan.profit.toFixed(2)}`;
    let sets = plan.sets;
    for (const l of plan.legs) {
      const filled = await this.buy({ strategy: "arb", market: byTicker.get(l.ticker)!, side: "no", contracts: sets, price: l.noAsk, note });
      if (filled < sets) {
        if (filled === 0) {
          this.lastError = `Arbitrage on ${eventTicker} stopped part-way: a leg didn't fill. Earlier legs are held to settlement.`;
          break;
        }
        sets = filled; // keep the remaining legs matched to what actually filled
      }
    }
    this.store.addDecision({ ts: now, strategy: "arb", ticker: eventTicker, action: "buy_no_basket", reason: note });
  }

  // --------------------------------------------------------------- crypto
  async runCrypto(now: number, maxClose: number | null): Promise<void> {
    const due = [...this.series.entries()].filter(([, st]) => st.nextCheck <= now).sort((a, b) => a[1].nextCheck - b[1].nextCheck).slice(0, this.s.seriesPerTick);

    for (const [series, st] of due) {
      this.phase = `pricing ${series}`;
      const markets = (await this.client.getMarkets({ series_ticker: series, status: "open", limit: 200 })).filter(
        (m) => this.inWindow(m, now, maxClose) && this.cryptoAsset(m) && (!m.status || m.status === "active"),
      );
      if (!markets.length) {
        st.nextCheck = now + 300;
        continue;
      }

      const spot = await this.feed.spot(st.asset);
      const bankroll = await this.bankroll(this.modeFor("crypto"));
      let best: { ticker: string; action: string; reason: string; p: number; price: number | null; edge: number } | null = null;
      let nearest = Infinity;

      for (const m of markets) {
        const secondsLeft = ts(m.close_time) - now;
        nearest = Math.min(nearest, secondsLeft);
        if (now - ts(m.open_time) < this.s.minSecondsElapsed) continue;

        const rawVol = await this.feed.volatility(st.asset, secondsLeft);
        const vol = Math.min(Math.max(rawVol, this.s.minVol), this.s.maxVol);
        const averaged = /average/i.test(String(m.rules_primary ?? ""));
        const model = probYesForStrike(String(m.strike_type), num(m.floor_strike), num(m.cap_strike), spot, secondsLeft, vol, averaged);
        if (model === null) continue;
        // Humility: the market sees the exact settlement index and we only
        // approximate it, so blend our estimate with the market's own price.
        // An empty or one-sided book (no bids, a lone offer at 79¢) has no
        // meaningful midpoint to blend with, and a bid there won't fill.
        const yb = dollars(m, "yes_bid");
        const ya = dollars(m, "yes_ask");
        const thin = yb === null || ya === null || !(yb > 0) || !(ya < 1) || ya - yb > this.s.cryptoMaxSpread + 1e-9;
        if (thin && !this.store.restingOrders(this.modeFor("crypto")).some((o) => o.ticker === m.ticker)) {
          if (!best) best = { ticker: m.ticker, action: "hold", reason: "book too thin to price", p: model, price: null, edge: -Infinity };
          continue;
        }
        const p = blendWithMarket(model, yb, ya, this.s.modelWeight);
        const limits = { ...this.s, cheapBelow: this.s.cryptoCheapBelow, cheapMinEdge: this.s.cryptoCheapMinEdge };

        // A resting bid tends to fill just as the price turns against it, so
        // re-check it every time: if the edge at our price is gone, pull it.
        const resting = this.store.restingOrders(this.modeFor("crypto")).find((o) => o.ticker === m.ticker);
        if (resting) {
          const left = (resting.side === "yes" ? p : 1 - p) - resting.price - takerFee(100, resting.price, this.s.makerFeeRate) / 100;
          if (left < requiredEdge(resting.price, limits)) await this.cancelResting(resting, now);
          continue;
        }

        const q = this.quotes(m, "crypto");
        const d = decideBinary(p, q.yes, q.no, bankroll, { ...limits, takerFeeRate: q.feeRate });
        const side = sideOf(d);
        let reason = d.reason;
        if (side && d.price !== undefined) {
          const r = await this.enter({ strategy: "crypto", market: m, side, contracts: d.contracts, price: d.price, pFair: side === "yes" ? p : 1 - p, edge: d.edge });
          reason = `${d.reason}; ${r.message}`;
          this.store.addDecision({ ts: now, strategy: "crypto", ticker: m.ticker, action: d.action, reason, p_fair: p, price: d.price });
          st.lastLogged = now;
        }
        if (!best || d.edge > best.edge) best = { ticker: m.ticker, action: d.action, reason, p, price: d.price ?? null, edge: d.edge };
      }

      if (best && now - st.lastLogged >= DECISION_LOG_SECONDS) {
        this.store.addDecision({ ts: now, strategy: "crypto", ticker: best.ticker, action: "hold", reason: `best in ${series}: ${best.reason}`, p_fair: best.p, price: best.price });
        st.lastLogged = now;
      }
      // Re-check short-dated series often and long-dated ones rarely.
      st.nextCheck = now + Math.min(300, Math.max(this.s.pollSeconds, nearest / 30));
    }
  }

  // ------------------------------------------------------------------ sports
  async runSports(now: number, maxClose: number | null): Promise<void> {
    if (!this.s.sportsEnabled) return void (this.sportsStatus = "Off.");
    if (!this.oddsKey) return void (this.sportsStatus = "Off: add the ODDS_API_KEY secret (the-odds-api.com).");
    if (now - this.lastSportsAt < this.s.sportsIntervalMinutes * 60) return;
    this.lastSportsAt = now;

    const day = tradingDay(now, this.s.timezone);
    const creditKey = `odds_credits_${day}`;
    let used = Number(this.store.get(creditKey) ?? 0);
    const perCall = this.s.sportsRegions.split(",").filter(Boolean).length;
    const bankroll = await this.bankroll(this.modeFor("sports"));
    const latestStart = maxClose ?? now + 7 * 86400;
    const view: typeof this.sportsView = [];
    let checked = 0;
    let traded = 0;
    let budgetHit = false;
    let oddsError = "";

    for (const sportKey of this.s.sportsList) {
      const sport = SPORTS[sportKey];
      if (!sport) continue;
      // Kalshi first (free): skip the paid odds call if there are no open games.
      let events: Awaited<ReturnType<KalshiClient["getEventsWithMarkets"]>>;
      try {
        events = (await this.client.getEventsWithMarkets(sport.series)).filter((e) => (e.markets ?? []).some((m) => !m.status || m.status === "active"));
      } catch (e) {
        if (e instanceof KalshiError && e.status === 429) throw e; // let the round back off
        continue;
      }
      if (!events.length) continue;
      if (used + perCall > this.s.sportsDailyCredits) {
        budgetHit = true;
        break;
      }
      let odds: OddsResult;
      try {
        odds = await this.oddsFetchFn(this.oddsKey, sportKey, this.s.sportsRegions);
      } catch (e) {
        oddsError = (e as Error).message;
        continue;
      }
      used += odds.cost;
      this.store.set(creditKey, String(used));
      if (odds.remaining !== null) this.oddsRemaining = odds.remaining;

      for (const game of odds.games) {
        const start = Date.parse(game.commence_time) / 1000;
        // Pre-game only, and inside your time limit.
        if (start - now < this.s.sportsMinMinutesBeforeStart * 60 || start > latestStart) continue;
        const ev = events.find((e) => tickerDate(e.event_ticker) === easternTickerDate(game.commence_time) && matchGame(game, (e.markets ?? []) as any));
        if (!ev) continue;
        const map = matchGame(game, (ev.markets ?? []) as any)!;
        const fair = fairOdds(game, now * 1000);
        if (!fair) continue;
        checked++;
        const label = `${game.away_team} @ ${game.home_team}`;
        const startLabel = new Date(start * 1000).toISOString();

        if ((ev.markets ?? []).some((m) => this.store.openSides(m.ticker, this.modeFor("sports")).length)) {
          view.push({ game: label, start: startLabel, books: "", kalshi: "", action: "already holding a position", source: fair.source });
          continue;
        }
        // Best single bet in this game (YES or NO on any team).
        let best: { m: Market; d: ReturnType<typeof decideBinary>; p: number; outcome: string } | null = null;
        for (const m of ev.markets ?? []) {
          const outcome = map.get(m.ticker);
          const p = outcome ? fair.probs[outcome] : undefined;
          if (p === undefined) continue;
          const q = this.quotes(m, "sports");
          const d = decideBinary(p, q.yes, q.no, bankroll, { ...this.s, minEdge: this.s.sportsMinEdge, takerFeeRate: q.feeRate });
          if (!best || d.edge > best.d.edge) best = { m, d, p, outcome: outcome! };
        }
        if (!best) continue;
        const books = `${best.outcome} ${(best.p * 100).toFixed(0)}%`;
        const mid = (() => {
          const b = dollars(best.m, "yes_bid");
          const a = dollars(best.m, "yes_ask");
          return b !== null && a !== null ? `${(((a + b) / 2) * 100).toFixed(0)}¢` : "—";
        })();
        let action = `no bet: ${best.d.reason}`;
        const side = sideOf(best.d);
        if (side && best.d.price !== undefined) {
          const r = await this.enter({
            strategy: "sports",
            market: best.m,
            side,
            contracts: best.d.contracts,
            price: best.d.price,
            pFair: side === "yes" ? best.p : 1 - best.p,
            edge: best.d.edge,
            note: `${label}: ${fair.source} says ${books}`,
            // never leave a bid resting into the game
            expiresAt: start - this.s.sportsMinMinutesBeforeStart * 60,
          });
          if (r.ok) {
            traded++;
            action = `${r.message} (edge ${fmtEdge(best.d.edge)})`;
            this.store.addDecision({ ts: now, strategy: "sports", ticker: best.m.ticker, action: best.d.action, reason: `${label} — books ${books}, Kalshi ${mid}: ${action}`, p_fair: best.p, price: best.d.price });
          } else action = `edge ${fmtEdge(best.d.edge)} but blocked by limits`;
        }
        view.push({ game: label, start: startLabel, books, kalshi: `${best.outcome} ${mid}`, action, source: fair.source });
      }
    }
    this.sportsView = view.slice(0, 12);
    this.sportsStatus = budgetHit
      ? `Daily odds budget used (${used} of ${this.s.sportsDailyCredits} credits). Resumes tomorrow.`
      : oddsError && !checked
        ? `Odds error: ${oddsError}`
        : checked
          ? `Compared ${checked} upcoming game${checked > 1 ? "s" : ""} with the sportsbooks${traded ? `, bought ${traded}` : ""}. Next check in ${this.s.sportsIntervalMinutes} min.`
          : "No upcoming games inside your time limit match Kalshi right now.";
  }

  // ----------------------------------------------------------- AI forecaster
  isCryptoSeries(series: string): boolean {
    return this.s.cryptoAssets.some((a) => series.startsWith(`KX${a}`));
  }

  /** Liquid, two-sided, undecided, and far enough from closing for a slow forecast. */
  aiWorthy(m: Market, now: number): boolean {
    const bid = dollars(m, "yes_bid");
    const ask = dollars(m, "yes_ask");
    if (bid === null || ask === null || !(ask > bid) || ask - bid > 0.1) return false;
    const mid = (bid + ask) / 2;
    if (mid < 0.08 || mid > 0.92) return false;
    if (volume24h(m) < this.s.aiMinVolume) return false;
    return ts(m.close_time) - now >= this.s.aiMinHoursToClose * 3600 && (!m.status || m.status === "active");
  }

  /** Trust in AI shrinks if its settled bets win less often than it predicted. */
  aiTrustFactor(): number {
    const mc = this.store.modelCheck(this.modeFor("ai"), "ai");
    if (mc.settled < 20 || mc.expectedWins <= 0) return 1;
    return Math.min(1, Math.max(0.5, mc.actualWins / mc.expectedWins));
  }

  /** At most one forecast per call; the Durable Object runs this in the background. */
  async runAi(now: number): Promise<void> {
    if (!this.s.aiEnabled) return void (this.aiStatus = "Off.");
    if (!this.aiKey) return void (this.aiStatus = "Off: add the ANTHROPIC_API_KEY secret.");
    if (this.store.killSwitchOn()) return void (this.aiStatus = "Paused by the kill switch.");
    if (now - this.lastAiAt < this.s.aiIntervalMinutes * 60) return;

    const day = tradingDay(now, this.s.timezone);
    const spent = this.store.aiSpend(day);
    if (spent + 0.25 > this.s.aiDailyBudget) {
      this.aiStatus = `Daily AI budget used ($${spent.toFixed(2)} of $${this.s.aiDailyBudget.toFixed(2)}). Resumes tomorrow.`;
      return;
    }

    const maxClose = this.maxClose(now);
    const pick = [...this.aiCandidates.values()]
      .filter((m) => (maxClose === null || ts(m.close_time) <= maxClose) && this.aiWorthy(m, now))
      .filter((m) => now - this.store.lastForecastTs(m.ticker) >= this.s.aiRefreshHours * 3600)
      .filter((m) => this.store.openSides(m.ticker, this.modeFor("ai")).length === 0)
      .sort((a, b) => volume24h(b) - volume24h(a))[0];
    this.lastAiAt = now;
    if (!pick) {
      this.aiStatus =
        maxClose !== null && maxClose - now < this.s.aiMinHoursToClose * 3600
          ? `Idle: your time limit is shorter than the ${this.s.aiMinHoursToClose}h the AI needs. Pick 1 day or longer.`
          : `Idle: no new liquid markets to research yet (${this.aiCandidates.size} seen so far).`;
      return;
    }
    this.aiCandidates.delete(pick.ticker);

    let eventTitle = pick.event_ticker;
    try {
      const ev = await this.client.getEvent(pick.event_ticker);
      eventTitle = String(ev.title ?? eventTitle);
      if (ev.fee_type_override || ev.fee_multiplier_override) {
        this.store.addForecast({ ts: now, day, ticker: pick.ticker, title: eventTitle, p: null, confidence: null, summary: "Skipped: non-standard fees.", market_mid: null, cost: 0, searches: 0, action: "skip" });
        return;
      }
    } catch {
      /* title is cosmetic */
    }
    const title = [eventTitle, String(pick.yes_sub_title ?? pick.title ?? "")].filter(Boolean).join(" — ");

    this.aiStatus = `Researching: ${title}`;
    let f: Forecast;
    try {
      f = await this.aiForecastFn(
        { eventTitle, marketTitle: String(pick.yes_sub_title ?? pick.title ?? pick.ticker), rules: [pick.rules_primary, pick.rules_secondary].filter(Boolean).join("\n\n"), closeTime: pick.close_time, now: new Date(now * 1000).toISOString() },
        { apiKey: this.aiKey, model: this.s.aiModel, maxSearches: this.s.aiMaxSearches, inputPricePerM: this.s.aiInputPrice, outputPricePerM: this.s.aiOutputPrice },
      );
    } catch (e) {
      const cost = e instanceof AiError ? e.cost : 0;
      this.store.addForecast({ ts: now, day, ticker: pick.ticker, title, p: null, confidence: null, summary: `Failed: ${(e as Error).message}`, market_mid: null, cost, searches: 0, action: "error" });
      this.aiStatus = `Last forecast failed: ${(e as Error).message}`;
      return;
    }

    // Prices may have moved while Claude was researching.
    const m = await this.client.getMarket(pick.ticker);
    const bid = dollars(m, "yes_bid");
    const ask = dollars(m, "yes_ask");
    const mid = bid !== null && ask !== null ? (bid + ask) / 2 : null;
    const weight = this.s.modelWeight * this.aiTrustFactor();
    const p = blendWithMarket(f.probability, bid, ask, weight);

    let action: string;
    if (f.confidence === "low") {
      action = "no bet: low confidence";
    } else {
      const q = this.quotes(m, "ai");
      const d = decideBinary(p, q.yes, q.no, await this.bankroll(this.modeFor("ai")), { ...this.s, minEdge: this.s.aiMinEdge, takerFeeRate: q.feeRate });
      const side = sideOf(d);
      if (side && d.price !== undefined) {
        const r = await this.enter({ strategy: "ai", market: { ...pick, ...m }, side, contracts: d.contracts, price: d.price, pFair: side === "yes" ? p : 1 - p, edge: d.edge, note: f.summary });
        action = r.ok ? `${r.message} (edge ${fmtEdge(d.edge)})` : `edge ${fmtEdge(d.edge)} but blocked by limits`;
      } else {
        action = `no bet: ${d.reason}`;
      }
    }
    this.store.addForecast({ ts: now, day, ticker: pick.ticker, title, p: f.probability, confidence: f.confidence, summary: f.summary, market_mid: mid, cost: f.cost, searches: f.searches, action });
    this.store.addDecision({ ts: now, strategy: "ai", ticker: pick.ticker, action: action.startsWith("bought") || action.startsWith("posted") ? "buy" : "hold", reason: `AI ${(f.probability * 100).toFixed(0)}% vs market ${mid === null ? "?" : (mid * 100).toFixed(0) + "%"}: ${action}`, p_fair: p, price: mid });
    this.aiStatus = `Last: ${title} — AI ${(f.probability * 100).toFixed(0)}%, ${action}`;
  }

  // ------------------------------------------------------------ execution
  /** Paper or live for one strategy: its own dashboard setting, else the bot's overall mode. */
  modeFor(strategy: Strategy): Mode {
    return this.strategyModes[strategy] ?? this.s.mode;
  }

  async bankroll(mode: Mode = this.s.mode): Promise<number> {
    const hit = this.bankrollCache.get(mode);
    if (hit) return hit.value;
    let value: number;
    if (mode !== "paper") {
      // Never size off more than the configured bankroll, even if the account holds more.
      value = Math.min(await this.client.getBalance(), this.limitsFor(mode).bankroll);
    } else {
      const sum = this.store.summary("paper");
      value = this.limitsFor(mode).bankroll + sum.pnl - sum.openCost;
    }
    this.bankrollCache.set(mode, { value, at: this.clock() });
    return value;
  }

  /** Dollars the risk limits still allow on this event (and market, if given), counted within one mode. */
  room(eventTicker: string, ticker: string | null, mode: Mode = this.s.mode): number {
    const s = { ...this.s, ...this.limitsFor(mode) };
    let room = Math.min(
      s.maxCostPerEvent - this.store.eventExposure(eventTicker, mode),
      s.maxOpenRisk - this.store.openRisk(mode),
      s.maxDailyLoss - this.store.dayLoss(tradingDay(this.clock(), s.timezone), mode),
    );
    if (ticker) {
      const ex = this.store.marketExposure(ticker, mode);
      if (ex.orders >= s.maxOrdersPerMarket) return 0;
      room = Math.min(room, s.maxCostPerMarket - ex.cost, s.maxCostPerOrder);
    }
    return Math.max(0, room);
  }

  // ------------------------------------------------------------ maker orders
  usesMaker(strategy: Strategy): boolean {
    return this.s.makerStrategies.includes(strategy);
  }

  /** Prices a strategy would pay for YES and NO, and the fee rate that goes with them. */
  quotes(m: Market, strategy: Strategy): { yes: number | null; no: number | null; feeRate: number } {
    if (!this.usesMaker(strategy)) return { yes: dollars(m, "yes_ask"), no: dollars(m, "no_ask"), feeRate: this.s.takerFeeRate };
    return { ...makerQuotes(m), feeRate: this.s.makerFeeRate };
  }

  /** Enter a position the way this strategy is set to: rest a maker bid, or take the ask. */
  async enter(o: BuyOrder): Promise<{ ok: boolean; message: string }> {
    const sideUp = o.side.toUpperCase();
    if (!this.usesMaker(o.strategy)) {
      const filled = await this.buy(o);
      return filled ? { ok: true, message: `bought ${filled} ${sideUp} @ $${o.price.toFixed(2)}` } : { ok: false, message: "not filled or blocked by limits" };
    }
    const r = await this.placeMaker(o);
    if (!r.filled && !r.resting) return { ok: false, message: "not posted or blocked by limits" };
    const parts = [r.filled ? `bought ${r.filled}` : "", r.resting ? `posted ${r.resting}` : ""].filter(Boolean).join(", ");
    return { ok: true, message: `${parts} ${sideUp} @ $${o.price.toFixed(2)} (maker${r.resting ? ", resting" : ""})` };
  }

  /** Rest a post-only bid. Its unfilled part counts against every limit until it fills, expires or is cancelled. */
  async placeMaker(o: BuyOrder): Promise<{ filled: number; resting: number }> {
    const m = o.market;
    const mode = this.modeFor(o.strategy);
    const none = { filled: 0, resting: 0 };
    if (this.store.openSides(m.ticker, mode).some((side) => side !== o.side)) return none;
    const contracts = fitToRoom(o.contracts, o.price, this.room(m.event_ticker, m.ticker, mode), this.s.makerFeeRate);
    if (contracts < 1) return none;

    const now = this.clock();
    const close = ts(m.close_time);
    const ttl = o.strategy === "crypto" ? this.s.makerTtlSeconds : this.s.makerSlowTtlSeconds;
    const expiresAt = Math.floor(Math.min(now + ttl, close - this.s.minSecondsLeft, o.expiresAt ?? Infinity));
    if (expiresAt - now < 10) return none;

    let orderId: string;
    let placed: Order = {};
    if (mode !== "paper") {
      try {
        placed = await this.client.createMakerOrder(m.ticker, o.side, contracts, o.price, expiresAt);
      } catch (e) {
        if (e instanceof KalshiError && e.status === 429) throw e;
        // Post-only orders are rejected if the price would cross; just skip this round.
        this.lastError = `Maker order on ${m.ticker} failed: ${(e as Error).message}`;
        return none;
      }
      if (!placed.order_id) {
        this.lastError = `Maker order on ${m.ticker}: Kalshi returned no order id.`;
        return none;
      }
      orderId = placed.order_id;
    } else {
      orderId = `paper-${crypto.randomUUID()}`;
    }

    const row: OrderRow = {
      id: 0,
      ts: now,
      day: tradingDay(now, this.s.timezone),
      mode,
      strategy: o.strategy,
      ticker: m.ticker,
      event_ticker: m.event_ticker,
      side: o.side,
      price: o.price,
      count: contracts,
      filled: 0,
      fee_paid: 0,
      order_id: orderId,
      p_fair: o.pFair ?? null,
      edge: o.edge ?? null,
      note: o.note ?? null,
      close_ts: close,
      expires_ts: expiresAt,
      status: "resting",
    };
    const { id: _id, status: _status, ...insert } = row;
    row.id = this.store.addOrder(insert);
    this.bankrollCache.delete(mode);
    if (mode !== "paper") this.syncOrder(row, placed, now);
    return { filled: row.filled, resting: row.status === "resting" ? row.count - row.filled : 0 };
  }

  /** Record any new fills Kalshi reports on a live order, and close it out if Kalshi has. */
  private syncOrder(row: OrderRow, live: Order, now: number): void {
    const filled = Math.min(row.count, orderFilled(live));
    const feeTotal = live.maker_fees_dollars !== undefined ? Number(live.maker_fees_dollars) + Number(live.taker_fees_dollars ?? 0) : null;
    this.recordFill(row, filled, feeTotal, now);
    const st = String(live.status ?? "");
    if (st && st !== "resting") this.closeOrder(row, st === "executed" ? "filled" : "canceled");
  }

  /** Book fills up to `filledTotal` contracts as trades (each new batch is one trade row). */
  private recordFill(row: OrderRow, filledTotal: number, feeTotal: number | null, now: number): void {
    const add = filledTotal - row.filled;
    if (add < 1) return;
    const est = takerFee(filledTotal, row.price, this.s.makerFeeRate);
    const total = feeTotal === null || !Number.isFinite(feeTotal) ? Math.max(est, row.fee_paid) : feeTotal;
    const fee = Math.max(0, Math.round((total - row.fee_paid) * 10000) / 10000);
    this.store.addTrade({
      ts: now,
      day: tradingDay(now, this.s.timezone),
      mode: row.mode,
      strategy: row.strategy,
      ticker: row.ticker,
      event_ticker: row.event_ticker,
      side: row.side,
      contracts: add,
      price: row.price,
      fee,
      cost: Math.round((add * row.price + fee) * 10000) / 10000,
      p_fair: row.p_fair,
      edge: row.edge,
      note: row.note,
      order_id: row.order_id,
      close_ts: row.close_ts,
    });
    row.filled = filledTotal;
    row.fee_paid = row.fee_paid + fee;
    if (row.filled >= row.count) row.status = "filled";
    this.store.updateOrder(row.id, row.filled, row.fee_paid, row.status);
    this.bankrollCache.delete(row.mode);
    this.store.addDecision({
      ts: now,
      strategy: row.strategy,
      ticker: row.ticker,
      action: row.side === "yes" ? "buy_yes" : "buy_no",
      reason: `maker bid filled: bought ${add} ${row.side.toUpperCase()} @ $${row.price.toFixed(2)}${row.filled < row.count ? ` (${row.filled} of ${row.count})` : ""}`,
      p_fair: row.p_fair,
      price: row.price,
    });
  }

  private closeOrder(row: OrderRow, status: "filled" | "canceled"): void {
    row.status = row.filled >= row.count ? "filled" : status;
    this.store.updateOrder(row.id, row.filled, row.fee_paid, row.status);
    this.bankrollCache.delete(row.mode);
  }

  /** Each round: pick up fills on resting orders, and cancel any that are stale or near the market's close. */
  async manageOrders(now: number): Promise<void> {
    const rows = this.store.restingOrders();
    if (!rows.length) return;

    // Paper: a resting bid fills only once the market trades down to it (the
    // ask on our side reaches our price), which is when real ones fill too.
    const paper = rows.filter((r) => r.mode === "paper");
    if (paper.length) {
      const fresh = new Map((await this.client.getMarketsByTicker([...new Set(paper.map((r) => r.ticker))])).map((m) => [m.ticker, m]));
      for (const r of paper) {
        const m = fresh.get(r.ticker);
        const ask = m ? dollars(m, r.side === "yes" ? "yes_ask" : "no_ask") : null;
        if (ask !== null && ask <= r.price + 1e-9) this.recordFill(r, r.count, null, now);
      }
    }

    for (const r of rows) {
      if (r.status !== "resting") continue;
      if (r.mode !== "paper") {
        try {
          this.syncOrder(r, await this.client.getOrder(r.order_id!), now);
        } catch (e) {
          if (e instanceof KalshiError && e.status === 429) throw e;
          if (e instanceof KalshiError && e.status === 404) this.closeOrder(r, "canceled");
          else this.lastError = `Checking order on ${r.ticker} failed: ${(e as Error).message}`;
          continue;
        }
        if (r.status !== "resting") continue;
      }
      if (now >= r.expires_ts || (r.close_ts !== null && now >= r.close_ts - this.s.minSecondsLeft)) await this.cancelResting(r, now);
    }
  }

  /** Cancel a resting order, booking whatever filled before the cancel landed. */
  async cancelResting(r: OrderRow, now: number): Promise<void> {
    if (r.mode !== "paper") {
      try {
        const final = (await this.client.cancelOrder(r.order_id!)) ?? (await this.client.getOrder(r.order_id!));
        this.syncOrder(r, { ...final, status: "canceled" }, now);
        return;
      } catch (e) {
        if (e instanceof KalshiError && e.status === 429) throw e;
        // Already gone (filled, expired or cancelled): read its final state.
        try {
          const final = await this.client.getOrder(r.order_id!);
          this.syncOrder(r, final, now);
          if (String(final.status ?? "") === "resting") {
            this.lastError = `Couldn't cancel order on ${r.ticker}: ${(e as Error).message}. Kalshi will expire it.`;
            return;
          }
        } catch {
          // Can't reach it; Kalshi's own expiry still cancels it. Stop reserving
          // limits for it only once that expiry has passed.
          if (now < r.expires_ts) {
            this.lastError = `Couldn't cancel order on ${r.ticker}: ${(e as Error).message}. Kalshi will expire it.`;
            return;
          }
        }
      }
    }
    this.closeOrder(r, "canceled");
  }

  /** Place (or simulate) a buy within every limit. Returns contracts filled. */
  async buy(o: BuyOrder): Promise<number> {
    const m = o.market;
    const mode = this.modeFor(o.strategy);
    // Never bet against our own open position on the same market.
    if (this.store.openSides(m.ticker, mode).some((side) => side !== o.side)) return 0;
    const contracts = fitToRoom(o.contracts, o.price, this.room(m.event_ticker, m.ticker, mode), this.s.takerFeeRate);
    if (contracts < 1) return 0;

    let filled: number;
    let fee: number;
    let orderId: string | null = null;
    if (mode !== "paper") {
      try {
        const order = await this.client.createOrder(m.ticker, o.side, contracts, o.price);
        orderId = order.order_id ?? null;
        filled = Math.floor(Number(order.fill_count_fp ?? order.fill_count ?? 0));
        fee = Number(order.taker_fees_dollars ?? 0) || takerFee(filled, o.price, this.s.takerFeeRate);
      } catch (e) {
        this.lastError = `Order on ${m.ticker} failed: ${(e as Error).message}`;
        return 0;
      }
    } else {
      // Paper: assume we take the displayed ask, limited by the size showing there.
      const shown = askSize(m, o.side);
      filled = shown === null ? contracts : Math.min(contracts, shown);
      fee = takerFee(filled, o.price, this.s.takerFeeRate);
    }
    if (filled < 1) return 0;

    const now = this.clock();
    this.store.addTrade({
      ts: now,
      day: tradingDay(now, this.s.timezone),
      mode,
      strategy: o.strategy,
      ticker: m.ticker,
      event_ticker: m.event_ticker,
      side: o.side,
      contracts: filled,
      price: o.price,
      fee,
      cost: Math.round((filled * o.price + fee) * 10000) / 10000,
      p_fair: o.pFair ?? null,
      edge: o.edge ?? null,
      note: o.note ?? null,
      order_id: orderId,
      close_ts: ts(m.close_time),
    });
    this.bankrollCache.delete(mode);
    return filled;
  }
}

/** Weighted average of the model's P(yes) and the market's mid price (model only if no quotes). */
export function volume24h(m: Market): number {
  return Number(m.volume_24h_fp ?? m.volume_24h ?? 0) || 0;
}

export function blendWithMarket(model: number, yesBid: number | null, yesAsk: number | null, weight: number): number {
  if (yesBid === null || yesAsk === null || !(yesAsk > yesBid)) return model;
  const mid = (yesBid + yesAsk) / 2;
  return weight * model + (1 - weight) * mid;
}

function num(v: unknown): number | null {
  const n = Number(v);
  return v === null || v === undefined || v === "" || !Number.isFinite(n) ? null : n;
}

export { fmtEdge };
