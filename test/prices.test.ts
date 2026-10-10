import { test } from "node:test";
import assert from "node:assert/strict";
import { PriceFeed, REST_QUOTES, STREAMS, indexPrice, weightedMedian } from "../src/prices.ts";

test("weighted median follows the heavy side", () => {
  assert.equal(weightedMedian([{ value: 1, weight: 1 }, { value: 2, weight: 1 }, { value: 3, weight: 10 }]), 3);
  assert.equal(weightedMedian([{ value: 1, weight: 5 }, { value: 2, weight: 1 }, { value: 3, weight: 1 }]), 1);
});

test("index uses mid-prices and ignores a thin outlier", () => {
  const now = Date.now();
  const p = indexPrice([
    { bid: 99, ask: 101, volume: 1000, at: now }, // mid 100, big
    { bid: 100, ask: 102, volume: 800, at: now }, // mid 101
    { bid: 149, ask: 151, volume: 1, at: now }, // broken, tiny
  ]);
  assert.ok(p === 100 || p === 101);
});

// Fake exchange APIs, one per constituent
const RESPONSES: Record<string, unknown> = {
  "api.exchange.coinbase.com": { bid: "99.9", ask: "100.1", volume: "500" },
  "api.kraken.com": { result: { XXBTZUSD: { b: ["99.8", "1", "1"], a: ["100.2", "1", "1"], v: ["10", "400"] } } },
  "www.bitstamp.net": { bid: "99.7", ask: "100.3", volume: "300" },
  "api.gemini.com": { bid: "99.6", ask: "100.4", volume: { BTC: "200" } },
  "api.crypto.com": { result: { data: [{ b: "99.5", k: "100.5", v: "250" }] } },
  "api.exchange.bullish.com": { bestBid: "99.4", bestAsk: "100.6", baseVolume: "150" },
};

function fakeFetch(down: string[] = []) {
  const hits: string[] = [];
  const f = (async (url: string) => {
    const host = new URL(url).host;
    hits.push(host);
    if (down.includes(host) || !RESPONSES[host]) return new Response("nope", { status: 503 });
    return new Response(JSON.stringify(RESPONSES[host]), { status: 200 });
  }) as typeof fetch;
  return { f, hits };
}

test("every exchange's REST quote parses", async () => {
  const { f } = fakeFetch();
  for (const [name, get] of Object.entries(REST_QUOTES)) {
    const qt = await get(f, "BTC");
    assert.ok(qt.bid > 99 && qt.ask < 101 && qt.volume! > 0, name);
  }
});

test("spot builds an index from all six and survives outages", async () => {
  const { f } = fakeFetch();
  const feed = new PriceFeed(f, async () => {
    throw new Error("no sockets in tests");
  });
  const p = await feed.spot("BTC");
  assert.ok(Math.abs(p - 100) < 0.01);
  assert.equal(feed.lastSources.BTC.length, 6);

  const down = fakeFetch(["api.exchange.coinbase.com", "api.kraken.com", "www.bitstamp.net", "api.gemini.com"]);
  const feed2 = new PriceFeed(down.f);
  await feed2.spot("BTC"); // two left is enough
  const dead = fakeFetch(Object.keys(RESPONSES).slice(1));
  await assert.rejects(new PriceFeed(dead.f).spot("BTC"), /only 1/);
});

test("stream messages parse", () => {
  const cb = STREAMS.coinbase.parse({ type: "ticker", product_id: "ETH-USD", best_bid: "2500.1", best_ask: "2500.3", volume_24h: "9000" });
  assert.equal(cb[0][0], "ETH");
  assert.equal(cb[0][1].bid, 2500.1);
  const kr = STREAMS.kraken.parse({ channel: "ticker", type: "update", data: [{ symbol: "SOL/USD", bid: 150.1, ask: 150.2, volume: 1e5 }] });
  assert.equal(kr[0][0], "SOL");
  assert.deepEqual(STREAMS.kraken.parse({ channel: "heartbeat" }), []);
});

test("fresh streamed quotes skip REST polling for that exchange", async () => {
  const listeners: Record<string, (ev: any) => void>[] = [];
  const sent: string[] = [];
  const factory = async () => {
    const l: Record<string, (ev: any) => void> = {};
    listeners.push(l);
    return { addEventListener: (t: string, fn: any) => (l[t] = fn), send: (m: string) => sent.push(m), close() {} } as any;
  };
  const { f, hits } = fakeFetch();
  const feed = new PriceFeed(f, factory);
  await feed.ensureStreams(["BTC"]);
  assert.equal(feed.sockets.size, 2);
  assert.ok(sent.some((m) => m.includes("BTC-USD")) && sent.some((m) => m.includes("BTC/USD")));

  // Coinbase streams a quote
  listeners[0].message({ data: JSON.stringify({ type: "ticker", product_id: "BTC-USD", best_bid: "99.95", best_ask: "100.05", volume_24h: "500" }) });
  await feed.spot("BTC");
  assert.ok(!hits.includes("api.exchange.coinbase.com"), "coinbase came from the stream");
  assert.ok(hits.includes("api.kraken.com"), "kraken stream silent, so it was polled");
  assert.match(feed.describe(), /6 exchanges, 2 live streams/);

  // a dropped socket is forgotten and reconnected next round
  listeners[1].close({});
  assert.equal(feed.sockets.size, 1);
  await feed.ensureStreams(["BTC"]);
  assert.equal(feed.sockets.size, 2);
});

// ------------------------------------------------------------ Kalshi CF Benchmarks index feed
class FakeSocket {
  sent: any[] = [];
  listeners: Record<string, ((ev: any) => void)[]> = {};
  addEventListener(t: string, f: (ev: any) => void) {
    (this.listeners[t] ??= []).push(f);
  }
  send(s: string) {
    this.sent.push(JSON.parse(s));
  }
  close() {
    this.emit("close", { code: 1000 });
  }
  emit(t: string, ev: any) {
    for (const f of this.listeners[t] ?? []) f(ev);
  }
  tick(index_id: string, value: string) {
    this.emit("message", { data: JSON.stringify({ type: "cfbenchmarks_value_5hz", sid: 1, seq: 1, msg: { index_id, value_usd: value, source_ts_ms: Date.now(), received_at: Date.now() } }) });
  }
}

test("CF feed: signed handshake, subscribes to the 5Hz index channel, and spot() uses it with no exchange polling", async () => {
  const sock = new FakeSocket();
  const opened: { url: string; headers: any }[] = [];
  let polls = 0;
  const feed = new PriceFeed((async () => (polls++, new Response("{}"))) as any, async (url, headers) => (opened.push({ url, headers }), sock as any));
  await feed.ensureIndexFeed(["BTC", "ETH"], { url: "wss://external-api-ws.kalshi.com/trade-api/ws/v2", headers: async () => ({ "KALSHI-ACCESS-KEY": "k", "KALSHI-ACCESS-SIGNATURE": "s", "KALSHI-ACCESS-TIMESTAMP": "1" }) });
  assert.equal(opened[0].url, "wss://external-api-ws.kalshi.com/trade-api/ws/v2");
  assert.equal(opened[0].headers["KALSHI-ACCESS-KEY"], "k");
  assert.deepEqual(sock.sent[0], { id: 1, cmd: "subscribe", params: { channels: ["cfbenchmarks_value_5hz"], index_ids: ["BRTI", "ETHUSD_RTI"] } });

  sock.tick("BRTI", "82762.40000000");
  assert.equal(await feed.spot("BTC"), 82762.4);
  assert.equal(polls, 0, "no exchange requests when the CF value is fresh");
  assert.equal(feed.spotSource.BTC, "cf");
  assert.match(feed.describe(), /CF Benchmarks/);
});

test("CF feed: falls back to the exchanges when it's stale or down, and reconnects after a drop", async () => {
  const sock = new FakeSocket();
  let opens = 0;
  const feed = new PriceFeed(fakeFetch().f, async () => (opens++, sock as any));
  const auth = { url: "wss://x/trade-api/ws/v2", headers: async () => ({ a: "b" }) };
  await feed.ensureIndexFeed(["BTC"], auth);
  sock.tick("BRTI", "90000");
  feed.cf.get("BTC")!.at = Date.now() - 10_000; // stale
  const p = await feed.spot("BTC");
  assert.ok(p > 99 && p < 101, `fell back to exchange index: ${p}`);
  assert.equal(feed.spotSource.BTC, "exchanges");

  sock.close();
  assert.equal(feed.cfSocket, null);
  await feed.ensureIndexFeed(["BTC"], auth);
  assert.equal(opens, 2, "reconnected");
});

test("CF feed: needs API keys; reports Kalshi errors", async () => {
  const feed = new PriceFeed(fakeFetch().f, async () => {
    throw new Error("should not connect");
  });
  await feed.ensureIndexFeed(["BTC"], { url: "wss://x", headers: async () => null });
  assert.equal(feed.cfSocket, null);
  assert.equal(feed.cfError, "no Kalshi API keys");

  const sock = new FakeSocket();
  const f2 = new PriceFeed(fakeFetch().f, async () => sock as any);
  await f2.ensureIndexFeed(["BTC"], { url: "wss://x", headers: async () => ({}) });
  sock.emit("message", { data: JSON.stringify({ type: "error", msg: { code: 6, msg: "Unknown channel" } }) });
  assert.equal(f2.cfError, "6 Unknown channel");
});

test("volatility comes from the CF index once there's 45+ minutes of it, and matches the real movement", async () => {
  const feed = new PriceFeed((async () => {
    throw new Error("no candles needed");
  }) as any, async () => new FakeSocket() as any);
  const t0 = Date.now() - 60 * 60_000;
  // 60 minutes of index values alternating ±0.1% per minute: annualized vol ≈ 0.001 * sqrt(525600) ≈ 0.725
  let v = 100;
  for (let i = 0; i <= 60 * 6; i++) {
    if (i % 6 === 0 && i) v *= i % 12 === 0 ? 1.001 : 1 / 1.001;
    feed.recordCf("BTC", v, t0 + i * 10_000);
  }
  const vol = await feed.volatility("BTC", 900);
  assert.ok(Math.abs(vol - 0.725) < 0.03, `vol ${vol}`);
  assert.equal(feed.volSource.BTC, "cf");
});

test("volatility falls back to candles until the CF history is long enough", async () => {
  const candles = Array.from({ length: 120 }, (_, i) => [1_000_000 + i * 60, 0, 0, 0, 100 * (i % 2 ? 1.001 : 1), 0]);
  const feed = new PriceFeed((async () => new Response(JSON.stringify(candles))) as any, async () => new FakeSocket() as any);
  feed.recordCf("BTC", 100, Date.now() - 10 * 60_000);
  feed.recordCf("BTC", 100.1, Date.now());
  await feed.volatility("BTC", 900);
  assert.equal(feed.volSource.BTC, "candles");
});

test("CF history survives a restart: snapshot, restore, and volatility is available right away", async () => {
  const now = Date.now();
  const a = new PriceFeed((async () => new Response("[]")) as any, async () => new FakeSocket() as any);
  let v = 100;
  for (let i = 0; i <= 60 * 6; i++) {
    if (i % 6 === 0 && i) v *= i % 12 === 0 ? 1.001 : 1 / 1.001;
    a.recordCf("ETH", v, now - 60 * 60_000 + i * 10_000);
  }
  const saved = JSON.parse(JSON.stringify(a.cfHistorySnapshot()));
  assert.ok(saved.ETH.length >= 55 && saved.ETH.length <= 62, `about one per minute: ${saved.ETH.length}`);

  // "restart": a fresh feed with only a couple of live ticks
  const b = new PriceFeed((async () => {
    throw new Error("should use CF history, not candles");
  }) as any, async () => new FakeSocket() as any);
  b.recordCf("ETH", v, now - 5_000);
  b.restoreCfHistory(saved, now);
  const vol = await b.volatility("ETH", 900);
  assert.equal(b.volSource.ETH, "cf");
  assert.ok(Math.abs(vol - 0.725) < 0.06, `vol ${vol}`);
});

test("CF volatility ignores history before a gap (bot was down), so a jump across the gap can't inflate it", () => {
  const now = Date.now();
  const f = new PriceFeed((async () => new Response("[]")) as any, async () => new FakeSocket() as any);
  // old stretch at 100, then a 30-minute gap, then 50 calm minutes at 120
  for (let i = 0; i < 60; i++) f.recordCf("BTC", 100, now - 140 * 60_000 + i * 60_000);
  for (let i = 0; i <= 50 * 6; i++) f.recordCf("BTC", 120 * (1 + (i % 2 ? 1e-5 : 0)), now - 50 * 60_000 + i * 10_000);
  const vol = f.cfVolatility("BTC", now)!;
  assert.ok(vol !== null && vol < 0.05, `calm stretch only: ${vol}`);

  const g = new PriceFeed((async () => new Response("[]")) as any, async () => new FakeSocket() as any);
  for (let i = 0; i < 60; i++) g.recordCf("BTC", 100, now - 100 * 60_000 + i * 60_000);
  for (let i = 0; i <= 20 * 6; i++) g.recordCf("BTC", 120, now - 20 * 60_000 + i * 10_000);
  assert.equal(g.cfVolatility("BTC", now), null, "only 20 unbroken minutes: not enough yet");
});
