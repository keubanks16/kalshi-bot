// Crypto spot prices and volatility from public exchange APIs.
//
// Kalshi's crypto markets settle on CF Benchmarks indexes built from several
// big USD exchanges. We approximate each with the median of the exchanges
// that answer, which is close enough for these probability models.

import { ewmaVol } from "./model.ts";

const HEADERS = { "User-Agent": "kalshi-bot/0.3", Accept: "application/json" };

const KRAKEN_PAIRS: Record<string, string> = { BTC: "XBTUSD", ETH: "ETHUSD", SOL: "SOLUSD", XRP: "XRPUSD", DOGE: "XDGUSD" };

type Fetch = typeof fetch;

async function getJson(f: Fetch, url: string): Promise<any> {
  const r = await f(url, { headers: HEADERS });
  if (!r.ok) throw new Error(`${new URL(url).host} -> ${r.status}`);
  return r.json();
}

const SOURCES: Record<string, (f: Fetch, asset: string) => Promise<number>> = {
  coinbase: async (f, a) => Number((await getJson(f, `https://api.exchange.coinbase.com/products/${a}-USD/ticker`)).price),
  kraken: async (f, a) => {
    const pair = KRAKEN_PAIRS[a] ?? `${a}USD`;
    const res = (await getJson(f, `https://api.kraken.com/0/public/Ticker?pair=${pair}`)).result;
    return Number((Object.values(res)[0] as any).c[0]);
  },
  bitstamp: async (f, a) => Number((await getJson(f, `https://www.bitstamp.net/api/v2/ticker/${a.toLowerCase()}usd/`)).last),
  gemini: async (f, a) => Number((await getJson(f, `https://api.gemini.com/v1/pubticker/${a.toLowerCase()}usd`)).last),
};

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export class PriceFeed {
  fetchFn: Fetch;
  requests = 0;
  private spots = new Map<string, { price: number; at: number }>();
  private vols = new Map<string, { vol: number; at: number }>();

  constructor(fetchFn: Fetch = (...a) => fetch(...a)) {
    this.fetchFn = (...a) => {
      this.requests++;
      return fetchFn(...a);
    };
  }

  /** Median of the exchanges that answer (cached 5s). Throws if fewer than two do. */
  async spot(asset: string): Promise<number> {
    const hit = this.spots.get(asset);
    if (hit && Date.now() - hit.at < 5000) return hit.price;
    const names = Object.keys(SOURCES);
    const results = await Promise.allSettled(names.map((n) => SOURCES[n](this.fetchFn, asset)));
    const vals = results.flatMap((r) => (r.status === "fulfilled" && Number.isFinite(r.value) && r.value > 0 ? [r.value] : []));
    if (vals.length < 2) throw new Error(`only ${vals.length} ${asset} price source(s) answered`);
    const price = median(vals);
    this.spots.set(asset, { price, at: Date.now() });
    return price;
  }

  /**
   * Annualized volatility suited to the time left: 1-minute candles for
   * markets closing within two hours, hourly candles beyond that.
   */
  async volatility(asset: string, secondsLeft: number): Promise<number> {
    const hourly = secondsLeft > 2 * 3600;
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
      const pair = KRAKEN_PAIRS[asset] ?? `${asset}USD`;
      const res = (await getJson(this.fetchFn, `https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=${gran / 60}`)).result;
      const k = Object.keys(res).find((x) => x !== "last")!;
      vol = ewmaVol((res[k] as any[]).slice(-bars).map((r) => Number(r[4])), gran, hourly ? 24 : 20);
    }
    this.vols.set(key, { vol, at: Date.now() });
    return vol;
  }
}
