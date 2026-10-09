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
  marketExposure(ticker: string): { cost: number; orders: number } {
    const r = this.one<{ cost: number; n: number }>("SELECT COALESCE(SUM(cost), 0) AS cost, COUNT(*) AS n FROM trades WHERE ticker = ?", ticker);
    return { cost: Number(r.cost), orders: Number(r.n) };
  }
  eventExposure(eventTicker: string): number {
    return Number(this.one<{ c: number }>("SELECT COALESCE(SUM(cost), 0) AS c FROM trades WHERE event_ticker = ? AND result IS NULL", eventTicker).c);
  }
  openRisk(): number {
    return Number(this.one<{ c: number }>("SELECT COALESCE(SUM(cost), 0) AS c FROM trades WHERE result IS NULL").c);
  }
  /** Losses realized today plus everything still at risk from today's trades (worst case). */
  dayLoss(day: string): number {
    const r = this.one<{ realized: number; at_risk: number }>(
      `SELECT COALESCE(SUM(CASE WHEN result IS NOT NULL THEN pnl END), 0) AS realized,
              COALESCE(SUM(CASE WHEN result IS NULL THEN cost END), 0) AS at_risk
       FROM trades WHERE day = ?`,
      day,
    );
    return Math.max(0, -Number(r.realized)) + Number(r.at_risk);
  }
  summary(): { trades: number; settled: number; wins: number; pnl: number; fees: number; openCost: number } {
    const r = this.one(
      `SELECT COUNT(*) AS trades,
              COALESCE(SUM(CASE WHEN result IS NOT NULL THEN 1 ELSE 0 END), 0) AS settled,
              COALESCE(SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END), 0) AS wins,
              COALESCE(SUM(pnl), 0) AS pnl,
              COALESCE(SUM(fee), 0) AS fees,
              COALESCE(SUM(CASE WHEN result IS NULL THEN cost ELSE 0 END), 0) AS open_cost
       FROM trades`,
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
  pnlForDay(day: string): number {
    return Number(this.one<{ p: number }>("SELECT COALESCE(SUM(pnl), 0) AS p FROM trades WHERE day = ? AND result IS NOT NULL", day).p);
  }
  byStrategy(): { strategy: string; trades: number; pnl: number }[] {
    return this.rows("SELECT strategy, COUNT(*) AS trades, COALESCE(SUM(pnl), 0) AS pnl FROM trades GROUP BY strategy") as any;
  }
  recentTrades(limit = 25): TradeRow[] {
    return this.rows<TradeRow>("SELECT * FROM trades ORDER BY ts DESC LIMIT ?", limit);
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
