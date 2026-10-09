// Phone-friendly dashboard HTML. Everything from Kalshi is escaped.

import type { Snapshot } from "./bot.ts";
import { renderPicks } from "./picks-page.ts";

const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const money = (x: number) => `${x >= 0 ? "+" : "−"}$${Math.abs(x).toFixed(2)}`;
const cls = (x: number | null) => (x === null ? "" : x >= 0 ? "up" : "down");
const STRATEGY: Record<string, string> = { crypto: "Crypto", arb: "Arbitrage", ai: "AI", sports: "Sports" };

export function renderDashboard(snap: Snapshot, opts: { authed: boolean; passwordSet: boolean; tab?: "bot" | "picks" }): string {
  const tab = opts.tab ?? "bot";
  // During a deploy the page can update before the bot does, so tolerate
  // fields an older bot doesn't send yet instead of crashing.
  const s: Snapshot = {
    ...snap,
    horizons: (snap.horizons ?? []).map((h) => ({ ...h, short: h.short ?? h.label })),
    limits: snap.limits ?? [],
    trades: snap.trades ?? [],
    decisions: snap.decisions ?? [],
    byStrategy: snap.byStrategy ?? [],
  };
  const time = (t: number) => new Date(t * 1000).toLocaleTimeString("en-US", { timeZone: s.timezone, hour: "numeric", minute: "2-digit" });
  const date = (t: number) => new Date(t * 1000).toLocaleDateString("en-US", { timeZone: s.timezone, month: "short", day: "numeric" });
  // "today 5:30 AM", "tomorrow 5 PM" style closing times; full date further out.
  const closes = (t: number) => {
    const today = date(Date.now() / 1000);
    const tomorrow = date(Date.now() / 1000 + 86400);
    const d = date(t);
    const day = d === today ? "today" : d === tomorrow ? "tomorrow" : d;
    return `${day} ${time(t)}`;
  };
  const sum = s.summary;
  const winrate = sum.settled ? `${Math.round((100 * sum.wins) / sum.settled)}%` : "—";
  const horizonLabel = s.horizons.find((h) => h.key === s.horizon)?.label ?? s.horizon;

  const trades = s.trades.length
    ? s.trades
        .map(
          (t) => `<tr>
  <td>${esc(date(t.ts))}<br><span class="sub">${esc(time(t.ts))}</span></td>
  <td class="wrap">${esc(t.ticker)}<br><span class="sub">${esc(STRATEGY[t.strategy] ?? t.strategy)}</span></td>
  <td>${esc(t.side.toUpperCase())} ×${t.contracts} <span class="sub">@ $${t.price.toFixed(2)}</span><br><b>Bet $${t.cost.toFixed(2)}</b>${
    t.pnl === null ? `<br><span class="sub">pays $${t.contracts.toFixed(2)} if right</span>` : ""
  }</td>
  <td class="${cls(t.pnl)}">${t.pnl === null ? `open<br><span class="sub">closes ${t.close_ts ? esc(closes(t.close_ts)) : ""}</span>` : esc(money(t.pnl))}</td>
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

  const mc = s.modelCheck;
  const check =
    mc && mc.settled > 0
      ? (() => {
          const diff = mc.actualWins - mc.expectedWins;
          const verdict =
            mc.settled < 50
              ? "Too few trades to judge yet — check back after 50+."
              : diff >= 0
                ? "Winning at least as often as the model expected."
                : "Winning less often than the model expected: it's likely overconfident.";
          return `<div class="card"><div class="k">Model check (crypto)</div>
<div class="row2"><span>Expected wins</span><b>${mc.expectedWins.toFixed(1)}</b></div>
<div class="row2"><span>Actual wins</span><b class="${diff >= 0 ? "up" : "down"}">${mc.actualWins} of ${mc.settled}</b></div>
<div class="sub" style="margin-top:6px">${esc(verdict)} The model only has an edge if actual wins keep beating expected.</div></div>`;
        })()
      : "";

  const ai = s.ai;
  const pctv = (x: number | null | undefined) => (x === null || x === undefined ? "—" : `${Math.round(x * 100)}%`);
  const aiCard = !ai
    ? ""
    : `<div class="card"><div class="k">AI forecaster</div>
<div>${esc(ai.status)}</div>
<div class="sub" style="margin-top:4px">Spent today $${ai.spentToday.toFixed(2)} of $${ai.budget.toFixed(2)}${
        ai.check.settled ? ` · AI bets: expected ${ai.check.expectedWins.toFixed(1)} wins, got ${ai.check.actualWins} of ${ai.check.settled}` : ""
      }${ai.trust < 1 ? ` · trust reduced to ${Math.round(ai.trust * 100)}% (losing more than predicted)` : ""}</div>
${
  ai.forecasts.length
    ? `<table class="fc">${ai.forecasts
        .map(
          (f) => `<tr><td class="wrap"><b>${esc(f.title || f.ticker)}</b><br>
<span>AI ${esc(pctv(f.p))} · market ${esc(pctv(f.market_mid))}${f.confidence ? ` · ${esc(f.confidence)} confidence` : ""}</span><br>
<span class="${String(f.action).startsWith("bought") ? "up" : "sub"}">${esc(f.action)}</span><br>
<span class="sub">${esc(f.summary)}</span><br>
<span class="sub">${esc(time(f.ts))} · $${Number(f.cost).toFixed(2)}${f.searches ? ` · ${f.searches} searches` : ""}</span></td></tr>`,
        )
        .join("")}</table>`
    : `<div class="sub" style="margin-top:8px">No forecasts yet.</div>`
}</div>`;

  const strat = s.byStrategy.length
    ? s.byStrategy.map((b) => `<span>${esc(STRATEGY[b.strategy] ?? b.strategy)}: ${b.trades} trades, <b class="${cls(b.pnl)}">${esc(money(b.pnl))}</b></span>`).join(" · ")
    : "";

  const horizonPicker = opts.authed
    ? `<form method="post" action="/horizon" class="seg">${s.horizons
        .map((h) => `<button name="horizon" value="${esc(h.key)}" class="${h.key === s.horizon ? "on" : ""}">${esc(h.short)}</button>`)
        .join("")}</form>`
    : `<div class="v small">${esc(horizonLabel)}</div>`;

  const mw = s.modelWeight;
  const pct = (w: number) => `${Math.round(w * 100)}%`;
  const modelCard = !mw
    ? ""
    : `<div class="card"><div class="k">Trust in the bot's own estimates</div>${
        opts.authed
          ? `<form method="post" action="/model" class="seg">${mw.options
              .map((w) => `<button name="weight" value="${w}" class="${Math.abs(w - mw.value) < 1e-9 ? "on" : ""}">${pct(w)}</button>`)
              .join("")}</form>`
          : `<div class="v small">${pct(mw.value)}</div>`
      }<div class="sub" style="margin-top:8px">Applies to the crypto model and the AI. Lower blends their estimates more toward the market's price, so the bot trades less and only on bigger disagreements. 100% trusts them alone. Default ${pct(mw.dflt)}.</div></div>`;

  const view = s.view ?? s.mode;
  const views = s.views ?? [s.mode];
  const MODE: Record<string, string> = { paper: "Paper", demo: "Demo", live: "Live" };
  const viewSwitch =
    views.length > 1
      ? `<div class="seg views">${views
          .map((v) => `<a href="/?view=${esc(v)}" class="${v === view ? "on" : ""}">${esc(MODE[v] ?? v)} results</a>`)
          .join("")}</div>`
      : "";

  // Paper/live is chosen per strategy in the Strategies card below.
  const modeCard = "";

  const pr = s.priceRange;
  const cents = (x: number) => Math.round(x * 100);
  const priceCard = !pr
    ? ""
    : `<div class="card"><div class="k">Bet price range</div>${
        opts.authed
          ? `<form method="post" action="/prices" class="limits">
<label><span><b>Lowest</b><br><span class="sub">Skip long shots below this</span></span><span class="dollar"><input name="min" type="number" inputmode="numeric" min="1" max="98" step="1" value="${cents(pr.min)}">¢</span></label>
<label><span><b>Highest</b><br><span class="sub">Skip near-sure things above this</span></span><span class="dollar"><input name="max" type="number" inputmode="numeric" min="2" max="99" step="1" value="${cents(pr.max)}">¢</span></label>
<button class="go">Save range</button></form>`
          : `<div class="v small">${cents(pr.min)}¢ – ${cents(pr.max)}¢</div>`
      }<div class="sub" style="margin-top:8px">Only buys contracts priced inside this range. Default ${cents(pr.dfltMin)}–${cents(pr.dfltMax)}¢.</div></div>`;

  const since = s.testSince ?? 0;
  const sinceLabel = since ? `${date(since)} ${time(since)}` : "";
  const testBar = !since
    ? ""
    : `<div class="card test">${
        s.showingAll
          ? `Showing <b>all history</b>. <a href="/">Back to the current test</a>`
          : `Stats count trades since the <b>fresh test started ${esc(sinceLabel)}</b>. <a href="/?all=1">Show all history</a>`
      }${
        opts.authed
          ? `<form method="post" action="/fresh-test" style="margin-top:8px"><button class="link">Start a new fresh test now</button></form>`
          : ""
      }</div>`;

  const sw = s.switches ?? [];
  const anyLive = sw.some((x) => x.mode && x.mode !== "paper");
  const goLiveForm = (strategy: string, label: string) =>
    s.canGoLive === false
      ? `<div class="sub">Deployed in demo mode: change BOT_MODE in wrangler.jsonc.</div>`
      : s.keysSet === false
        ? `<div class="sub">Add your Kalshi API key secrets to go live.</div>`
        : `<details><summary>Go live with ${esc(label)}</summary>
<form method="post" action="/mode" class="golive"><input type="hidden" name="mode" value="live"><input type="hidden" name="strategy" value="${esc(strategy)}">
<p class="sub">${esc(label)} will place real orders on Kalshi with your account balance, within your spending limits. The other strategies keep doing whatever they're set to. The kill switch or "Switch to paper" stops it instantly.</p>
<input type="password" name="password" placeholder="Dashboard password" autocomplete="current-password" required>
<label class="check"><input type="checkbox" name="confirm" value="yes" required> I understand this trades real money and I can lose it</label>
<button class="stop">Go live with ${esc(label)}</button></form></details>`;
  const switchCard = !sw.length
    ? ""
    : `<div class="card${anyLive ? " live-card" : ""}"><div class="k">Strategies</div>${sw
        .map((x) => {
          const live = x.mode && x.mode !== "paper";
          const badge = `<span class="pill ${live ? "live" : "paper"}">${live ? "LIVE" : "PAPER"}</span>`;
          const toggle = opts.authed
            ? `<form method="post" action="/strategy"><input type="hidden" name="key" value="${esc(x.key)}"><input type="hidden" name="on" value="${x.on ? "off" : "on"}"><button class="${x.on ? "pill-on" : "pill-off"}">${x.on ? "On" : "Off"}</button></form>`
            : `<b class="${x.on ? "up" : "sub"}">${x.on ? "On" : "Off"}</b>`;
          const modeCtl = !opts.authed || !x.mode
            ? ""
            : live
              ? `<form method="post" action="/mode"><input type="hidden" name="mode" value="paper"><input type="hidden" name="strategy" value="${esc(x.strategy)}"><button class="link">Switch ${esc(x.label)} to paper</button></form>`
              : goLiveForm(x.strategy, x.label);
          return `<div class="strow"><div class="row2 sw"><span>${esc(x.label)} ${x.mode ? badge : ""}</span>${toggle}</div>${modeCtl}</div>`;
        })
        .join("")}<div class="sub" style="margin-top:6px">On/Off starts or stops a strategy. PAPER/LIVE picks simulated or real money for it. Open bets stay open and settle normally.</div>${
        opts.authed && anyLive
          ? `<form method="post" action="/mode" style="margin-top:10px"><input type="hidden" name="mode" value="paper"><input type="hidden" name="strategy" value="all"><button class="go">Switch everything back to paper</button></form>`
          : ""
      }</div>`;

  const sp = s.sports;
  const sportsCard = !sp
    ? ""
    : `<div class="card"><div class="k">Sports vs sportsbooks</div>
<div>${esc(sp.status)}</div>
<div class="sub" style="margin-top:4px">Odds credits today ${sp.creditsToday} of ${sp.creditBudget}${sp.remaining !== null ? ` · ${sp.remaining} left on your Odds API plan` : ""}${
        sp.check.settled ? ` · Sports bets: expected ${sp.check.expectedWins.toFixed(1)} wins, got ${sp.check.actualWins} of ${sp.check.settled}` : ""
      }</div>
${
  sp.games.length
    ? `<table class="fc">${sp.games
        .map(
          (g) => `<tr><td class="wrap"><b>${esc(g.game)}</b> <span class="sub">${esc(date(Date.parse(g.start) / 1000))} ${esc(time(Date.parse(g.start) / 1000))}</span><br>
${g.books ? `<span>Books: ${esc(g.books)} · Kalshi: ${esc(g.kalshi)}</span><br>` : ""}<span class="${String(g.action).startsWith("bought") ? "up" : "sub"}">${esc(g.action)}</span> <span class="sub">(${esc(g.source)})</span></td></tr>`,
        )
        .join("")}</table>`
    : ""
}</div>`;

  // Paper and live each get their own limits; AI spend is shared (real money either way).
  type LimitRow = Snapshot["limits"][number];
  const limitForm = (rows: LimitRow[], set: string | null) =>
    opts.authed
      ? `<form method="post" action="/limits" class="limits">${set ? `<input type="hidden" name="set" value="${set}">` : ""}${rows
          .map(
            (l) => `<label><span><b>${esc(l.label)}</b><br><span class="sub">${esc(l.help)}</span></span>
  <span class="dollar">$<input name="${esc(l.key)}" type="number" inputmode="decimal" min="0.01" step="0.01" value="${l.value}"></span></label>`,
          )
          .join("")}<button class="go">Save ${set ? `${set} limits` : "limit"}</button></form>
<form method="post" action="/limits">${set ? `<input type="hidden" name="set" value="${set}">` : ""}<input type="hidden" name="reset" value="1"><button class="link">Reset ${set ?? "AI limit"} to defaults</button></form>`
      : `<div class="limits">${rows.map((l) => `<div class="row"><span>${esc(l.label)}</span><b>$${l.value.toFixed(2)}</b></div>`).join("")}</div>`;
  const byMode = s.limitsByMode;
  const limitsCard = byMode
    ? `<div class="k" style="margin-top:4px">Live (real money)</div>${limitForm(byMode.live, "live")}
<div class="k" style="margin-top:22px">Paper (practice)</div>${limitForm(byMode.paper, "paper")}
${s.limits.length ? `<div class="k" style="margin-top:22px">Shared</div>${limitForm(s.limits, null)}` : ""}`
    : limitForm(s.limits, null);

  const botBody = `<div class="card"><div class="k">Now</div><div>${esc(s.status)}</div>
${s.problem ? `<div class="err">${esc(s.problem)}</div>` : ""}
${
  s.kalshiCash
    ? `<div class="sub" style="margin-top:8px">Kalshi cash available to the bot: <b>${s.kalshiCash.value === null ? "not read yet" : `$${s.kalshiCash.value.toFixed(2)}`}</b>${
        s.kalshiCash.at ? ` (checked ${esc(time(s.kalshiCash.at))})` : ""
      }${
        s.kalshiCash.byIndex && Object.keys(s.kalshiCash.byIndex).length > 1
          ? `<br>Split by exchange shard: ${Object.entries(s.kalshiCash.byIndex)
              .map(([i, v]) => `#${esc(i)} $${Number(v).toFixed(2)}`)
              .join(" · ")}. A bet can only use the cash on its own market's shard.`
          : ""
      }${s.kalshiCash.error ? ` · couldn't read it: ${esc(s.kalshiCash.error)}` : ""}</div>`
    : ""
}
${s.lastError ? `<div class="err">Last error: ${esc(s.lastError)}</div>` : ""}</div>

${modeCard}

${switchCard}

<div class="card"><div class="k">Only trade markets that close</div>${horizonPicker}</div>

${modelCard}

${priceCard}

${s.limits.length || s.limitsByMode ? `<div class="card"><div class="k">Spending limits</div>${limitsCard}</div>` : ""}

${testBar}
${viewSwitch}
<div class="grid">
 <div class="card"><div class="k">Total P&amp;L</div><div class="v ${cls(sum.pnl)}">${esc(money(sum.pnl))}</div></div>
 <div class="card"><div class="k">Today</div><div class="v ${cls(s.today)}">${esc(money(s.today))}</div></div>
 <div class="card"><div class="k">Win rate</div><div class="v">${winrate}</div><div class="sub">${sum.settled} settled</div></div>
 <div class="card"><div class="k">Open risk</div><div class="v">$${sum.openCost.toFixed(2)}</div><div class="sub">fees paid $${sum.fees.toFixed(2)}</div></div>
</div>
${strat ? `<div class="strat">${strat}</div>` : ""}
${check}
${aiCard}
${sportsCard}

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
`;

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<noscript><meta http-equiv="refresh" content="20"></noscript>
<title>${tab === "picks" ? "PrizePicks Finder" : "Kalshi Bot"}</title>
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
.limits label,.limits .row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid var(--line)}
.limits .dollar{display:flex;align-items:center;gap:4px;font-weight:600}
.limits input{width:96px;margin:0;text-align:right}
.limits button.go{margin-top:12px}
.msg{border-color:var(--accent);font-weight:600}
.live-card{border-color:var(--down)}
details summary{cursor:pointer;color:var(--down);font-weight:600;margin-top:10px}
.golive p{margin:10px 0}
.check{display:flex;gap:8px;align-items:flex-start;font-size:14px;margin:4px 0 12px}
.check input{width:auto;margin:3px 0 0}
.views{margin-top:16px}.views a{flex:1;text-align:center;padding:9px 6px;border:1px solid var(--line);border-radius:10px;color:var(--ink);text-decoration:none;font-size:13px;font-weight:600}
.views a.on{background:var(--accent);border-color:var(--accent);color:#fff}
.fc td{padding:10px 0}
.strow{border-bottom:1px solid var(--line);padding:4px 0 8px}.strow details summary{margin-top:2px;font-size:14px}
.strow form .link{font-size:13px;padding:2px 0}
.sw{align-items:center;padding:6px 0 2px}.sw form{margin:0}
.sw button{width:auto;padding:6px 18px;border-radius:99px;font-size:13px}
.pill-on{background:var(--up);color:#fff}.pill-off{background:var(--bg);color:var(--mute);border:1px solid var(--line)}
.row2{display:flex;justify-content:space-between;padding:4px 0}
.test{font-size:14px}.test a{color:var(--accent)}
.top{display:flex;align-items:center;justify-content:space-between;gap:12px}
.top form{margin:0}button.link{background:none;color:var(--accent);padding:6px 0;width:auto;font-weight:600;font-size:14px}
.strat{font-size:13px;color:var(--mute);margin-top:4px}.strat b{font-weight:600}
.tabs{margin-top:12px}
.slip{border-top:1px solid var(--line);padding:10px 0}.slip:first-of-type{border-top:0}
.slip ol{margin:6px 0 0;padding-left:20px}.slip li{margin:3px 0}
.pk td{padding:9px 4px;word-break:normal;overflow-wrap:anywhere}.pk .side{font-weight:700}
.more{color:var(--up)}.less{color:var(--accent)}
.pp-ctl{display:flex;gap:8px;margin-top:10px}.pp-ctl form{flex:1;margin:0}
.shot-form{margin-top:10px}.shot-form input[type=file]{padding:10px;background:var(--bg)}
.shot-form button:disabled{opacity:.7}
</style></head><body><main>
<div class="top"><h1>Kalshi Bot <span class="pill ${esc(s.mode)}">${esc(s.mode === "paper" ? "PAPER" : `LIVE: ${(s.switches ?? []).filter((x) => x.mode && x.mode !== "paper").map((x) => x.label).join(", ") || "on"}`)}</span></h1>${
  opts.authed ? `<form method="post" action="/logout"><button class="link">Sign out</button></form>` : ""
}</div>
<div class="sub">${s.alive ? `<span class="up">● running</span>` : `<span class="down">● not running</span>`}${s.killSwitch ? ` · <span class="warn">kill switch on</span>` : ""}</div>
<div class="seg views tabs"><a href="/" class="${tab === "bot" ? "on" : ""}">Kalshi bot</a><a href="/?tab=picks" class="${tab === "picks" ? "on" : ""}">PrizePicks</a></div>

${s.message ? `<div class="card msg">${esc(s.message)}</div>` : ""}

${tab === "picks" ? renderPicks(s, opts, { esc, date, time }) : botBody}

${
  opts.passwordSet && !opts.authed
    ? `<h2>Sign in to make changes</h2><form method="post" action="/login"><input type="password" name="password" placeholder="Dashboard password" autocomplete="current-password"><button class="go">Sign in</button></form>`
    : ""
}
</main>
<script>
// Refresh every 20s to stay current, but never while you're typing in a form:
// a reload would throw away numbers you haven't saved yet.
(function () {
  var dirty = false, last = Date.now();
  document.addEventListener("input", function (e) { if (e.target && e.target.form) dirty = true; });
  document.addEventListener("submit", function () { dirty = false; });
  function editing() {
    var a = document.activeElement;
    return dirty || (a && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName));
  }
  setInterval(function () {
    if (document.hidden || editing() || Date.now() - last < 20000) return;
    location.reload();
  }, 2000);
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && !editing() && Date.now() - last >= 20000) location.reload();
  });
})();
</script>
</body></html>`;
}
