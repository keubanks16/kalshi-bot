// End-to-end paper trading against a fake Kalshi and a fake price feed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { loadSettings } from "../src/config.ts";
import { Engine } from "../src/engine.ts";
import { Store, type Sql } from "../src/store.ts";
import { renderDashboard } from "../src/dashboard.ts";
import { KalshiError } from "../src/kalshi.ts";

const NOW = Date.parse("2026-10-09T14:00:00Z") / 1000;
const iso = (t: number) => new Date(t * 1000).toISOString();
const CF_RULES = "If the simple average of the sixty seconds of CF Benchmarks' Bitcoin Real-Time Index (BRTI) before 11 AM EDT is above 80,000.00, then the market resolves to Yes.";

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

function markets() {
  return [
    // crypto: BTC above $80,000 in an hour, BTC is at $80,600, YES offered at 55¢
    {
      ticker: "KXBTCD-26OCT0911-T80000",
      event_ticker: "KXBTCD-26OCT0911",
      status: "active",
      open_time: iso(NOW - 7200),
      close_time: iso(NOW + 3600),
      strike_type: "greater",
      floor_strike: 80000,
      rules_primary: CF_RULES,
      yes_ask_dollars: "0.5500",
      no_ask_dollars: "0.4700",
      yes_bid_dollars: "0.5300",
      yes_ask_size_fp: "200.00",
      yes_bid_size_fp: "200.00",
      result: "",
    },
    // same, but closes in 10 days — outside a one-day limit
    {
      ticker: "KXBTCD-26OCT1911-T80000",
      event_ticker: "KXBTCD-26OCT1911",
      status: "active",
      open_time: iso(NOW - 7200),
      close_time: iso(NOW + 10 * 86400),
      strike_type: "greater",
      floor_strike: 80000,
      rules_primary: CF_RULES,
      yes_ask_dollars: "0.3000",
      no_ask_dollars: "0.7200",
      yes_bid_size_fp: "200.00",
      yes_ask_size_fp: "200.00",
      result: "",
    },
    // a mutually exclusive 3-way event whose YES bids add to $1.15
    ...[
      ["A", "0.40"],
      ["B", "0.40"],
      ["C", "0.35"],
    ].map(([k, bid]) => ({
      ticker: `KXFEDDEC-26-${k}`,
      event_ticker: "KXFEDDEC-26",
      status: "active",
      open_time: iso(NOW - 86400),
      close_time: iso(NOW + 6 * 3600),
      strike_type: "custom",
      yes_bid_dollars: bid,
      no_ask_dollars: (1 - Number(bid)).toFixed(4),
      yes_ask_dollars: (Number(bid) + 0.02).toFixed(4),
      yes_bid_size_fp: "50.00",
      yes_ask_size_fp: "50.00",
      rules_primary: "Fed decision",
      result: "",
    })),
  ];
}

class FakeClient {
  all = markets();
  requests = 0;
  async getMarketsPage() {
    return { markets: this.all, cursor: "" };
  }
  async getMarkets(p: Record<string, any>) {
    return this.all.filter((m) => m.event_ticker.startsWith(p.series_ticker + "-"));
  }
  async getMarketsByTicker(t: string[]) {
    return this.all.filter((m) => t.includes(m.ticker));
  }
  async getEvent(e: string) {
    return { event_ticker: e, series_ticker: e.split("-")[0], mutually_exclusive: e.startsWith("KXFED") };
  }
  async getBalance(): Promise<number> {
    throw new Error("paper mode must not touch the account");
  }
}

class FakeFeed {
  requests = 0;
  async spot() {
    return 80600;
  }
  async volatility() {
    return 0.4;
  }
}

function setup(vars: Record<string, string> = {}) {
  const s = loadSettings({ BOT: undefined as any, BOT_MODE: "paper", MAX_DAILY_LOSS: "100", ...vars });
  const store = new Store(memorySql());
  const client = new FakeClient();
  const engine = new Engine(s, client as any, new FakeFeed() as any, store, () => NOW);
  return { engine, store, client };
}

test("one tick finds the crypto edge and the arbitrage, inside the time limit", async () => {
  const { engine, store } = setup();
  await engine.tick();
  const trades = store.openTrades();

  const crypto = trades.filter((t) => t.strategy === "crypto");
  assert.equal(crypto.length, 1);
  assert.equal(crypto[0].ticker, "KXBTCD-26OCT0911-T80000"); // not the 10-day one
  assert.equal(crypto[0].side, "yes");

  const arb = trades.filter((t) => t.strategy === "arb");
  assert.equal(arb.length, 3);
  assert.ok(arb.every((t) => t.side === "no" && t.contracts === arb[0].contracts));
});

test("a week-long limit lets the 10-day market through only with 'month' or 'any'", async () => {
  const { engine, store } = setup();
  store.set("horizon", "month");
  await engine.tick();
  const tickers = store.openTrades().map((t) => t.ticker);
  assert.ok(tickers.includes("KXBTCD-26OCT1911-T80000"));
});

test("arbitrage pays its locked-in profit whichever outcome wins", async () => {
  for (const winner of ["A", "B", "C", null]) {
    const { engine, store, client } = setup({ CRYPTO_ENABLED: "false" });
    await engine.tick();
    const cost = store.openTrades().reduce((s, t) => s + t.cost, 0);
    for (const m of client.all) if (m.event_ticker === "KXFEDDEC-26") m.result = m.ticker.endsWith(`-${winner}`) ? "yes" : "no";
    await engine.settle();
    const pnl = store.summary().pnl;
    assert.ok(pnl > 0, `winner ${winner}: pnl ${pnl} on cost ${cost}`);
  }
});

test("crypto win and loss settle correctly", async () => {
  const { engine, store, client } = setup({ ARB_ENABLED: "false" });
  await engine.tick();
  const t = store.openTrades()[0];
  client.all[0].result = "no";
  await engine.settle();
  assert.equal(store.recentTrades()[0].pnl, -t.cost);
});

test("backs off when Kalshi says too many requests", async () => {
  const { engine, client } = setup();
  let calls = 0;
  client.getMarketsPage = async () => {
    calls++;
    throw new KalshiError(429, '{"error":{"code":"too_many_requests"}}');
  };
  await engine.tick(); // hits the limit
  assert.ok(engine.cooldownUntil > NOW);
  await engine.tick(); // still cooling down: no new request
  assert.equal(calls, 1);
  assert.match(engine.status, /slow down/);
});

test("kill switch stops trading", async () => {
  const { engine, store } = setup();
  store.set("kill_switch", "on");
  await engine.tick();
  assert.equal(store.openTrades().length, 0);
});

test("limits hold over many ticks", async () => {
  const { engine, store } = setup();
  for (let i = 0; i < 20; i++) {
    engine.series.forEach((st) => (st.nextCheck = 0));
    await engine.tick();
  }
  assert.ok(store.openRisk() <= 50 + 1e-9);
  for (const t of new Set(store.openTrades().map((t) => t.ticker))) {
    const ex = store.marketExposure(t);
    assert.ok(ex.orders <= 3 && ex.cost <= 10 + 1e-9, `${t}: ${JSON.stringify(ex)}`);
  }
  assert.ok(store.eventExposure("KXFEDDEC-26") <= 20 + 1e-9);
});

test("dashboard renders and escapes Kalshi text", async () => {
  const { engine, store } = setup();
  await engine.tick();
  store.addDecision({ ts: NOW, strategy: "crypto", ticker: "<script>x</script>", action: "hold", reason: "r" });
  const html = renderDashboard(
    {
      mode: "paper", problem: null, status: engine.status, lastError: null, alive: true, killSwitch: false,
      horizon: "day", horizons: [{ key: "day", label: "Within a day" }], summary: store.summary(), today: 0,
      byStrategy: store.byStrategy(), trades: store.recentTrades(), decisions: store.recentDecisions(), timezone: "America/New_York",
    },
    { authed: true, passwordSet: true },
  );
  assert.ok(html.includes("KXFEDDEC-26"));
  assert.ok(!html.includes("<script>x"));
});
