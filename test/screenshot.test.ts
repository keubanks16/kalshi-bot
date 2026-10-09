import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanPicks, marketFor, readScreenshot, type ShotPick } from "../src/screenshot.ts";
import { PicksScanner, chanceFor, chanceText, extractQuotes, findGame, judge, type PicksSettings } from "../src/prizepicks.ts";

const NOW = Date.parse("2026-10-09T18:40:00Z") / 1000; // Fri 2:40 PM Eastern

// What Claude reads from the screenshot the user shared.
const SHOT = {
  picks: [
    { league: "WNBA", player: "Jordin Canada", stat: "3PTM", line: 1.5, kind: "demon", sides: ["less", "more"], matchup: "ATL vs NYL", teams: ["Atlanta Dream", "New York Liberty"], when: "Fri 7:30pm" },
    { league: "WNBA", player: "Chelsea Gray", stat: "Points", line: 12.5, kind: "demon", sides: ["more"], matchup: "GSV vs LVA", teams: ["Golden State Valkyries", "Las Vegas Aces"], when: "Fri 9:30pm" },
    { league: "WNBA", player: "Kayla Thornton", stat: "PRA", line: 14.5, kind: "demon", sides: ["more"], matchup: "GSV vs LVA", teams: ["Golden State Valkyries", "Las Vegas Aces"], when: "Fri 9:30pm" },
    { league: "MLB", player: "Freddie Freeman", stat: "Hits+Runs+RBIs", line: 0.5, kind: "goblin", sides: ["less", "more"], matchup: "LAD vs MIL", teams: ["Los Angeles Dodgers", "Milwaukee Brewers"], when: "Sun 8:00pm" },
    { league: "MLB", player: "Max Muncy", stat: "Hits+Runs+RBIs", line: 1.5, kind: "demon", sides: ["less", "more"], matchup: "LAD vs MIL", teams: ["Los Angeles Dodgers", "Milwaukee Brewers"], when: "Sun 8:00pm" },
    { league: "XFL", player: "Someone", stat: "Rush Yards", line: 40.5, kind: "standard", sides: ["more", "less"] },
    { league: "NBA", player: "Bad", stat: "Points" }, // no line: dropped
  ],
};

test("cleans Claude's reading and drops malformed cards", () => {
  const picks = cleanPicks(SHOT);
  assert.equal(picks.length, 6);
  assert.deepEqual(picks[1].sides, ["more"]);
  assert.equal(picks[3].kind, "goblin");
  assert.deepEqual(cleanPicks({ picks: [{ league: "nba", player: "X", stat: "Points", line: "20.5", kind: "weird", sides: [] }] })[0], {
    league: "NBA",
    player: "X",
    stat: "Points",
    line: 20.5,
    kind: "standard",
    sides: ["more", "less"],
    matchup: "",
    teams: [],
    when: "",
  });
});

test("PrizePicks stat names map to sportsbook markets", () => {
  assert.equal(marketFor("basketball_wnba", "3PTM"), "player_threes");
  assert.equal(marketFor("basketball_wnba", "PRA"), "player_points_rebounds_assists");
  assert.equal(marketFor("baseball_mlb", "Hits+Runs+RBIs"), "batter_hits_runs_rbis");
  assert.equal(marketFor("americanfootball_ncaaf", "Rush Yards"), "player_rush_yds");
  assert.equal(marketFor("basketball_nba", "Fantasy Score"), null);
});

test("sends the image to Claude with a forced tool and reads the picks back", async () => {
  let sent: any;
  const fetchFn = (async (_u: string, init: RequestInit) => {
    sent = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ content: [{ type: "tool_use", name: "report_picks", input: SHOT }], usage: { input_tokens: 2000, output_tokens: 400 } }));
  }) as unknown as typeof fetch;
  const r = await readScreenshot("AAAA", "image/png", { apiKey: "k", model: "m", inputPricePerM: 3, outputPricePerM: 15 }, fetchFn);
  assert.equal(sent.tool_choice.name, "report_picks");
  assert.equal(sent.messages[0].content[0].source.media_type, "image/png");
  assert.equal(r.picks.length, 6);
  assert.ok(Math.abs(r.cost - (2000 * 3 + 400 * 15) / 1e6) < 1e-12);
});

const ou = (player: string, point: number, over: number, under: number) => [
  { name: "Over", description: player, price: over, point },
  { name: "Under", description: player, price: under, point },
];
const lineOf = (player: string, market: string, line: number) => ({ player, stat: "", market, line });

test("a side's chance: exact, at least, at most, or a range", () => {
  const q = extractQuotes({
    bookmakers: [{ key: "dk", markets: [{ key: "player_points", outcomes: [...ou("A", 10.5, 1.9, 1.9), ...ou("A", 14.5, 2.5, 1.55)] }] }],
  });
  const exact = chanceFor(lineOf("A", "player_points", 10.5), q, "More")!;
  assert.equal(exact.exact, true);
  assert.equal(chanceText(exact), "50%");
  const range = chanceFor(lineOf("A", "player_points", 12.5), q, "More")!; // between 10.5 and 14.5
  assert.ok(range.lo! < range.hi!);
  assert.match(chanceText(range), /^\d+%–\d+%$/);
  const demon = chanceFor(lineOf("A", "player_points", 18.5), q, "More")!; // above every book line: only a ceiling
  assert.equal(demon.lo, null);
  assert.match(chanceText(demon), /^at most/);
  const low = chanceFor(lineOf("A", "player_points", 8.5), q, "More")!; // below every book line: only a floor
  assert.equal(low.hi, null);
  assert.match(chanceText(low), /^at least 50%/);
});

test("verdicts depend on the pick type", () => {
  const c = (lo: number | null, hi: number | null, exact = false) => ({ exact, lo, hi, books: 2, bookLine: 1 });
  const bar = 0.577;
  assert.equal(judge(c(0.62, 0.62, true), "standard", bar).tone, "good");
  assert.equal(judge(c(0.53, 0.53, true), "standard", bar).tone, "meh");
  assert.equal(judge(c(0.4, 0.4, true), "standard", bar).tone, "bad");
  assert.equal(judge(c(0.65, 0.65, true), "goblin", bar).tone, "meh"); // likely, but goblins pay less
  assert.equal(judge(c(0.8, null), "goblin", bar).tone, "good");
  assert.equal(judge(c(null, 0.3), "demon", bar).tone, "bad");
  assert.equal(judge(c(0.45, 0.5), "demon", bar).tone, "meh");
  assert.match(judge(c(null, 0.59), "demon", bar).verdict, /^At most 59%/);
});

test("finds the game from full team names", () => {
  const evs = [
    { id: "a", commence_time: "2026-10-09T23:30:00Z", home_team: "New York Liberty", away_team: "Atlanta Dream" },
    { id: "b", commence_time: "2026-10-10T01:30:00Z", home_team: "Las Vegas Aces", away_team: "Golden State Valkyries" },
  ];
  assert.equal(findGame(["Atlanta Dream", "New York Liberty"], evs)?.id, "a");
  assert.equal(findGame(["Golden State Valkyries", "Las Vegas Aces"], evs)?.id, "b");
  assert.equal(findGame(["Valkyries"], evs)?.id, "b"); // nickname alone
  assert.equal(findGame([], evs), null);
});

const settings: PicksSettings = {
  enabled: true,
  sports: ["americanfootball_ncaaf"],
  markets: ["player_rush_yds"],
  intervalMinutes: 0,
  dailyCredits: 300,
  regions: "us,us_dfs",
  hoursAhead: 24,
  minBooks: 1,
  payouts: { 2: 3, 3: 5 },
  timezone: "America/New_York",
};
function kv() {
  const m = new Map<string, string>();
  return { get: (k: string) => m.get(k) ?? null, set: (k: string, v: string) => void m.set(k, v) };
}
function fakeOdds(calls: string[]) {
  const json = (b: unknown, h: Record<string, string> = {}) => new Response(JSON.stringify(b), { headers: { "content-type": "application/json", ...h } });
  return (async (url: string) => {
    calls.push(url);
    if (url.includes("basketball_wnba/events?"))
      return json([
        { id: "w1", commence_time: "2026-10-09T23:30:00Z", home_team: "New York Liberty", away_team: "Atlanta Dream" },
        { id: "w2", commence_time: "2026-10-10T01:30:00Z", home_team: "Las Vegas Aces", away_team: "Golden State Valkyries" },
      ]);
    if (url.includes("baseball_mlb/events?")) return json([{ id: "m1", commence_time: "2026-10-12T00:00:00Z", home_team: "Milwaukee Brewers", away_team: "Los Angeles Dodgers" }]);
    if (url.includes("/events/w1/odds")) return json({ bookmakers: [{ key: "dk", markets: [{ key: "player_threes", outcomes: ou("Jordin Canada", 1.5, 3.2, 1.33) }] }] }, { "x-requests-last": "1" });
    if (url.includes("/events/w2/odds"))
      return json(
        { bookmakers: [{ key: "dk", markets: [{ key: "player_points", outcomes: ou("Chelsea Gray", 9.5, 1.6, 2.3) }, { key: "player_points_rebounds_assists", outcomes: ou("Kayla Thornton", 12.5, 1.9, 1.9) }] }] },
        { "x-requests-last": "2" },
      );
    if (url.includes("/events/m1/odds")) return json({ bookmakers: [{ key: "dk", markets: [{ key: "batter_hits_runs_rbis", outcomes: [...ou("Freddie Freeman", 0.5, 1.25, 4.0), ...ou("Max Muncy", 1.5, 2.1, 1.75)] }] }] }, { "x-requests-last": "1" });
    return new Response("nope", { status: 404 });
  }) as any;
}

test("checks a whole screenshot: one sportsbook call per game, sportsbook regions only", async () => {
  const calls: string[] = [];
  const store = kv();
  const sc = new PicksScanner(settings, store, "k", fakeOdds(calls));
  const v = await sc.checkShot(cleanPicks(SHOT), NOW, 0.012);
  const odds = calls.filter((u) => u.includes("/odds"));
  assert.equal(odds.length, 3);
  assert.ok(odds.every((u) => /regions=us&/.test(u))); // PrizePicks' line is in the screenshot: no us_dfs
  assert.match(odds.find((u) => u.includes("w2"))!, /markets=player_points,player_points_rebounds_assists/);
  assert.equal(v.credits, 4);
  assert.equal(sc.creditsToday(NOW), 4);
  assert.match(v.status, /Checked 6 picks.*4 odds credits.*\$0\.012 of AI/);

  const by = Object.fromEntries(v.results.map((r) => [r.player, r]));
  assert.equal(by["Jordin Canada"].side, "Less"); // books: over 1.5 threes is unlikely
  assert.equal(by["Jordin Canada"].chance!.exact, true);
  assert.doesNotMatch(by["Jordin Canada"].verdict, /demon/i); // Less on a demon card is judged as standard
  assert.equal(by["Chelsea Gray"].side, "More");
  assert.equal(by["Chelsea Gray"].chance!.lo, null); // demon line above the book's 9.5: a ceiling only
  assert.match(chanceText(by["Chelsea Gray"].chance!), /^at most 59%/);
  assert.equal(by["Kayla Thornton"].chance!.lo, null); // 14.5 above the book's 12.5: a ceiling only
  assert.equal(by["Freddie Freeman"].side, "More");
  assert.equal(by["Freddie Freeman"].tone, "good"); // ~76% for a goblin
  assert.equal(by["Someone"].tone, "unknown");
  assert.match(by["Someone"].verdict, /don't cover XFL/);
  assert.equal(sc.shotView()?.results.length, 6);

  calls.length = 0;
  await sc.checkShot(cleanPicks(SHOT), NOW + 120); // same games 2 minutes later: free
  assert.equal(calls.filter((u) => u.includes("/odds")).length, 0);
});

test("a screenshot check respects the daily credit cap", async () => {
  const calls: string[] = [];
  const store = kv();
  store.set("pp_credits_2026-10-09", "299");
  const sc = new PicksScanner(settings, store, "k", fakeOdds(calls));
  const v = await sc.checkShot(cleanPicks(SHOT), NOW);
  assert.equal(calls.filter((u) => u.includes("/odds")).length, 1); // only the 1-credit game fits
  assert.ok(v.results.some((r) => /Daily odds budget used/.test(r.verdict)));
});
