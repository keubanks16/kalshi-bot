// The dashboard's PrizePicks tab. Finder only: it never places entries.

import type { Snapshot } from "./bot.ts";
import { breakEven, type Pick } from "./prizepicks.ts";

type Fmt = { esc: (v: unknown) => string; date: (t: number) => string; time: (t: number) => string };

const pct = (p: number) => `${Math.round(p * 100)}%`;
const signedPct = (x: number) => `${x >= 0 ? "+" : "−"}${Math.abs(Math.round(x * 100))}%`;

export function renderPicks(s: Snapshot, opts: { authed: boolean }, f: Fmt): string {
  const { esc, date, time } = f;
  const pp = s.picks;
  if (!pp) return `<div class="card"><div class="sub">The bot is still on the previous version and hasn't picked up the PrizePicks update yet. Refresh in a minute; if this stays for more than a few minutes, deploy again.</div></div>`;
  const v = pp.view;
  const when = (iso: string) => {
    const t = Date.parse(iso) / 1000;
    return Number.isFinite(t) ? `${date(t)} ${time(t)}` : "";
  };
  // A pick is worth highlighting when it beats the 2-pick power break-even.
  const bar = pp.payouts[2] ? breakEven(2, pp.payouts[2]) : 0.577;

  const status = !pp.keySet
    ? "Off: add the ODDS_API_KEY secret (the-odds-api.com) — the same key your Kalshi sports strategy uses."
    : !pp.on
      ? "Off."
      : (v?.status ?? (pp.intervalMinutes > 0 ? "Waiting for the first check (runs within a minute)…" : "Tap Check now to look for picks."));

  const controls = opts.authed
    ? `<div class="pp-ctl">${
        pp.on
          ? `<form method="post" action="/picks"><input type="hidden" name="action" value="refresh"><button class="go">Check now</button></form>
<form method="post" action="/picks"><input type="hidden" name="action" value="off"><button class="pill-off">Turn off</button></form>`
          : `<form method="post" action="/picks"><input type="hidden" name="action" value="on"><button class="go">Turn on</button></form>`
      }</div>`
    : "";

  const head = `<div class="card"><div class="k">PrizePicks finder</div>
<div>${esc(status)}</div>
<div class="sub" style="margin-top:4px">${v?.ts ? `Last checked ${esc(date(v.ts))} ${esc(time(v.ts))} · ` : ""}${pp.intervalMinutes > 0 ? "" : "Checks only when you tap Check now · "}Odds credits today ${pp.creditsToday} of ${pp.creditBudget}${
    pp.remaining !== null ? ` · ${pp.remaining} left on your Odds API plan` : ""
  }</div>
<div class="sub" style="margin-top:4px">Finds picks only. You place them yourself in the PrizePicks app.</div>${controls}</div>`;

  const pickLine = (p: Pick) =>
    `<b>${esc(p.player)}</b> <span class="side ${p.side === "More" ? "more" : "less"}">${esc(p.side)} ${esc(p.line)}</span> ${esc(p.stat)} <span class="sub">· ${esc(p.exact ? "" : "≥")}${esc(pct(p.p))}</span>`;

  const slips = v?.slips?.length
    ? `<div class="card"><div class="k">Best power plays</div>${v.slips
        .map(
          (sl) => `<div class="slip"><div class="row2"><b>${sl.size}-pick power · pays ${esc(sl.payout)}x</b><b class="${sl.ev >= 0 ? "up" : "down"}">${esc(signedPct(sl.ev))} EV</b></div>
<div class="sub">Needs ${esc(pct(sl.breakEven))} per pick to break even${sl.ev < 0 ? " — these picks fall short, so skip this size" : ""}</div>
<ol>${sl.picks.map((p) => `<li>${pickLine(p)}</li>`).join("")}</ol></div>`,
        )
        .join("")}<div class="sub" style="margin-top:6px">One pick per game, since picks from the same game tend to win or lose together. EV is expected profit per $1 entered, from the sportsbooks' odds. Set PRIZEPICKS_POWER_PAYOUTS to match the payouts your app shows.</div></div>`
    : "";

  const rows = v?.picks?.length
    ? v.picks
        .map(
          (p) => `<tr><td><b>${esc(p.player)}</b><br><span class="sub">${esc(p.team)}${p.opponent ? ` vs ${esc(p.opponent)}` : ""} · ${esc(when(p.start))}</span></td>
<td><span class="side ${p.side === "More" ? "more" : "less"}">${esc(p.side)} ${esc(p.line)}</span><br><span class="sub">${esc(p.stat)}</span></td>
<td><b class="${p.p >= bar ? "up" : ""}">${esc(p.exact ? "" : "≥")}${esc(pct(p.p))}</b><br><span class="sub">${p.books} book${p.books === 1 ? "" : "s"}${p.exact ? "" : ` at ${esc(p.bookLine)}`}</span></td></tr>`,
        )
        .join("")
    : `<tr><td colspan="3" class="sub">${pp.on && pp.keySet ? "No priced picks yet." : "Turn the finder on to see picks."}</td></tr>`;

  const table = `<div class="card"><div class="k">Top picks by sportsbook odds</div>
<table class="pk">${rows}</table>
<div class="sub" style="margin-top:8px">Chance the pick hits, from the sportsbooks' over/under odds with their margin removed (median across books). Green beats the ${esc(pct(bar))} a 2-pick power play needs. "≥" means no book had PrizePicks' exact line, so the number is a safe minimum from a book line further out. Only standard lines are checked (no goblins or demons).</div></div>`;

  return `${head}\n${slips}\n${table}`;
}
