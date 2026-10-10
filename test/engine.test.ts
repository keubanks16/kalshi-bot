// End-to-end paper trading against a fake Kalshi and a fake price feed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { loadSettings } from "../src/config.ts";
import { Engine, blendWithMarket } from "../src/engine.ts";
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
      yes_bid_dollars: "0.2800",
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
  const s = loadSettings({ BOT: undefined as any, BOT_MODE: "paper", MAKER_STRATEGIES: "none", MAX_ORDERS_PER_MARKET: "1", MAX_DAILY_LOSS: "100", MAX_COST_PER_ORDER: "10", ...vars });
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
    const pnl = store.summary("paper").pnl;
    assert.ok(pnl > 0, `winner ${winner}: pnl ${pnl} on cost ${cost}`);
  }
});

test("crypto win and loss settle correctly", async () => {
  const { engine, store, client } = setup({ ARB_ENABLED: "false" });
  await engine.tick();
  const t = store.openTrades()[0];
  client.all[0].result = "no";
  await engine.settle();
  assert.equal(store.recentTrades("paper")[0].pnl, -t.cost);
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

test("dashboard survives an older bot without limits or short labels", () => {
  const html = renderDashboard(
    {
      mode: "paper", problem: null, status: "ok", lastError: null, alive: true, killSwitch: false, horizon: "day",
      horizons: [{ key: "day", label: "Within a day" }] as any, limits: undefined as any,
      summary: { trades: 0, settled: 0, wins: 0, pnl: 0, fees: 0, openCost: 0 }, today: 0,
      byStrategy: [], trades: [], decisions: [], timezone: "America/New_York", diag: {},
    },
    { authed: true, passwordSet: true },
  );
  assert.ok(html.includes("Kalshi Bot"));
});

test("never buys the opposite side of an open position", async () => {
  const { engine, store, client } = setup({ ARB_ENABLED: "false" });
  await engine.tick();
  assert.equal(store.openTrades()[0].side, "yes");
  // BTC collapses: the model now wants NO on the same market
  (engine.feed as any).spot = async () => 79000;
  client.all[0].no_ask_dollars = "0.40";
  engine.series.forEach((st) => (st.nextCheck = 0));
  await engine.tick();
  assert.deepEqual(store.openSides("KXBTCD-26OCT0911-T80000", "paper"), ["yes"]);
});

test("model is blended halfway toward the market price", () => {
  assert.equal(blendWithMarket(0.3, 0.12, 0.14, 0.5), 0.215);
  assert.equal(blendWithMarket(0.3, null, 0.14, 0.5), 0.3);
});

test("model trust set on the dashboard overrides the default", async () => {
  const { engine, store } = setup();
  store.set("model_weight", "0.75");
  await engine.tick();
  assert.equal(engine.s.modelWeight, 0.75);
  store.set("model_weight", "7");
  await engine.tick();
  assert.equal(engine.s.modelWeight, 0.5); // invalid -> default
});

test("switching to live keeps paper results and risk separate", async () => {
  const { engine, store } = setup({ ARB_ENABLED: "false" });
  await engine.tick(); // paper trade
  assert.equal(store.summary("paper").trades, 1);
  store.set("mode_override", "live");
  engine.applyOverrides();
  assert.equal(engine.s.mode, "live");
  assert.equal(store.summary("live").trades, 0);
  assert.equal(store.openRisk("live"), 0); // paper positions don't use up live limits
  store.set("mode_override", "paper");
  engine.applyOverrides();
  assert.equal(engine.s.mode, "paper");
});

test("dashboard: per-strategy go-live forms, switch-back and results tabs", () => {
  const base = {
    problem: null, status: "ok", lastError: null, alive: true, killSwitch: false, horizon: "day",
    horizons: [], limits: [], summary: { trades: 0, settled: 0, wins: 0, pnl: 0, fees: 0, openCost: 0 }, today: 0,
    byStrategy: [], trades: [], decisions: [], timezone: "America/New_York", diag: {}, canGoLive: true, keysSet: true,
  } as any;
  const sw = (cryptoMode: string) => [
    { key: "cryptoEnabled", strategy: "crypto", label: "Crypto", on: true, mode: cryptoMode },
    { key: "aiEnabled", strategy: "ai", label: "AI forecaster", on: true, mode: "paper" },
  ];
  const paper = renderDashboard({ ...base, mode: "paper", views: ["paper"], switches: sw("paper") }, { authed: true, passwordSet: true });
  assert.ok(paper.includes("Go live with Crypto") && paper.includes("Go live with AI forecaster"));
  assert.ok(paper.includes('name="strategy" value="crypto"') && paper.includes('name="confirm"'));

  const mixed = renderDashboard({ ...base, mode: "live", view: "live", views: ["live", "paper"], switches: sw("live") }, { authed: true, passwordSet: true });
  assert.ok(mixed.includes("LIVE: Crypto"), "header names the live strategy");
  assert.ok(mixed.includes("Switch Crypto to paper") && mixed.includes("Go live with AI forecaster"));
  assert.ok(mixed.includes("Switch everything back to paper") && mixed.includes("?view=paper"));

  const noKeys = renderDashboard({ ...base, mode: "paper", keysSet: false, switches: sw("paper") }, { authed: true, passwordSet: true });
  assert.ok(!noKeys.includes('name="confirm"'));
  const signedOut = renderDashboard({ ...base, mode: "paper", switches: sw("paper") }, { authed: false, passwordSet: true });
  assert.ok(!signedOut.includes("Go live"));
});

test("crypto can trade live while the other strategies stay on paper", async () => {
  const { engine, store, client } = setup();
  const orders: any[] = [];
  (client as any).createOrder = async (ticker: string, side: string, count: number, price: number) => {
    orders.push({ ticker, side, count, price });
    return { order_id: "o1", fill_count: count, taker_fees_dollars: "0.05" };
  };
  (client as any).getBalance = async () => 500;
  store.set("strategy_modes", JSON.stringify({ crypto: "live" }));
  await engine.tick();
  const trades = store.openTrades();
  const crypto = trades.filter((t) => t.strategy === "crypto");
  const arb = trades.filter((t) => t.strategy === "arb");
  assert.ok(crypto.length >= 1 && crypto.every((t) => t.mode === "live"), "crypto trades are live");
  assert.ok(arb.length === 3 && arb.every((t) => t.mode === "paper"), "arbitrage stays paper");
  assert.equal(orders.length, crypto.length, "only crypto sent real orders");
  assert.equal(engine.modeFor("arb"), "paper");
});

test("model check counts expected vs actual wins", async () => {
  const { engine, store, client } = setup({ ARB_ENABLED: "false" });
  await engine.tick();
  client.all[0].result = "yes";
  await engine.settle();
  const mc = store.modelCheck("paper");
  assert.equal(mc.settled, 1);
  assert.equal(mc.actualWins, 1);
  assert.ok(mc.expectedWins > 0.5 && mc.expectedWins < 1);
  const html = renderDashboard({ ...({} as any), mode: "paper", problem: null, status: "", lastError: null, alive: true, killSwitch: false,
    horizon: "day", horizons: [], limits: [], summary: store.summary("paper"), today: 0, byStrategy: store.byStrategy("paper"),
    trades: [], decisions: [], timezone: "America/New_York", diag: {}, modelCheck: mc }, { authed: false, passwordSet: true });
  assert.ok(html.includes("Model check") && html.includes("1 of 1"));
});

test("only one bet per market by default", async () => {
  const { engine, store } = setup({ ARB_ENABLED: "false" });
  for (let i = 0; i < 5; i++) {
    engine.series.forEach((st) => (st.nextCheck = 0));
    await engine.tick();
  }
  assert.equal(store.marketExposure("KXBTCD-26OCT0911-T80000", "paper").orders, 1);
});

test("price range from the dashboard blocks long shots", async () => {
  const { engine, store } = setup({ ARB_ENABLED: "false" });
  store.set("price_range", JSON.stringify({ minPrice: 0.6, maxPrice: 0.8 })); // YES ask is 0.55 -> out of range
  await engine.tick();
  assert.equal(engine.s.minPrice, 0.6);
  assert.equal(store.openTrades().length, 0);
});

test("fresh test: stats only count trades after it started", async () => {
  const { engine, store, client } = setup({ ARB_ENABLED: "false" });
  await engine.tick();
  client.all[0].result = "no";
  await engine.settle();
  assert.equal(store.summary("paper").settled, 1);
  assert.equal(store.summary("paper", NOW + 1).settled, 0);
  assert.equal(store.modelCheck("paper", "crypto", NOW + 1).settled, 0);
  assert.equal(store.byStrategy("paper", NOW + 1).length, 0);
  const html = renderDashboard({ ...({} as any), mode: "paper", problem: null, status: "", lastError: null, alive: true, killSwitch: false,
    horizon: "day", horizons: [], limits: [], summary: store.summary("paper", NOW + 1), today: 0, byStrategy: [],
    trades: [], decisions: [], timezone: "America/New_York", diag: {}, testSince: NOW + 1,
    priceRange: { min: 0.15, max: 0.85, dfltMin: 0.15, dfltMax: 0.85 } }, { authed: true, passwordSet: true });
  assert.ok(html.includes("fresh test started") && html.includes('action="/fresh-test"'));
  assert.ok(html.includes('action="/prices"') && html.includes('value="15"') && html.includes('value="85"'));
});

test("15-minute limit skips markets closing later", async () => {
  const { engine, store } = setup();
  store.set("horizon", "15m");
  await engine.tick();
  assert.equal(store.openTrades().length, 0);
});

test("dashboard spending limits override the defaults", async () => {
  const { engine, store } = setup({ ARB_ENABLED: "false" });
  store.set("limits", JSON.stringify({ maxCostPerOrder: 2, bogus: 9, maxOpenRisk: -5 }));
  await engine.tick();
  assert.equal(engine.s.maxCostPerOrder, 2);
  assert.equal(engine.s.maxOpenRisk, 50); // invalid value ignored
  const t = store.openTrades()[0];
  assert.ok(t.cost <= 2, `cost ${t.cost}`);
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
  assert.ok(store.openRisk("paper") <= 50 + 1e-9);
  for (const t of new Set(store.openTrades().map((t) => t.ticker))) {
    const ex = store.marketExposure(t, "paper");
    assert.ok(ex.orders <= 1 && ex.cost <= 10 + 1e-9, `${t}: ${JSON.stringify(ex)}`);
  }
  assert.ok(store.eventExposure("KXFEDDEC-26", "paper") <= 20 + 1e-9);
});

test("dashboard renders and escapes Kalshi text", async () => {
  const { engine, store } = setup();
  await engine.tick();
  store.addDecision({ ts: NOW, strategy: "crypto", ticker: "<script>x</script>", action: "hold", reason: "r" });
  const html = renderDashboard(
    {
      mode: "paper", problem: null, status: engine.status, lastError: null, alive: true, killSwitch: false,
      horizon: "day", horizons: [{ key: "day", label: "Within a day", short: "1 day" }],
      limits: [{ key: "maxCostPerOrder", label: "Max per trade", help: "h", value: 5, dflt: 5 }],
      modelWeight: { value: 0.5, dflt: 0.5, options: [0.25, 0.5, 0.75, 1] }, summary: store.summary("paper"), today: 0,
      byStrategy: store.byStrategy("paper"), trades: store.recentTrades("paper"), decisions: store.recentDecisions(), timezone: "America/New_York", diag: {},
    },
    { authed: true, passwordSet: true },
  );
  assert.ok(html.includes("KXFEDDEC-26"));
  assert.ok(!html.includes("<script>x"));
  assert.ok(html.includes('action="/logout"'));
  assert.match(html, /Bet \$\d+\.\d{2}/);
  assert.match(html, /pays \$\d+\.00 if right/);
  assert.ok(html.includes('action="/model"') && html.includes(">50%<"));
  assert.match(html, /closes (today|tomorrow|[A-Z][a-z]{2} \d+) \d{1,2}:\d{2}/);
});

// ------------------------------------------------------------ maker orders
function makerSetup(vars: Record<string, string> = {}) {
  const s = loadSettings({ BOT: undefined as any, BOT_MODE: "paper", MAX_DAILY_LOSS: "100", MAX_COST_PER_ORDER: "10", ARB_ENABLED: "false", MAKER_STRATEGIES: "crypto", MAX_ORDERS_PER_MARKET: "1", HYBRID_TAKE: "false", ...vars });
  const store = new Store(memorySql());
  const client = new FakeClient();
  const clock = { now: NOW };
  const engine = new Engine(s, client as any, new FakeFeed() as any, store, () => clock.now);
  const again = async (dt = 0) => {
    clock.now += dt;
    engine.series.forEach((st) => (st.nextCheck = 0));
    await engine.tick();
  };
  return { engine, store, client, clock, again };
}
const BTC = "KXBTCD-26OCT0911-T80000";

test("maker: rests a bid 1¢ above the best bid instead of taking the ask, and reserves its cost", async () => {
  const { engine, store } = makerSetup();
  await engine.tick();
  assert.equal(store.openTrades().length, 0, "nothing bought at the ask");
  const [o] = store.restingOrders("paper");
  assert.equal(o.ticker, BTC);
  assert.equal(o.side, "yes");
  assert.equal(o.price, 0.54); // bid 53¢, ask 55¢
  assert.ok(o.expires_ts <= NOW + 120);
  assert.ok(Math.abs(store.openRisk("paper") - o.count * 0.54) < 1e-9, "unfilled order counts against limits");
  assert.equal(store.marketExposure(BTC, "paper").orders, 1);
});

test("maker (paper): fills only when the market trades down to our price, at our price and the maker fee", async () => {
  const { store, client, again } = makerSetup();
  await again();
  const [o] = store.restingOrders("paper");
  await again(5);
  assert.equal(store.openTrades().length, 0, "ask still above our bid: no fill");
  client.all[0].yes_ask_dollars = "0.5400";
  await again(5);
  const [t] = store.openTrades();
  assert.equal(t.price, 0.54);
  assert.equal(t.contracts, o.count);
  assert.ok(t.fee < 0.07 * o.count * 0.54 * 0.46, "maker fee, well under the taker fee");
  assert.equal(store.restingOrders().length, 0);
  assert.equal(store.marketExposure(BTC, "paper").orders, 1, "the order and its fill count once");
});

test("maker: an unfilled bid is cancelled after its time and frees the limits", async () => {
  const { store, again } = makerSetup();
  await again();
  assert.equal(store.restingOrders().length, 1);
  await again(121);
  // the old one expired; the bot may have posted a fresh one, but never two at once
  assert.ok(store.restingOrders().length <= 1);
  assert.equal(store.openTrades().length, 0);
  const all = (store as any).rows("SELECT status FROM orders");
  assert.equal(all[0].status, "canceled");
});

test("maker: crypto pulls a resting bid as soon as the edge at its price is gone", async () => {
  const { engine, store, again } = makerSetup();
  await again();
  assert.equal(store.restingOrders().length, 1);
  (engine.feed as any).spot = async () => 79900; // BTC drops below the strike
  await again(10);
  assert.equal(store.restingOrders().length, 0);
  assert.equal(store.openTrades().length, 0);
});

test("maker: never rests a bid into the market's last minutes", async () => {
  const { store, client, again } = makerSetup();
  client.all[0].close_time = iso(NOW + 65); // 1 min left is the floor
  await again();
  assert.equal(store.restingOrders().length, 0);
});

function liveMaker(vars: Record<string, string> = {}) {
  const env = makerSetup({ BOT_MODE: "paper", ...vars });
  const { client, store } = env;
  const calls: string[] = [];
  const book: Record<string, any> = {};
  (client as any).getBalance = async () => 500;
  (client as any).createMakerOrder = async (ticker: string, side: string, count: number, price: number, exp: number) => {
    calls.push(`post ${ticker} ${side} ${count} @${price} exp ${exp}`);
    book.o1 = { order_id: "o1", status: "resting", fill_count: 0, maker_fees_dollars: "0.0000" };
    return { ...book.o1 };
  };
  (client as any).getOrder = async (id: string) => {
    calls.push(`get ${id}`);
    return { ...book[id] };
  };
  (client as any).cancelOrder = async (id: string) => {
    calls.push(`cancel ${id}`);
    book[id] = { ...book[id], status: "canceled" };
    return { ...book[id] };
  };
  (client as any).createOrder = async () => {
    throw new Error("maker strategies must never take the ask");
  };
  store.set("strategy_modes", JSON.stringify({ crypto: "live" }));
  return { ...env, calls, book };
}

test("maker (live): books partial fills Kalshi reports, then cancels the rest on expiry", async () => {
  const { store, again, calls, book } = liveMaker();
  await again();
  assert.match(calls[0], /^post KXBTCD-26OCT0911-T80000 yes \d+ @0\.54 exp \d+/);
  const count = store.restingOrders("live")[0].count;
  assert.ok(count >= 2);
  book.o1 = { ...book.o1, fill_count: 1, maker_fees_dollars: "0.0100" };
  await again(5);
  let trades = store.openTrades().filter((t) => t.mode === "live");
  assert.equal(trades.length, 1);
  assert.equal(trades[0].contracts, 1);
  assert.equal(trades[0].fee, 0.01);
  assert.ok(Math.abs(store.openRisk("live") - (trades[0].cost + (count - 1) * 0.54)) < 1e-9);
  await again(120);
  assert.ok(calls.includes("cancel o1"));
  assert.equal((store as any).rows("SELECT status FROM orders WHERE order_id = 'o1'")[0].status, "canceled");
  trades = store.openTrades().filter((t) => t.mode === "live");
  assert.equal(trades.length, 1, "only the filled contract is held");
  assert.ok(Math.abs(store.openRisk("live") - trades[0].cost) < 1e-9, "the cancelled remainder no longer reserves limits");
});

test("maker (live): kill switch cancels resting orders", async () => {
  const { store, again, calls } = liveMaker();
  await again();
  assert.equal(store.restingOrders("live").length, 1);
  store.set("kill_switch", "on");
  await again(1);
  assert.ok(calls.includes("cancel o1"));
  assert.equal(store.restingOrders().length, 0);
});

test("maker (live): an order Kalshi already removed stops reserving limits, and the market can be bid again", async () => {
  const { store, again, book, calls } = liveMaker();
  await again();
  book.o1 = { ...book.o1, status: "canceled" }; // expired on Kalshi's side
  await again(5);
  assert.equal((store as any).rows("SELECT status FROM orders WHERE id = 1")[0].status, "canceled");
  assert.ok(store.restingOrders().length <= 1);
  assert.equal(calls.filter((c) => c.startsWith("post")).length, 2, "re-posted after the unfilled order went away");
});

test("maker (live): when Kalshi says an order is gone, its fills record decides what was bought", async () => {
  const { store, again, calls, client } = liveMaker();
  await again();
  (client as any).getOrder = async (id: string) => {
    calls.push(`get ${id}`);
    throw new KalshiError(404, '{"error":{"code":"not_found"}}');
  };
  (client as any).getOrderFills = async (id: string) => {
    calls.push(`fills ${id}`);
    return { filled: 2, fees: 0.02 };
  };
  await again(5);
  assert.ok(calls.includes("fills o1"));
  const trades = store.openTrades().filter((t) => t.mode === "live");
  assert.equal(trades.length, 1, "the filled contracts are tracked, not lost");
  assert.equal(trades[0].contracts, 2);
  assert.equal(trades[0].fee, 0.02);
  assert.equal(store.restingOrders("live").length, 0);
});

test("maker (live): a cancel that can't reach the order still books fills once Kalshi's expiry passes", async () => {
  const { store, again, calls, client } = liveMaker();
  await again();
  (client as any).cancelOrder = async (id: string) => {
    calls.push(`cancel ${id}`);
    throw new KalshiError(404, '{"error":{"code":"not_found"}}');
  };
  (client as any).getOrder = async (id: string) => {
    calls.push(`get ${id}`);
    throw new Error("network");
  };
  (client as any).getOrderFills = async () => ({ filled: 1, fees: 0.01 });
  await again(130);
  assert.ok(calls.includes("cancel o1"));
  assert.equal(store.openTrades().filter((t) => t.mode === "live").length, 1);
  assert.equal(store.restingOrders("live").length, 0);
});

test("maker: an expired, unfilled bid doesn't use up the market's one order", async () => {
  const { store, again } = makerSetup();
  await again();
  await again(121); // first bid expires unfilled
  await again(5);
  const rows = (store as any).rows("SELECT status FROM orders ORDER BY id");
  assert.equal(rows[0].status, "canceled");
  assert.ok(rows.some((r: any) => r.status === "resting"), "a fresh bid was posted");
  assert.equal(store.marketExposure(BTC, "paper").orders, 1);
});

test("maker: a filled bid still uses up the market's one order", async () => {
  const { store, client, again } = makerSetup();
  await again();
  client.all[0].yes_ask_dollars = "0.5400";
  await again(5);
  assert.equal(store.openTrades().length, 1);
  client.all[0].yes_ask_dollars = "0.5500";
  await again(200);
  assert.equal(store.restingOrders().length, 0, "no second order on the same market");
});

test("crypto skips markets with an empty or one-sided book", async () => {
  const { store, client, again, engine } = makerSetup();
  // like the XRP buckets: no YES bids, one contract offered at 79¢
  client.all[0].yes_bid_dollars = "0.0000";
  client.all[0].yes_ask_dollars = "0.7900";
  await again();
  assert.equal(store.restingOrders().length + store.openTrades().length, 0);
  // and a very wide spread is skipped too
  client.all[0].yes_bid_dollars = "0.3000";
  client.all[0].yes_ask_dollars = "0.5500";
  await again(5);
  assert.equal(store.restingOrders().length + store.openTrades().length, 0);
  assert.ok(engine.s.cryptoMaxSpread === 0.1);
});

test("maker: limits hold over many ticks with fills", async () => {
  const { store, client, again } = makerSetup({ MAKER_STRATEGIES: "crypto,ai,sports" });
  for (let i = 0; i < 20; i++) {
    client.all[0].yes_ask_dollars = "0.5500"; // bot rests a bid at 54¢
    await again(5);
    client.all[0].yes_ask_dollars = "0.5400"; // ...and the market trades down to it
    await again(5);
  }
  assert.ok(store.openTrades().some((t) => t.strategy === "crypto"), "bids did fill");
  for (const t of new Set(store.openTrades().map((t) => t.ticker))) {
    const ex = store.marketExposure(t, "paper");
    assert.ok(ex.orders <= 1 && ex.cost <= 10 + 1e-9, `${t}: ${JSON.stringify(ex)}`);
  }
  assert.ok(store.openRisk("paper") <= 50 + 1e-9);
});

// ------------------------------------------------------------ paper vs live limits
test("paper and live each use their own spending limits", async () => {
  const { engine, store, client } = setup();
  (client as any).createOrder = async (_t: string, _s: string, count: number) => ({ order_id: `o${Math.random()}`, fill_count: count, taker_fees_dollars: "0.01" });
  (client as any).getBalance = async () => 500;
  store.set("strategy_modes", JSON.stringify({ crypto: "live" })); // crypto live, arbitrage paper
  store.set("limits_live", JSON.stringify({ maxCostPerOrder: 1 }));
  store.set("limits_paper", JSON.stringify({ maxCostPerOrder: 8, bogus: 9 }));
  await engine.tick();
  assert.equal(engine.limitsFor("live").maxCostPerOrder, 1);
  assert.equal(engine.limitsFor("paper").maxCostPerOrder, 8);
  assert.equal(engine.limitsFor("paper").maxOpenRisk, 50, "unset fields fall back to the shared value");
  const trades = store.openTrades();
  const live = trades.filter((t) => t.mode === "live");
  const paper = trades.filter((t) => t.mode === "paper");
  assert.ok(live.length && live.every((t) => t.cost <= 1 + 1e-9), "live capped at $1");
  assert.ok(paper.length && paper.every((t) => t.cost <= 8 + 1e-9), "paper capped at $8");
  assert.ok(paper.some((t) => t.cost > 1), "paper not held to the live cap");
});

test("each mode sizes bets from its own bankroll", async () => {
  const { engine, store, client } = setup();
  (client as any).getBalance = async () => 1000;
  store.set("limits_live", JSON.stringify({ bankroll: 40 }));
  store.set("limits_paper", JSON.stringify({ bankroll: 250 }));
  engine.applyOverrides();
  assert.equal(await engine.bankroll("live"), 40, "live never sizes off more than its bankroll");
  assert.equal(await engine.bankroll("paper"), 250);
});

test("old single set of limits still applies to both modes until a mode gets its own", async () => {
  const { engine, store } = setup();
  store.set("limits", JSON.stringify({ maxCostPerOrder: 2 }));
  engine.applyOverrides();
  assert.equal(engine.limitsFor("paper").maxCostPerOrder, 2);
  assert.equal(engine.limitsFor("live").maxCostPerOrder, 2);
  store.set("limits_live", JSON.stringify({ maxCostPerOrder: 4 }));
  engine.applyOverrides();
  assert.equal(engine.limitsFor("live").maxCostPerOrder, 4);
  assert.equal(engine.limitsFor("paper").maxCostPerOrder, 2);
});

test("dashboard shows separate live and paper limit forms", () => {
  const row = (key: string, value: number) => ({ key, label: key, help: "", value, dflt: value });
  const html = renderDashboard(
    {
      mode: "paper", problem: null, status: "ok", lastError: null, alive: true, killSwitch: false, horizon: "day",
      horizons: [{ key: "day", label: "Within a day" }] as any,
      limits: [row("aiDailyBudget", 2)],
      limitsByMode: { live: [row("maxCostPerOrder", 1)], paper: [row("maxCostPerOrder", 5)] },
      summary: { trades: 0, settled: 0, wins: 0, pnl: 0, fees: 0, openCost: 0 }, today: 0,
      byStrategy: [], trades: [], decisions: [], timezone: "America/New_York", diag: {},
    } as any,
    { authed: true, passwordSet: true },
  );
  assert.ok(html.includes('name="set" value="live"') && html.includes('name="set" value="paper"'));
  assert.ok(html.includes("Save live limits") && html.includes("Save paper limits"));
  assert.ok(html.includes("Live (real money)") && html.includes("Paper (practice)"));
});

test("dashboard doesn't force-reload over unsaved form edits", () => {
  const html = renderDashboard(
    {
      mode: "paper", problem: null, status: "ok", lastError: null, alive: true, killSwitch: false, horizon: "day",
      horizons: [{ key: "day", label: "Within a day" }] as any, limits: [],
      summary: { trades: 0, settled: 0, wins: 0, pnl: 0, fees: 0, openCost: 0 }, today: 0,
      byStrategy: [], trades: [], decisions: [], timezone: "America/New_York", diag: {},
    } as any,
    { authed: true, passwordSet: true },
  );
  // the only hard refresh is the no-JavaScript fallback
  assert.ok(html.includes('<noscript><meta http-equiv="refresh" content="20"></noscript>'));
  assert.equal(html.split('http-equiv="refresh"').length, 2);
  assert.ok(html.includes("editing()") && html.includes("location.reload()"));
});

// ------------------------------------------------------------ timeouts on live orders
function timeoutError(): Error {
  // Like the Workers runtime's AbortSignal.timeout() error: its message can't be changed.
  const e = new Error("The operation was aborted due to timeout");
  Object.defineProperty(e, "message", { value: e.message, writable: false });
  e.name = "TimeoutError";
  return e;
}

test("live taker order that times out but was placed on Kalshi is still recorded", async () => {
  const { engine, store, client } = setup({ ARB_ENABLED: "false" });
  (client as any).getBalance = async () => 500;
  const sent: string[] = [];
  (client as any).createOrder = async (_t: string, _s: string, count: number, _p: number, id: string) => {
    sent.push(id);
    throw timeoutError();
  };
  (client as any).findOrderByClientId = async (_t: string, id: string) =>
    id === sent[0] ? { order_id: "late1", client_order_id: id, fill_count: 3, taker_fees_dollars: "0.05" } : null;
  store.set("strategy_modes", JSON.stringify({ crypto: "live" }));
  await engine.tick();
  const live = store.openTrades().filter((t) => t.mode === "live");
  assert.equal(live.length, 1, "the position Kalshi opened is tracked");
  assert.equal(live[0].contracts, 3);
  assert.equal(live[0].order_id, "late1");
  assert.match(engine.lastError ?? "", /timed out.*tracked/);
});

test("live maker order that times out but was placed is tracked as resting", async () => {
  const { engine, store, client, again } = liveMaker();
  let id = "";
  (client as any).createMakerOrder = async (_t: string, _s: string, _c: number, _p: number, _x: number, cid: string) => {
    id = cid;
    throw timeoutError();
  };
  (client as any).findOrderByClientId = async (_t: string, cid: string) => (cid === id ? { order_id: "o1", status: "resting", fill_count: 0 } : null);
  await again();
  assert.equal(store.restingOrders("live").length, 1);
  assert.equal(store.restingOrders("live")[0].order_id, "o1");
  assert.ok(store.openRisk("live") > 0, "its cost counts against live limits");
  void engine;
});

test("live order with no reply and nothing on Kalshi is treated as not placed", async () => {
  const { engine, store, client } = setup({ ARB_ENABLED: "false" });
  (client as any).getBalance = async () => 500;
  (client as any).createOrder = async () => {
    throw timeoutError();
  };
  (client as any).findOrderByClientId = async () => null;
  store.set("strategy_modes", JSON.stringify({ crypto: "live" }));
  await engine.tick();
  assert.equal(store.openTrades().filter((t) => t.mode === "live").length, 0);
  assert.match(engine.lastError ?? "", /never placed/);
});

test("a timeout with a read-only message is reported, not turned into a crash about 'message'", async () => {
  const { engine, client } = setup();
  client.getMarketsPage = async () => {
    throw timeoutError();
  };
  await assert.rejects(engine.tick(), (e: Error) => /while scanning markets: The operation was aborted due to timeout/.test(e.message) && !/read only/.test(e.message));
});

test("a skipped bet says exactly why: which limit, or what Kalshi said", async () => {
  // limit: live max-per-trade below the price of one contract
  const a = liveMaker();
  a.store.set("limits_live", JSON.stringify({ maxCostPerOrder: 0.3 }));
  await a.again();
  const why = a.store.recentDecisions(5).map((d: any) => d.reason).join(" | ");
  assert.match(why, /not posted: blocked by max per trade \(\$0\.30 left, 1 contract costs \$0\.54\)/);

  // Kalshi rejects the order
  const b = liveMaker();
  (b.client as any).createMakerOrder = async () => {
    throw new KalshiError(400, '{"error":{"code":"post_only_cross"}}');
  };
  await b.again();
  const why2 = b.store.recentDecisions(5).map((d: any) => d.reason).join(" | ");
  assert.match(why2, /not posted: Order on .* rejected: .*post_only_cross/);
});

test("live bets fit the cash Kalshi has available, and skip with a clear reason when even 1 contract doesn't", async () => {
  const a = liveMaker();
  (a.client as any).getBalance = async () => 0.3;
  await a.again();
  assert.equal(a.calls.filter((c) => c.startsWith("post")).length, 0, "nothing sent that Kalshi would reject");
  assert.match(a.store.recentDecisions(5).map((d: any) => d.reason).join(" | "), /not posted: not enough cash in Kalshi \(\$0\.30 available/);

  const b = liveMaker();
  (b.client as any).getBalance = async () => 1.2;
  await b.again();
  const post = b.calls.find((c) => c.startsWith("post"))!;
  const n = Number(post.split(" ")[3]);
  assert.ok(n >= 1 && n * 0.54 <= 1.2, `order fits $1.20 of cash: ${post}`);

  // cash shrinks an order the limits would otherwise allow
  const c = liveMaker();
  let reads = 0;
  (c.client as any).getBalance = async () => (++reads <= 1 ? 1.2 : 500); // tight cash, but bankroll sizing sees plenty
  (c.engine as any).bankroll = async () => 500;
  await c.again();
  const post2 = c.calls.find((x) => x.startsWith("post"));
  if (post2) assert.ok(Number(post2.split(" ")[3]) * 0.54 <= 1.2 + 1e-9, post2);
});

test("dashboard shows Kalshi cash while something is live", async () => {
  const a = liveMaker();
  (a.client as any).getBalance = async () => 59.73;
  await a.again();
  assert.equal(a.engine.kalshiCash?.value, 59.73);
  const row = (key: string, value: number) => ({ key, label: key, help: "", value, dflt: value });
  const html = renderDashboard(
    {
      mode: "live", problem: null, status: "ok", lastError: null, alive: true, killSwitch: false, horizon: "day",
      horizons: [{ key: "day", label: "Within a day" }] as any, limits: [row("aiDailyBudget", 2)],
      kalshiCash: { value: 59.73, at: NOW, error: null },
      summary: { trades: 0, settled: 0, wins: 0, pnl: 0, fees: 0, openCost: 0 }, today: 0,
      byStrategy: [], trades: [], decisions: [], timezone: "America/New_York", diag: {},
    } as any,
    { authed: true, passwordSet: true },
  );
  assert.ok(html.includes("Kalshi cash available to the bot: <b>$59.73</b>"));
});

test("live bets only count the cash on their market's exchange shard", async () => {
  // $59.10 in total, but only $0.30 on shard #1 where this market trades
  const a = liveMaker();
  (a.client as any).getBalanceDetail = async () => ({ total: 59.1, byIndex: { 0: 58.8, 1: 0.3 } });
  a.client.all[0].exchange_index = 1;
  await a.again();
  assert.equal(a.calls.filter((c) => c.startsWith("post")).length, 0);
  assert.match(
    a.store.recentDecisions(5).map((d: any) => d.reason).join(" | "),
    /not enough cash in Kalshi on this market's exchange shard #1 \(\$0\.30 available/,
  );
  assert.deepEqual(a.engine.kalshiCash?.byIndex, { 0: 58.8, 1: 0.3 });

  // same money, but the market is on the shard that holds it: the bet goes through
  const b = liveMaker();
  (b.client as any).getBalanceDetail = async () => ({ total: 59.1, byIndex: { 0: 58.8, 1: 0.3 } });
  b.client.all[0].exchange_index = 0;
  await b.again();
  assert.equal(b.calls.filter((c) => c.startsWith("post")).length, 1);
});

test("live: an empty market shard is topped up to the live bankroll, once, then the bet goes through", async () => {
  const a = liveMaker();
  a.store.set("limits_live", JSON.stringify({ bankroll: 50 }));
  let bal = { total: 59.1, byIndex: { 0: 59.1, 2: 0 } as Record<number, number> };
  const moves: string[] = [];
  (a.client as any).getBalanceDetail = async () => bal;
  (a.client as any).transferBetweenShards = async (from: number, to: number, dollars: number) => {
    moves.push(`${from}->${to} $${dollars.toFixed(2)}`);
    return "t1";
  };
  a.client.all[0].exchange_index = 2;
  await a.again();
  assert.deepEqual(moves, ["0->2 $50.00"], "moved exactly up to the live bankroll");
  assert.equal(a.calls.filter((c) => c.startsWith("post")).length, 0, "no bet until the money lands");
  assert.match(a.store.recentDecisions(10).map((d: any) => d.reason).join(" | "), /moved \$50\.00 from Kalshi shard #0 to #2/);
  assert.ok(a.engine.lastShardMove?.ok);

  await a.again(5); // still not landed: no second transfer within a minute
  assert.equal(moves.length, 1);

  bal = { total: 59.1, byIndex: { 0: 9.1, 2: 50 } }; // transfer landed
  await a.again(5);
  assert.equal(a.calls.filter((c) => c.startsWith("post")).length, 1, "bet placed once the shard has cash");
  assert.equal(moves.length, 1);
});

test("live: no transfer when the other shards can't cover even one contract", async () => {
  const a = liveMaker();
  (a.client as any).getBalanceDetail = async () => ({ total: 0.1, byIndex: { 0: 0.1, 2: 0 } });
  let moved = false;
  (a.client as any).transferBetweenShards = async () => ((moved = true), "t");
  a.client.all[0].exchange_index = 2;
  await a.again();
  assert.equal(moved, false);
  assert.match(a.engine.lastShardMove?.text ?? "", /Couldn't fund shard #2/);
});

test("live: auto-funding can be switched off", async () => {
  const a = liveMaker({ AUTO_FUND_SHARDS: "false" });
  (a.client as any).getBalanceDetail = async () => ({ total: 59.1, byIndex: { 0: 59.1, 2: 0 } });
  let moved = false;
  (a.client as any).transferBetweenShards = async () => ((moved = true), "t");
  a.client.all[0].exchange_index = 2;
  await a.again();
  assert.equal(moved, false);
});

test("transfer request uses centicents and the right shards", async () => {
  const { KalshiClient } = await import("../src/kalshi.ts");
  let sent: any = null;
  const c = new KalshiClient("https://x.test/trade-api/v2", "", null, (async (_u: string, init: any) => {
    sent = JSON.parse(init.body);
    return new Response(JSON.stringify({ transfer_id: "abc" }), { status: 200 });
  }) as any);
  assert.equal(await c.transferBetweenShards(0, 2, 50), "abc");
  assert.equal(sent.amount, 500000);
  assert.equal(sent.source_exchange_shard, 0);
  assert.equal(sent.destination_exchange_shard, 2);
  assert.equal(sent.source, "event_contract");
  assert.equal(sent.destination, "event_contract");
});

test("dashboard Move cash: moves what you ask, only if the source shard has it", async () => {
  const a = liveMaker();
  (a.client as any).getBalanceDetail = async () => ({ total: 59.1, byIndex: { 0: 57.64, 1: 0, 2: 1.44, 3: 0.02 } });
  const moves: string[] = [];
  (a.client as any).transferBetweenShards = async (f: number, t: number, d: number) => (moves.push(`${f}->${t} $${d.toFixed(2)}`), "t");
  const ok = await a.engine.moveCash(0, 2, 40);
  assert.ok(ok.ok, ok.message);
  assert.deepEqual(moves, ["0->2 $40.00"]);
  assert.match(a.store.recentDecisions(3).map((d: any) => d.reason).join(" | "), /moved \$40\.00 from Kalshi shard #0 to #2 \(from the dashboard\)/);

  const tooMuch = await a.engine.moveCash(2, 0, 5);
  assert.equal(tooMuch.ok, false);
  assert.match(tooMuch.message, /only has \$1\.44/);
  assert.equal((await a.engine.moveCash(2, 2, 1)).ok, false);
  assert.equal(moves.length, 1, "nothing else moved");
});

test("shard balances are read in the right unit (Kalshi sends dollars where cents were expected)", async () => {
  const { parseBreakdown } = await import("../src/kalshi.ts");
  // what the real account returned: total $59.10, shards in dollars
  assert.deepEqual(parseBreakdown([{ exchange_index: 0, balance: 57.64 }, { exchange_index: 1, balance: 0 }, { exchange_index: 2, balance: 1.44 }, { exchange_index: 3, balance: 0.02 }], 59.1), { 0: 57.64, 1: 0, 2: 1.44, 3: 0.02 });
  // the same in cents, as the docs describe
  assert.deepEqual(parseBreakdown([{ exchange_index: 0, balance: 5764 }, { exchange_index: 2, balance: 144 }, { exchange_index: 3, balance: 2 }], 59.1), { 0: 57.64, 2: 1.44, 3: 0.02 });
  // explicit dollar strings, and index 0 left out (zero values omitted)
  assert.deepEqual(parseBreakdown([{ balance_dollars: "57.6400" }, { exchange_index: 2, balance_dollars: "1.4400" }], 59.08), { 0: 57.64, 2: 1.44 });
  // a dollars field that is itself 100x too small (what the live account showed)
  assert.deepEqual(parseBreakdown([{ exchange_index: 0, balance_dollars: "0.5707" }, { exchange_index: 2, balance_dollars: "0.0201" }, { exchange_index: 3, balance_dollars: "0.0002" }], 59.1), { 0: 57.07, 2: 2.01, 3: 0.02 });
  assert.equal(parseBreakdown([], 1), null);
});

test("a crypto series with a resting bid is re-checked every round, so a stale bid is pulled fast", async () => {
  const { engine, store, again } = makerSetup();
  await again();
  assert.equal(store.restingOrders().length, 1);
  // don't force a re-check: the series isn't due for a while on its own
  engine.series.forEach((st) => (st.nextCheck = NOW + 3600));
  (engine.feed as any).spot = async () => 79900; // edge gone
  (engine as any).clock = () => NOW + 10;
  await engine.tick();
  assert.equal(store.restingOrders().length, 0, "pulled on the very next round");
});

test("every cancelled bid is logged with its reason", async () => {
  const a = makerSetup();
  await a.again();
  await a.again(121); // expires unfilled
  assert.match(a.store.recentDecisions(10).map((d: any) => d.reason).join(" | "), /cancelled bid for \d+ YES @ \$0\.54: not filled after 2 min/);

  const b = makerSetup();
  await b.again();
  (b.engine.feed as any).spot = async () => 79900;
  await b.again(10);
  assert.match(b.store.recentDecisions(10).map((d: any) => d.reason).join(" | "), /cancelled bid for \d+ YES @ \$0\.54: edge at this price is now -/);
});

test("maker bids: the bot cancels before Kalshi's own expiry, which stays as a backstop", async () => {
  const a = liveMaker();
  await a.again();
  const post = a.calls.find((c) => c.startsWith("post"))!;
  const kalshiExp = Number(post.split("exp ")[1]);
  const botExp = a.store.restingOrders("live")[0].expires_ts;
  assert.ok(kalshiExp > botExp, `Kalshi expiry ${kalshiExp} after the bot's ${botExp}`);
  assert.ok(kalshiExp - botExp <= 30);
});

// ------------------------------------------------------------ chasing
test("chase: when the price moves up a little, the bid follows it", async () => {
  const { store, client, again } = makerSetup();
  await again();
  assert.equal(store.restingOrders()[0].price, 0.54); // bid 53, ask 55
  client.all[0].yes_bid_dollars = "0.5500"; // someone outbids us
  client.all[0].yes_ask_dollars = "0.5700";
  await again(10);
  const [o] = store.restingOrders();
  assert.equal(o.price, 0.56, "re-posted 1¢ above the new best bid");
  assert.match(store.recentDecisions(10).map((d: any) => d.reason).join(" | "), /price moved; re-posting at \$0\.56 \(chasing up to \$0\.57\)/);
});

test("chase: never more than MAKER_MAX_CHASE above the first price", async () => {
  const { store, client, again } = makerSetup();
  await again();
  client.all[0].yes_bid_dollars = "0.6000"; // jumped 7¢
  client.all[0].yes_ask_dollars = "0.6200";
  await again(10);
  const [o] = store.restingOrders();
  assert.equal(o.price, 0.54, "stays put: 61¢ would be past the 57¢ cap");
});

test("chase: won't follow into a price where the edge is gone", async () => {
  const { engine, store, client, again } = makerSetup({ MAKER_MAX_CHASE: "0.10" });
  await again();
  (engine.feed as any).spot = async () => 80110; // still worth it at 54¢, not at 56¢
  client.all[0].yes_bid_dollars = "0.5500";
  client.all[0].yes_ask_dollars = "0.5700";
  await again(10);
  const prices = store.restingOrders().map((o) => o.price);
  assert.deepEqual(prices, [0.54], "keeps the 54¢ bid, doesn't chase to 56¢");
});

test("chase: off when MAKER_MAX_CHASE is 0", async () => {
  const { store, client, again } = makerSetup({ MAKER_MAX_CHASE: "0" });
  await again();
  client.all[0].yes_bid_dollars = "0.5500";
  client.all[0].yes_ask_dollars = "0.5700";
  await again(10);
  assert.equal(store.restingOrders()[0].price, 0.54);
});

// ------------------------------------------------------------ exits
test("exit: sells a position when the model turns against it, books P&L, logs it", async () => {
  const { engine, store, client, again } = setup({ ARB_ENABLED: "false" });
  await again0(engine);
  const [t] = store.openTrades();
  assert.equal(t.side, "yes");
  // BTC collapses below the strike; someone still bids 50¢ for YES
  (engine.feed as any).spot = async () => 79500;
  client.all[0].yes_bid_dollars = "0.5000";
  client.all[0].yes_ask_dollars = "0.5200";
  (engine as any).clock = () => NOW + 60;
  engine.series.forEach((st) => (st.nextCheck = 0));
  await engine.tick();
  assert.equal(store.openTrades().filter((x) => x.ticker === t.ticker).length, 0, "position closed");
  const sold = (store as any).rows("SELECT * FROM trades WHERE result = 'sold'");
  assert.equal(sold.length, 1);
  const fee = Math.ceil(0.07 * t.contracts * 0.5 * 0.5 * 100 - 1e-9) / 100;
  assert.ok(Math.abs(sold[0].pnl - (t.contracts * 0.5 - fee - t.cost)) < 0.011, `pnl ${sold[0].pnl}`);
  assert.match(store.recentDecisions(10).map((d: any) => d.reason).join(" | "), /sold \d+ YES @ \$0\.50 to exit \(paper\): model now gives it \d+%/);
  // sold bets don't count in the model check
  assert.equal(store.modelCheck("paper").settled, 0);
});

test("exit: holds when the bid isn't clearly better than holding", async () => {
  const { engine, store } = setup({ ARB_ENABLED: "false" });
  await again0(engine);
  (engine as any).clock = () => NOW + 60;
  engine.series.forEach((st) => (st.nextCheck = 0));
  await engine.tick(); // model still likes YES at these prices
  assert.equal((store as any).rows("SELECT * FROM trades WHERE result = 'sold'").length, 0);
  assert.equal(store.openTrades().length, 1);
});

test("exit: waits EXIT_MIN_HOLD_SECONDS after buying", async () => {
  const { engine, store, client } = setup({ ARB_ENABLED: "false", EXIT_MIN_HOLD_SECONDS: "120" });
  await again0(engine);
  (engine.feed as any).spot = async () => 79500;
  client.all[0].yes_bid_dollars = "0.5000";
  (engine as any).clock = () => NOW + 60;
  engine.series.forEach((st) => (st.nextCheck = 0));
  await engine.tick();
  assert.equal(store.openTrades().length, 1, "too soon to sell");
});

test("exit: live sells are reduce-only and only book what filled", async () => {
  const { engine, store, client } = setup({ ARB_ENABLED: "false" });
  (client as any).getBalance = async () => 500;
  (client as any).createOrder = async (_t: string, _s: string, count: number) => ({ order_id: "b1", fill_count_fp: String(count), taker_fees_dollars: "0.05" });
  const sells: any[] = [];
  (client as any).sellOrder = async (ticker: string, side: string, count: number, price: number) => {
    sells.push({ ticker, side, count, price });
    return { order_id: "s1", fill_count_fp: "1", taker_fees_dollars: "0.02", status: "executed" };
  };
  store.set("strategy_modes", JSON.stringify({ crypto: "live" }));
  await again0(engine);
  const before = store.openTrades().find((t) => t.mode === "live")!;
  (engine.feed as any).spot = async () => 79500;
  client.all[0].yes_bid_dollars = "0.5000";
  client.all[0].yes_ask_dollars = "0.5200";
  (engine as any).clock = () => NOW + 60;
  engine.series.forEach((st) => (st.nextCheck = 0));
  await engine.tick();
  assert.deepEqual(sells, [{ ticker: before.ticker, side: "yes", count: before.contracts, price: 0.5 }]);
  const still = store.openTrades().filter((t) => t.mode === "live").reduce((n, t) => n + t.contracts, 0);
  assert.equal(still, before.contracts - 1, "only the 1 contract that sold is closed");
});

test("sell order goes to V2 as a reduce-only IOC on the right side of the book", async () => {
  const { KalshiClient } = await import("../src/kalshi.ts");
  const bodies: any[] = [];
  const c = new KalshiClient("https://x.test/trade-api/v2", "", null, (async (_u: string, init: any) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ order_id: "s", fill_count: "2.00", remaining_count: "0.00" }), { status: 201 });
  }) as any);
  await c.sellOrder("T", "yes", 2, 0.5);
  await c.sellOrder("T", "no", 3, 0.3);
  assert.deepEqual([bodies[0].side, bodies[0].price, bodies[0].reduce_only, bodies[0].time_in_force], ["ask", "0.5000", true, "immediate_or_cancel"]);
  assert.deepEqual([bodies[1].side, bodies[1].price, bodies[1].count], ["bid", "0.7000", "3.00"]);
});

async function again0(engine: any) {
  await engine.tick();
}

// ------------------------------------------------------------ learning data
test("learning: every priced crypto market is snapshotted (throttled) and labelled when it settles", async () => {
  const { engine, store, client, again } = makerSetup({ MAKER_STRATEGIES: "none" });
  await again();
  let st = store.snapshotStats();
  assert.equal(st.total, 1, "the one priceable market");
  await again(60); // within SNAPSHOT_EVERY_SECONDS: no new row
  assert.equal(store.snapshotStats().total, 1);
  await again(300);
  assert.equal(store.snapshotStats().total, 2);
  const [row] = (store as any).rows("SELECT * FROM snapshots LIMIT 1");
  assert.equal(row.asset, "BTC");
  assert.equal(row.yes_bid, 0.53);
  assert.ok(row.model_p > 0 && row.model_p < 1);

  // market settles YES
  client.all[0].result = "yes";
  (engine as any).clock = () => NOW + 3700;
  await engine.labelSnapshots(NOW + 3700);
  st = store.snapshotStats();
  assert.equal(st.labelled, 2);
  const csv = store.snapshotsCsv();
  assert.match(csv.split("\n")[0], /^ts,ticker,series,asset,/);
  assert.equal(csv.trim().split("\n").length, 3);
  assert.match(csv, /,yes\n/);
});

test("learning: respects the daily cap and can be turned off", async () => {
  const a = makerSetup({ MAKER_STRATEGIES: "none", SNAPSHOT_DAILY_CAP: "1", SNAPSHOT_EVERY_SECONDS: "1" });
  await a.again();
  await a.again(5);
  assert.equal(a.store.snapshotStats().total, 1);
  const b = makerSetup({ MAKER_STRATEGIES: "none", SNAPSHOTS_ENABLED: "false" });
  await b.again();
  assert.equal(b.store.snapshotStats().total, 0);
});

// ------------------------------------------------------------ up to 3 bets per market
test("3 per market: adds to a position up to 3 bets, then stops", async () => {
  const { engine, store } = setup({ ARB_ENABLED: "false", MAX_ORDERS_PER_MARKET: "3", MAX_COST_PER_ORDER: "2", MAX_COST_PER_MARKET: "50", EXIT_ENABLED: "false" });
  for (let i = 0; i < 6; i++) {
    engine.series.forEach((st) => (st.nextCheck = 0));
    await engine.tick();
  }
  const btc = store.openTrades().filter((t) => t.ticker === "KXBTCD-26OCT0911-T80000");
  assert.equal(btc.length, 3, "three bets, no more");
  assert.ok(btc.every((t) => t.side === "yes"), "never the opposite side");
  assert.equal(store.marketExposure("KXBTCD-26OCT0911-T80000", "paper").orders, 3);
  assert.match(store.recentDecisions(20).map((d: any) => d.reason).join(" | "), /already bet this market \(3 per market\)/);
});

test("3 per market: the per-market dollar cap still applies", async () => {
  const { engine, store } = setup({ ARB_ENABLED: "false", MAX_ORDERS_PER_MARKET: "3", MAX_COST_PER_ORDER: "4", MAX_COST_PER_MARKET: "5", EXIT_ENABLED: "false" });
  for (let i = 0; i < 6; i++) {
    engine.series.forEach((st) => (st.nextCheck = 0));
    await engine.tick();
  }
  assert.ok(store.marketExposure("KXBTCD-26OCT0911-T80000", "paper").cost <= 5 + 1e-9);
});

test("3 per market: maker bids never stack — one resting bid at a time", async () => {
  const { store, again } = makerSetup({ MAX_ORDERS_PER_MARKET: "3" });
  await again();
  await again(10);
  await again(10);
  assert.equal(store.restingOrders().length, 1);
});

test("bids can still go up with a bit over a minute left, and are pulled at 1 minute", async () => {
  const { store, client, again } = makerSetup();
  client.all[0].close_time = iso(NOW + 150); // 2.5 min left
  await again();
  assert.equal(store.restingOrders().length, 1, "posted with 2.5 min left");
  assert.ok(store.restingOrders()[0].expires_ts <= NOW + 90, "set to come down at the 1-minute mark");
  await again(95); // 55s left
  assert.equal(store.restingOrders().length, 0);
});

// ------------------------------------------------------------ hybrid: take the ask when it's worth it
test("hybrid: a big edge is bought at the ask right away instead of resting a bid", async () => {
  const { store, again } = makerSetup({ HYBRID_TAKE: "true" });
  await again(); // model ~0.75 vs YES ask 0.55: clears 4¢ even after the taker fee
  assert.equal(store.restingOrders().length, 0, "no resting bid");
  const [t] = store.openTrades();
  assert.equal(t.side, "yes");
  assert.equal(t.price, 0.55, "paid the ask");
  assert.match(store.recentDecisions(5).map((d: any) => d.reason).join(" | "), /took the ask/);
});

test("hybrid: a small edge still rests a bid (not worth the taker fee)", async () => {
  const { engine, store, again } = makerSetup({ HYBRID_TAKE: "true" });
  (engine.feed as any).spot = async () => 80150; // blended ~0.61: ≥4¢ at the 54¢ bid, <4¢ at the 55¢ ask + fee
  await again();
  assert.equal(store.openTrades().length, 0);
  assert.equal(store.restingOrders().length, 1);
  assert.equal(store.restingOrders()[0].price, 0.54);
});

test("hybrid: a resting bid is swapped for the ask when the edge grows enough", async () => {
  const { engine, store, again } = makerSetup({ HYBRID_TAKE: "true" });
  (engine.feed as any).spot = async () => 80150;
  await again();
  assert.equal(store.restingOrders().length, 1);
  (engine.feed as any).spot = async () => 80600; // now clearly worth taking
  await again(10);
  assert.equal(store.restingOrders().length, 0, "bid pulled");
  assert.equal(store.openTrades().length, 1);
  assert.equal(store.openTrades()[0].price, 0.55);
  assert.match(store.recentDecisions(10).map((d: any) => d.reason).join(" | "), /taking the ask at \$0\.55 instead/);
});
