// Phone-friendly dashboard HTML. Everything from Kalshi is escaped.

import type { Snapshot } from "./bot.ts";

const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const money = (x: number) => `${x >= 0 ? "+" : "−"}$${Math.abs(x).toFixed(2)}`;
const cls = (x: number | null) => (x === null ? "" : x >= 0 ? "up" : "down");
const STRATEGY: Record<string, string> = { crypto: "Crypto", arb: "Arbitrage" };

export function renderDashboard(s: Snapshot, opts: { authed: boolean; passwordSet: boolean }): string {
  const time = (t: number) => new Date(t * 1000).toLocaleTimeString("en-US", { timeZone: s.timezone, hour: "numeric", minute: "2-digit" });
  const date = (t: number) => new Date(t * 1000).toLocaleDateString("en-US", { timeZone: s.timezone, month: "short", day: "numeric" });
  const sum = s.summary;
  const winrate = sum.settled ? `${Math.round((100 * sum.wins) / sum.settled)}%` : "—";
  const horizonLabel = s.horizons.find((h) => h.key === s.horizon)?.label ?? s.horizon;

  const trades = s.trades.length
    ? s.trades
        .map(
          (t) => `<tr>
  <td>${esc(date(t.ts))}<br><span class="sub">${esc(time(t.ts))}</span></td>
  <td class="wrap">${esc(t.ticker)}<br><span class="sub">${esc(STRATEGY[t.strategy] ?? t.strategy)}</span></td>
  <td>${esc(t.side.toUpperCase())} ×${t.contracts}<br><span class="sub">@ $${t.price.toFixed(2)}</span></td>
  <td class="${cls(t.pnl)}">${t.pnl === null ? `open<br><span class="sub">closes ${t.close_ts ? esc(date(t.close_ts)) : ""}</span>` : esc(money(t.pnl))}</td>
</tr>`,
        )
        .join("")
    : `<tr><td colspan="4" class="sub">No trades yet.</td></tr>`;

  const decisions = s.decisions.length
    ? s.decisions
        .map(
          (d) => `<tr>
  <td>${esc(time(d.ts))}</td>
  <td class="wrap"><b>${esc(STRATEGY[d.strategy] ?? d.strategy)}</b> · ${esc(d.ticker)}<br><span class="sub">${esc(d.reason)}</span></td>
</tr>`,
        )
        .join("")
    : `<tr><td colspan="2" class="sub">Nothing logged yet.</td></tr>`;

  const strat = s.byStrategy.length
    ? s.byStrategy.map((b) => `<span>${esc(STRATEGY[b.strategy] ?? b.strategy)}: ${b.trades} trades, <b class="${cls(b.pnl)}">${esc(money(b.pnl))}</b></span>`).join(" · ")
    : "";

  const horizonPicker = opts.authed
    ? `<form method="post" action="/horizon" class="seg">${s.horizons
        .map((h) => `<button name="horizon" value="${esc(h.key)}" class="${h.key === s.horizon ? "on" : ""}">${esc(h.label.replace("Within ", "").replace("an ", "1 ").replace("a ", "1 "))}</button>`)
        .join("")}</form>`
    : `<div class="v small">${esc(horizonLabel)}</div>`;

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="20">
<title>Kalshi Bot</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#14171c;--mute:#6b7280;--line:#e5e7eb;--up:#0f8a4f;--down:#c2261d;--accent:#2f5bea;--warn:#b45309}
@media (prefers-color-scheme:dark){:root{--bg:#0d0f12;--card:#171a1f;--ink:#e8eaed;--mute:#9aa0a6;--line:#262a31;--up:#34c77b;--down:#ff6b5e;--accent:#7b9bff;--warn:#f0a43a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.4 -apple-system,system-ui,Segoe UI,Roboto,sans-serif}
main{max-width:720px;margin:0 auto;padding:16px}
h1{font-size:20px;margin:4px 0 2px}.sub{color:var(--mute);font-size:12px}
.pill{display:inline-block;padding:2px 9px;border-radius:99px;font-size:12px;font-weight:600;letter-spacing:.03em;vertical-align:middle}
.paper{background:#e0e7ff;color:#3730a3}.demo{background:#fef3c7;color:#92400e}.live{background:#fee2e2;color:#991b1b}
.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin:12px 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin-top:12px}
.grid .card{margin:0}
.k{color:var(--mute);font-size:12px;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px}
.v{font-size:22px;font-weight:650;font-variant-numeric:tabular-nums}.v.small{font-size:16px;font-weight:550}
.up{color:var(--up)}.down{color:var(--down)}.warn{color:var(--warn)}
.err{font-size:13px;color:var(--down);margin-top:6px;word-break:break-word}
table{width:100%;border-collapse:collapse;font-size:13px;font-variant-numeric:tabular-nums}
td{text-align:left;padding:8px 4px;border-bottom:1px solid var(--line);vertical-align:top}
td.wrap{word-break:break-all}h2{font-size:15px;margin:20px 0 6px}
button{font:inherit;font-weight:600;border:0;border-radius:10px;padding:12px;width:100%;cursor:pointer}
.stop{background:var(--down);color:#fff}.go{background:var(--up);color:#fff}
.seg{display:flex;gap:6px;flex-wrap:wrap}.seg button{flex:1;min-width:56px;padding:10px 6px;background:var(--bg);color:var(--ink);border:1px solid var(--line);font-size:13px}
.seg button.on{background:var(--accent);color:#fff;border-color:var(--accent)}
input{font:inherit;padding:10px;border:1px solid var(--line);border-radius:10px;width:100%;margin-bottom:8px;background:var(--card);color:var(--ink)}
.strat{font-size:13px;color:var(--mute);margin-top:4px}.strat b{font-weight:600}
</style></head><body><main>
<h1>Kalshi Bot <span class="pill ${esc(s.mode)}">${esc(s.mode.toUpperCase())}</span></h1>
<div class="sub">${s.alive ? `<span class="up">● running</span>` : `<span class="down">● not running</span>`}${s.killSwitch ? ` · <span class="warn">kill switch on</span>` : ""}</div>

<div class="card"><div class="k">Now</div><div>${esc(s.status)}</div>
${s.problem ? `<div class="err">${esc(s.problem)}</div>` : ""}
${s.lastError ? `<div class="err">Last error: ${esc(s.lastError)}</div>` : ""}</div>

<div class="card"><div class="k">Only trade markets that close</div>${horizonPicker}</div>

<div class="grid">
 <div class="card"><div class="k">Total P&amp;L</div><div class="v ${cls(sum.pnl)}">${esc(money(sum.pnl))}</div></div>
 <div class="card"><div class="k">Today</div><div class="v ${cls(s.today)}">${esc(money(s.today))}</div></div>
 <div class="card"><div class="k">Win rate</div><div class="v">${winrate}</div><div class="sub">${sum.settled} settled</div></div>
 <div class="card"><div class="k">Open risk</div><div class="v">$${sum.openCost.toFixed(2)}</div><div class="sub">fees paid $${sum.fees.toFixed(2)}</div></div>
</div>
${strat ? `<div class="strat">${strat}</div>` : ""}

${
  opts.authed
    ? `<form method="post" action="/kill" style="margin-top:14px"><input type="hidden" name="on" value="${s.killSwitch ? "off" : "on"}">${
        s.killSwitch ? `<button class="go">Resume trading</button>` : `<button class="stop">Stop trading (kill switch)</button>`
      }</form>`
    : opts.passwordSet
      ? ""
      : `<div class="sub warn" style="margin-top:12px">Add a DASHBOARD_PASSWORD secret to change settings and use the kill switch here.</div>`
}

<h2>Trades</h2><table>${trades}</table>
<h2>What the bot is seeing</h2><table>${decisions}</table>

${
  opts.passwordSet && !opts.authed
    ? `<h2>Sign in to make changes</h2><form method="post" action="/login"><input type="password" name="password" placeholder="Dashboard password" autocomplete="current-password"><button class="go">Sign in</button></form>`
    : ""
}
</main></body></html>`;
}
