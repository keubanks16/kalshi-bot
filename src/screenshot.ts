// Reads a PrizePicks screenshot with Claude. Claude only READS the image
// (player, stat, line, goblin/demon, teams); it never guesses chances. The
// chances come from sportsbook odds, priced by PicksScanner.checkShot.

import { costOf, type AiConfig } from "./ai.ts";

export interface ShotPick {
  league: string; // as shown, e.g. "WNBA", "MLB", "CFB"
  player: string;
  stat: string; // as shown, e.g. "3PTM", "Hits+Runs+RBIs"
  line: number;
  kind: "standard" | "goblin" | "demon";
  sides: ("more" | "less")[]; // buttons the card offers
  matchup: string; // as shown, e.g. "ATL vs NYL"
  teams: string[]; // full team names, e.g. ["Atlanta Dream", "New York Liberty"]
  when: string; // as shown, e.g. "Fri 7:30pm"
}

const PROMPT = `This is a screenshot from the PrizePicks app. List every player projection card you can see.

For each card report:
- league: the league badge exactly as shown (e.g. NFL, CFB, NBA, WNBA, MLB, NHL, CBB)
- player: the player's name
- stat: the stat exactly as shown (e.g. "Pass Yards", "3PTM", "PRA", "Hits+Runs+RBIs")
- line: the number
- kind: "demon" if a red devil icon is next to the line, "goblin" if a green goblin icon is, otherwise "standard"
- sides: which buttons the card shows: ["more","less"], or ["more"] if only More is offered
- matchup: the game text exactly as shown (e.g. "ATL vs NYL")
- teams: the two teams' full names for that league (e.g. ["Atlanta Dream", "New York Liberty"]); [] if you can't tell
- when: the game time exactly as shown

Only report what is visible. Do not estimate chances or give advice.

Report the cards by calling the report_picks tool once. If you can't use the tool, reply with only the JSON object {"picks": [...]} instead.`;

const TOOL = {
  name: "report_picks",
  description: "Report the PrizePicks projection cards visible in the screenshot.",
  input_schema: {
    type: "object",
    properties: {
      picks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            league: { type: "string" },
            player: { type: "string" },
            stat: { type: "string" },
            line: { type: "number" },
            kind: { type: "string", enum: ["standard", "goblin", "demon"] },
            sides: { type: "array", items: { type: "string", enum: ["more", "less"] } },
            matchup: { type: "string" },
            teams: { type: "array", items: { type: "string" } },
            when: { type: "string" },
          },
          required: ["league", "player", "stat", "line", "kind", "sides"],
        },
      },
    },
    required: ["picks"],
  },
};

/** Keep only well-formed picks from Claude's tool input. */
export function cleanPicks(raw: any): ShotPick[] {
  const out: ShotPick[] = [];
  for (const p of raw?.picks ?? []) {
    const line = Number(p?.line);
    const player = String(p?.player ?? "").trim();
    if (!player || !Number.isFinite(line)) continue;
    const sides = (Array.isArray(p.sides) ? p.sides : []).filter((s: unknown) => s === "more" || s === "less");
    out.push({
      league: String(p.league ?? "").trim().toUpperCase(),
      player,
      stat: String(p.stat ?? "").trim(),
      line,
      kind: p.kind === "goblin" || p.kind === "demon" ? p.kind : "standard",
      sides: sides.length ? sides : ["more", "less"],
      matchup: String(p.matchup ?? ""),
      teams: (Array.isArray(p.teams) ? p.teams : []).map(String).filter(Boolean).slice(0, 2),
      when: String(p.when ?? ""),
    });
  }
  return out.slice(0, 20);
}

export async function readScreenshot(
  imageBase64: string,
  mediaType: string,
  cfg: Pick<AiConfig, "apiKey" | "model" | "inputPricePerM" | "outputPricePerM">,
  fetchFn: typeof fetch = (...a) => fetch(...a),
): Promise<{ picks: ShotPick[]; cost: number }> {
  const resp = await fetchFn("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: 2000,
      // Some models don't allow forcing a tool, so offer it and also accept plain JSON.
      tools: [TOOL],
      tool_choice: { type: "auto" },
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 } },
            { type: "text", text: PROMPT },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = await resp.text();
  if (!resp.ok) throw new Error(`Claude API ${resp.status}: ${body.slice(0, 200)}`);
  const data = JSON.parse(body);
  const { cost } = costOf(data.usage ?? {}, cfg);
  const use = (data.content ?? []).find((b: any) => b.type === "tool_use" && b.name === TOOL.name);
  if (use) return { picks: cleanPicks(use.input), cost };
  const text = (data.content ?? [])
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("");
  const parsed = picksFromText(text);
  if (!parsed) throw new Error("Claude didn't list the picks it saw. Try a clearer screenshot.");
  return { picks: cleanPicks(parsed), cost };
}

/** The {"picks": [...]} object from a plain-text reply (possibly inside a code block), or null. */
export function picksFromText(text: string): { picks: unknown[] } | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const j = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(j?.picks) ? j : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------- league and stat maps

/** PrizePicks league badge -> The Odds API sport key. */
export const LEAGUE_SPORT: Record<string, string> = {
  NFL: "americanfootball_nfl",
  CFB: "americanfootball_ncaaf",
  NCAAF: "americanfootball_ncaaf",
  NBA: "basketball_nba",
  WNBA: "basketball_wnba",
  CBB: "basketball_ncaab",
  NCAAB: "basketball_ncaab",
  MLB: "baseball_mlb",
  NHL: "icehockey_nhl",
};

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
};
const BASKETBALL: Record<string, string> = {
  points: "player_points",
  pts: "player_points",
  rebounds: "player_rebounds",
  rebs: "player_rebounds",
  assists: "player_assists",
  asts: "player_assists",
  pra: "player_points_rebounds_assists",
  ptsrebsasts: "player_points_rebounds_assists",
  pr: "player_points_rebounds",
  ptsrebs: "player_points_rebounds",
  pa: "player_points_assists",
  ptsasts: "player_points_assists",
  ra: "player_rebounds_assists",
  rebsasts: "player_rebounds_assists",
  "3ptm": "player_threes",
  "3ptmade": "player_threes",
  "3pointersmade": "player_threes",
  blockedshots: "player_blocks",
  blocks: "player_blocks",
  steals: "player_steals",
  turnovers: "player_turnovers",
};
const BASEBALL: Record<string, string> = {
  pitcherstrikeouts: "pitcher_strikeouts",
  strikeouts: "pitcher_strikeouts",
  hitsallowed: "pitcher_hits_allowed",
  earnedrunsallowed: "pitcher_earned_runs",
  walksallowed: "pitcher_walks",
  pitchingouts: "pitcher_outs",
  totalbases: "batter_total_bases",
  hits: "batter_hits",
  runs: "batter_runs_scored",
  rbis: "batter_rbis",
  hitsrunsrbis: "batter_hits_runs_rbis",
  homeruns: "batter_home_runs",
  singles: "batter_singles",
  stolenbases: "batter_stolen_bases",
  walks: "batter_walks",
};
const HOCKEY: Record<string, string> = {
  shotsongoal: "player_shots_on_goal",
  sog: "player_shots_on_goal",
  points: "player_points",
  goals: "player_goals",
  assists: "player_assists",
  goaliesaves: "player_total_saves",
  saves: "player_total_saves",
  blockedshots: "player_blocked_shots",
};
const STATS_BY_SPORT: Record<string, Record<string, string>> = {
  americanfootball_nfl: FOOTBALL,
  americanfootball_ncaaf: FOOTBALL,
  basketball_nba: BASKETBALL,
  basketball_wnba: BASKETBALL,
  basketball_ncaab: BASKETBALL,
  baseball_mlb: BASEBALL,
  icehockey_nhl: HOCKEY,
};

/** The Odds API market for a PrizePicks stat in a sport, or null if no sportsbook market prices it. */
export function marketFor(sport: string, stat: string): string | null {
  return STATS_BY_SPORT[sport]?.[stat.toLowerCase().replace(/[^a-z0-9]/g, "")] ?? null;
}
