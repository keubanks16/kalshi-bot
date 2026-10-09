// The math: fair probabilities, fees, bet sizing and arbitrage. No I/O, fully unit-tested.
//
// Crypto price markets on Kalshi settle on a CF Benchmarks index, usually the
// simple average of its last 60 seconds before a set time. Model: the log price
// is a driftless random walk with volatility sigma. With t seconds left, the
// variance of the settlement value is
//   sigma^2 * (t - 60)   before the averaging window, plus
//   sigma^2 * 60 / 3     for the 60-second average itself
// (an average of a random walk over a window W has variance W/3).

export const SECONDS_PER_YEAR = 365 * 24 * 3600;
export const AVG_WINDOW = 60;

// Abramowitz–Stegun 7.1.26, max error ~1.5e-7 — plenty for prices in cents.
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return sign * y;
}

export function normCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

/** P(settlement value >= strike). */
export function probAtLeast(spot: number, strike: number, secondsLeft: number, annualVol: number, averaged = true): number {
  if (!(spot > 0 && strike > 0)) throw new Error("prices must be positive");
  const sigma2 = (annualVol * annualVol) / SECONDS_PER_YEAR;
  const t = Math.max(secondsLeft, 0);
  let variance: number;
  if (!averaged) variance = sigma2 * t;
  else if (t >= AVG_WINDOW) variance = sigma2 * (t - AVG_WINDOW + AVG_WINDOW / 3);
  else variance = (sigma2 * t) / 3; // inside the window; the bot doesn't trade here by default
  const x = Math.log(spot / strike);
  if (variance <= 0) return x >= 0 ? 1 : 0;
  return normCdf(x / Math.sqrt(variance));
}

export type StrikeType = "greater" | "greater_or_equal" | "less" | "less_or_equal" | "between";
export const SUPPORTED_STRIKES = new Set<string>(["greater", "greater_or_equal", "less", "less_or_equal", "between"]);

/** Fair P(YES) for a numeric-strike market, or null if we can't price it. */
export function probYesForStrike(
  strikeType: string,
  floor: number | null,
  cap: number | null,
  spot: number,
  secondsLeft: number,
  annualVol: number,
  averaged = true,
): number | null {
  const above = (k: number) => probAtLeast(spot, k, secondsLeft, annualVol, averaged);
  switch (strikeType) {
    case "greater":
    case "greater_or_equal":
      return floor && floor > 0 ? above(floor) : null;
    case "less":
    case "less_or_equal": {
      const k = cap ?? floor;
      return k && k > 0 ? 1 - above(k) : null;
    }
    case "between":
      return floor && cap && cap > floor ? Math.max(0, above(floor) - above(cap)) : null;
    default:
      return null;
  }
}

/** Kalshi taker fee in dollars: rate * C * P * (1-P), rounded up to the cent. */
export function takerFee(contracts: number, price: number, rate = 0.07): number {
  const cents = Math.round(rate * contracts * price * (1 - price) * 100 * 1e6) / 1e6;
  return Math.ceil(cents) / 100;
}

/** Full-Kelly share of bankroll to spend on a $1 binary costing `price` that wins with prob `p`. */
export function kellyFraction(p: number, price: number): number {
  if (!(price > 0 && price < 1)) return 0;
  return Math.max(0, (p - price) / (1 - price));
}

export function fmtEdge(e: number): string {
  return (e >= 0 ? "+" : "") + e.toFixed(3);
}

// ----------------------------------------------------------- directional
export interface Decision {
  action: "buy_yes" | "buy_no" | "hold";
  reason: string;
  pYes?: number;
  price?: number;
  contracts: number;
  edge: number;
}

export function sideOf(d: Decision): "yes" | "no" | null {
  return d.action === "buy_yes" ? "yes" : d.action === "buy_no" ? "no" : null;
}

export interface BinaryLimits {
  minEdge: number;
  minPrice: number;
  maxPrice: number;
  kellyFraction: number;
  takerFeeRate: number;
  maxContractsPerOrder: number;
}

/** Given a fair P(YES) and the asks, pick the better side if its after-fee edge clears the bar, and size it. */
export function decideBinary(pYes: number, yesAsk: number | null, noAsk: number | null, bankroll: number, s: BinaryLimits): Decision {
  const hold = (reason: string, extra: Partial<Decision> = {}): Decision => ({ action: "hold", reason, contracts: 0, edge: 0, pYes, ...extra });

  let best: { edge: number; side: "yes" | "no"; prob: number; ask: number } | null = null;
  for (const [side, prob, ask] of [
    ["yes", pYes, yesAsk],
    ["no", 1 - pYes, noAsk],
  ] as const) {
    if (ask === null || !(ask >= s.minPrice && ask <= s.maxPrice)) continue;
    const feePer = takerFee(100, ask, s.takerFeeRate) / 100;
    const edge = prob - ask - feePer;
    if (!best || edge > best.edge) best = { edge, side, prob, ask };
  }
  if (!best) return hold("no tradable price in range");

  const extra = { price: best.ask, edge: best.edge };
  if (best.edge < s.minEdge) return hold(`best edge ${fmtEdge(best.edge)} on ${best.side}`, extra);

  const spend = s.kellyFraction * kellyFraction(best.prob, best.ask) * bankroll;
  const contracts = Math.min(Math.floor(spend / best.ask), s.maxContractsPerOrder);
  if (contracts < 1) return hold(`edge ${fmtEdge(best.edge)} but size rounds to 0`, extra);
  return { action: best.side === "yes" ? "buy_yes" : "buy_no", reason: `edge ${fmtEdge(best.edge)}`, contracts, pYes, ...extra };
}

// ------------------------------------------------------------ arbitrage
// In an event where at most one market can resolve YES (Kalshi marks these
// mutually_exclusive), owning one NO on each of k markets pays at least k-1
// dollars whatever happens — and k if none resolves YES. If the NOs cost less
// than k-1 including fees, the difference is locked-in profit. This does not
// need the outcome list to be complete, unlike buying every YES.

export interface ArbLeg {
  ticker: string;
  noAsk: number;
  size: number; // contracts available at that ask
}

export interface ArbPlan {
  legs: ArbLeg[];
  sets: number; // contracts bought on each leg
  cost: number; // total dollars incl. fees
  profit: number; // guaranteed minimum profit in dollars
}

function setCost(legs: ArbLeg[], n: number, feeRate: number): number {
  return legs.reduce((sum, l) => sum + n * l.noAsk + takerFee(n, l.noAsk, feeRate), 0);
}

/**
 * Best NO-basket on a mutually exclusive event, sized to what's available and
 * to `maxCost` dollars, or null if nothing clears `minProfitPerSet`.
 */
export function planNoArb(allLegs: ArbLeg[], feeRate: number, minProfitPerSet: number, maxSets: number, maxCost: number): ArbPlan | null {
  // Each leg adds (1 - noAsk - fee) to the payout floor; keep only those that help.
  const legs = allLegs
    .filter((l) => l.noAsk > 0 && l.noAsk < 1 && l.size >= 1)
    .filter((l) => 1 - l.noAsk - takerFee(100, l.noAsk, feeRate) / 100 > 0);
  if (legs.length < 2) return null;

  let sets = Math.min(maxSets, ...legs.map((l) => Math.floor(l.size)));
  while (sets >= 1) {
    const cost = setCost(legs, sets, feeRate);
    const profit = sets * (legs.length - 1) - cost;
    if (cost <= maxCost + 1e-9 && profit >= minProfitPerSet * sets - 1e-9) {
      return { legs, sets, cost: round2(cost), profit: round2(profit) };
    }
    sets--;
  }
  return null;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

// ------------------------------------------------------------- volatility
/** Annualized volatility from closing prices using an exponentially weighted variance. */
export function ewmaVol(closes: number[], secondsPerBar = 60, halflifeBars = 20): number {
  if (closes.length < 3) throw new Error("need at least 3 prices");
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0 && closes[i] > 0) rets.push(Math.log(closes[i] / closes[i - 1]));
  }
  const lam = Math.pow(0.5, 1 / halflifeBars);
  let v = 0;
  let w = 0;
  for (let i = 0; i < rets.length; i++) {
    const r = rets[rets.length - 1 - i]; // newest gets the most weight
    const wi = Math.pow(lam, i);
    v += wi * r * r;
    w += wi;
  }
  return Math.sqrt(((v / w) * SECONDS_PER_YEAR) / secondsPerBar);
}

/** Shrink an order until cost + fee fits in `room` dollars. */
export function fitToRoom(contracts: number, price: number, room: number, feeRate: number): number {
  let c = contracts;
  while (c > 0 && c * price + takerFee(c, price, feeRate) > room + 1e-9) c--;
  return c;
}
