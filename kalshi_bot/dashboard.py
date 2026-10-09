"""Phone-friendly dashboard. Reads the same SQLite file the bot writes.

If DASHBOARD_PASSWORD is set, the page requires a login and the kill switch
works. Without a password the page is read-only.
"""

from __future__ import annotations

import hmac
import time
from datetime import datetime

from flask import Flask, redirect, render_template_string, request, session, url_for

from .config import Settings
from .engine import TZ
from .store import Store

PAGE = """<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="15">
<title>Kalshi Bot</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#14171c;--mute:#6b7280;--line:#e5e7eb;--up:#0f8a4f;--down:#c2261d;--accent:#2f5bea;--warn:#b45309}
@media (prefers-color-scheme:dark){:root{--bg:#0d0f12;--card:#171a1f;--ink:#e8eaed;--mute:#9aa0a6;--line:#262a31;--up:#34c77b;--down:#ff6b5e;--accent:#7b9bff;--warn:#f0a43a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.4 -apple-system,system-ui,Segoe UI,Roboto,sans-serif}
main{max-width:720px;margin:0 auto;padding:16px}
h1{font-size:20px;margin:4px 0 2px}.sub{color:var(--mute);font-size:13px;margin-bottom:14px}
.pill{display:inline-block;padding:2px 9px;border-radius:99px;font-size:12px;font-weight:600;letter-spacing:.03em}
.paper{background:#e0e7ff;color:#3730a3}.demo{background:#fef3c7;color:#92400e}.live{background:#fee2e2;color:#991b1b}
.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px}
.k{color:var(--mute);font-size:12px;text-transform:uppercase;letter-spacing:.05em}.v{font-size:22px;font-weight:650;font-variant-numeric:tabular-nums}
.up{color:var(--up)}.down{color:var(--down)}.warn{color:var(--warn)}
.status{margin-bottom:12px}.status .v{font-size:15px;font-weight:500}
table{width:100%;border-collapse:collapse;font-size:13px;font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:6px 4px;border-bottom:1px solid var(--line);white-space:nowrap}th{color:var(--mute);font-weight:500}
.scroll{overflow-x:auto}h2{font-size:15px;margin:18px 0 8px}
button{font:inherit;font-weight:600;border:0;border-radius:10px;padding:12px;width:100%;cursor:pointer}
.stop{background:var(--down);color:#fff}.go{background:var(--up);color:#fff}
input{font:inherit;padding:10px;border:1px solid var(--line);border-radius:10px;width:100%;margin-bottom:8px;background:var(--card);color:var(--ink)}
.err{font-size:13px;color:var(--down);word-break:break-word}
</style></head><body><main>
<h1>Kalshi BTC Bot <span class="pill {{mode}}">{{mode|upper}}</span></h1>
<div class="sub">{{series}} · updated {{now}} · {% if alive %}<span class="up">● running</span>{% else %}<span class="down">● not responding</span>{% endif %}</div>

<div class="card status"><div class="k">Now</div><div class="v">{{status}}</div>
{% if last_error %}<div class="err">Last error: {{last_error}}</div>{% endif %}</div>

<div class="grid">
 <div class="card"><div class="k">Total P&amp;L</div><div class="v {{'up' if s.pnl>=0 else 'down'}}">{{money(s.pnl)}}</div></div>
 <div class="card"><div class="k">Today</div><div class="v {{'up' if today>=0 else 'down'}}">{{money(today)}}</div></div>
 <div class="card"><div class="k">Win rate</div><div class="v">{{winrate}}</div></div>
 <div class="card"><div class="k">Open risk</div><div class="v">${{'%.2f'|format(s.open_cost)}}</div></div>
</div>

{% if can_control %}
<form method="post" action="{{url_for('toggle')}}">
{% if killed %}<button class="go">Resume trading</button>{% else %}<button class="stop">Stop trading (kill switch)</button>{% endif %}
</form>
{% elif not password_set %}
<div class="sub warn">Set DASHBOARD_PASSWORD to enable the kill switch here.</div>
{% endif %}

<h2>Trades</h2><div class="scroll"><table>
<tr><th>Time</th><th>Market</th><th>Side</th><th>Qty</th><th>Price</th><th>Fair</th><th>P&amp;L</th></tr>
{% for t in trades %}<tr>
<td>{{ts(t.ts)}}</td><td>{{t.ticker.split('-',1)[1]}}</td><td>{{t.side|upper}}</td><td>{{t.contracts}}</td>
<td>{{'%.2f'|format(t.price)}}</td><td>{{'%.2f'|format(t.p_fair if t.side=='yes' else 1-t.p_fair)}}</td>
<td class="{{'' if t.pnl is none else ('up' if t.pnl>=0 else 'down')}}">{{'open' if t.pnl is none else money(t.pnl)}}</td></tr>
{% else %}<tr><td colspan="7" class="sub">No trades yet.</td></tr>{% endfor %}
</table></div>

<h2>Recent checks</h2><div class="scroll"><table>
<tr><th>Time</th><th>BTC</th><th>Strike</th><th>Left</th><th>Fair YES</th><th>Ask Y/N</th><th>Action</th></tr>
{% for d in decisions %}<tr>
<td>{{ts(d.ts)}}</td><td>{{'{:,.0f}'.format(d.spot or 0)}}</td><td>{{'{:,.0f}'.format(d.strike or 0)}}</td>
<td>{{'%d:%02d'|format((d.seconds_left or 0)//60, (d.seconds_left or 0)%60)}}</td>
<td>{{'%.2f'|format(d.p_fair) if d.p_fair is not none else '—'}}</td>
<td>{{'%.2f'|format(d.yes_ask) if d.yes_ask else '—'}}/{{'%.2f'|format(d.no_ask) if d.no_ask else '—'}}</td>
<td title="{{d.reason}}">{{d.action}}</td></tr>
{% endfor %}</table></div>

{% if password_set and not can_control %}
<h2>Sign in</h2><form method="post" action="{{url_for('login')}}">
<input type="password" name="password" placeholder="Dashboard password" autocomplete="current-password"><button class="go">Sign in</button></form>
{% endif %}
</main></body></html>"""


def create_app(settings: Settings | None = None) -> Flask:
    settings = settings or Settings()
    store = Store(settings.db_path)
    app = Flask(__name__)
    app.secret_key = settings.secret_key
    pw = settings.dashboard_password

    def authed() -> bool:
        return bool(pw) and session.get("ok") is True

    @app.get("/")
    def index():
        s = store.summary()
        today_row = next((r for r in store.daily_pnl(1) if r["day"] == datetime.now(TZ).strftime("%Y-%m-%d")), None)
        hb = float(store.get("heartbeat", "0") or 0)
        return render_template_string(
            PAGE,
            mode=store.get("mode", settings.mode),
            series=settings.series_ticker,
            now=datetime.now(TZ).strftime("%-I:%M:%S %p"),
            alive=time.time() - hb < max(60, settings.poll_seconds * 6),
            status=store.get("status", "waiting for the bot to start"),
            last_error=store.get("last_error"),
            s=s,
            today=today_row["pnl"] if today_row else 0.0,
            winrate=f"{100 * s['wins'] / s['settled']:.0f}% ({s['settled']})" if s["settled"] else "—",
            trades=store.recent_trades(25),
            decisions=store.recent_decisions(20),
            killed=store.kill_switch_on(),
            can_control=authed(),
            password_set=bool(pw),
            money=lambda x: f"{'+' if x >= 0 else '−'}${abs(x):.2f}",
            ts=lambda t: datetime.fromtimestamp(t, TZ).strftime("%-I:%M %p"),
        )

    @app.post("/login")
    def login():
        if pw and hmac.compare_digest(request.form.get("password", ""), pw):
            session["ok"] = True
            session.permanent = True
        return redirect(url_for("index"))

    @app.post("/toggle")
    def toggle():
        if authed():
            store.set("kill_switch", "off" if store.kill_switch_on() else "on")
        return redirect(url_for("index"))

    @app.get("/health")
    def health():
        hb = float(store.get("heartbeat", "0") or 0)
        return {"alive": time.time() - hb < 60, "status": store.get("status"), "kill_switch": store.kill_switch_on()}

    return app
