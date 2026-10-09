// Small Kalshi Trade API v2 client using WebCrypto (works in Workers and Node).
//
// Auth (per Kalshi's docs): sign `timestampMs + METHOD + /trade-api/v2/path`
// (no query string) with RSA-PSS / SHA-256 / 32-byte salt, base64 it, and send
// it with the key id and timestamp headers. Market data is public.

export class KalshiError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string) {
    super(`Kalshi API error ${status}: ${body.slice(0, 300)}`);
    this.status = status;
    this.body = body;
  }
}

// ---------------------------------------------------------------- key setup
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: ArrayBuffer): string {
  const u = new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s);
}

function derLength(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return [0x80 | bytes.length, ...bytes];
}

function der(tag: number, body: Uint8Array): Uint8Array {
  const len = derLength(body.length);
  const out = new Uint8Array(1 + len.length + body.length);
  out[0] = tag;
  out.set(len, 1);
  out.set(body, 1 + len.length);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Wrap a PKCS#1 RSAPrivateKey (BEGIN RSA PRIVATE KEY) in PKCS#8, which WebCrypto requires. */
export function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  // SEQUENCE { OID rsaEncryption 1.2.840.113549.1.1.1, NULL }
  const algId = new Uint8Array([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);
  return der(0x30, concat(version, algId, der(0x04, pkcs1)));
}

export type SigningKey = { kind: "rsa" | "ed25519"; key: CryptoKey };

export async function importPrivateKey(pem: string): Promise<SigningKey> {
  // Secrets pasted through a dashboard sometimes arrive with literal "\n".
  const text = pem.replace(/\\n/g, "\n").trim();
  const isPkcs1 = text.includes("BEGIN RSA PRIVATE KEY");
  const body = text.replace(/-----(BEGIN|END)[^-]+-----/g, "").replace(/\s+/g, "");
  if (!body) throw new Error("KALSHI_PRIVATE_KEY is empty or not a PEM key");
  let bytes = b64ToBytes(body);
  if (isPkcs1) bytes = pkcs1ToPkcs8(bytes);
  const der = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  try {
    const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSA-PSS", hash: "SHA-256" }, false, ["sign"]);
    return { kind: "rsa", key };
  } catch {
    const key = await crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, false, ["sign"]);
    return { kind: "ed25519", key };
  }
}

export async function sign(k: SigningKey, timestampMs: string, method: string, path: string): Promise<string> {
  const message = new TextEncoder().encode(`${timestampMs}${method.toUpperCase()}${path.split("?")[0]}`);
  const algo = k.kind === "rsa" ? { name: "RSA-PSS", saltLength: 32 } : { name: "Ed25519" };
  return bytesToB64(await crypto.subtle.sign(algo, k.key, message));
}

// ------------------------------------------------------------------ client
export interface Market {
  ticker: string;
  event_ticker: string;
  open_time: string;
  close_time: string;
  status?: string;
  strike_type?: string;
  floor_strike?: number | null;
  cap_strike?: number | null;
  result?: string;
  rules_primary?: string;
  [k: string]: unknown;
}

export interface KalshiEvent {
  event_ticker: string;
  series_ticker: string;
  title?: string;
  mutually_exclusive: boolean;
  fee_type_override?: string | null;
  fee_multiplier_override?: number | string | null;
  [k: string]: unknown;
}

export interface Order {
  order_id?: string;
  fill_count?: number;
  fill_count_fp?: string;
  taker_fees_dollars?: string;
  maker_fees_dollars?: string;
  status?: string; // resting, canceled, executed
  [k: string]: unknown;
}

/** Contracts filled so far on an order. */
export function orderFilled(o: Order): number {
  return Math.floor(Number(o.fill_count_fp ?? o.fill_count ?? 0)) || 0;
}

type Params = Record<string, string | number | undefined>;

export class KalshiClient {
  baseUrl: string;
  apiKeyId: string;
  key: SigningKey | null;
  fetchFn: typeof fetch;
  requests = 0; // subrequests made, for staying under Workers limits
  timeoutMs = 8000; // never let one request hang a round
  ok = 0;
  lastFailure: Record<string, unknown> | null = null;
  private basePath: string;

  constructor(baseUrl: string, apiKeyId = "", key: SigningKey | null = null, fetchFn: typeof fetch = (...a) => fetch(...a)) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKeyId = apiKeyId;
    this.key = key;
    this.fetchFn = fetchFn;
    this.basePath = new URL(this.baseUrl).pathname; // e.g. /trade-api/v2
  }

  async headers(method: string, path: string): Promise<Record<string, string>> {
    const h: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
    if (this.key && this.apiKeyId) {
      const ts = String(Date.now());
      h["KALSHI-ACCESS-KEY"] = this.apiKeyId;
      h["KALSHI-ACCESS-TIMESTAMP"] = ts;
      h["KALSHI-ACCESS-SIGNATURE"] = await sign(this.key, ts, method, this.basePath + path);
    }
    return h;
  }

  async request<T = any>(method: string, path: string, params?: Params, body?: unknown): Promise<T> {
    const entries = Object.entries(params ?? {}).filter(([, v]) => v !== undefined && v !== "") as [string, string | number][];
    const qs = entries.length ? "?" + new URLSearchParams(entries.map(([k, v]) => [k, String(v)])) : "";
    // GETs retry once on rate limits and server errors; orders never auto-retry.
    const attempts = method === "GET" ? 2 : 1;
    for (let i = 0; ; i++) {
      this.requests++;
      const resp = await this.fetchFn(this.baseUrl + path + qs, {
        method,
        headers: await this.headers(method, path),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const text = await resp.text();
      if (resp.ok) {
        this.ok++;
        return (text ? JSON.parse(text) : {}) as T;
      }
      this.lastFailure = {
        status: resp.status,
        path,
        signed: !!(this.key && this.apiKeyId),
        retryAfter: resp.headers.get("retry-after"),
        server: resp.headers.get("server"),
        cfRay: resp.headers.get("cf-ray"),
        at: new Date().toISOString(),
      };
      const retryable = resp.status === 429 || resp.status >= 500;
      if (!retryable || i + 1 >= attempts) throw new KalshiError(resp.status, text);
      await new Promise((r) => setTimeout(r, 750));
    }
  }

  async getMarketsPage(params: Params): Promise<{ markets: Market[]; cursor: string }> {
    const d = await this.request<{ markets?: Market[]; cursor?: string }>("GET", "/markets", params);
    return { markets: d.markets ?? [], cursor: d.cursor ?? "" };
  }

  async getMarkets(params: Params): Promise<Market[]> {
    return (await this.getMarketsPage(params)).markets;
  }

  /** Up to ~100 markets by ticker in one request. */
  async getMarketsByTicker(tickers: string[]): Promise<Market[]> {
    if (!tickers.length) return [];
    return this.getMarkets({ tickers: tickers.join(","), limit: Math.min(1000, tickers.length) });
  }

  /** Open events of a series with their markets nested. */
  async getEventsWithMarkets(seriesTicker: string): Promise<(KalshiEvent & { markets?: Market[] })[]> {
    const d = await this.request<{ events?: (KalshiEvent & { markets?: Market[] })[] }>("GET", "/events", {
      series_ticker: seriesTicker,
      status: "open",
      with_nested_markets: "true",
      limit: 200,
    });
    return d.events ?? [];
  }

  async getMarket(ticker: string): Promise<Market> {
    return (await this.request<{ market: Market }>("GET", `/markets/${ticker}`)).market;
  }

  async getEvent(eventTicker: string): Promise<KalshiEvent> {
    const d = await this.request<{ event: KalshiEvent }>("GET", `/events/${eventTicker}`);
    return d.event;
  }

  async getBalance(): Promise<number> {
    const d = await this.request<{ balance?: number; balance_dollars?: string }>("GET", "/portfolio/balance");
    if (d.balance_dollars !== undefined) return Number(d.balance_dollars);
    return (d.balance ?? 0) / 100;
  }

  /** Buy with a limit at `price` dollars, immediate-or-cancel: fill now at that price or not at all. */
  async createOrder(ticker: string, side: "yes" | "no", count: number, price: number, clientOrderId: string = crypto.randomUUID()): Promise<Order> {
    const body = {
      ticker,
      side,
      action: "buy",
      count: Math.floor(count),
      type: "limit",
      [`${side}_price_dollars`]: price.toFixed(4),
      time_in_force: "immediate_or_cancel",
      client_order_id: clientOrderId,
    };
    return (await this.request<{ order: Order }>("POST", "/portfolio/orders", undefined, body)).order ?? {};
  }

  /**
   * Post a resting buy at `price` that can only add liquidity (post-only, so it
   * never pays the taker fee). Kalshi itself cancels it at `expiresAt` (unix
   * seconds), even if the bot stops running.
   */
  async createMakerOrder(ticker: string, side: "yes" | "no", count: number, price: number, expiresAt: number, clientOrderId: string = crypto.randomUUID()): Promise<Order> {
    const body = {
      ticker,
      side,
      action: "buy",
      count: Math.floor(count),
      type: "limit",
      [`${side}_price_dollars`]: price.toFixed(4),
      time_in_force: "good_till_canceled",
      post_only: true,
      expiration_ts: Math.floor(expiresAt),
      cancel_order_on_pause: true,
      client_order_id: clientOrderId,
    };
    return (await this.request<{ order: Order }>("POST", "/portfolio/orders", undefined, body)).order ?? {};
  }

  /**
   * Find an order we sent by its client_order_id. Used when an order request
   * times out: Kalshi may have placed it even though we never got the reply.
   */
  async findOrderByClientId(ticker: string, clientOrderId: string): Promise<Order | null> {
    const d = await this.request<{ orders?: Order[] }>("GET", "/portfolio/orders", { ticker, limit: 100 });
    return (d.orders ?? []).find((o) => o.client_order_id === clientOrderId) ?? null;
  }

  async getOrder(orderId: string): Promise<Order> {
    return (await this.request<{ order: Order }>("GET", `/portfolio/orders/${orderId}`)).order ?? {};
  }

  /** Cancel a resting order. Returns the order as it ended (with its final fill count) when Kalshi sends it. */
  async cancelOrder(orderId: string): Promise<Order | null> {
    const d = await this.request<{ order?: Order }>("DELETE", `/portfolio/orders/${orderId}`);
    return d.order ?? null;
  }
}

/** Best price to rest a buy at: 1¢ above the best bid when the spread allows, never at or through the ask. */
export function makerPrice(bid: number | null, ask: number | null): number | null {
  // Work in whole cents so float noise never nudges a price across the ask.
  const b = bid === null ? null : Math.round(bid * 100);
  const a = ask === null ? null : Math.round(ask * 100);
  if (a === null && b === null) return null;
  let c = b === null ? a! - 1 : b + 1;
  if (a !== null && c > a - 1) c = b !== null && b < a ? Math.min(b, a - 1) : a - 1;
  return c >= 1 && c <= 99 ? c / 100 : null;
}

/** Where we would rest a YES and a NO buy. A NO bid is the other side of a YES ask. */
export function makerQuotes(m: Record<string, unknown>): { yes: number | null; no: number | null } {
  const r = (x: number | null) => (x === null ? null : Math.round(x * 100) / 100);
  const yb = dollars(m, "yes_bid");
  const ya = dollars(m, "yes_ask");
  const nb = dollars(m, "no_bid") ?? (ya === null ? null : r(1 - ya));
  const na = dollars(m, "no_ask") ?? (yb === null ? null : r(1 - yb));
  return { yes: makerPrice(yb, ya), no: makerPrice(nb, na) };
}

/** Read a price from a market object, preferring the `_dollars` field. */
export function dollars(m: Record<string, unknown>, field: string): number | null {
  const d = m[`${field}_dollars`];
  if (d !== undefined && d !== null && d !== "") return Number(d);
  const c = m[field];
  if (c !== undefined && c !== null && c !== "") return Number(c) / 100;
  return null;
}

/** Contracts showing at the best ask for a side. A NO ask is the other side of a YES bid. */
export function askSize(m: Record<string, unknown>, side: "yes" | "no"): number | null {
  const v = m[side === "yes" ? "yes_ask_size_fp" : "yes_bid_size_fp"];
  return v === undefined || v === null || v === "" ? null : Math.floor(Number(v));
}

export function seriesOf(eventTicker: string): string {
  return eventTicker.split("-")[0];
}

export function ts(iso: string): number {
  return Date.parse(iso) / 1000;
}
