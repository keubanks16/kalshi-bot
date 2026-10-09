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

interface V2OrderReply {
  order_id?: string;
  client_order_id?: string;
  fill_count?: string;
  remaining_count?: string;
  average_fill_price?: string;
  average_fee_paid?: string; // per contract
}

/** V2 side and price for buying `side` at `price` dollars (V2 prices are always YES prices). */
export function v2Side(side: "yes" | "no", price: number): { side: "bid" | "ask"; price: string } {
  const yesPrice = side === "yes" ? price : 1 - price;
  return { side: side === "yes" ? "bid" : "ask", price: (Math.round(yesPrice * 10000) / 10000).toFixed(4) };
}

/**
 * Per-shard balances in dollars. Kalshi's breakdown has been seen in dollars
 * (e.g. "57.64") where the docs suggest cents, so each entry's unit is checked:
 * a _dollars field is dollars; otherwise pick whichever reading (dollars or
 * cents) makes the shards add up to the account total.
 */
export function parseBreakdown(raw: unknown, total: number): Record<number, number> | null {
  if (!Array.isArray(raw) || !raw.length) return null;
  // Each entry's number, from balance_dollars when present, else balance.
  const rows = raw.map((b: any) => ({
    i: Number(b?.exchange_index ?? 0),
    v: b?.balance_dollars !== undefined && b?.balance_dollars !== null && b?.balance_dollars !== "" ? Number(b.balance_dollars) : Number(b?.balance ?? 0),
  }));
  const sum = rows.reduce((t, r) => t + (Number.isFinite(r.v) ? r.v : 0), 0);
  // The unit isn't documented reliably (live data came back 100x off), so use
  // whichever scale makes the shards add up to the account's total balance.
  const scales = [1, 1 / 100, 100, 1 / 10000];
  const scale = sum > 0 && total > 0 ? scales.reduce((best, sc) => (Math.abs(sum * sc - total) < Math.abs(sum * best - total) ? sc : best)) : 1;
  const out: Record<number, number> = {};
  for (const r of rows) out[r.i] = Math.round(((out[r.i] ?? 0) + (Number.isFinite(r.v) ? r.v : 0) * scale) * 10000) / 10000;
  return out;
}

/** A V2 create-order reply in the shape the engine reads (fills, fees, status). */
export function fromV2(r: V2OrderReply, count: number, timeInForce: string): Order {
  const filled = Math.floor(Number(r.fill_count ?? 0)) || 0;
  const remaining = Number(r.remaining_count ?? count - filled);
  const fee = filled > 0 && r.average_fee_paid !== undefined ? Number(r.average_fee_paid) * filled : undefined;
  const status = remaining > 0 && timeInForce === "good_till_canceled" ? "resting" : filled > 0 && remaining <= 0 ? "executed" : "canceled";
  return {
    ...r,
    order_id: r.order_id,
    fill_count_fp: String(filled),
    ...(fee !== undefined ? { taker_fees_dollars: fee.toFixed(4) } : {}),
    status,
  };
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
  lastBalanceRaw: unknown = null; // Kalshi's last balance reply, for /health diagnostics
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

  /**
   * Available cash in dollars, in total and per exchange shard. Kalshi's total
   * adds up every shard, but an order can only spend the cash on its own
   * market's shard (the market's exchange_index).
   */
  async getBalanceDetail(): Promise<{ total: number; byIndex: Record<number, number> | null }> {
    const d = await this.request<{ balance?: number; balance_dollars?: string; balance_breakdown?: { exchange_index?: number; balance?: number; balance_dollars?: string }[] }>("GET", "/portfolio/balance");
    const total = d.balance_dollars !== undefined ? Number(d.balance_dollars) : (d.balance ?? 0) / 100;
    this.lastBalanceRaw = { balance: d.balance, balance_dollars: d.balance_dollars, balance_breakdown: d.balance_breakdown };
    return { total, byIndex: parseBreakdown(d.balance_breakdown, total) };
  }

  /**
   * Move cash between exchange shards of this account. Kalshi processes it in
   * the background. API orders can only spend cash already on their market's
   * shard (crypto is shard 2), unlike app orders, which Kalshi funds automatically.
   */
  async transferBetweenShards(fromShard: number, toShard: number, dollars: number, clientTransferId: string = crypto.randomUUID()): Promise<string> {
    const body = {
      source: "event_contract",
      destination: "event_contract",
      amount: Math.round(dollars * 10000), // centicents
      client_transfer_id: clientTransferId,
      source_exchange_shard: fromShard,
      destination_exchange_shard: toShard,
    };
    const r = await this.request<{ transfer_id?: string }>("POST", "/portfolio/intra_exchange_instance_transfer", undefined, body);
    return String(r.transfer_id ?? "");
  }

  async getBalance(): Promise<number> {
    const d = await this.request<{ balance?: number; balance_dollars?: string }>("GET", "/portfolio/balance");
    if (d.balance_dollars !== undefined) return Number(d.balance_dollars);
    return (d.balance ?? 0) / 100;
  }

  /**
   * Send a buy through Kalshi's V2 order endpoint (the v1 one is retired).
   * V2 quotes everything from the YES side: buying YES is a "bid" at the YES
   * price; buying NO is an "ask" (sell YES) at 1 − the NO price. The reply is
   * turned back into the order shape the rest of the bot reads.
   */
  private async placeV2(
    ticker: string,
    side: "yes" | "no",
    count: number,
    price: number,
    clientOrderId: string,
    extra: Record<string, unknown>,
  ): Promise<Order> {
    const contracts = Math.floor(count);
    const body = {
      ticker,
      ...v2Side(side, price),
      count: contracts.toFixed(2),
      self_trade_prevention_type: "taker_at_cross",
      client_order_id: clientOrderId,
      ...extra,
    };
    const r = await this.request<V2OrderReply>("POST", "/portfolio/events/orders", undefined, body);
    return fromV2(r, contracts, String(extra.time_in_force));
  }

  /** Buy with a limit at `price` dollars, immediate-or-cancel: fill now at that price or not at all. */
  async createOrder(ticker: string, side: "yes" | "no", count: number, price: number, clientOrderId: string = crypto.randomUUID()): Promise<Order> {
    return this.placeV2(ticker, side, count, price, clientOrderId, { time_in_force: "immediate_or_cancel" });
  }

  /**
   * Post a resting buy at `price` that can only add liquidity (post-only, so it
   * never pays the taker fee). Kalshi itself cancels it at `expiresAt` (unix
   * seconds), even if the bot stops running.
   */
  async createMakerOrder(ticker: string, side: "yes" | "no", count: number, price: number, expiresAt: number, clientOrderId: string = crypto.randomUUID()): Promise<Order> {
    return this.placeV2(ticker, side, count, price, clientOrderId, {
      time_in_force: "good_till_canceled",
      post_only: true,
      expiration_time: Math.floor(expiresAt),
      cancel_order_on_pause: true,
    });
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
  async cancelOrder(orderId: string, ticker?: string): Promise<Order | null> {
    // V2 cancel replies with only the amount cancelled, not the order, so
    // return null and let the caller read the final order (with its fills).
    try {
      await this.request("DELETE", `/portfolio/events/orders/${orderId}`, { market_ticker: ticker });
      return null;
    } catch (e) {
      // "Not found" from V2 can mean it routed the cancel wrong; the older
      // cancel endpoint is still live, so try it before giving up.
      if (!(e instanceof KalshiError && e.status === 404)) throw e;
      const d = await this.request<{ order?: Order }>("DELETE", `/portfolio/orders/${orderId}`);
      return d.order ?? null;
    }
  }

  /** What actually filled on an order, from Kalshi's fills record (works even after the order is gone). */
  async getOrderFills(orderId: string, ticker?: string): Promise<{ filled: number; fees: number }> {
    const d = await this.request<{ fills?: Record<string, unknown>[] }>("GET", "/portfolio/fills", { order_id: orderId, ticker, limit: 1000 });
    let filled = 0;
    let fees = 0;
    for (const f of d.fills ?? []) {
      if (f.order_id !== undefined && f.order_id !== orderId) continue;
      filled += Number(f.count_fp ?? f.count ?? 0) || 0;
      fees += Number(f.fee_cost ?? 0) || 0;
    }
    return { filled: Math.floor(filled + 1e-9), fees: Math.round(fees * 10000) / 10000 };
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
