// Worker entry: serves the dashboard and keeps the trading loop alive.

import type { Env } from "./config.ts";
import { renderDashboard } from "./dashboard.ts";
import type { Bot } from "./bot.ts";

export { Bot } from "./bot.ts";

const COOKIE = "kb_session";

function bot(env: Env): DurableObjectStub<Bot> {
  const ns = env.BOT as DurableObjectNamespace<Bot>;
  return ns.get(ns.idFromName("main"));
}

async function sessionToken(password: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("kalshi-bot-dashboard"));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function isAuthed(req: Request, env: Env): Promise<boolean> {
  const pw = env.DASHBOARD_PASSWORD;
  if (!pw) return false;
  const cookie = req.headers.get("Cookie") ?? "";
  const m = cookie.match(new RegExp(`${COOKIE}=([a-f0-9]+)`));
  return !!m && timingSafeEqual(m[1], await sessionToken(pw));
}

const homeMsg = (msg: string) => new Response(null, { status: 303, headers: { Location: `/?msg=${encodeURIComponent(msg)}` } });

const home = (extraHeaders: Record<string, string> = {}) => new Response(null, { status: 303, headers: { Location: "/", ...extraHeaders } });

export default {
  async fetch(req, env, ctx): Promise<Response> {
    const url = new URL(req.url);
    const stub = bot(env);
    ctx.waitUntil(stub.start());

    if (req.method === "GET" && url.pathname === "/") {
      const snap = await stub.snapshot(url.searchParams.get("view") ?? undefined, url.searchParams.get("all") === "1");
      snap.message = url.searchParams.get("msg");
      const html = renderDashboard(snap, { authed: await isAuthed(req, env), passwordSet: !!env.DASHBOARD_PASSWORD });
      return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    }

    if (req.method === "GET" && url.pathname === "/health") {
      const s = await stub.snapshot();
      return Response.json({ alive: s.alive, mode: s.mode, status: s.status, killSwitch: s.killSwitch, horizon: s.horizon, problem: s.problem, lastError: s.lastError, diag: s.diag });
    }

    if (req.method === "POST" && url.pathname === "/login") {
      const pw = env.DASHBOARD_PASSWORD;
      const form = await req.formData();
      if (pw && timingSafeEqual(String(form.get("password") ?? ""), pw)) {
        const token = await sessionToken(pw);
        return home({ "Set-Cookie": `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000` });
      }
      return home();
    }

    if (req.method === "POST" && url.pathname === "/logout") {
      return home({ "Set-Cookie": `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0` });
    }

    if (req.method === "POST" && url.pathname === "/mode") {
      if (!(await isAuthed(req, env))) return new Response("Sign in first", { status: 401 });
      const form = await req.formData();
      const mode = String(form.get("mode") ?? "");
      const strategy = String(form.get("strategy") ?? "all");
      if (mode === "live") {
        // Real money: ask for the password again and an explicit confirmation.
        const pw = env.DASHBOARD_PASSWORD ?? "";
        if (!pw || !timingSafeEqual(String(form.get("password") ?? ""), pw)) return homeMsg("Wrong password — still in paper mode.");
        if (form.get("confirm") !== "yes") return homeMsg("Tick the box to confirm real money — still in paper mode.");
      }
      const problem = await stub.setMode(mode, strategy);
      const what = strategy === "all" ? "Everything" : ({ crypto: "Crypto", ai: "AI forecaster", sports: "Sports", arb: "Arbitrage" } as Record<string, string>)[strategy] ?? strategy;
      return homeMsg(problem ?? (mode === "live" ? `LIVE: ${what} now trades real money.` : `${what} is back to paper trading.`));
    }

    if (req.method === "POST" && url.pathname === "/strategy") {
      if (!(await isAuthed(req, env))) return new Response("Sign in first", { status: 401 });
      const form = await req.formData();
      await stub.setStrategy(String(form.get("key") ?? ""), form.get("on") === "on");
      return home();
    }

    if (req.method === "POST" && (url.pathname === "/prices" || url.pathname === "/fresh-test")) {
      if (!(await isAuthed(req, env))) return new Response("Sign in first", { status: 401 });
      const form = await req.formData();
      if (url.pathname === "/fresh-test") {
        await stub.startFreshTest();
        return homeMsg("Fresh test started: stats and model checks now count from this moment.");
      }
      const problem = await stub.setPriceRange(Number(form.get("min")), Number(form.get("max")));
      return homeMsg(problem ?? "Price range saved.");
    }

    if (req.method === "POST" && ["/kill", "/horizon", "/limits", "/model"].includes(url.pathname)) {
      if (!(await isAuthed(req, env))) return new Response("Sign in first", { status: 401 });
      const form = await req.formData();
      if (url.pathname === "/kill") await stub.setKillSwitch(form.get("on") === "on");
      else if (url.pathname === "/horizon") await stub.setHorizon(String(form.get("horizon") ?? ""));
      else if (url.pathname === "/model") await stub.setModelWeight(Number(form.get("weight")));
      else if (form.get("reset") === "1") await stub.resetLimits();
      else await stub.setLimits(Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)])));
      return home();
    }

    return new Response("Not found", { status: 404 });
  },

  // Runs every minute (see wrangler.jsonc) just to make sure the loop is alive.
  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(bot(env).start());
  },
} satisfies ExportedHandler<Env>;
