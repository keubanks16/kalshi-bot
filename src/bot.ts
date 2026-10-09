// The Durable Object that owns the trading loop and its SQLite database.
// An alarm fires every POLL_SECONDS; each alarm runs one engine tick and
// schedules the next. A once-a-minute cron makes sure the alarm is running.

import { DurableObject } from "cloudflare:workers";
import { HORIZONS, baseUrl, loadSettings, placesOrders, validate, type Env, type Settings } from "./config.ts";
import { Engine, tradingDay } from "./engine.ts";
import { KalshiClient, importPrivateKey } from "./kalshi.ts";
import { PriceFeed } from "./prices.ts";
import { Store, type Sql } from "./store.ts";

export interface Snapshot {
  mode: string;
  problem: string | null;
  status: string;
  lastError: string | null;
  alive: boolean;
  killSwitch: boolean;
  horizon: string;
  horizons: { key: string; label: string }[];
  summary: ReturnType<Store["summary"]>;
  today: number;
  byStrategy: { strategy: string; trades: number; pnl: number }[];
  trades: ReturnType<Store["recentTrades"]>;
  decisions: Record<string, any>[];
  timezone: string;
}

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
    const key = placesOrders(s) ? await importPrivateKey(String(this.env.KALSHI_PRIVATE_KEY)) : null;
    const client = new KalshiClient(baseUrl(this.env, s), String(this.env.KALSHI_API_KEY_ID ?? ""), key);
    this.engine = new Engine(s, client, new PriceFeed(), this.store);
    this.store.set("mode", s.mode);
    return this.engine;
  }

  /** Make sure the alarm loop is running. Safe to call any number of times. */
  async start(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + 1000);
  }

  async alarm(): Promise<void> {
    try {
      if (!this.problem) {
        const engine = await this.getEngine();
        try {
          await engine.tick();
        } catch (e) {
          engine.lastError = `${new Date().toISOString().slice(11, 19)} UTC — ${(e as Error).message}`;
        }
      }
    } finally {
      // While misconfigured, check back slowly; a redeploy restarts the object anyway.
      const wait = this.problem ? 60 : this.settings.pollSeconds;
      await this.ctx.storage.setAlarm(Date.now() + wait * 1000);
    }
  }

  async snapshot(): Promise<Snapshot> {
    await this.start();
    const e = this.engine;
    const now = Date.now() / 1000;
    const tz = this.settings.timezone;
    const horizon = e?.horizon() ?? this.store.get("horizon") ?? this.settings.defaultHorizon;
    return {
      mode: this.settings.mode,
      problem: this.problem,
      status: this.problem ? "Not running — fix the setting below" : e?.status ?? "Starting up…",
      lastError: e?.lastError ?? null,
      alive: !!e && now - e.heartbeat < Math.max(60, this.settings.pollSeconds * 6),
      killSwitch: this.store.killSwitchOn(),
      horizon,
      horizons: Object.entries(HORIZONS).map(([key, h]) => ({ key, label: h.label })),
      summary: this.store.summary(),
      today: this.store.pnlForDay(tradingDay(now, tz)),
      byStrategy: this.store.byStrategy(),
      trades: this.store.recentTrades(30),
      decisions: this.store.recentDecisions(25),
      timezone: tz,
    };
  }

  async setKillSwitch(on: boolean): Promise<void> {
    this.store.set("kill_switch", on ? "on" : "off");
  }

  async setHorizon(h: string): Promise<void> {
    if (!HORIZONS[h]) return;
    this.store.set("horizon", h);
    if (this.engine) this.engine.cursor = ""; // start the scan over with the new limit
  }
}
