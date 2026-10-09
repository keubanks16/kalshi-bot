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
