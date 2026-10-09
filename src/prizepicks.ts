// PrizePicks pick finder. It never places entries and never touches
// PrizePicks' own site: The Odds API licenses PrizePicks' lines (bookmaker
// "prizepicks", region "us_dfs"), so one request per game returns both the
// PrizePicks lines and the sportsbooks' player-prop odds for the same game.
//
// Fair probabilities: each sportsbook's over/under prices are de-vigged
// (scaled to sum to 100%), then the median across books is used. When no
// book has the exact PrizePicks line, a book line on the far side still gives
// a safe lower bound: if the books say 58% over 74.5 yards, "More than 69.5"
// is at least 58%. Bounds are shown with "≥" and never overstate the chance.

import { devig } from "./sports.ts";

export interface PicksSettings {
  enabled: boolean;
  sports: string[]; // The Odds API sport keys
  markets: string[]; // Odds API player-prop market keys to price
  intervalMinutes: number;
  dailyCredits: number; // Odds API credits this finder may use per day (separate from Kalshi sports)
  regions: string; // must include us_dfs (PrizePicks) and a sportsbook region
  hoursAhead: number;
  minBooks: number;
  payouts: Record<number, number>; // power play: number of picks -> payout multiplier
  timezone: string;
}

/** "2:3,3:5,4:10" -> {2: 3, 3: 5, 4: 10}; bad entries are dropped. */
export function parsePayouts(raw: string): Record<number, number> {
  const out: Record<number, number> = {};
  for (const part of raw.split(",")) {
    const [n, x] = part.split(":").map((v) => Number(v.trim()));
    if (Number.isInteger(n) && n >= 2 && n <= 8 && x > 1) out[n] = x;
  }
  return out;
}

/** Pick'em / DFS sites in The Odds API's us_dfs region: lines to bet, not sportsbooks to price from. */
export const DFS_BOOKS = ["prizepicks", "underdog", "pick6", "dabble_us_dfs"];

export const SPORT_LABELS: Record<string, string> = {
  americanfootball_ncaaf: "College football",
  americanfootball_nfl: "NFL",
  basketball_nba: "NBA",
  basketball_ncaab: "College basketball",
  basketball_wnba: "WNBA",
  baseball_mlb: "MLB",
  icehockey_nhl: "NHL",
};

/** Readable stat names for Odds API player-prop markets. */
export const MARKET_LABELS: Record<string, string> = {
  player_pass_yds: "Pass Yards",
  player_pass_tds: "Pass TDs",
  player_pass_completions: "Pass Completions",
  player_pass_attempts: "Pass Attempts",
  player_pass_interceptions: "INTs Thrown",
  player_rush_yds: "Rush Yards",
  player_rush_attempts: "Rush Attempts",
  player_reception_yds: "Receiving Yards",
  player_receptions: "Receptions",
  player_rush_reception_yds: "Rush+Rec Yds",
  player_pass_rush_yds: "Pass+Rush Yds",
  player_points: "Points",
  player_rebounds: "Rebounds",
  player_assists: "Assists",
  player_threes: "3-PT Made",
  player_points_rebounds_assists: "Pts+Rebs+Asts",
  pitcher_strikeouts: "Pitcher Strikeouts",
  batter_total_bases: "Total Bases",
  player_shots_on_goal: "Shots On Goal",
};

/** Player names compared loosely: case, punctuation and Jr./III suffixes ignored. */
export function normName(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z ]/g, "")
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export interface PPLine {
  player: string;
  stat: string;
  market: string;
  line: number;
}

/** PrizePicks' standard lines in an Odds API event-odds response (one per player, stat and line). */
export function extractPPLines(ev: any): PPLine[] {
  const seen = new Set<string>();
  const out: PPLine[] = [];
  for (const b of ev?.bookmakers ?? []) {
    if (b?.key !== "prizepicks") continue;
    for (const m of b?.markets ?? []) {
      const market = String(m?.key ?? "");
      if (market.endsWith("_alternate")) continue; // goblins and demons
      for (const o of m?.outcomes ?? []) {
        const player = String(o?.description ?? "").trim();
        const line = Number(o?.point);
        const k = `${market}|${normName(player)}|${line}`;
        if (!player || !Number.isFinite(line) || seen.has(k)) continue;
        seen.add(k);
        out.push({ player, stat: MARKET_LABELS[market] ?? market, market, line });
      }
    }
  }
  return out;
}

export interface OddsEvent {
  id: string;
  commence_time: string;
  home_team: string;
  away_team: string;
}

/** One book's de-vigged over chance for a player/stat/line. */
export interface Quote {
  market: string;
  player: string; // normalized
  point: number;
  over: number;
  book: string;
}

/** Pull every player over/under pair out of an Odds API event-odds response. */
export function extractQuotes(ev: any, skip: string[] = DFS_BOOKS): Quote[] {
  const out: Quote[] = [];
  for (const b of ev?.bookmakers ?? []) {
    if (skip.includes(String(b?.key))) continue; // pick'em sites aren't sportsbooks
    for (const m of b?.markets ?? []) {
      const pairs = new Map<string, { over?: number; under?: number; player: string; point: number }>();
      for (const o of m?.outcomes ?? []) {
        const side = String(o?.name ?? "").toLowerCase();
        if ((side !== "over" && side !== "under") || !Number.isFinite(Number(o?.point))) continue;
        const player = normName(String(o?.description ?? ""));
        const k = `${player}|${o.point}`;
        const cur = pairs.get(k) ?? { player, point: Number(o.point) };
        cur[side] = Number(o.price);
        pairs.set(k, cur);
      }
      for (const p of pairs.values()) {
        if (!p.player || p.over === undefined || p.under === undefined) continue;
        const fair = devig([
          { name: "o", price: p.over },
          { name: "u", price: p.under },
        ]);
        if (fair) out.push({ market: String(m.key), player: p.player, point: p.point, over: fair.o, book: String(b.key) });
      }
    }
  }
  return out;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export interface Fair {
  side: "More" | "Less";
  p: number;
  books: number;
  exact: boolean; // false = lower bound from another line
  bookLine: number;
}

/** Best side of a PrizePicks line by sportsbook consensus, or null if the books don't cover it. */
export function fairFor(line: PPLine, quotes: Quote[], minBooks = 1): Fair | null {
  const mine = quotes.filter((q) => q.market === line.market && q.player === normName(line.player));
  const byPoint = new Map<number, number[]>();
  for (const q of mine) byPoint.set(q.point, [...(byPoint.get(q.point) ?? []), q.over]);
  const points = [...byPoint.keys()].filter((pt) => byPoint.get(pt)!.length >= minBooks).sort((a, b) => a - b);
  if (!points.length) return null;
  const over = (pt: number) => median(byPoint.get(pt)!);
  const n = (pt: number) => byPoint.get(pt)!.length;

  const cands: Fair[] = [];
  if (byPoint.has(line.line) && points.includes(line.line)) {
    const o = over(line.line);
    cands.push({ side: "More", p: o, books: n(line.line), exact: true, bookLine: line.line });
    cands.push({ side: "Less", p: 1 - o, books: n(line.line), exact: true, bookLine: line.line });
  } else {
    const above = points.find((pt) => pt > line.line); // P(more than line) >= P(over this)
    const below = [...points].reverse().find((pt) => pt < line.line); // P(less than line) >= P(under this)
    if (above !== undefined) cands.push({ side: "More", p: over(above), books: n(above), exact: false, bookLine: above });
    if (below !== undefined) cands.push({ side: "Less", p: 1 - over(below), books: n(below), exact: false, bookLine: below });
  }
  if (!cands.length) return null;
  return cands.reduce((a, b) => (b.p > a.p ? b : a));
}

// ------------------------------------------------------------------- slips

export interface Pick {
  player: string;
  team: string;
  opponent: string;
  stat: string;
  line: number;
  side: "More" | "Less";
  p: number;
  books: number;
  exact: boolean;
  bookLine: number;
  start: string;
  game: string; // sportsbook event id, so slips avoid stacking one game
  sport: string;
}

export interface Slip {
  size: number;
  payout: number;
  breakEven: number; // per-pick chance needed to break even
  ev: number; // expected profit per $1 entered
  picks: Pick[];
}

/** Break-even chance per pick for an n-pick power play paying `payout`x. */
export const breakEven = (n: number, payout: number) => Math.pow(1 / payout, 1 / n);

/**
 * Best power-play slip of each size: the highest-chance picks, at most one
 * per game and per player (picks from one game move together, which this
 * simple product doesn't account for).
 */
export function bestSlips(picks: Pick[], payouts: Record<number, number>): Slip[] {
  const seenGame = new Set<string>();
  const seenPlayer = new Set<string>();
  const pool: Pick[] = [];
  for (const p of [...picks].sort((a, b) => b.p - a.p)) {
    const who = normName(p.player);
    if (seenGame.has(p.game) || seenPlayer.has(who)) continue;
    seenGame.add(p.game);
    seenPlayer.add(who);
    pool.push(p);
  }
  return Object.entries(payouts)
    .map(([k, payout]) => ({ size: Number(k), payout }))
    .filter(({ size }) => pool.length >= size)
    .sort((a, b) => a.size - b.size)
    .map(({ size, payout }) => {
      const chosen = pool.slice(0, size);
      const hit = chosen.reduce((acc, p) => acc * p.p, 1);
      return { size, payout, breakEven: breakEven(size, payout), ev: payout * hit - 1, picks: chosen };
    });
}

// ----------------------------------------------------------------- scanner

export interface PicksView {
  ts: number;
  status: string;
  picks: Pick[];
  slips: Slip[];
  linesSeen: number;
  priced: number;
}

export interface KV {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

interface CacheEntry {
  ts: number;
  markets: string[];
  lines: PPLine[];
  quotes: Quote[];
}

function dayOf(epochSeconds: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(epochSeconds * 1000));
}

export class PicksScanner {
  oddsRemaining: number | null = null;
  s: PicksSettings;
  store: KV;
  oddsKey: string;
  fetchFn: FetchFn;
  constructor(s: PicksSettings, store: KV, oddsKey: string, fetchFn: FetchFn = (u, i) => fetch(u, i)) {
    this.s = s;
    this.store = store;
    this.oddsKey = oddsKey;
    this.fetchFn = fetchFn;
  }

  enabled(): boolean {
    const o = this.store.get("picks_enabled");
    return o === "on" ? true : o === "off" ? false : this.s.enabled;
  }

  view(): PicksView | null {
    try {
      return JSON.parse(this.store.get("picks_view") ?? "null");
    } catch {
      return null;
    }
  }

  creditsToday(now: number): number {
    return Number(this.store.get(`pp_credits_${dayOf(now, this.s.timezone)}`) ?? 0);
  }

  due(now: number): boolean {
    return this.enabled() && !!this.oddsKey && now - Number(this.store.get("picks_last_ts") ?? 0) >= this.s.intervalMinutes * 60;
  }

  private async json(url: string): Promise<{ body: any; res: Response }> {
    const res = await this.fetchFn(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Odds API ${res.status}: ${(await res.text()).slice(0, 120)}`);
    return { body: await res.json(), res };
  }

  async run(now: number): Promise<PicksView> {
    this.store.set("picks_last_ts", String(now));
    const creditKey = `pp_credits_${dayOf(now, this.s.timezone)}`;
    let used = Number(this.store.get(creditKey) ?? 0);
    const regions = this.s.regions.split(",").map((r) => r.trim()).filter(Boolean);
    const cost = this.s.markets.length * regions.length;
    const key = encodeURIComponent(this.oddsKey);
    let cache: Record<string, CacheEntry> = {};
    try {
      cache = JSON.parse(this.store.get("pp_props_cache") ?? "{}");
    } catch {}
    for (const [k, v] of Object.entries(cache)) if (now - v.ts > 2 * 86400) delete cache[k];

    const picks: Pick[] = [];
    const problems: string[] = [];
    let linesSeen = 0;
    let priced = 0;
    let games = 0;
    let budgetHit = false;

    for (const sportKey of this.s.sports) {
      const label = SPORT_LABELS[sportKey] ?? sportKey;
      // 1. Upcoming games (free).
      let events: OddsEvent[];
      try {
        events = (await this.json(`https://api.the-odds-api.com/v4/sports/${sportKey}/events?apiKey=${key}`)).body;
      } catch (e) {
        problems.push(`${label}: ${(e as Error).message}`);
        continue;
      }
      const soon = events
        .filter((e) => {
          const t = Date.parse(e.commence_time) / 1000;
          return t - now > 5 * 60 && t - now < this.s.hoursAhead * 3600;
        })
        .sort((a, b) => Date.parse(a.commence_time) - Date.parse(b.commence_time));

      // 2. PrizePicks lines + sportsbook props per game (paid), soonest first, reusing recent results.
      for (const ev of soon) {
        let entry: CacheEntry | undefined = cache[ev.id];
        const fresh = entry && now - entry.ts < this.s.intervalMinutes * 60 && this.s.markets.every((m) => entry!.markets.includes(m));
        if (!fresh) {
          if (used + cost > this.s.dailyCredits) {
            budgetHit = true;
          } else {
            try {
              const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/events/${ev.id}/odds?apiKey=${key}&regions=${regions.join(",")}&markets=${this.s.markets.join(",")}&oddsFormat=decimal`;
              const { body, res } = await this.json(url);
              used += Number(res.headers.get("x-requests-last") ?? cost);
              this.store.set(creditKey, String(used));
              const rem = res.headers.get("x-requests-remaining");
              if (rem !== null) this.oddsRemaining = Number(rem);
              entry = { ts: now, markets: this.s.markets, lines: extractPPLines(body), quotes: extractQuotes(body) };
              cache[ev.id] = entry;
            } catch (e) {
              problems.push(`${label} props: ${(e as Error).message}`);
            }
          }
        }
        if (!entry) continue;
        games++;
        linesSeen += entry.lines.length;
        for (const l of entry.lines) {
          const f = fairFor(l, entry.quotes, this.s.minBooks);
          if (!f) continue;
          priced++;
          picks.push({
            player: l.player,
            team: `${ev.away_team} @ ${ev.home_team}`,
            opponent: "",
            stat: l.stat,
            line: l.line,
            side: f.side,
            p: f.p,
            books: f.books,
            exact: f.exact,
            bookLine: f.bookLine,
            start: ev.commence_time,
            game: ev.id,
            sport: label,
          });
        }
      }
    }
    this.store.set("pp_props_cache", JSON.stringify(cache));

    picks.sort((a, b) => b.p - a.p);
    const slips = bestSlips(picks, this.s.payouts);
    const sports = this.s.sports.map((k) => SPORT_LABELS[k] ?? k).join(", ");
    const budget = budgetHit ? `; daily odds budget used (${used} of ${this.s.dailyCredits} credits), so later games weren't checked` : "";
    const status =
      problems.length && !games
        ? problems.join(" · ")
        : !games
          ? budgetHit
            ? `Daily odds budget used (${used} of ${this.s.dailyCredits} credits). Resumes tomorrow.`
            : `No ${sports} games in the next ${this.s.hoursAhead} hours.`
          : !linesSeen
            ? `Checked ${games} ${sports} game${games > 1 ? "s" : ""}, but PrizePicks has no lines posted for them yet${budget}.`
            : `Priced ${priced} of ${linesSeen} PrizePicks lines in ${games} ${sports} game${games > 1 ? "s" : ""}${budget}. Next check in ${this.s.intervalMinutes} min.${problems.length ? ` (${problems.join(" · ")})` : ""}`;
    const v: PicksView = { ts: now, status, picks: picks.slice(0, 40), slips, linesSeen, priced };
    this.store.set("picks_view", JSON.stringify(v));
    return v;
  }
}
