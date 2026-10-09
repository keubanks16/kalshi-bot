import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { buildPrompt, costOf, forecast, parseForecast } from "../src/ai.ts";
import { loadSettings } from "../src/config.ts";
import { Engine } from "../src/engine.ts";
import { Store, type Sql } from "../src/store.ts";

const NOW = Date.parse("2026-10-09T14:00:00Z") / 1000;
const iso = (t: number) => new Date(t * 1000).toISOString();

test("parses the final JSON line, ignoring earlier ones", () => {
  const text = 'I looked at {"probability": 0.9} early... then\n{"probability": 0.37, "confidence": "medium", "summary": "CPI data due Tuesday."}';
  assert.deepEqual(parseForecast(text), { probability: 0.37, confidence: "medium", summary: "CPI data due Tuesday." });
  assert.equal(parseForecast("no numbers here"), null);
  assert.equal(parseForecast('{"probability": 1.7}'), null);
});

test("cost adds tokens and searches", () => {
  const c = costOf({ input_tokens: 20_000, output_tokens: 1_000, server_tool_use: { web_search_requests: 3 } }, { inputPricePerM: 2, outputPricePerM: 10 });
  assert.equal(c.searches, 3);
  assert.ok(Math.abs(c.cost - (0.04 + 0.01 + 0.03)) < 1e-9);
});

test("prompt has the rules but never the market price", () => {
  const p = buildPrompt({ eventTitle: "Fed decision", marketTitle: "Cut 25bp", rules: "Resolves Yes if...", closeTime: "x", now: "y" });
  assert.ok(p.includes("Resolves Yes if"));
  assert.ok(!/price|¢|\$/.test(p));
});

test("forecast continues after pause_turn and sums cost", async () => {
  const replies = [
    { stop_reason: "pause_turn", content: [{ type: "text", text: "Searching…" }], usage: { input_tokens: 1000, output_tokens: 100, server_tool_use: { web_search_requests: 2 } } },
    { stop_reason: "end_turn", content: [{ type: "text", text: '{"probability": 0.2, "confidence": "high", "summary": "Unlikely."}' }], usage: { input_tokens: 2000, output_tokens: 200 } },
  ];
  let calls = 0;
  const fakeFetch = (async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    assert.equal(body.tools[0].type, "web_search_20250305");
    if (calls === 1) assert.equal(body.messages.at(-1).role, "assistant");
    return new Response(JSON.stringify(replies[calls++]), { status: 200 });
  }) as typeof fetch;
  const f = await forecast(
    { eventTitle: "e", marketTitle: "m", rules: "r", closeTime: "c", now: "n" },
    { apiKey: "k", model: "claude-sonnet-5-5", maxSearches: 3, inputPricePerM: 2, outputPricePerM: 10 },
    fakeFetch,
  );
  assert.equal(calls, 2);
  assert.equal(f.probability, 0.2);
  assert.equal(f.searches, 2);
  assert.ok(f.cost > 0.02);
});

// ---------------------------------------------------------------- engine

function memorySql(): Sql {
  const db = new DatabaseSync(":memory:");
  return {
    exec(q: string, ...b: unknown[]) {
      const st = db.prepare(q);
      if (/^\s*(select|with)/i.test(q)) {
        const rows = st.all(...(b as any[]));
        return { toArray: () => rows as any[] };
      }
      st.run(...(b as any[]));
      return { toArray: () => [] };
    },
  };
}

function fedMarket() {
  return {
    ticker: "KXCPI-26OCT-T3.0",
    event_ticker: "KXCPI-26OCT",
    status: "active",
    open_time: iso(NOW - 86400),
    close_time: iso(NOW + 3 * 86400),
    yes_sub_title: "Above 3.0%",
    rules_primary: "If CPI YoY for September is above 3.0%, resolves Yes.",
    yes_bid_dollars: "0.40",
    yes_ask_dollars: "0.42",
    no_ask_dollars: "0.60",
    yes_bid_size_fp: "500.00",
    yes_ask_size_fp: "500.00",
    volume_24h_fp: "8000.00",
    result: "",
  };
}

function setup(probability: number, confidence: "low" | "medium" | "high" = "high", vars: Record<string, string> = {}) {
  const s = loadSettings({ BOT: undefined as any, BOT_MODE: "paper", MAKER_STRATEGIES: "none", TRADE_HORIZON: "week", CRYPTO_ENABLED: "false", ARB_ENABLED: "false", MAX_COST_PER_ORDER: "10", ...vars });
  const store = new Store(memorySql());
  const market = fedMarket();
  const client = {
    async getMarketsPage() {
      return { markets: [market], cursor: "" };
    },
    async getMarkets() {
      return [market];
    },
    async getMarketsByTicker() {
      return [market];
    },
    async getMarket() {
      return market;
    },
    async getEvent() {
      return { event_ticker: "KXCPI-26OCT", series_ticker: "KXCPI", title: "September CPI", mutually_exclusive: false };
    },
  };
  const engine = new Engine(s, client as any, {} as any, store, () => NOW);
  engine.aiKey = "test-key";
  let calls = 0;
  engine.aiForecastFn = async () => {
    calls++;
    return { probability, confidence, summary: "Economists expect 3.2%.", cost: 0.12, searches: 3 };
  };
  return { engine, store, calls: () => calls };
}

test("AI researches a liquid market and bets on a big gap", async () => {
  const { engine, store } = setup(0.8);
  await engine.tick(); // scan finds the market
  await engine.runAi(NOW);
  const t = store.openTrades();
  assert.equal(t.length, 1);
  assert.equal(t[0].strategy, "ai");
  assert.equal(t[0].side, "yes");
  assert.equal(t[0].note, "Economists expect 3.2%.");
  const f = store.recentForecasts()[0];
  assert.equal(f.p, 0.8);
  assert.match(f.action, /^bought/);
  assert.ok(Math.abs(store.aiSpend("2026-10-09") - 0.12) < 1e-9);
});

test("AI doesn't bet when the gap is small or confidence is low", async () => {
  const small = setup(0.47);
  await small.engine.tick();
  await small.engine.runAi(NOW);
  assert.equal(small.store.openTrades().length, 0);
  assert.match(small.store.recentForecasts()[0].action, /no bet/);

  const unsure = setup(0.9, "low");
  await unsure.engine.tick();
  await unsure.engine.runAi(NOW);
  assert.equal(unsure.store.openTrades().length, 0);
  assert.match(unsure.store.recentForecasts()[0].action, /low confidence/);
});

test("AI respects the daily budget and the interval", async () => {
  const { engine, store, calls } = setup(0.8, "high", { AI_DAILY_BUDGET: "0.30" });
  await engine.tick();
  store.addForecast({ ts: NOW - 3600, day: "2026-10-09", ticker: "X", title: "x", p: 0.5, confidence: "low", summary: "", market_mid: 0.5, cost: 0.2, searches: 1, action: "x" });
  await engine.runAi(NOW);
  assert.equal(calls(), 0);
  assert.match(engine.aiStatus, /budget used/);

  const b = setup(0.8);
  await b.engine.tick();
  await b.engine.runAi(NOW);
  await b.engine.runAi(NOW + 60); // too soon for another
  assert.equal(b.calls(), 1);
});

test("AI explains when the time limit is too short", async () => {
  const { engine, store, calls } = setup(0.8);
  await engine.tick();
  store.set("horizon", "hour");
  await engine.runAi(NOW);
  assert.equal(calls(), 0);
  assert.match(engine.aiStatus, /time limit is shorter/);
});

test("AI is off without a key", async () => {
  const { engine, calls } = setup(0.8);
  engine.aiKey = "";
  await engine.runAi(NOW);
  assert.equal(calls(), 0);
  assert.match(engine.aiStatus, /ANTHROPIC_API_KEY/);
});
