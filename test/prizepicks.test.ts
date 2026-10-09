import { test } from "node:test";
import assert from "node:assert/strict";
import { PicksScanner, bestSlips, breakEven, extractQuotes, fairFor, matchEvent, normName, parsePayouts, parseProjections, PP_SPORTS, type PPLine, type PicksSettings } from "../src/prizepicks.ts";

const NOW = Date.parse("2026-10-09T14:00:00Z") / 1000;
const KICK = "2026-10-10T16:00:00Z"; // Saturday noon Eastern
const CFB = PP_SPORTS.americanfootball_ncaaf.stats;

function ppJson() {
  return {
    data: [
      { id: "1", attributes: { stat_type: "Rush Yards", line_score: 69.5, odds_type: "standard", status: "pre_game", start_time: KICK, description: "AUB" }, relationships: { new_player: { data: { id: "p1" } } } },
      { id: "2", attributes: { stat_type: "Pass Yards", line_score: 240.5, odds_type: "standard", status: "pre_game", start_time: KICK, description: "AUB" }, relationships: { new_player: { data: { id: "p2" } } } },
      { id: "3", attributes: { stat_type: "Rush Yards", line_score: 40.5, odds_type: "goblin", status: "pre_game", start_time: KICK }, relationships: { new_player: { data: { id: "p1" } } } },
      { id: "4", attributes: { stat_type: "Fantasy Score", line_score: 20.5, odds_type: "standard", status: "pre_game", start_time: KICK }, relationships: { new_player: { data: { id: "p1" } } } },
      { id: "5", attributes: { stat_type: "Receiving Yards", line_score: 55.5, odds_type: "standard", status: "pre_game", start_time: KICK, description: "UGA" }, relationships: { new_player: { data: { id: "p3" } } } },
    ],
    included: [
      { type: "new_player", id: "p1", attributes: { display_name: "Nate Frazier", team_name: "Georgia" } },
      { type: "new_player", id: "p2", attributes: { display_name: "Gunner Stockton", team_name: "Georgia" } },
      { type: "new_player", id: "p3", attributes: { display_name: "Cam Coleman", team_name: "Auburn" } },
    ],
  };
}

const events = [
  { id: "e1", commence_time: KICK, home_team: "Georgia Bulldogs", away_team: "Auburn Tigers" },
  { id: "e2", commence_time: KICK, home_team: "Georgia Tech Yellow Jackets", away_team: "Duke Blue Devils" },
];

const ou = (player: string, point: number, over: number, under: number) => [
  { name: "Over", description: player, price: over, point },
  { name: "Under", description: player, price: under, point },
];
function propsJson() {
  return {
    id: "e1",
    bookmakers: [
      { key: "draftkings", markets: [{ key: "player_rush_yds", outcomes: ou("Nate Frazier", 74.5, 1.8, 2.0) }, { key: "player_pass_yds", outcomes: ou("Gunner Stockton", 240.5, 2.1, 1.75) }] },
      { key: "fanduel", markets: [{ key: "player_rush_yds", outcomes: ou("Nate Frazier", 74.5, 1.75, 2.05) }, { key: "player_pass_yds", outcomes: ou("Gunner Stockton", 240.5, 2.2, 1.7) }] },
    ],
  };
}

test("parses standard PrizePicks lines the books can price, and skips goblins and unpriced stats", () => {
  const lines = parseProjections(ppJson(), CFB);
  assert.deepEqual(lines.map((l) => [l.player, l.market, l.line]), [
    ["Nate Frazier", "player_rush_yds", 69.5],
    ["Gunner Stockton", "player_pass_yds", 240.5],
    ["Cam Coleman", "player_reception_yds", 55.5],
  ]);
});

test("matches a line to its game by kickoff and team, and refuses to guess", () => {
  const [frazier] = parseProjections(ppJson(), CFB);
  assert.equal(matchEvent(frazier, events)?.id, "e1"); // Georgia, not Georgia Tech at the same kickoff
  assert.equal(matchEvent({ ...frazier, team: "Georgia Tech" }, events)?.id, "e2");
  assert.equal(matchEvent({ ...frazier, start: "2026-10-10T20:00:00Z" }, events), null); // wrong kickoff
});

test("ambiguous team names at the same kickoff are skipped", () => {
  const l: PPLine = { id: "x", player: "A", team: "Georgia", opponent: "", stat: "Rush Yards", market: "player_rush_yds", line: 1, start: KICK };
  const evs = [
    { id: "a", commence_time: KICK, home_team: "Georgia Bulldogs", away_team: "Auburn Tigers" },
    { id: "b", commence_time: KICK, home_team: "Georgia Peaches", away_team: "Troy Trojans" },
  ];
  assert.equal(matchEvent(l, evs), null); // a true tie
  assert.equal(matchEvent({ ...l, team: "Auburn" }, evs)?.id, "a");
});

test("exact line: de-vigged median across books picks the likelier side", () => {
  const [, stockton] = parseProjections(ppJson(), CFB);
  const f = fairFor(stockton, extractQuotes(propsJson()))!;
  assert.equal(f.side, "Less");
  assert.equal(f.exact, true);
  assert.equal(f.books, 2);
  assert.ok(f.p > 0.54 && f.p < 0.57);
});

test("different book line gives a safe lower bound on the right side only", () => {
  const [frazier] = parseProjections(ppJson(), CFB);
  const q = extractQuotes(propsJson());
  const f = fairFor(frazier, q)!; // PP 69.5, books 74.5: More >= P(over 74.5)
  assert.equal(f.side, "More");
  assert.equal(f.exact, false);
  assert.equal(f.bookLine, 74.5);
  assert.ok(f.p > 0.5 && f.p < 0.55);
  // Less below the only book line has no safe bound, so a higher PP line only offers Less
  const high = fairFor({ ...frazier, line: 80.5 }, q)!;
  assert.equal(high.side, "Less");
  assert.equal(fairFor({ ...frazier, player: "Someone Else" }, q), null);
  assert.equal(fairFor(frazier, q, 3), null); // needs 3 books
});

test("names ignore case, accents and suffixes", () => {
  assert.equal(normName("Marvin Harrison Jr."), normName("marvin harrison"));
  assert.equal(normName("José  Ramírez"), "jose ramirez");
});

test("slips: one pick per game, EV from payouts, break-even per pick", () => {
  assert.ok(Math.abs(breakEven(2, 3) - 0.57735) < 1e-4);
  assert.deepEqual(parsePayouts("2:3, 3:5,bad,9:100,4:0.5"), { 2: 3, 3: 5 });
  const mk = (player: string, game: string, p: number) => ({ player, team: "", opponent: "", stat: "", line: 1, side: "More" as const, p, books: 2, exact: true, bookLine: 1, start: KICK, game, sport: "CFB" });
  const slips = bestSlips([mk("A", "g1", 0.65), mk("B", "g1", 0.64), mk("C", "g2", 0.6), mk("D", "g3", 0.55)], { 2: 3, 3: 5, 4: 10 });
  assert.equal(slips.length, 2); // only 3 games -> no 4-pick slip
  assert.deepEqual(slips[0].picks.map((p) => p.player), ["A", "C"]);
  assert.ok(Math.abs(slips[0].ev - (3 * 0.65 * 0.6 - 1)) < 1e-9);
  assert.deepEqual(slips[1].picks.map((p) => p.player), ["A", "C", "D"]);
});

function kv() {
  const m = new Map<string, string>();
  return { get: (k: string) => m.get(k) ?? null, set: (k: string, v: string) => void m.set(k, v), m };
}
const settings = (over: Partial<PicksSettings> = {}): PicksSettings => ({
  enabled: true,
  sports: ["americanfootball_ncaaf"],
  intervalMinutes: 60,
  dailyCredits: 30,
  regions: "us",
  marketsPerGame: 3,
  hoursAhead: 36,
  minBooks: 1,
  payouts: { 2: 3, 3: 5 },
  timezone: "America/New_York",
  ...over,
});

function fakeFetch(calls: string[]) {
  return async (url: string) => {
    calls.push(url);
    const json = (b: unknown, h: Record<string, string> = {}) => new Response(JSON.stringify(b), { headers: { "content-type": "application/json", ...h } });
    if (url.includes("prizepicks.com/leagues")) return json({ data: [{ id: "15", attributes: { name: "CFB" } }] });
    if (url.includes("prizepicks.com/projections")) return json(ppJson());
    if (url.endsWith("/events?apiKey=k")) return json(events);
    if (url.includes("/events/e1/odds")) return json(propsJson(), { "x-requests-last": "2", "x-requests-remaining": "480" });
    return new Response("nope", { status: 404 });
  };
}

test("scanner: prices lines, spends credits once, reuses the cache, saves a view", async () => {
  const store = kv();
  const calls: string[] = [];
  const sc = new PicksScanner(settings(), store, "k", fakeFetch(calls) as any);
  assert.equal(sc.due(NOW), true);
  const v = await sc.run(NOW);
  assert.equal(v.linesSeen, 3);
  assert.equal(v.priced, 2); // Coleman's receiving yards weren't in the book response
  assert.equal(v.picks[0].player, "Gunner Stockton");
  assert.match(v.status, /Priced 2 of 3 College football lines/);
  assert.equal(sc.creditsToday(NOW), 2);
  assert.equal(sc.oddsRemaining, 480);
  assert.ok(calls.some((u) => u.includes("league_id=15")));
  const odds = calls.find((u) => u.includes("/events/e1/odds"))!;
  assert.match(odds, /markets=player_rush_yds,player_pass_yds,player_reception_yds|markets=player_[a-z_]+,player_[a-z_]+,player_[a-z_]+/);

  assert.equal(sc.due(NOW + 60), false);
  calls.length = 0;
  await sc.run(NOW + 600); // within the interval: props come from the cache
  assert.equal(calls.filter((u) => u.includes("/odds")).length, 0);
  assert.equal(sc.creditsToday(NOW), 2);
  assert.equal(sc.view()?.priced, 2);
});

test("scanner: respects the daily credit cap and the dashboard switch", async () => {
  const store = kv();
  const calls: string[] = [];
  const sc = new PicksScanner(settings({ dailyCredits: 2 }), store, "k", fakeFetch(calls) as any);
  const v = await sc.run(NOW); // 3 markets would cost 3 > 2
  assert.equal(calls.filter((u) => u.includes("/odds")).length, 0);
  assert.match(v.status, /daily odds budget used/);
  store.set("picks_enabled", "off");
  assert.equal(sc.due(NOW + 7200), false);
});

test("scanner: a blocked PrizePicks request shows up as the status", async () => {
  const sc = new PicksScanner(settings(), kv(), "k", (async (u: string) => (u.includes("prizepicks") ? new Response("blocked", { status: 403 }) : new Response("[]"))) as any);
  const v = await sc.run(NOW);
  assert.match(v.status, /PrizePicks College football: api\.prizepicks\.com 403/);
});
