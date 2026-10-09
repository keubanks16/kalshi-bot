import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { devig, easternTickerDate, fairOdds, matchGame, teamMatches, type OddsGame } from "../src/sports.ts";
import { loadSettings } from "../src/config.ts";
import { Engine } from "../src/engine.ts";
import { Store, type Sql } from "../src/store.ts";

const NOW = Date.parse("2026-10-09T14:00:00Z") / 1000; // 10 AM Eastern
const START = "2026-10-09T23:08:00Z"; // 7:08 PM Eastern

test("de-vig turns odds into probabilities that sum to 1", () => {
  const p = devig([{ name: "A", price: 1.8 }, { name: "B", price: 2.1 }])!;
  assert.ok(Math.abs(p.A + p.B - 1) < 1e-12);
  assert.ok(p.A > 0.53 && p.A < 0.55);
});

function game(books: OddsGame["bookmakers"]): OddsGame {
  return { id: "g1", sport_key: "baseball_mlb", commence_time: START, home_team: "Atlanta Braves", away_team: "Los Angeles Dodgers", bookmakers: books };
}
const fresh = new Date(NOW * 1000 - 60_000).toISOString();
const stale = new Date(NOW * 1000 - 3 * 3600_000).toISOString();
const book = (key: string, home: number, away: number, at = fresh) => ({
  key,
  title: key,
  markets: [{ key: "h2h", last_update: at, outcomes: [{ name: "Atlanta Braves", price: home }, { name: "Los Angeles Dodgers", price: away }] }],
});

test("fair odds prefer Pinnacle, else median of books, and ignore stale ones", () => {
  const withPin = fairOdds(game([book("draftkings", 2.2, 1.7), book("pinnacle", 2.0, 1.9)]), NOW * 1000)!;
  assert.equal(withPin.source, "Pinnacle");
  assert.ok(Math.abs(withPin.probs["Atlanta Braves"] - (1 / 2.0) / (1 / 2.0 + 1 / 1.9)) < 1e-9);

  const median = fairOdds(game([book("draftkings", 2.2, 1.7), book("fanduel", 2.1, 1.75), book("pinnacle", 3, 1.4, stale)]), NOW * 1000)!;
  assert.match(median.source, /median of 2/);

  assert.equal(fairOdds(game([book("draftkings", 2.2, 1.7)]), NOW * 1000), null); // one book isn't enough
});

test("team names match Kalshi's abbreviations", () => {
  assert.ok(teamMatches("Los Angeles D", "Los Angeles Dodgers"));
  assert.ok(teamMatches("Atlanta", "Atlanta Braves"));
  assert.ok(teamMatches("New York Y", "New York Yankees"));
  assert.ok(!teamMatches("Los Angeles A", "Los Angeles Dodgers"));
});

test("games match only on the same Eastern date with both teams covered", () => {
  assert.equal(easternTickerDate(START), "26OCT09");
  const mk = (ev: string) => [
    { ticker: `${ev}-LAD`, event_ticker: ev, yes_sub_title: "Los Angeles D" },
    { ticker: `${ev}-ATL`, event_ticker: ev, yes_sub_title: "Atlanta" },
  ];
  const m = matchGame(game([]), mk("KXMLBGAME-26OCT091908LADATL"))!;
  assert.equal(m.get("KXMLBGAME-26OCT091908LADATL-LAD"), "Los Angeles Dodgers");
  assert.equal(matchGame(game([]), mk("KXMLBGAME-26OCT101908LADATL")), null); // different day
  assert.equal(matchGame(game([]), [{ ticker: "x", event_ticker: "KXMLBGAME-26OCT09X", yes_sub_title: "Atlanta" }]), null); // one team only
});

// ------------------------------------------------------------------ engine
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

function setup(kalshiAtlAsk: string, vars: Record<string, string> = {}) {
  const s = loadSettings({ BOT: undefined as any, BOT_MODE: "paper", CRYPTO_ENABLED: "false", ARB_ENABLED: "false", AI_ENABLED: "false", SPORTS_LIST: "baseball_mlb", ...vars });
  const store = new Store(memorySql());
  const ev = "KXMLBGAME-26OCT091908LADATL";
  const atlAsk = Number(kalshiAtlAsk);
  const markets = [
    { ticker: `${ev}-ATL`, event_ticker: ev, status: "active", yes_sub_title: "Atlanta", close_time: "2026-10-12T00:00:00Z", yes_bid_dollars: (atlAsk - 0.01).toFixed(2), yes_ask_dollars: atlAsk.toFixed(2), no_ask_dollars: (1 - atlAsk + 0.02).toFixed(2), yes_ask_size_fp: "500", yes_bid_size_fp: "500" },
    { ticker: `${ev}-LAD`, event_ticker: ev, status: "active", yes_sub_title: "Los Angeles D", close_time: "2026-10-12T00:00:00Z", yes_bid_dollars: (1 - atlAsk - 0.02).toFixed(2), yes_ask_dollars: (1 - atlAsk + 0.01).toFixed(2), no_ask_dollars: (atlAsk + 0.02).toFixed(2), yes_ask_size_fp: "500", yes_bid_size_fp: "500" },
  ];
  const client = {
    async getMarketsPage() {
      return { markets: [], cursor: "" };
    },
    async getMarketsByTicker() {
      return markets;
    },
    async getEventsWithMarkets(series: string) {
      return series === "KXMLBGAME" ? [{ event_ticker: ev, series_ticker: "KXMLBGAME", mutually_exclusive: true, markets }] : [];
    },
  };
  const engine = new Engine(s, client as any, {} as any, store, () => NOW);
  engine.oddsKey = "k";
  let calls = 0;
  engine.oddsFetchFn = async () => {
    calls++;
    return { games: [game([book("pinnacle", 1.8, 2.15)])], remaining: 480, cost: 2 }; // Braves ~54%
  };
  return { engine, store, calls: () => calls };
}

test("buys the team Kalshi sells below the sportsbook price", async () => {
  const { engine, store } = setup("0.45"); // Braves at 45¢ vs ~54% fair
  await engine.tick();
  const t = store.openTrades();
  assert.equal(t.length, 1);
  assert.equal(t[0].strategy, "sports");
  assert.equal(t[0].ticker, "KXMLBGAME-26OCT091908LADATL-ATL");
  assert.equal(t[0].side, "yes");
  assert.match(engine.sportsStatus, /Compared 1 upcoming game/);
  assert.equal(engine.oddsRemaining, 480);
});

test("no bet when Kalshi agrees with the books", async () => {
  const { engine, store } = setup("0.54");
  await engine.tick();
  assert.equal(store.openTrades().length, 0);
  assert.match(engine.sportsView[0].action, /no bet/);
});

test("never bets after the game starts or outside the time limit", async () => {
  const late = setup("0.45");
  late.engine.clock = () => Date.parse(START) / 1000 - 60; // 1 min before first pitch
  await late.engine.tick();
  assert.equal(late.store.openTrades().length, 0);

  const short = setup("0.45");
  short.store.set("horizon", "hour"); // game is 9 hours away
  await short.engine.tick();
  assert.equal(short.store.openTrades().length, 0);
});

test("odds credit budget is respected", async () => {
  const { engine, calls } = setup("0.45", { SPORTS_DAILY_CREDITS: "1" });
  await engine.tick();
  assert.equal(calls(), 0);
  assert.match(engine.sportsStatus, /budget used/);
});

test("dashboard switches turn strategies off", async () => {
  const { engine, store, calls } = setup("0.45");
  store.set("strategies", JSON.stringify({ sportsEnabled: false }));
  await engine.tick();
  assert.equal(calls(), 0);
  assert.equal(store.openTrades().length, 0);
  assert.equal(engine.sportsStatus, "Off.");
});
