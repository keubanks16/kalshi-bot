// Settings come from wrangler.jsonc "vars" (plain settings) and Cloudflare
// secrets (keys and passwords). Every knob that affects money lives here.

export interface Env {
  BOT: DurableObjectNamespace;
  // secrets (set in the Cloudflare dashboard, never in the repo)
  KALSHI_API_KEY_ID?: string;
  KALSHI_PRIVATE_KEY?: string; // the whole PEM file, pasted as-is
  DASHBOARD_PASSWORD?: string;
  // plain settings (strings from wrangler.jsonc "vars")
  [key: string]: unknown;
}

export const BASE_URLS = {
  prod: "https://external-api.kalshi.com/trade-api/v2",
  demo: "https://external-api.demo.kalshi.co/trade-api/v2",
} as const;

/** How far out a market may close for the bot to trade it. */
export const HORIZONS: Record<string, { label: string; short: string; seconds: number | null }> = {
  "15m": { label: "Within 15 minutes", short: "15 min", seconds: 15 * 60 },
  hour: { label: "Within an hour", short: "1 hour", seconds: 3600 },
  day: { label: "Within a day", short: "1 day", seconds: 86400 },
  week: { label: "Within a week", short: "1 week", seconds: 7 * 86400 },
  month: { label: "Within a month", short: "1 month", seconds: 31 * 86400 },
  any: { label: "Any time", short: "Any", seconds: null },
};

export type Mode = "paper" | "demo" | "live";

export interface Settings {
  mode: Mode;
  liveConfirm: boolean;
  pollSeconds: number;
  timezone: string;
  defaultHorizon: string;

  // which strategies run
  cryptoEnabled: boolean;
  arbEnabled: boolean;
  cryptoAssets: string[]; // e.g. BTC, ETH, SOL
  seriesPerTick: number; // how many crypto series to re-check each tick

  // strategy
  minEdge: number; // expected profit per $1 contract after fees, directional trades
  minArbProfit: number; // locked-in profit per arbitrage set, after fees
  minSecondsLeft: number; // never open a trade this close to a market's close
  minSecondsElapsed: number; // ...or right after it opens
  minPrice: number;
  maxPrice: number;
  minVol: number; // annualized vol floor/ceiling
  maxVol: number;
  kellyFraction: number;
  takerFeeRate: number;
  modelWeight: number; // 0..1, how much to trust our crypto model vs the market price

  // risk limits
  bankroll: number;
  maxContractsPerOrder: number;
  maxCostPerOrder: number;
  maxCostPerMarket: number;
  maxCostPerEvent: number;
  maxOpenRisk: number;
  maxDailyLoss: number;
  maxOrdersPerMarket: number;
}

function str(env: Env, key: string, dflt: string): string {
  const v = env[key];
  return v === undefined || v === null || String(v).trim() === "" ? dflt : String(v).trim();
}
function num(env: Env, key: string, dflt: number): number {
  const n = Number(str(env, key, String(dflt)));
  if (!Number.isFinite(n)) throw new Error(`${key} must be a number`);
  return n;
}
function bool(env: Env, key: string, dflt: boolean): boolean {
  return ["1", "true", "yes", "on"].includes(str(env, key, dflt ? "true" : "false").toLowerCase());
}

export function loadSettings(env: Env): Settings {
  return {
    mode: str(env, "BOT_MODE", "paper").toLowerCase() as Mode,
    liveConfirm: str(env, "LIVE_TRADING_CONFIRM", "") === "yes",
    pollSeconds: num(env, "POLL_SECONDS", 10),
    timezone: str(env, "BOT_TIMEZONE", "America/New_York"),
    defaultHorizon: str(env, "TRADE_HORIZON", "day").toLowerCase(),

    cryptoEnabled: bool(env, "CRYPTO_ENABLED", true),
    arbEnabled: bool(env, "ARB_ENABLED", true),
    cryptoAssets: str(env, "CRYPTO_ASSETS", "BTC,ETH,SOL,XRP,DOGE")
      .split(",")
      .map((a) => a.trim().toUpperCase())
      .filter(Boolean),
    seriesPerTick: num(env, "SERIES_PER_TICK", 3),

    minEdge: num(env, "MIN_EDGE", 0.04),
    minArbProfit: num(env, "MIN_ARB_PROFIT", 0.02),
    minSecondsLeft: num(env, "MIN_SECONDS_LEFT", 120),
    minSecondsElapsed: num(env, "MIN_SECONDS_ELAPSED", 60),
    minPrice: num(env, "MIN_PRICE", 0.05),
    maxPrice: num(env, "MAX_PRICE", 0.95),
    minVol: num(env, "MIN_VOL", 0.2),
    maxVol: num(env, "MAX_VOL", 2.5),
    kellyFraction: num(env, "KELLY_FRACTION", 0.25),
    takerFeeRate: num(env, "TAKER_FEE_RATE", 0.07),
    modelWeight: num(env, "MODEL_WEIGHT", 0.5),

    bankroll: num(env, "BANKROLL", 100),
    maxContractsPerOrder: num(env, "MAX_CONTRACTS_PER_ORDER", 10),
    maxCostPerOrder: num(env, "MAX_COST_PER_ORDER", 5),
    maxCostPerMarket: num(env, "MAX_COST_PER_MARKET", 10),
    maxCostPerEvent: num(env, "MAX_COST_PER_EVENT", 20),
    maxOpenRisk: num(env, "MAX_OPEN_RISK", 50),
    maxDailyLoss: num(env, "MAX_DAILY_LOSS", 25),
    maxOrdersPerMarket: num(env, "MAX_ORDERS_PER_MARKET", 3),
  };
}

export function placesOrders(s: Settings): boolean {
  return s.mode === "demo" || s.mode === "live";
}

export function baseUrl(env: Env, s: Settings): string {
  const override = str(env, "KALSHI_BASE_URL", "");
  if (override) return override.replace(/\/+$/, "");
  return s.mode === "demo" ? BASE_URLS.demo : BASE_URLS.prod;
}

/** Returns a problem description, or null if the settings are safe to run. */
export function validate(env: Env, s: Settings): string | null {
  if (!["paper", "demo", "live"].includes(s.mode)) return `BOT_MODE must be paper, demo or live (got "${s.mode}")`;
  if (s.mode === "live" && !s.liveConfirm)
    return "BOT_MODE=live also requires LIVE_TRADING_CONFIRM=yes. Run paper or demo first.";
  if (placesOrders(s)) {
    if (!env.KALSHI_API_KEY_ID) return "KALSHI_API_KEY_ID secret is missing";
    if (!env.KALSHI_PRIVATE_KEY) return "KALSHI_PRIVATE_KEY secret is missing";
  }
  if (!(s.kellyFraction > 0 && s.kellyFraction <= 1)) return "KELLY_FRACTION must be between 0 and 1";
  if (!(s.modelWeight > 0 && s.modelWeight <= 1)) return "MODEL_WEIGHT must be between 0 and 1";
  if (s.pollSeconds < 5) return "POLL_SECONDS must be at least 5";
  if (!HORIZONS[s.defaultHorizon]) return `TRADE_HORIZON must be one of ${Object.keys(HORIZONS).join(", ")}`;
  return null;
}

/** Spending limits you can change from the dashboard (dollars). */
export const LIMIT_FIELDS = [
  { key: "bankroll", label: "Bankroll", help: "Money the bot sizes bets from" },
  { key: "maxCostPerOrder", label: "Max per trade", help: "Most it spends on one order" },
  { key: "maxCostPerMarket", label: "Max per market", help: "Total on any one market" },
  { key: "maxCostPerEvent", label: "Max per event", help: "Total across related markets" },
  { key: "maxOpenRisk", label: "Max open at once", help: "Total in trades not yet settled" },
  { key: "maxDailyLoss", label: "Daily loss limit", help: "Stops new trades for the day after this" },
] as const;

export type LimitKey = (typeof LIMIT_FIELDS)[number]["key"];
export type Limits = Record<LimitKey, number>;

export const MAX_LIMIT = 100_000;

export function limitsOf(s: Settings): Limits {
  return Object.fromEntries(LIMIT_FIELDS.map((f) => [f.key, s[f.key]])) as Limits;
}

/** Keep only valid, positive dollar amounts. */
export function cleanLimits(raw: Record<string, unknown>): Partial<Limits> {
  const out: Partial<Limits> = {};
  for (const f of LIMIT_FIELDS) {
    const v = Number(String(raw[f.key] ?? "").replace(/[$,\s]/g, ""));
    if (Number.isFinite(v) && v > 0 && v <= MAX_LIMIT) out[f.key] = Math.round(v * 100) / 100;
  }
  return out;
}
