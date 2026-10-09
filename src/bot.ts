// The Durable Object that owns the trading loop and its SQLite database.
// An alarm fires every POLL_SECONDS; each alarm runs one engine tick and
// schedules the next. A once-a-minute cron makes sure the alarm is running.

import { DurableObject } from "cloudflare:workers";
import { HORIZONS, LIMIT_FIELDS, baseUrl, cleanLimits, limitsOf, loadSettings, validate, type Env, type Limits, type Settings } from "./config.ts";
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
  summary: ReturnType<Store["summary"]>;
  today: number;
  byStrategy: { strategy: string; trades: number; pnl: number }[];
  trades: ReturnType<Store["recentTrades"]>;
  decisions: Record<string, any>[];
  timezone: string;
  diag: Record<string, unknown>;
}

export const VERSION = "0.5.1";

export const MODEL_WEIGHT_OPTIONS = [0.25, 0.5, 0.75, 1];

export class Bot extends DurableObject<Env> {
  store: Store;
  settings: Settings;
  problem: string | null;
  engine: Engine | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new Store(ctx.storage.sql as unknown as Sql);
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
    this.store.set("mode", s.mode);
    return this.engine;
  }

  /** Make sure the alarm loop is running. Safe to call any number of times. */
  async start(): Promise<void> {
    if (this.ticking) return; // an alarm is mid-run and will schedule the next one
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + 1000);
  }

  private ticking = false;
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

  async snapshot(viewArg?: string): Promise<Snapshot> {
    await this.start();
    const e = this.engine;
    const now = Date.now() / 1000;
    const tz = this.settings.timezone;
    const horizon = e?.horizon() ?? this.store.get("horizon") ?? this.settings.defaultHorizon;
    const mode = this.currentMode();
    const views = [...new Set([mode, ...this.store.modesWithTrades()])];
    const view = viewArg && views.includes(viewArg) ? viewArg : mode;
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
      summary: this.store.summary(view),
      today: this.store.pnlForDay(tradingDay(now, tz), view),
      byStrategy: this.store.byStrategy(view),
      modelCheck: this.store.modelCheck(view),
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

  /** Switch between paper and live from the dashboard. Returns a problem, or null. */
  async setMode(mode: string): Promise<string | null> {
    if (mode !== "paper" && mode !== "live") return "Unknown mode.";
    if (mode === "live") {
      if (this.settings.mode === "demo") return "This bot is deployed in demo mode; change BOT_MODE in wrangler.jsonc instead.";
      if (!this.keysSet()) return "Add your Kalshi API key secrets before going live.";
    }
    this.store.set("mode_override", mode);
    this.store.set("mode", mode);
    this.engine?.applyOverrides();
    return null;
  }

  async setHorizon(h: string): Promise<void> {
    if (!HORIZONS[h]) return;
    this.store.set("horizon", h);
    if (this.engine) this.engine.cursor = ""; // start the scan over with the new limit
  }
}
