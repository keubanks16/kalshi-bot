// SQLite storage. In production this is the Durable Object's built-in SQLite;
// in tests it's node:sqlite. Both are wrapped to the tiny `Sql` interface.

export interface Sql {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, any>[] };
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL NOT NULL,
    day TEXT NOT NULL,
    mode TEXT NOT NULL,
    strategy TEXT NOT NULL,
    ticker TEXT NOT NULL,
    event_ticker TEXT NOT NULL,
    side TEXT NOT NULL,
    contracts INTEGER NOT NULL,
    price REAL NOT NULL,
    fee REAL NOT NULL,
    cost REAL NOT NULL,
    p_fair REAL,
    edge REAL,
    note TEXT,
    order_id TEXT,
    close_ts REAL,
    result TEXT,
    pnl REAL,
    settled_ts REAL
  )`,
  `CREATE INDEX IF NOT EXISTS trades_open ON trades(result)`,
  `CREATE INDEX IF NOT EXISTS trades_ticker ON trades(ticker)`,
  `CREATE INDEX IF NOT EXISTS trades_event ON trades(event_ticker)`,
  `CREATE INDEX IF NOT EXISTS trades_day ON trades(day)`,
  `CREATE TABLE IF NOT EXISTS decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL NOT NULL,
    strategy TEXT,
    ticker TEXT,
    action TEXT,
    reason TEXT,
    p_fair REAL,
    price REAL
  )`,
  `CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT)`,
  `CREATE TABLE IF NOT EXISTS ai_forecasts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL NOT NULL,
    day TEXT NOT NULL,
    ticker TEXT NOT NULL,
    title TEXT,
    p REAL,
    confidence TEXT,
    summary TEXT,
    market_mid REAL,
    cost REAL NOT NULL,
    searches INTEGER,
    action TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS ai_ticker ON ai_forecasts(ticker)`,
  // Resting maker orders. Until they finish, their unfilled part counts against
  // every risk limit as if it had already filled.
  `CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL NOT NULL,
    day TEXT NOT NULL,
    mode TEXT NOT NULL,
    strategy TEXT NOT NULL,
    ticker TEXT NOT NULL,
    event_ticker TEXT NOT NULL,
    side TEXT NOT NULL,
    price REAL NOT NULL,
    count INTEGER NOT NULL,
    filled INTEGER NOT NULL DEFAULT 0,
    fee_paid REAL NOT NULL DEFAULT 0,
    order_id TEXT,
    p_fair REAL,
    edge REAL,
    note TEXT,
    close_ts REAL,
    expires_ts REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'resting'
  )`,
  `CREATE INDEX IF NOT EXISTS orders_status ON orders(status)`,
  `CREATE INDEX IF NOT EXISTS ai_day ON ai_forecasts(day)`,
];

export interface TradeRow {
  id: number;
  ts: number;
  day: string;
  mode: string;
  strategy: string;
  ticker: string;
  event_ticker: string;
  side: "yes" | "no";
  contracts: number;
  price: number;
  fee: number;
  cost: number;
  p_fair: number | null;
  edge: number | null;
  note: string | null;
  order_id: string | null;
  close_ts: number | null;
  result: string | null;
  pnl: number | null;
}

export type NewTrade = Omit<TradeRow, "id" | "result" | "pnl">;

export interface OrderRow {
  id: number;
  ts: number;
  day: string;
  mode: string;
  strategy: string;
  ticker: string;
  event_ticker: string;
  side: "yes" | "no";
  price: number;
  count: number;
  filled: number;
  fee_paid: number;
  order_id: string | null;
  p_fair: number | null;
  edge: number | null;
  note: string | null;
  close_ts: number | null;
  expires_ts: number;
  status: string;
}

// Dollars still reserved by resting orders (unfilled part only), used in every limit below.
const PENDING = "(count - filled) * price";

export class Store {
  sql: Sql;
  constructor(sql: Sql) {
    this.sql = sql;
    for (const q of SCHEMA) sql.exec(q);
  }

  private rows<T = Record<string, any>>(q: string, ...b: unknown[]): T[] {
    return this.sql.exec(q, ...b).toArray() as T[];
  }
  private one<T = Record<string, any>>(q: string, ...b: unknown[]): T {
    return this.rows<T>(q, ...b)[0];
  }

  // state
  get(key: string): string | null {
    return this.one<{ value: string }>("SELECT value FROM state WHERE key = ?", key)?.value ?? null;
  }
  set(key: string, value: string): void {
    this.sql.exec("INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  }
  killSwitchOn(): boolean {
    return this.get("kill_switch") === "on";
  }

  // trades
  addTrade(t: NewTrade): void {
    const cols = Object.keys(t);
    this.sql.exec(`INSERT INTO trades (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, ...cols.map((c) => (t as any)[c] ?? null));
  }
  openTrades(): TradeRow[] {
    return this.rows<TradeRow>("SELECT * FROM trades WHERE result IS NULL ORDER BY ts");
  }
  settleTrade(id: number, result: string, pnl: number, now: number): void {
    this.sql.exec("UPDATE trades SET result = ?, pnl = ?, settled_ts = ? WHERE id = ?", result, pnl, now, id);
  }

  /** Open filled positions on a market, one per mode and side. */
  positions(ticker: string, strategy?: string): { mode: string; side: "yes" | "no"; contracts: number; cost: number; firstTs: number }[] {
    return this.rows(
      `SELECT mode, side, SUM(contracts) AS contracts, SUM(cost) AS cost, MIN(ts) AS firstTs FROM trades
       WHERE ticker = ? AND result IS NULL ${strategy ? "AND strategy = ?" : ""} GROUP BY mode, side`,
      ...(strategy ? [ticker, strategy] : [ticker]),
    ).map((r: any) => ({ mode: String(r.mode), side: r.side, contracts: Number(r.contracts), cost: Number(r.cost), firstTs: Number(r.firstTs) }));
  }

  /**
   * Book selling `contracts` of an open position at `price` (fee in dollars, for
   * the whole sale), oldest trades first, splitting a trade if only part of it
   * is sold. Each closed part gets result "sold" and its share of the P&L.
   * Returns the total P&L booked.
   */
  closeSold(ticker: string, mode: string, side: string, contracts: number, price: number, fee: number, now: number): number {
    const open = this.rows<TradeRow>("SELECT * FROM trades WHERE ticker = ? AND mode = ? AND side = ? AND result IS NULL ORDER BY ts, id", ticker, mode, side);
    let left = contracts;
    let total = 0;
    const r4 = (x: number) => Math.round(x * 10000) / 10000;
    for (const t of open) {
      if (left <= 0) break;
      const k = Math.min(left, t.contracts);
      const proceeds = k * price - (fee * k) / contracts;
      if (k === t.contracts) {
        const pnl = r4(proceeds - t.cost);
        this.settleTrade(t.id, "sold", pnl, now);
        total += pnl;
      } else {
        // Split: the sold part becomes its own closed row; the rest stays open.
        const share = k / t.contracts;
        const cost = r4(t.cost * share);
        const tradeFee = r4(t.fee * share);
        this.sql.exec("UPDATE trades SET contracts = ?, cost = ?, fee = ? WHERE id = ?", t.contracts - k, r4(t.cost - cost), r4(t.fee - tradeFee), t.id);
        const { id: _id, result: _r, pnl: _p, ...rest } = t as any;
        delete rest.settled_ts;
        this.addTrade({ ...rest, contracts: k, cost, fee: tradeFee });
        const newId = Number(this.one<{ id: number }>("SELECT MAX(id) AS id FROM trades").id);
        const pnl = r4(proceeds - cost);
        this.settleTrade(newId, "sold", pnl, now);
        total += pnl;
      }
      left -= k;
    }
    return r4(total);
  }
  // Everything below is per trading mode, so paper results never mix with
  // real ones and paper positions never use up live risk limits.
  /** Sides held or resting on a market (a resting order counts, so we never stack or oppose it). */
  openSides(ticker: string, mode: string): string[] {
    return this.rows<{ side: string }>(
      "SELECT side FROM trades WHERE ticker = ? AND mode = ? AND result IS NULL UNION SELECT side FROM orders WHERE ticker = ? AND mode = ? AND status = 'resting'",
      ticker, mode, ticker, mode,
    ).map((r) => r.side);
  }
  /**
   * Spend on a market, and how many orders it has had. A maker order counts
   * once however many fills it gets, and not at all if it was cancelled
   * without filling (so an expired bid doesn't use up the market).
   */
  marketExposure(ticker: string, mode: string): { cost: number; orders: number } {
    const t = this.one<{ cost: number }>("SELECT COALESCE(SUM(cost), 0) AS cost FROM trades WHERE ticker = ? AND mode = ?", ticker, mode);
    const taker = this.one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM trades WHERE ticker = ? AND mode = ? AND (order_id IS NULL OR order_id NOT IN (SELECT order_id FROM orders WHERE order_id IS NOT NULL))",
      ticker, mode,
    );
    const maker = this.one<{ n: number }>("SELECT COUNT(*) AS n FROM orders WHERE ticker = ? AND mode = ? AND (status = 'resting' OR filled > 0)", ticker, mode);
    const pend = this.one<{ c: number }>(`SELECT COALESCE(SUM(${PENDING}), 0) AS c FROM orders WHERE ticker = ? AND mode = ? AND status = 'resting'`, ticker, mode);
    return { cost: Number(t.cost) + Number(pend.c), orders: Number(taker.n) + Number(maker.n) };
  }
  eventExposure(eventTicker: string, mode: string): number {
    const t = Number(this.one<{ c: number }>("SELECT COALESCE(SUM(cost), 0) AS c FROM trades WHERE event_ticker = ? AND mode = ? AND result IS NULL", eventTicker, mode).c);
    return t + Number(this.one<{ c: number }>(`SELECT COALESCE(SUM(${PENDING}), 0) AS c FROM orders WHERE event_ticker = ? AND mode = ? AND status = 'resting'`, eventTicker, mode).c);
  }
  openRisk(mode: string): number {
    const t = Number(this.one<{ c: number }>("SELECT COALESCE(SUM(cost), 0) AS c FROM trades WHERE mode = ? AND result IS NULL", mode).c);
    return t + this.pendingCost(mode);
  }
  pendingCost(mode: string, day?: string): number {
    return day === undefined
      ? Number(this.one<{ c: number }>(`SELECT COALESCE(SUM(${PENDING}), 0) AS c FROM orders WHERE mode = ? AND status = 'resting'`, mode).c)
      : Number(this.one<{ c: number }>(`SELECT COALESCE(SUM(${PENDING}), 0) AS c FROM orders WHERE mode = ? AND day = ? AND status = 'resting'`, mode, day).c);
  }

  // resting maker orders
  addOrder(o: Omit<OrderRow, "id" | "status">): number {
    const cols = Object.keys(o);
    this.sql.exec(`INSERT INTO orders (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, ...cols.map((c) => (o as any)[c] ?? null));
    return Number(this.one<{ id: number }>("SELECT MAX(id) AS id FROM orders").id);
  }
  restingOrders(mode?: string): OrderRow[] {
    return mode === undefined
      ? this.rows<OrderRow>("SELECT * FROM orders WHERE status = 'resting' ORDER BY ts")
      : this.rows<OrderRow>("SELECT * FROM orders WHERE status = 'resting' AND mode = ? ORDER BY ts", mode);
  }
  updateOrder(id: number, filled: number, feePaid: number, status: string): void {
    this.sql.exec("UPDATE orders SET filled = ?, fee_paid = ?, status = ? WHERE id = ?", filled, feePaid, status, id);
  }
  /** Losses realized today plus everything still at risk from today's trades (worst case). */
  dayLoss(day: string, mode: string): number {
    const r = this.one<{ realized: number; at_risk: number }>(
      `SELECT COALESCE(SUM(CASE WHEN result IS NOT NULL THEN pnl END), 0) AS realized,
              COALESCE(SUM(CASE WHEN result IS NULL THEN cost END), 0) AS at_risk
       FROM trades WHERE day = ? AND mode = ?`,
      day,
      mode,
    );
    return Math.max(0, -Number(r.realized)) + Number(r.at_risk) + this.pendingCost(mode, day);
  }
  summary(mode: string, since = 0): { trades: number; settled: number; wins: number; pnl: number; fees: number; openCost: number } {
    const r = this.one(
      `SELECT COUNT(*) AS trades,
              COALESCE(SUM(CASE WHEN result IS NOT NULL THEN 1 ELSE 0 END), 0) AS settled,
              COALESCE(SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END), 0) AS wins,
              COALESCE(SUM(pnl), 0) AS pnl,
              COALESCE(SUM(fee), 0) AS fees,
              COALESCE(SUM(CASE WHEN result IS NULL THEN cost ELSE 0 END), 0) AS open_cost
       FROM trades WHERE mode = ? AND ts >= ?`,
      mode,
      since,
    );
    return {
      trades: Number(r.trades),
      settled: Number(r.settled),
      wins: Number(r.wins),
      pnl: Number(r.pnl),
      fees: Number(r.fees),
      openCost: Number(r.open_cost),
    };
  }
  pnlForDay(day: string, mode: string, since = 0): number {
    return Number(this.one<{ p: number }>("SELECT COALESCE(SUM(pnl), 0) AS p FROM trades WHERE day = ? AND mode = ? AND ts >= ? AND result IS NOT NULL", day, mode, since).p);
  }

  // AI forecasts
  addForecast(f: { ts: number; day: string; ticker: string; title: string; p: number | null; confidence: string | null; summary: string; market_mid: number | null; cost: number; searches: number; action: string }): void {
    this.sql.exec(
      "INSERT INTO ai_forecasts (ts, day, ticker, title, p, confidence, summary, market_mid, cost, searches, action) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      f.ts, f.day, f.ticker, f.title, f.p, f.confidence, f.summary, f.market_mid, f.cost, f.searches, f.action,
    );
  }
  aiSpend(day: string): number {
    return Number(this.one<{ c: number }>("SELECT COALESCE(SUM(cost), 0) AS c FROM ai_forecasts WHERE day = ?", day).c);
  }
  lastForecastTs(ticker: string): number {
    return Number(this.one<{ t: number }>("SELECT COALESCE(MAX(ts), 0) AS t FROM ai_forecasts WHERE ticker = ?", ticker).t);
  }
  recentForecasts(limit = 8): Record<string, any>[] {
    return this.rows("SELECT * FROM ai_forecasts ORDER BY id DESC LIMIT ?", limit);
  }

  /** How many bets of a strategy the model expected to win vs how many did. */
  modelCheck(mode: string, strategy = "crypto", since = 0): { settled: number; expectedWins: number; actualWins: number; avgPrice: number } {
    const r = this.one(
      `SELECT COUNT(*) AS n, COALESCE(SUM(p_fair), 0) AS exp,
              COALESCE(SUM(CASE WHEN result = side THEN 1 ELSE 0 END), 0) AS won,
              COALESCE(AVG(price), 0) AS px
       FROM trades WHERE mode = ? AND strategy = ? AND ts >= ? AND result IN ('yes', 'no') AND p_fair IS NOT NULL`,
      mode,
      strategy,
      since,
    );
    return { settled: Number(r.n), expectedWins: Number(r.exp), actualWins: Number(r.won), avgPrice: Number(r.px) };
  }
  byStrategy(mode: string, since = 0): { strategy: string; trades: number; pnl: number }[] {
    return this.rows("SELECT strategy, COUNT(*) AS trades, COALESCE(SUM(pnl), 0) AS pnl FROM trades WHERE mode = ? AND ts >= ? GROUP BY strategy", mode, since) as any;
  }

  recentTrades(mode: string, limit = 25): TradeRow[] {
    return this.rows<TradeRow>("SELECT * FROM trades WHERE mode = ? ORDER BY ts DESC LIMIT ?", mode, limit);
  }
  /** Modes that have any trades, for the dashboard's view switcher. */
  modesWithTrades(): string[] {
    return this.rows<{ mode: string }>("SELECT DISTINCT mode FROM trades").map((r) => r.mode);
  }

  // decisions (kept small: Durable Object free plans cap rows written per day)
  addDecision(d: { ts: number; strategy: string; ticker: string; action: string; reason: string; p_fair?: number | null; price?: number | null }): void {
    this.sql.exec(
      "INSERT INTO decisions (ts, strategy, ticker, action, reason, p_fair, price) VALUES (?, ?, ?, ?, ?, ?, ?)",
      d.ts, d.strategy, d.ticker, d.action, d.reason, d.p_fair ?? null, d.price ?? null,
    );
    this.sql.exec("DELETE FROM decisions WHERE id <= (SELECT MAX(id) - 2000 FROM decisions)");
  }
  recentDecisions(limit = 25): Record<string, any>[] {
    return this.rows("SELECT * FROM decisions ORDER BY id DESC LIMIT ?", limit);
  }
}
