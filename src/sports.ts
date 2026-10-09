// Sports: compare Kalshi game-winner prices with what the sportsbooks say.
//
// Sportsbook odds include a margin (the "vig"), so we convert each book's odds
// to probabilities and scale them to add up to 100% ("de-vig"). Pinnacle, the
// sharpest book, is used when available; otherwise the median across books.
// If Kalshi sells a team cheaper than that fair probability (after fees), buy.

/** The Odds API sport key -> Kalshi series that lists single games for it. */
export const SPORTS: Record<string, { label: string; series: string }> = {
  baseball_mlb: { label: "MLB", series: "KXMLBGAME" },
  americanfootball_nfl: { label: "NFL", series: "KXNFLGAME" },
  americanfootball_ncaaf: { label: "College football", series: "KXNCAAFGAME" },
  basketball_nba: { label: "NBA", series: "KXNBAGAME" },
  basketball_ncaab: { label: "College basketball", series: "KXNCAAMBGAME" },
  basketball_wnba: { label: "WNBA", series: "KXWNBAGAME" },
  icehockey_nhl: { label: "NHL", series: "KXNHLGAME" },
  soccer_epl: { label: "Premier League", series: "KXEPLGAME" },
  soccer_usa_mls: { label: "MLS", series: "KXMLSGAME" },
  soccer_germany_bundesliga: { label: "Bundesliga", series: "KXBUNDESLIGAGAME" },
  soccer_italy_serie_a: { label: "Serie A", series: "KXSERIEAGAME" },
};

export interface OddsGame {
  id: string;
  sport_key: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers: {
    key: string;
    title?: string;
    last_update?: string;
    markets: { key: string; last_update?: string; outcomes: { name: string; price: number }[] }[];
  }[];
}

/** Turn one bookmaker's decimal odds into fair probabilities that sum to 1. */
export function devig(outcomes: { name: string; price: number }[]): Record<string, number> | null {
  const inv = outcomes.map((o) => (o.price > 1 ? 1 / o.price : NaN));
  if (inv.some((x) => !Number.isFinite(x))) return null;
  const total = inv.reduce((a, b) => a + b, 0);
  return Object.fromEntries(outcomes.map((o, i) => [o.name, inv[i] / total]));
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export interface FairOdds {
  probs: Record<string, number>; // outcome name -> probability
  source: string; // "Pinnacle" or "median of N books"
}

/** Fair win probabilities for a game, from fresh head-to-head odds only. */
export function fairOdds(game: OddsGame, nowMs: number, maxAgeMs = 30 * 60_000): FairOdds | null {
  const books: { key: string; title: string; probs: Record<string, number> }[] = [];
  for (const b of game.bookmakers ?? []) {
    const m = b.markets?.find((x) => x.key === "h2h");
    if (!m) continue;
    const updated = Date.parse(m.last_update ?? b.last_update ?? "");
    if (!(nowMs - updated <= maxAgeMs)) continue;
    const probs = devig(m.outcomes);
    if (probs) books.push({ key: b.key, title: b.title ?? b.key, probs });
  }
  const pin = books.find((b) => b.key === "pinnacle");
  if (pin) return { probs: pin.probs, source: "Pinnacle" };
  if (books.length < 2) return null;
  const names = Object.keys(books[0].probs);
  const probs = Object.fromEntries(names.map((n) => [n, median(books.map((b) => b.probs[n]).filter((x) => x !== undefined))]));
  const total = Object.values(probs).reduce((a, b) => a + b, 0);
  for (const n of names) probs[n] /= total;
  return { probs, source: `median of ${books.length} books` };
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();

/** Does Kalshi's (often abbreviated) team label refer to this full team name? "Los Angeles D" ~ "Los Angeles Dodgers". */
export function teamMatches(kalshiLabel: string, fullName: string): boolean {
  const k = norm(kalshiLabel);
  const f = norm(fullName);
  if (!k || !f) return false;
  if (f === k || f.startsWith(k + " ") || f.startsWith(k)) return true;
  // Nickname only ("Dodgers")
  return f.endsWith(" " + k);
}

/** Kalshi event-ticker date (e.g. KXMLBGAME-26OCT061800LADATL -> "26OCT06"), or null. */
export function tickerDate(eventTicker: string): string | null {
  const m = eventTicker.split("-")[1]?.match(/^(\d{2}[A-Z]{3}\d{2})/);
  return m ? m[1] : null;
}

/** The same "26OCT06" style date for a game start, in US Eastern time (how Kalshi names games). */
export function easternTickerDate(iso: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "2-digit", month: "short", day: "2-digit" })
      .formatToParts(new Date(iso))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}${String(parts.month).toUpperCase()}${parts.day}`;
}

export interface KalshiGameMarket {
  ticker: string;
  event_ticker: string;
  yes_sub_title?: string;
  [k: string]: unknown;
}

/**
 * Pair each market in a Kalshi game event with the sportsbook outcome it
 * represents. Returns null unless every team market maps to exactly one
 * outcome and both teams are covered — no guessing.
 */
export function matchGame(game: OddsGame, markets: KalshiGameMarket[]): Map<string, string> | null {
  if (!markets.length || tickerDate(markets[0].event_ticker) !== easternTickerDate(game.commence_time)) return null;
  const teams = [game.home_team, game.away_team];
  const out = new Map<string, string>(); // kalshi ticker -> outcome name
  for (const m of markets) {
    const label = String(m.yes_sub_title ?? "");
    if (/^(tie|draw)$/i.test(label.trim())) {
      out.set(m.ticker, "Draw");
      continue;
    }
    const hits = teams.filter((t) => teamMatches(label, t));
    if (hits.length !== 1) return null;
    out.set(m.ticker, hits[0]);
  }
  const covered = new Set(out.values());
  return teams.every((t) => covered.has(t)) ? out : null;
}

export interface OddsResult {
  games: OddsGame[];
  remaining: number | null;
  cost: number;
}

export async function fetchOdds(apiKey: string, sportKey: string, regions: string, fetchFn: typeof fetch = (...a) => fetch(...a)): Promise<OddsResult> {
  const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds/?apiKey=${encodeURIComponent(apiKey)}&regions=${regions}&markets=h2h&oddsFormat=decimal`;
  const r = await fetchFn(url, { signal: AbortSignal.timeout(10_000) });
  const remaining = r.headers.get("x-requests-remaining");
  const cost = Number(r.headers.get("x-requests-last") ?? regions.split(",").length);
  if (!r.ok) throw new Error(`Odds API ${r.status}: ${(await r.text()).slice(0, 150)}`);
  return { games: (await r.json()) as OddsGame[], remaining: remaining === null ? null : Number(remaining), cost };
}
