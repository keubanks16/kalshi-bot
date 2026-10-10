// Crypto index prices and volatility, built the way CF Benchmarks builds the
// Real-Time Indices that Kalshi settles on: from the ORDER BOOKS of the
// constituent exchanges (bid/ask mid-prices, weighted by how much each
// exchange trades), not from last-trade prices.
//
// Constituents for BTC per CME/CF: Bitstamp, Bullish, Coinbase, Gemini,
// Kraken, LMAX and Crypto.com. LMAX Digital has no public API, so we use the
// other six. Coinbase and Kraken can also stream live over websockets (turn on
// with LIVE_STREAMS); the rest are polled each round.

import { ewmaVol } from "./model.ts";

const HEADERS = { "User-Agent": "kalshi-bot/0.7", Accept: "application/json" };
const KRAKEN_REST: Record<string, string> = { BTC: "XBTUSD", ETH: "ETHUSD", SOL: "SOLUSD", XRP: "XRPUSD", DOGE: "XDGUSD" };
const STALE_MS = 15_000; // ignore quotes older than this
const STREAM_FRESH_MS = 3_000; // a streamed quote this fresh skips the REST poll

type Fetch = typeof fetch;

export interface Quote {
  bid: number;
  ask: number;
  volume: number | null; // 24h base volume, used as the weight
  at: number; // ms
}

async function getJson(f: Fetch, url: string): Promise<any> {
  const r = await f(url, { headers: HEADERS, signal: AbortSignal.timeout(4000) });
  if (!r.ok) throw new Error(`${new URL(url).host} -> ${r.status}`);
  return r.json();
}

function q(bid: unknown, ask: unknown, volume: unknown): Omit<Quote, "at"> {
  const b = Number(bid);
  const a = Number(ask);
  if (!(b > 0 && a > 0 && a >= b)) throw new Error("bad quote");
  const v = Number(volume);
  return { bid: b, ask: a, volume: v > 0 ? v : null };
}

/** Best bid/ask (+24h volume) from each exchange's public REST API. */
export const REST_QUOTES: Record<string, (f: Fetch, asset: string) => Promise<Omit<Quote, "at">>> = {
  coinbase: async (f, a) => {
    const d = await getJson(f, `https://api.exchange.coinbase.com/products/${a}-USD/ticker`);
    return q(d.bid, d.ask, d.volume);
  },
  kraken: async (f, a) => {
    const res = (await getJson(f, `https://api.kraken.com/0/public/Ticker?pair=${KRAKEN_REST[a] ?? a + "USD"}`)).result;
    const t: any = Object.values(res)[0];
    return q(t.b[0], t.a[0], t.v?.[1]);
  },
  bitstamp: async (f, a) => {
    const d = await getJson(f, `https://www.bitstamp.net/api/v2/ticker/${a.toLowerCase()}usd/`);
    return q(d.bid, d.ask, d.volume);
  },
  gemini: async (f, a) => {
    const d = await getJson(f, `https://api.gemini.com/v1/pubticker/${a.toLowerCase()}usd`);
    return q(d.bid, d.ask, d.volume?.[a]);
  },
  cryptocom: async (f, a) => {
    const d = (await getJson(f, `https://api.crypto.com/exchange/v1/public/get-tickers?instrument_name=${a}_USD`)).result.data[0];
    return q(d.b, d.k, d.v);
  },
  bullish: async (f, a) => {
    const d = await getJson(f, `https://api.exchange.bullish.com/trading-api/v1/markets/${a}USDC/tick`);
    return q(d.bestBid, d.bestAsk, d.baseVolume ?? d.volume);
  },
};

/** Weighted median: the value where half the total weight sits on each side. */
export function weightedMedian(points: { value: number; weight: number }[]): number {
  const s = [...points].sort((a, b) => a.value - b.value);
  const total = s.reduce((t, p) => t + p.weight, 0);
  let acc = 0;
  for (const p of s) {
    acc += p.weight;
    if (acc >= total / 2) return p.value;
  }
  return s[s.length - 1].value;
}

/** Combine exchange quotes into one index price: size-weighted median of mid-prices. */
export function indexPrice(quotes: Quote[]): number {
  const vols = quotes.map((x) => x.volume).filter((v): v is number => v !== null);
  const fallback = vols.length ? vols.sort((a, b) => a - b)[Math.floor(vols.length / 2)] : 1;
  return weightedMedian(quotes.map((x) => ({ value: (x.bid + x.ask) / 2, weight: x.volume ?? fallback })));
}

// ---------------------------------------------------------------- streams
type SocketFactory = (url: string, headers?: Record<string, string>) => Promise<WebSocket>;

/** Outbound websocket from a Worker / Durable Object (fetch with Upgrade). */
const workerSocket: SocketFactory = async (url, headers = {}) => {
  const resp = await fetch(url.replace(/^wss:/, "https:"), { headers: { ...headers, Upgrade: "websocket" } });
  const ws = (resp as any).webSocket as WebSocket | null;
  if (!ws) throw new Error(`websocket upgrade refused by ${new URL(url).host} (${resp.status})`);
  (ws as any).accept();
  return ws;
};

interface StreamDef {
  url: string;
  subscribe: (assets: string[]) => unknown;
  /** Returns [asset, quote] pairs found in one message. */
  parse: (msg: any) => [string, Omit<Quote, "at">][];
}

export const STREAMS: Record<string, StreamDef> = {
  coinbase: {
    url: "wss://ws-feed.exchange.coinbase.com",
    subscribe: (assets) => ({ type: "subscribe", product_ids: assets.map((a) => `${a}-USD`), channels: ["ticker"] }),
    parse: (m) => (m.type === "ticker" && m.product_id ? [[String(m.product_id).split("-")[0], q(m.best_bid, m.best_ask, m.volume_24h)]] : []),
  },
  kraken: {
    url: "wss://ws.kraken.com/v2",
    subscribe: (assets) => ({ method: "subscribe", params: { channel: "ticker", symbol: assets.map((a) => `${a}/USD`) } }),
    parse: (m) => (m.channel === "ticker" && Array.isArray(m.data) ? m.data.map((d: any) => [String(d.symbol).split("/")[0], q(d.bid, d.ask, d.volume)]) : []),
  },
};

/** Plain (equal-weight) annualized realized volatility of evenly spaced prices. */
export function realizedVol(prices: number[], secondsPerBar: number): number {
  let sum = 0;
  let n = 0;
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1] > 0 && prices[i] > 0) {
      const r = Math.log(prices[i] / prices[i - 1]);
      sum += r * r;
      n++;
    }
  }
  return n ? Math.sqrt(((sum / n) * 365 * 86400) / secondsPerBar) : 0;
}

/** CF Benchmarks Real-Time Index ids on Kalshi's 5Hz feed: the exact values Kalshi settles on. */
export const CF_INDEX: Record<string, string> = { BTC: "BRTI", ETH: "ETHUSD_RTI", SOL: "SOLUSD_RTI", XRP: "XRPUSD_RTI", DOGE: "DOGEUSD_RTI" };
const CF_FRESH_MS = 3_000; // use the CF value only if a tick arrived this recently

/** Where to connect for the CF feed, and how to sign the handshake (from the Kalshi client). */
export interface IndexFeedAuth {
  url: string;
  headers: () => Promise<Record<string, string> | null>;
}

export class PriceFeed {
  fetchFn: Fetch;
  requests = 0;
  streamMessages = 0;
  /** asset -> exchange -> latest quote */
  quotes = new Map<string, Map<string, Quote>>();
  sockets = new Map<string, WebSocket>();
  lastSources: Record<string, string[]> = {};
  private vols = new Map<string, { vol: number; at: number }>();
  private socketFactory: SocketFactory;
  private connecting = new Set<string>();
  /** Latest CF Benchmarks index value per asset (received time in ms). */
  cf = new Map<string, { value: number; at: number; sourceTs: number }>();
  cfSocket: WebSocket | null = null;
  cfMessages = 0;
  cfError: string | null = null;
  private cfConnecting = false;
  /** asset -> CF index values sampled every ~10s for the last 3 hours (for volatility). */
  cfHistory = new Map<string, { t: number; v: number }[]>();
  /** asset -> where the last volatility() came from */
  volSource: Record<string, "cf" | "candles"> = {};
  /** asset -> where the last spot() price came from */
  spotSource: Record<string, "cf" | "exchanges"> = {};

  constructor(fetchFn: Fetch = (...a) => fetch(...a), socketFactory: SocketFactory = workerSocket) {
    this.fetchFn = (...a) => {
      this.requests++;
      return fetchFn(...a);
    };
    this.socketFactory = socketFactory;
  }

  private store(asset: string, exchange: string, quote: Omit<Quote, "at">): void {
    let m = this.quotes.get(asset);
    if (!m) this.quotes.set(asset, (m = new Map()));
    const prev = m.get(exchange);
    // Streams don't always carry volume; keep the last known weight.
    m.set(exchange, { ...quote, volume: quote.volume ?? prev?.volume ?? null, at: Date.now() });
  }

  /** Open (or re-open) the live streams. Safe to call every round. */
  async ensureStreams(assets: string[]): Promise<void> {
    for (const [name, def] of Object.entries(STREAMS)) {
      if (this.sockets.has(name) || this.connecting.has(name)) continue;
      this.connecting.add(name);
      try {
        const ws = await this.socketFactory(def.url);
        ws.addEventListener("message", (ev: MessageEvent) => {
          this.streamMessages++;
          try {
            for (const [asset, quote] of def.parse(JSON.parse(String(ev.data)))) this.store(asset, name, quote);
          } catch {
            /* heartbeats, acks and odd messages */
          }
        });
        const drop = () => this.sockets.delete(name);
        ws.addEventListener("close", drop);
        ws.addEventListener("error", drop);
        ws.send(JSON.stringify(def.subscribe(assets)));
        this.sockets.set(name, ws);
      } catch {
        /* retried next round */
      } finally {
        this.connecting.delete(name);
      }
    }
  }

  /**
   * Keep Kalshi's CF Benchmarks 5Hz index stream open (BRTI etc.). Safe to
   * call every round; reconnects if it dropped. No-op without API keys.
   */
  async ensureIndexFeed(assets: string[], auth: IndexFeedAuth | null): Promise<void> {
    if (!auth || this.cfSocket || this.cfConnecting) return;
    const ids = assets.map((a) => CF_INDEX[a]).filter(Boolean);
    if (!ids.length) return;
    this.cfConnecting = true;
    try {
      const headers = await auth.headers();
      if (!headers) {
        this.cfError = "no Kalshi API keys";
        return;
      }
      const ws = await this.socketFactory(auth.url, headers);
      const byId = new Map(Object.entries(CF_INDEX).map(([asset, id]) => [id, asset]));
      ws.addEventListener("message", (ev: MessageEvent) => {
        try {
          const m = JSON.parse(String(ev.data));
          if (m.type === "cfbenchmarks_value_5hz" || m.type === "cfbenchmarks_value") {
            const asset = byId.get(String(m.msg?.index_id));
            const value = Number(m.msg?.value_usd);
            if (asset && value > 0) {
              this.cfMessages++;
              const now = Date.now();
              this.cf.set(asset, { value, at: now, sourceTs: Number(m.msg?.source_ts_ms) || now });
              this.recordCf(asset, value, now);
            }
          } else if (m.type === "error") {
            this.cfError = `${m.msg?.code ?? ""} ${m.msg?.msg ?? JSON.stringify(m.msg ?? {})}`.trim();
          }
        } catch {
          /* ignore odd frames */
        }
      });
      const drop = () => {
        if (this.cfSocket === ws) this.cfSocket = null;
      };
      ws.addEventListener("close", (ev: any) => {
        this.cfError = `stream closed${ev?.code ? ` (${ev.code}${ev.reason ? `: ${ev.reason}` : ""})` : ""}`;
        drop();
      });
      ws.addEventListener("error", drop);
      ws.send(JSON.stringify({ id: 1, cmd: "subscribe", params: { channels: ["cfbenchmarks_value_5hz"], index_ids: ids } }));
      this.cfSocket = ws;
      this.cfError = null;
    } catch (e) {
      this.cfError = (e as Error)?.message ?? String(e);
    } finally {
      this.cfConnecting = false;
    }
  }

  /** Keep a sparse (every ~10s) 3-hour history of the CF index for volatility. */
  recordCf(asset: string, value: number, now = Date.now()): void {
    let h = this.cfHistory.get(asset);
    if (!h) this.cfHistory.set(asset, (h = []));
    if (h.length && now - h[h.length - 1].t < 10_000) return;
    h.push({ t: now, v: value });
    while (h.length && now - h[0].t > 3 * 3600_000) h.shift();
  }

  /**
   * Volatility from the CF index itself: the clean, mid-price-based number
   * these markets settle on. Last-trade candles bounce between bid and ask
   * and overstate how much the price really moves. Sampled once a minute,
   * EWMA with a 20-minute half-life. Null until there's 45+ minutes of history.
   */
  cfVolatility(asset: string, now = Date.now()): number | null {
    const all = this.cfHistory.get(asset);
    if (!all || all.length < 2 || now - all[all.length - 1].t > 60_000) return null;
    // Only the latest unbroken stretch: a gap (bot was down) would read as one
    // giant one-minute move and inflate the volatility.
    let start = all.length - 1;
    while (start > 0 && all[start].t - all[start - 1].t <= 3 * 60_000) start--;
    const h = all.slice(start);
    if (now - h[0].t < 45 * 60_000) return null;
    const perMinute: number[] = [];
    let next = h[0].t;
    for (const p of h) {
      if (p.t >= next) {
        perMinute.push(p.v);
        next = p.t + 60_000;
      }
    }
    if (perMinute.length < 30) return null;
    // The larger of a fast reading (20-min half-life) and a steady one (plain
    // realized vol over the whole unbroken stretch, up to 3 hours): on quiet
    // days both are low, and right after a spike the steady one keeps the bot
    // from acting as if nothing happened once the last 20 minutes go calm.
    return Math.max(ewmaVol(perMinute, 60, 20), realizedVol(perMinute, 60));
  }

  /** One sample per minute of the CF history, for saving across restarts: { asset: [[unixSec, value], ...] }. */
  cfHistorySnapshot(): Record<string, [number, number][]> {
    const out: Record<string, [number, number][]> = {};
    for (const [asset, h] of this.cfHistory) {
      const pts: [number, number][] = [];
      let next = 0;
      for (const p of h) {
        if (p.t >= next) {
          pts.push([Math.round(p.t / 1000), p.v]);
          next = p.t + 60_000;
        }
      }
      out[asset] = pts;
    }
    return out;
  }

  /** Restore saved CF history (older than anything already collected), keeping the last 3 hours. */
  restoreCfHistory(saved: Record<string, [number, number][]>, now = Date.now()): void {
    for (const [asset, pts] of Object.entries(saved ?? {})) {
      if (!Array.isArray(pts)) continue;
      const cur = this.cfHistory.get(asset) ?? [];
      const firstLive = cur.length ? cur[0].t : Infinity;
      const old = pts
        .map(([s, v]) => ({ t: Number(s) * 1000, v: Number(v) }))
        .filter((p) => p.v > 0 && p.t < firstLive && now - p.t <= 3 * 3600_000)
        .sort((a, b) => a.t - b.t);
      this.cfHistory.set(asset, [...old, ...cur]);
    }
  }

  /** The live CF index value for an asset if a tick arrived in the last few seconds. */
  cfValue(asset: string): number | null {
    const v = this.cf.get(asset);
    return v && Date.now() - v.at <= CF_FRESH_MS ? v.value : null;
  }

  closeIndexFeed(): void {
    try {
      this.cfSocket?.close();
    } catch {}
    this.cfSocket = null;
  }

  closeStreams(): void {
    for (const ws of this.sockets.values()) {
      try {
        ws.close();
      } catch {}
    }
    this.sockets.clear();
  }

  /** Index price for an asset. Polls exchanges whose streamed quote isn't fresh. Throws if fewer than two answer. */
  async spot(asset: string): Promise<number> {
    // Kalshi's own CF Benchmarks feed is the exact settlement index: use it when fresh.
    const cf = this.cfValue(asset);
    if (cf !== null) {
      this.spotSource[asset] = "cf";
      return cf;
    }
    this.spotSource[asset] = "exchanges";
    const now = Date.now();
    const have = this.quotes.get(asset);
    const toPoll = Object.keys(REST_QUOTES).filter((ex) => {
      const qt = have?.get(ex);
      return !qt || now - qt.at > STREAM_FRESH_MS;
    });
    const results = await Promise.allSettled(toPoll.map((ex) => REST_QUOTES[ex](this.fetchFn, asset)));
    results.forEach((r, i) => {
      if (r.status === "fulfilled") this.store(asset, toPoll[i], r.value);
    });

    const fresh = [...(this.quotes.get(asset)?.entries() ?? [])].filter(([, x]) => Date.now() - x.at <= STALE_MS);
    this.lastSources[asset] = fresh.map(([ex]) => ex);
    if (fresh.length < 2) throw new Error(`only ${fresh.length} ${asset} price source(s) answered`);
    return indexPrice(fresh.map(([, x]) => x));
  }

  describe(): string {
    const fromCf = Object.values(this.spotSource).filter((s) => s === "cf").length;
    if (fromCf && fromCf === Object.keys(this.spotSource).length) return "Kalshi's CF Benchmarks index (live, 5/sec)";
    const counts = Object.values(this.lastSources).map((s) => s.length);
    const n = counts.length ? Math.max(...counts) : 0;
    const live = this.sockets.size ? `, ${this.sockets.size} live stream${this.sockets.size > 1 ? "s" : ""}` : "";
    return `${n} exchanges${live}`;
  }

  /**
   * Annualized volatility suited to the time left: 1-minute candles for
   * markets closing within two hours, hourly candles beyond that.
   */
  async volatility(asset: string, secondsLeft: number): Promise<number> {
    const hourly = secondsLeft > 2 * 3600;
    if (!hourly) {
      const cfVol = this.cfVolatility(asset);
      if (cfVol !== null) {
        this.volSource[asset] = "cf";
        return cfVol;
      }
    }
    this.volSource[asset] = "candles";
    const key = `${asset}:${hourly ? "1h" : "1m"}`;
    const hit = this.vols.get(key);
    const ttl = hourly ? 15 * 60_000 : 60_000;
    if (hit && Date.now() - hit.at < ttl) return hit.vol;

    const gran = hourly ? 3600 : 60;
    const bars = hourly ? 168 : 120; // a week of hours, or two hours of minutes
    let vol: number;
    try {
      // Coinbase candles: [time, low, high, open, close, volume]
      const rows: number[][] = await getJson(this.fetchFn, `https://api.exchange.coinbase.com/products/${asset}-USD/candles?granularity=${gran}`);
      vol = ewmaVol(rows.sort((a, b) => a[0] - b[0]).slice(-bars).map((r) => r[4]), gran, hourly ? 24 : 20);
    } catch {
      // Kraken OHLC: [time, open, high, low, close, ...]
      const res = (await getJson(this.fetchFn, `https://api.kraken.com/0/public/OHLC?pair=${KRAKEN_REST[asset] ?? asset + "USD"}&interval=${gran / 60}`)).result;
      const k = Object.keys(res).find((x) => x !== "last")!;
      vol = ewmaVol((res[k] as any[]).slice(-bars).map((r) => Number(r[4])), gran, hourly ? 24 : 20);
    }
    this.vols.set(key, { vol, at: Date.now() });
    return vol;
  }
}
