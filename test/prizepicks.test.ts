import { test } from "node:test";
import assert from "node:assert/strict";
import { PicksScanner, bestSlips, breakEven, extractPPLines, extractQuotes, fairFor, normName, parsePayouts, type PicksSettings } from "../src/prizepicks.ts";

const NOW = Date.parse("2026-10-09T14:00:00Z") / 1000;
const KICK = "2026-10-10T16:00:00Z"; // Saturday noon Eastern

const events = [
  { id: "e1", commence_time: KICK, home_team: "Georgia Bulldogs", away_team: "Auburn Tigers" },
  { id: "far", commence_time: "2026-10-17T16:00:00Z", home_team: "A", away_team: "B" }, // too far out
];

const ou = (player: string, point: number, over: number, under: number) => [
  { name: "Over", description: player, price: over, point },
  { name: "Under", description: player, price: under, point },
];
/** One Odds API event-odds reply: two sportsbooks plus PrizePicks (us_dfs). */
function oddsJson() {
  return {
    id: "e1",
    bookmakers: [
      { key: "draftkings", markets: [{ key: "player_rush_yds", outcomes: ou("Nate Frazier", 74.5, 1.8, 2.0) }, { key: "player_pass_yds", outcomes: ou("Gunner Stockton", 240.5, 2.1, 1.75) }] },
      { key: "fanduel", markets: [{ key: "player_rush_yds", outcomes: ou("Nate Frazier", 74.5, 1.75, 2.05) }, { key: "player_pass_yds", outcomes: ou("Gunner Stockton", 240.5, 2.2, 1.7) }] },
      {
        key: "prizepicks",
        markets: [
          { key: "player_rush_yds", outcomes: ou("Nate Frazier", 69.5, 1.87, 1.87) },
          { key: "player_pass_yds", outcomes: ou("Gunner Stockton", 240.5, 1.87, 1.87) },
          { key: "player_reception_yds", outcomes: ou("Cam Coleman", 55.5, 1.87, 1.87) },
          { key: "player_rush_yds_alternate", outcomes: [{ name: "Over", description: "Nate Frazier", price: 1.87, point: 40.5 }] },
        ],
      },
      { key: "underdog", markets: [{ key: "player_rush_yds", outcomes: ou("Nate Frazier", 60.5, 1.87, 1.87) }] },
    ],
  };
}

test("reads PrizePicks' standard lines once each, skipping goblins and demons", () => {
  assert.deepEqual(extractPPLines(oddsJson()).map((l) => [l.player, l.stat, l.line]), [
    ["Nate Frazier", "Rush Yards", 69.5],
    ["Gunner Stockton", "Pass Yards", 240.5],
    ["Cam Coleman", "Receiving Yards", 55.5],
  ]);
});

test("pick'em sites never count as sportsbooks", () => {
  const q = extractQuotes(oddsJson());
  assert.deepEqual([...new Set(q.map((x) => x.book))].sort(), ["draftkings", "fanduel"]);
});

test("exact line: de-vigged median across books picks the likelier side", () => {
  const [, stockton] = extractPPLines(oddsJson());
  const f = fairFor(stockton, extractQuotes(oddsJson()))!;
  assert.equal(f.side, "Less");
  assert.equal(f.exact, true);
  assert.equal(f.books, 2);
  assert.ok(f.p > 0.54 && f.p < 0.57);
});

test("different book line gives a safe lower bound on the right side only", () => {
  const [frazier] = extractPPLines(oddsJson());
  const q = extractQuotes(oddsJson());
  const f = fairFor(frazier, q)!; // PP 69.5, books 74.5: More >= P(over 74.5)
  assert.equal(f.side, "More");
  assert.equal(f.exact, false);
  assert.equal(f.bookLine, 74.5);
  assert.ok(f.p > 0.5 && f.p < 0.55);
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
  return { get: (k: string) => m.get(k) ?? null, set: (k: string, v: string) => void m.set(k, v) };
}
const settings = (over: Partial<PicksSettings> = {}): PicksSettings => ({
  enabled: true,
  sports: ["americanfootball_ncaaf"],
  markets: ["player_pass_yds", "player_rush_yds", "player_reception_yds"],
  intervalMinutes: 120,
  dailyCredits: 60,
  regions: "us,us_dfs",
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
    if (url.includes("/events?apiKey=k")) return json(events);
    if (url.includes("/events/e1/odds")) return json(oddsJson(), { "x-requests-last": "3", "x-requests-remaining": "480" });
    return new Response("nope", { status: 404 });
  };
}

test("scanner: PrizePicks first, then the books for just the posted stats, then reuses the cache", async () => {
  const store = kv();
  const calls: string[] = [];
  const sc = new PicksScanner(settings(), store, "k", fakeFetch(calls) as any);
  assert.equal(sc.due(NOW), true);
  const v = await sc.run(NOW);
  assert.ok(calls.every((u) => u.startsWith("https://api.the-odds-api.com/"))); // never PrizePicks' own site
  const odds = calls.filter((u) => u.includes("/odds"));
  assert.equal(odds.length, 2); // the far-off game isn't fetched
  assert.match(odds[0], /bookmakers=prizepicks&markets=player_pass_yds,player_rush_yds,player_reception_yds/);
  assert.match(odds[1], /regions=us&markets=/);
  assert.doesNotMatch(odds[1], /us_dfs/);
  assert.equal(v.linesSeen, 3);
  assert.equal(v.priced, 2); // no sportsbook priced Coleman's receiving yards
  assert.equal(v.picks[0].player, "Gunner Stockton");
  assert.equal(v.picks[0].team, "Auburn Tigers @ Georgia Bulldogs");
  assert.match(v.status, /Priced 2 of 3 PrizePicks lines in 1 College football game/);
  assert.equal(sc.creditsToday(NOW), 6);
  assert.equal(sc.oddsRemaining, 480);

  assert.equal(sc.due(NOW + 60), false);
  calls.length = 0;
  await sc.run(NOW + 600); // within the interval: from the cache
  assert.equal(calls.filter((u) => u.includes("/odds")).length, 0);
  assert.equal(sc.creditsToday(NOW), 6);
  assert.equal(sc.view()?.priced, 2);
});

test("scanner: respects the daily credit cap and the dashboard switch", async () => {
  const store = kv();
  const calls: string[] = [];
  const sc = new PicksScanner(settings({ dailyCredits: 5 }), store, "k", fakeFetch(calls) as any);
  const v = await sc.run(NOW); // PrizePicks check 3, then books 3 more would pass 5
  assert.equal(calls.filter((u) => u.includes("/odds")).length, 1);
  assert.match(v.status, /Daily odds budget used/);
  store.set("picks_enabled", "off");
  assert.equal(sc.due(NOW + 86400), false);
});

test("scanner: with interval 0 it only runs when Check now is tapped, and a quick second tap is free", async () => {
  const store = kv();
  const calls: string[] = [];
  const sc = new PicksScanner(settings({ intervalMinutes: 0 }), store, "k", fakeFetch(calls) as any);
  assert.equal(sc.due(NOW), false); // never on its own, even the first time
  sc.request();
  assert.equal(sc.due(NOW), true);
  const v = await sc.run(NOW);
  assert.doesNotMatch(v.status, /Next check/);
  assert.equal(sc.due(NOW + 86400), false); // request is used up
  sc.request();
  await sc.run(NOW + 300); // 5 minutes later: reuse
  assert.equal(calls.filter((u) => u.includes("/odds")).length, 2);
  sc.request();
  await sc.run(NOW + 900); // 15 minutes later: fresh odds
  assert.equal(calls.filter((u) => u.includes("/odds")).length, 4);
  assert.equal(sc.creditsToday(NOW), 12);
});

test("scanner: an Odds API error shows up as the status", async () => {
  const sc = new PicksScanner(settings(), kv(), "k", (async () => new Response("bad key", { status: 401 })) as any);
  const v = await sc.run(NOW);
  assert.match(v.status, /College football: Odds API 401/);
});

test("scanner: retries a 429 and succeeds", async () => {
  const calls: string[] = [];
  const real = fakeFetch(calls);
  let hits = 0;
  const sc = new PicksScanner(settings(), kv(), "k", (async (u: string, i: any) => {
    if (u.includes("/odds") && hits++ === 0) return new Response('{"message":"Requests are too frequent"}', { status: 429 });
    return (real as any)(u, i);
  }) as any);
  sc.spacingMs = 1;
  const v = await sc.run(NOW);
  assert.doesNotMatch(v.status, /429|too many/);
});

test("scanner: repeated rate limits collapse into one short note", async () => {
  const calls: string[] = [];
  const real = fakeFetch(calls);
  const sc = new PicksScanner(settings(), kv(), "k", (async (u: string, i: any) =>
    u.includes("/odds") ? new Response("{}", { status: 429 }) : (real as any)(u, i)) as any);
  sc.spacingMs = 1;
  const v = await sc.run(NOW);
  assert.doesNotMatch(v.status, /EXCEEDED|\{/);
  assert.match(v.status, /skipped: odds site said too many requests/);
});

test("scanner: clearShot empties the screenshot card", () => {
  const store = kv();
  const sc = new PicksScanner(settings(), store, "k", fakeFetch([]) as any);
  store.set("pp_shot_view", JSON.stringify({ ts: 1, status: "x", results: [] }));
  sc.clearShot();
  assert.equal(sc.shotView(), null);
});

test("scanner: games with no PrizePicks players are skipped without buying sportsbook odds", async () => {
  const calls: string[] = [];
  const sc = new PicksScanner(settings(), kv(), "k", (async (url: string) => {
    calls.push(url);
    const json = (b: unknown) => new Response(JSON.stringify(b), { headers: { "content-type": "application/json", "x-requests-last": "0" } });
    if (url.includes("/events?apiKey=k")) return json(events);
    if (url.includes("bookmakers=prizepicks")) return json({ bookmakers: [] });
    return json(oddsJson());
  }) as any);
  sc.spacingMs = 1;
  const v = await sc.run(NOW);
  const odds = calls.filter((u) => u.includes("/odds"));
  assert.equal(odds.length, 1);
  assert.ok(odds.every((u) => u.includes("bookmakers=prizepicks")));
  assert.match(v.status, /None of the 1 College football game .*PrizePicks players/);
});
