// The Durable Object that owns the trading loop and its SQLite database.
// An alarm fires every POLL_SECONDS; each alarm runs one engine tick and
// schedules the next. A once-a-minute cron makes sure the alarm is running.

import { DurableObject } from "cloudflare:workers";
import { HORIZONS, LIMIT_FIELDS, STRATEGIES, STRATEGY_SWITCHES, baseUrl, cleanLimits, cleanPriceRange, cleanStrategyModes, cleanSwitches, type Mode, type Strategy, limitsOf, loadSettings, validate, type Env, type Limits, type Settings } from "./config.ts";
import { Engine, tradingDay } from "./engine.ts";
import { KalshiClient, importPrivateKey } from "./kalshi.ts";
import { PriceFeed } from "./prices.ts";
import { Store, type Sql } from "./store.ts";

export interface Snapshot {
  mode: string;
  view?: string; // which mode's trades and P&L are shown
  views?: string[];
  canGoLive?: boolean;
  keysSet?: boolean;
  message?: string | null;
  testSince?: number; // stats count trades from here (0 = all history)
  showingAll?: boolean;
  priceRange?: { min: number; max: number; dfltMin: number; dfltMax: number };
  switches?: { key: string; strategy: string; label: string; on: boolean; mode: string }[];
  sports?: {
    on: boolean;
    status: string;
    creditsToday: number;
    creditBudget: number;
    remaining: number | null;
    games: { game: string; start: string; books: string; kalshi: string; action: string; source: string }[];
    check: { settled: number; expectedWins: number; actualWins: number; avgPrice: number };
  };
  problem: string | null;
  status: string;
  lastError: string | null;
  alive: boolean;
  killSwitch: boolean;
  horizon: string;
  horizons: { key: string; label: string; short: string }[];
  limits: { key: string; label: string; help: string; value: number; dflt: number }[];
  modelWeight?: { value: number; dflt: number; options: number[] };
  modelCheck?: { settled: number; expectedWins: number; actualWins: number; avgPrice: number };
  ai?: {
    on: boolean;
    status: string;
    spentToday: number;
    budget: number;
    trust: number;
    forecasts: Record<string, any>[];
    check: { settled: number; expectedWins: number; actualWins: number; avgPrice: number };
  };
  summary: ReturnType<Store["summary"]>;
  today: number;
  byStrategy: { strategy: string; trades: number; pnl: number }[];
  trades: ReturnType<Store["recentTrades"]>;
  decisions: Record<string, any>[];
  timezone: string;
  diag: Record<string, unknown>;
}

export const VERSION = "0.9.0";

export const MODEL_WEIGHT_OPTIONS = [0.25, 0.5, 0.75, 1];

export class Bot extends DurableObject<Env> {
  store: Store;
  settings: Settings;
  problem: string | null;
  engine: Engine | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new Store(ctx.storage.sql as unknown as Sql);
    // First run of this version starts a fresh scorecard automatically.
    if (this.store.get("test_since") === null) this.store.set("test_since", String(Date.now() / 1000));
    this.settings = loadSettings(env);
    this.problem = validate(env, this.settings);
  }

  private async getEngine(): Promise<Engine> {
    if (this.engine) return this.engine;
    const s = this.settings;
    // Sign requests whenever a key is set, even in paper mode: Kalshi rate-limits
    // signed requests per account instead of per (shared) Cloudflare IP.
    const key = this.env.KALSHI_PRIVATE_KEY && this.env.KALSHI_API_KEY_ID ? await importPrivateKey(String(this.env.KALSHI_PRIVATE_KEY)) : null;
    const client = new KalshiClient(baseUrl(this.env, s), String(this.env.KALSHI_API_KEY_ID ?? ""), key);
    this.engine = new Engine(s, client, new PriceFeed(), this.store);
    this.engine.aiKey = String(this.env.ANTHROPIC_API_KEY ?? "");
    this.engine.oddsKey = String(this.env.ODDS_API_KEY ?? "");
    this.store.set("mode", s.mode);
    return this.engine;
  }

  /** Make sure the alarm loop is running. Safe to call any number of times. */
  async start(): Promise<void> {
    if (this.ticking) return; // an alarm is mid-run and will schedule the next one
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + 1000);
  }

  private ticking = false;
  private aiRunning = false;
  private tickStarted = 0;

  async alarm(): Promise<void> {
    // Schedule the next round first, so a slow round can never stop the loop.
    const wait = this.problem ? 60 : this.settings.pollSeconds; // misconfigured: check back slowly
    await this.ctx.storage.setAlarm(Date.now() + wait * 1000);
    if (this.problem) return;

    // Never run two rounds at once (unless one is clearly stuck).
    if (this.ticking && Date.now() - this.tickStarted < 90_000) return;
    this.ticking = true;
    this.tickStarted = Date.now();
    try {
      const engine = await this.getEngine();
      try {
        await engine.tick();
      } catch (e) {
        engine.lastError = `${new Date().toISOString().slice(11, 19)} UTC — ${(e as Error).message}`;
      }
      // AI research takes up to a couple of minutes, so it runs alongside the
      // fast loop instead of blocking it.
      if (!this.aiRunning) {
        this.aiRunning = true;
        const job = engine
          .runAi(Date.now() / 1000)
          .catch((e) => void (engine.aiStatus = `AI error: ${(e as Error).message}`))
          .finally(() => (this.aiRunning = false));
        this.ctx.waitUntil(job);
      }
    } finally {
      this.ticking = false;
    }
  }

  /** The mode trading right now: dashboard choice if any, else the deployed setting. */
  currentMode(): string {
    if (this.engine) return this.engine.s.mode;
    const o = this.store.get("mode_override");
    return o === "paper" || (o === "live" && this.settings.mode !== "demo") ? o : this.settings.mode;
  }

  private keysSet(): boolean {
    return !!(this.env.KALSHI_API_KEY_ID && this.env.KALSHI_PRIVATE_KEY);
  }

  async snapshot(viewArg?: string, all = false): Promise<Snapshot> {
    await this.start();
    const e = this.engine;
    const now = Date.now() / 1000;
    const tz = this.settings.timezone;
    const horizon = e?.horizon() ?? this.store.get("horizon") ?? this.settings.defaultHorizon;
    const modes = this.strategyModes();
    const anyReal = Object.values(modes).some((m) => m !== "paper");
    const mode = anyReal ? (this.settings.mode === "demo" ? "demo" : "live") : "paper";
    const views = [...new Set([...new Set(Object.values(modes)), ...this.store.modesWithTrades()])].sort((a, b) => (a === "paper" ? 1 : b === "paper" ? -1 : 0));
    const view = viewArg && views.includes(viewArg) ? viewArg : mode;
    const testSince = Number(this.store.get("test_since") ?? 0);
    const since = all ? 0 : testSince;
    const range = this.priceRange();
    return {
      mode,
      view,
      views,
      canGoLive: this.settings.mode !== "demo",
      keysSet: this.keysSet(),
      problem: this.problem,
      status: this.problem ? "Not running — fix the setting below" : e?.status ?? "Starting up…",
      lastError: e?.lastError ?? null,
      alive: !!e && now - e.heartbeat < Math.max(60, this.settings.pollSeconds * 6),
      killSwitch: this.store.killSwitchOn(),
      horizon,
      horizons: Object.entries(HORIZONS).map(([key, h]) => ({ key, label: h.label, short: h.short })),
      limits: this.limitRows(),
      modelWeight: { value: this.modelWeight(), dflt: this.settings.modelWeight, options: MODEL_WEIGHT_OPTIONS },
      summary: this.store.summary(view, since),
      testSince,
      showingAll: all,
      priceRange: { min: range.minPrice, max: range.maxPrice, dfltMin: this.settings.minPrice, dfltMax: this.settings.maxPrice },
      today: this.store.pnlForDay(tradingDay(now, tz), view, since),
      byStrategy: this.store.byStrategy(view, since),
      modelCheck: this.store.modelCheck(view, "crypto", since),
      switches: STRATEGY_SWITCHES.map((f, i) => ({ key: f.key, strategy: STRATEGIES[i], label: f.label, on: this.effective()[f.key], mode: modes[STRATEGIES[i]] })),
      sports: {
        on: !!(this.env.ODDS_API_KEY && this.effective().sportsEnabled),
        status: e?.sportsStatus ?? (this.env.ODDS_API_KEY ? "Starting…" : "Off: add the ODDS_API_KEY secret (the-odds-api.com)."),
        creditsToday: Number(this.store.get(`odds_credits_${tradingDay(now, tz)}`) ?? 0),
        creditBudget: this.settings.sportsDailyCredits,
        remaining: e?.oddsRemaining ?? null,
        games: e?.sportsView ?? [],
        check: this.store.modelCheck(view, "sports", since),
      },
      ai: {
        on: !!(this.env.ANTHROPIC_API_KEY && this.effective().aiEnabled),
        status: e?.aiStatus ?? (this.env.ANTHROPIC_API_KEY ? "Starting…" : "Off: add the ANTHROPIC_API_KEY secret."),
        spentToday: this.store.aiSpend(tradingDay(now, tz)),
        budget: e?.s.aiDailyBudget ?? this.settings.aiDailyBudget,
        trust: e ? e.aiTrustFactor() : 1,
        forecasts: this.store.recentForecasts(8),
        check: this.store.modelCheck(view, "ai", since),
      },
      trades: this.store.recentTrades(view, 30),
      decisions: this.store.recentDecisions(25),
      timezone: tz,
      diag: {
        version: VERSION,
        phase: e?.phase ?? null,
        rounds: e?.rounds ?? 0,
        lastRoundMs: e?.lastRoundMs ?? null,
        roundRunningForMs: this.ticking ? Date.now() - this.tickStarted : 0,
        cooldownLeftS: e ? Math.max(0, Math.round(e.cooldownUntil - now)) : 0,
        kalshiRequests: e?.client.requests ?? 0,
        kalshiOk: e?.client.ok ?? 0,
        signed: !!(e?.client.key && e?.client.apiKeyId),
        baseUrl: e?.client.baseUrl ?? null,
        lastKalshiFailure: e?.client.lastFailure ?? null,
        priceRequests: e?.feed.requests ?? 0,
        cryptoSeries: e ? [...e.series.keys()] : [],
      },
    };
  }

  async setKillSwitch(on: boolean): Promise<void> {
    this.store.set("kill_switch", on ? "on" : "off");
  }

  private savedLimits(): Partial<Limits> {
    try {
      return cleanLimits(JSON.parse(this.store.get("limits") ?? "{}"));
    } catch {
      return {};
    }
  }

  private limitRows() {
    const dflt = limitsOf(this.settings);
    const current = { ...dflt, ...this.savedLimits() };
    return LIMIT_FIELDS.map((f) => ({ key: f.key, label: f.label, help: f.help, value: current[f.key], dflt: dflt[f.key] }));
  }

  /** Save spending limits from the dashboard; blank or invalid fields keep their current value. */
  async setLimits(raw: Record<string, unknown>): Promise<void> {
    this.store.set("limits", JSON.stringify({ ...this.savedLimits(), ...cleanLimits(raw) }));
    this.engine?.applyOverrides();
  }

  async resetLimits(): Promise<void> {
    this.store.set("limits", "{}");
    this.engine?.applyOverrides();
  }

  private modelWeight(): number {
    const w = Number(this.store.get("model_weight"));
    return w > 0 && w <= 1 ? w : this.settings.modelWeight;
  }

  async setModelWeight(w: number): Promise<void> {
    if (!(w > 0 && w <= 1)) return;
    this.store.set("model_weight", String(w));
    this.engine?.applyOverrides();
  }

  /** Paper/live for each strategy (each defaults to the deployed mode). */
  strategyModes(): Record<Strategy, Mode> {
    if (this.engine) return Object.fromEntries(STRATEGIES.map((k) => [k, this.engine!.modeFor(k)])) as Record<Strategy, Mode>;
    let saved: Partial<Record<Strategy, Mode>> = {};
    try {
      saved = cleanStrategyModes(JSON.parse(this.store.get("strategy_modes") ?? "{}"), this.settings.mode);
    } catch {}
    return Object.fromEntries(STRATEGIES.map((k) => [k, saved[k] ?? this.settings.mode])) as Record<Strategy, Mode>;
  }

  /** Switch one strategy (or "all") between paper and live. Returns a problem, or null. */
  async setMode(mode: string, strategy = "all"): Promise<string | null> {
    if (mode !== "paper" && mode !== "live") return "Unknown mode.";
    const targets = strategy === "all" ? STRATEGIES : STRATEGIES.filter((k) => k === strategy);
    if (!targets.length) return "Unknown strategy.";
    if (mode === "live") {
      if (this.settings.mode === "demo") return "This bot is deployed in demo mode; change BOT_MODE in wrangler.jsonc instead.";
      if (!this.keysSet()) return "Add your Kalshi API key secrets before going live.";
    }
    let cur: Record<string, string> = {};
    try {
      cur = cleanStrategyModes(JSON.parse(this.store.get("strategy_modes") ?? "{}"), this.settings.mode) as Record<string, string>;
    } catch {}
    for (const k of targets) cur[k] = mode;
    this.store.set("strategy_modes", JSON.stringify(cur));
    this.store.set("mode_override", "paper"); // the old all-or-nothing switch is retired
    this.engine?.applyOverrides();
    return null;
  }

  private priceRange(): { minPrice: number; maxPrice: number } {
    try {
      const r = cleanPriceRange(JSON.parse(this.store.get("price_range") ?? "null"));
      if (r) return r;
    } catch {}
    return { minPrice: this.settings.minPrice, maxPrice: this.settings.maxPrice };
  }

  /** Save the bet price range (in cents from the dashboard). Returns a problem or null. */
  async setPriceRange(minCents: number, maxCents: number): Promise<string | null> {
    const r = cleanPriceRange({ minPrice: minCents / 100, maxPrice: maxCents / 100 });
    if (!r) return "Price range must be between 1¢ and 99¢, lowest below highest.";
    this.store.set("price_range", JSON.stringify(r));
    this.engine?.applyOverrides();
    return null;
  }

  async startFreshTest(): Promise<void> {
    this.store.set("test_since", String(Date.now() / 1000));
  }

  /** Settings with dashboard switches applied (works before the engine exists). */
  private effective(): Settings {
    if (this.engine) return this.engine.s;
    let sw = {};
    try {
      sw = cleanSwitches(JSON.parse(this.store.get("strategies") ?? "{}"));
    } catch {}
    return { ...this.settings, ...sw };
  }

  async setStrategy(key: string, on: boolean): Promise<void> {
    if (!STRATEGY_SWITCHES.some((f) => f.key === key)) return;
    let cur: Record<string, boolean> = {};
    try {
      cur = cleanSwitches(JSON.parse(this.store.get("strategies") ?? "{}")) as Record<string, boolean>;
    } catch {}
    cur[key] = on;
    this.store.set("strategies", JSON.stringify(cur));
    this.engine?.applyOverrides();
  }

  async setHorizon(h: string): Promise<void> {
    if (!HORIZONS[h]) return;
    this.store.set("horizon", h);
    if (this.engine) this.engine.cursor = ""; // start the scan over with the new limit
  }
}
