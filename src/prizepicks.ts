// PrizePicks pick finder. It never places entries: it reads PrizePicks'
// player-prop lines, compares each with sportsbook player-prop odds for the
// same player, stat and line, and lists the picks the books say are most
// likely to hit, plus the best power-play slips built from them.
//
// Fair probabilities: each book's over/under prices are de-vigged (scaled to
// sum to 100%), then the median across books is used. When no book has the
// exact PrizePicks line, a book line on the far side still gives a safe
// lower bound: if the book says 58% over 74.5 yards, "More than 69.5" is at
// least 58%. Bounds are shown with "≥" and never overstate the chance.

import { devig, teamMatches } from "./sports.ts";

// ------------------------------------------------------------------ settings

export interface PicksSettings {
  enabled: boolean;
  sports: string[]; // The Odds API sport keys
  intervalMinutes: number;
  dailyCredits: number; // Odds API credits this finder may use per day (separate from Kalshi sports)
  regions: string;
  marketsPerGame: number; // most stat types to price per game (each costs credits)
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

// ------------------------------------------------------------- stat mapping

const FOOTBALL: Record<string, string> = {
  passyards: "player_pass_yds",
  passingyards: "player_pass_yds",
  passtds: "player_pass_tds",
  passingtds: "player_pass_tds",
  passcompletions: "player_pass_completions",
  passattempts: "player_pass_attempts",
  intthrown: "player_pass_interceptions",
  passints: "player_pass_interceptions",
  rushyards: "player_rush_yds",
  rushingyards: "player_rush_yds",
  rushattempts: "player_rush_attempts",
  receivingyards: "player_reception_yds",
  recyards: "player_reception_yds",
  receptions: "player_receptions",
  rushrecyds: "player_rush_reception_yds",
  rushrecyards: "player_rush_reception_yds",
  passrushyds: "player_pass_rush_yds",
  passrushyards: "player_pass_rush_yds",
  longestreception: "player_reception_longest",
  longestrush: "player_rush_longest",
};
const BASKETBALL: Record<string, string> = {
  points: "player_points",
  rebounds: "player_rebounds",
  assists: "player_assists",
  ptsrebsasts: "player_points_rebounds_assists",
  ptsrebs: "player_points_rebounds",
  ptsasts: "player_points_assists",
  rebsasts: "player_rebounds_assists",
  "3ptmade": "player_threes",
  blockedshots: "player_blocks",
  steals: "player_steals",
  turnovers: "player_turnovers",
};
const BASEBALL: Record<string, string> = {
  pitcherstrikeouts: "pitcher_strikeouts",
  hitsallowed: "pitcher_hits_allowed",
  earnedrunsallowed: "pitcher_earned_runs",
  walksallowed: "pitcher_walks",
  pitchingouts: "pitcher_outs",
  totalbases: "batter_total_bases",
  hits: "batter_hits",
  runs: "batter_runs_scored",
  rbis: "batter_rbis",
  hitsrunsrbis: "batter_hits_runs_rbis",
};
const HOCKEY: Record<string, string> = {
  shotsongoal: "player_shots_on_goal",
  points: "player_points",
  assists: "player_assists",
  goaliesaves: "player_total_saves",
  blockedshots: "player_blocked_shots",
};

/** Odds API sport key -> PrizePicks league name, fallback league id, and stat names it can price. */
export const PP_SPORTS: Record<string, { league: string; leagueId: number; label: string; stats: Record<string, string> }> = {
  americanfootball_ncaaf: { league: "CFB", leagueId: 15, label: "College football", stats: FOOTBALL },
  americanfootball_nfl: { league: "NFL", leagueId: 9, label: "NFL", stats: FOOTBALL },
  basketball_nba: { league: "NBA", leagueId: 7, label: "NBA", stats: BASKETBALL },
  basketball_ncaab: { league: "CBB", leagueId: 20, label: "College basketball", stats: BASKETBALL },
  basketball_wnba: { league: "WNBA", leagueId: 3, label: "WNBA", stats: BASKETBALL },
  baseball_mlb: { league: "MLB", leagueId: 2, label: "MLB", stats: BASEBALL },
  icehockey_nhl: { league: "NHL", leagueId: 8, label: "NHL", stats: HOCKEY },
};

const statKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Player names compared loosely: case, punctuation and Jr./III suffixes ignored. */
export function normName(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z ]/g, "")
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ------------------------------------------------------------ PrizePicks lines

export interface PPLine {
  id: string;
  player: string;
  team: string; // team name or abbreviation as PrizePicks shows it
  opponent: string;
  stat: string; // as PrizePicks shows it, e.g. "Rush Yards"
  market: string; // Odds API market key
  line: number;
  start: string; // ISO
}

/** Standard PrizePicks lines (no goblins/demons, no promos) that a sportsbook market can price. */
export function parseProjections(json: any, stats: Record<string, string>): PPLine[] {
  const players = new Map<string, any>();
  for (const inc of json?.included ?? []) if (inc?.type === "new_player") players.set(String(inc.id), inc.attributes ?? {});
  const out: PPLine[] = [];
  for (const p of json?.data ?? []) {
    const a = p?.attributes ?? {};
    if ((a.odds_type ?? "standard") !== "standard" || a.is_promo) continue;
    if (a.status && a.status !== "pre_game") continue;
    const market = stats[statKey(String(a.stat_type ?? ""))];
    const line = Number(a.line_score);
    if (!market || !Number.isFinite(line)) continue;
    const pl = players.get(String(p?.relationships?.new_player?.data?.id ?? ""));
    const name = String(pl?.display_name ?? pl?.name ?? "");
    if (!name || name.includes("+")) continue; // combo-player lines can't be priced
    out.push({
      id: String(p.id),
      player: name,
      team: String(pl?.team_name ?? pl?.market ?? pl?.team ?? ""),
      opponent: String(a.description ?? ""),
      stat: String(a.stat_type),
      market,
      line,
      start: String(a.start_time ?? ""),
    });
  }
  return out;
}

// ------------------------------------------------------------- sportsbooks

export interface OddsEvent {
  id: string;
  commence_time: string;
  home_team: string;
  away_team: string;
}

/** The sportsbook game a PrizePicks line belongs to: same kickoff (±20 min) and team. */
export function matchEvent(line: PPLine, events: OddsEvent[]): OddsEvent | null {
  const t = Date.parse(line.start);
  const near = events.filter((e) => Math.abs(Date.parse(e.commence_time) - t) <= 20 * 60_000);
  if (line.team) {
    // "Georgia" starts both "Georgia Bulldogs" and "Georgia Tech Yellow Jackets":
    // prefer the name with the fewest words left over, and skip true ties.
    const extra = (full: string) => (teamMatches(line.team, full) ? normName(full).split(" ").length - normName(line.team).split(" ").length : Infinity);
    const scored = near.map((e) => ({ e, d: Math.min(extra(e.home_team), extra(e.away_team)) })).filter((x) => x.d !== Infinity);
    if (scored.length) {
      const best = Math.min(...scored.map((x) => x.d));
      const top = scored.filter((x) => x.d === best);
      return top.length === 1 ? top[0].e : null;
    }
  }
  return near.length === 1 ? near[0] : null;
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
export function extractQuotes(ev: any): Quote[] {
  const out: Quote[] = [];
  for (const b of ev?.bookmakers ?? []) {
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

const PP_HEADERS = {
  Accept: "application/json",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36",
  Referer: "https://app.prizepicks.com/",
  Origin: "https://app.prizepicks.com",
};

interface CacheEntry {
  ts: number;
  markets: string[];
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

  private save(v: PicksView) {
    this.store.set("picks_view", JSON.stringify(v));
  }

  private async json(url: string, headers?: Record<string, string>): Promise<{ body: any; res: Response }> {
    const res = await this.fetchFn(url, { headers, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}: ${(await res.text()).slice(0, 120)}`);
    return { body: await res.json(), res };
  }

  private async leagueId(league: string, fallback: number): Promise<number> {
    try {
      const cached = JSON.parse(this.store.get("pp_leagues") ?? "{}");
      if (cached[league]) return cached[league];
      const { body } = await this.json("https://api.prizepicks.com/leagues", PP_HEADERS);
      const map: Record<string, number> = {};
      for (const l of body?.data ?? []) if (l?.attributes?.name) map[String(l.attributes.name)] = Number(l.id);
      if (Object.keys(map).length) this.store.set("pp_leagues", JSON.stringify(map));
      return map[league] ?? fallback;
    } catch {
      return fallback;
    }
  }

  async run(now: number): Promise<PicksView> {
    this.store.set("picks_last_ts", String(now));
    const creditKey = `pp_credits_${dayOf(now, this.s.timezone)}`;
    let used = Number(this.store.get(creditKey) ?? 0);
    const perMarket = this.s.regions.split(",").filter(Boolean).length;
    let cache: Record<string, CacheEntry> = {};
    try {
      cache = JSON.parse(this.store.get("pp_props_cache") ?? "{}");
    } catch {}
    for (const [k, v] of Object.entries(cache)) if (now - v.ts > 2 * 86400) delete cache[k];

    const picks: Pick[] = [];
    const problems: string[] = [];
    let linesSeen = 0;
    let priced = 0;
    let budgetHit = false;

    for (const sportKey of this.s.sports) {
      const sport = PP_SPORTS[sportKey];
      if (!sport) continue;
      // 1. PrizePicks lines (free).
      let lines: PPLine[];
      try {
        const id = await this.leagueId(sport.league, sport.leagueId);
        const { body } = await this.json(`https://api.prizepicks.com/projections?league_id=${id}&per_page=1000&single_stat=true`, PP_HEADERS);
        lines = parseProjections(body, sport.stats);
      } catch (e) {
        problems.push(`PrizePicks ${sport.label}: ${(e as Error).message}`);
        continue;
      }
      const soon = lines.filter((l) => {
        const t = Date.parse(l.start) / 1000;
        return t - now > 5 * 60 && t - now < this.s.hoursAhead * 3600;
      });
      linesSeen += soon.length;
      if (!soon.length) continue;

      // 2. Sportsbook game list (free).
      let events: OddsEvent[];
      try {
        events = (await this.json(`https://api.the-odds-api.com/v4/sports/${sportKey}/events?apiKey=${encodeURIComponent(this.oddsKey)}`)).body;
      } catch (e) {
        problems.push(`Odds API ${sport.label}: ${(e as Error).message}`);
        continue;
      }
      const byEvent = new Map<string, { ev: OddsEvent; lines: PPLine[] }>();
      for (const l of soon) {
        const ev = matchEvent(l, events);
        if (!ev) continue;
        const g = byEvent.get(ev.id) ?? { ev, lines: [] };
        g.lines.push(l);
        byEvent.set(ev.id, g);
      }

      // 3. Player props per game (paid), soonest games first, reusing recent results.
      const games = [...byEvent.values()].sort((a, b) => Date.parse(a.ev.commence_time) - Date.parse(b.ev.commence_time));
      for (const { ev, lines: gl } of games) {
        const count = new Map<string, number>();
        for (const l of gl) count.set(l.market, (count.get(l.market) ?? 0) + 1);
        const markets = [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, this.s.marketsPerGame).map(([m]) => m);
        let entry: CacheEntry | undefined = cache[ev.id];
        const fresh = entry && now - entry.ts < this.s.intervalMinutes * 60 && markets.every((m) => entry!.markets.includes(m));
        if (!fresh) {
          const cost = markets.length * perMarket;
          if (used + cost > this.s.dailyCredits) {
            budgetHit = true;
          } else {
            try {
              const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/events/${ev.id}/odds?apiKey=${encodeURIComponent(this.oddsKey)}&regions=${this.s.regions}&markets=${markets.join(",")}&oddsFormat=decimal`;
              const { body, res } = await this.json(url);
              used += Number(res.headers.get("x-requests-last") ?? cost);
              this.store.set(creditKey, String(used));
              const rem = res.headers.get("x-requests-remaining");
              if (rem !== null) this.oddsRemaining = Number(rem);
              entry = { ts: now, markets, quotes: extractQuotes(body) };
              cache[ev.id] = entry;
            } catch (e) {
              problems.push(`Odds API props: ${(e as Error).message}`);
            }
          }
        }
        if (!entry) continue;
        for (const l of gl) {
          const f = fairFor(l, entry.quotes, this.s.minBooks);
          if (!f) continue;
          priced++;
          picks.push({
            player: l.player,
            team: l.team,
            opponent: l.opponent,
            stat: l.stat,
            line: l.line,
            side: f.side,
            p: f.p,
            books: f.books,
            exact: f.exact,
            bookLine: f.bookLine,
            start: l.start,
            game: ev.id,
            sport: sport.label,
          });
        }
      }
    }
    this.store.set("pp_props_cache", JSON.stringify(cache));

    picks.sort((a, b) => b.p - a.p);
    const slips = bestSlips(picks, this.s.payouts);
    const sports = this.s.sports.map((k) => PP_SPORTS[k]?.label ?? k).join(", ");
    const status = problems.length && !priced
      ? problems.join(" · ")
      : !linesSeen
        ? `No ${sports} PrizePicks lines in the next ${this.s.hoursAhead} hours.`
        : `Priced ${priced} of ${linesSeen} ${sports} lines against the sportsbooks${budgetHit ? `; daily odds budget used (${used} of ${this.s.dailyCredits} credits), so some games weren't checked` : ""}. Next check in ${this.s.intervalMinutes} min.${problems.length ? ` (${problems.join(" · ")})` : ""}`;
    const v: PicksView = { ts: now, status, picks: picks.slice(0, 40), slips, linesSeen, priced };
    this.save(v);
    return v;
  }
}
