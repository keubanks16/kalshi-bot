import { test } from "node:test";
import assert from "node:assert/strict";
import { decideBinary, ewmaVol, kellyFraction, planNoArb, probAtLeast, probYesForStrike, takerFee } from "../src/model.ts";

const limits = { minEdge: 0.04, minPrice: 0.05, maxPrice: 0.95, kellyFraction: 0.25, takerFeeRate: 0.07, maxContractsPerOrder: 10 };
const close = (a: number, b: number, tol = 1e-6) => assert.ok(Math.abs(a - b) < tol, `${a} != ${b}`);

test("at the money is a coin flip", () => close(probAtLeast(80000, 80000, 600, 0.5), 0.5));

test("above strike favors yes, monotonic in spot", () => {
  const p1 = probAtLeast(80100, 80000, 600, 0.5);
  const p2 = probAtLeast(80300, 80000, 600, 0.5);
  assert.ok(0.5 < p1 && p1 < p2 && p2 < 1);
});

test("less time left means more certainty", () => {
  assert.ok(probAtLeast(80100, 80000, 180, 0.5) > probAtLeast(80100, 80000, 800, 0.5));
});

test("averaging lowers variance vs a single point", () => {
  assert.ok(probAtLeast(80100, 80000, 120, 0.5, true) > probAtLeast(80100, 80000, 120, 0.5, false));
});

test("strike types: less is the complement, between is a band", () => {
  const above = probAtLeast(80000, 79000, 3600, 0.5);
  close(probYesForStrike("less", null, 79000, 80000, 3600, 0.5)!, 1 - above);
  const band = probYesForStrike("between", 79500, 80500, 80000, 3600, 0.5)!;
  close(band, probAtLeast(80000, 79500, 3600, 0.5) - probAtLeast(80000, 80500, 3600, 0.5));
  assert.equal(probYesForStrike("functional", 1, 2, 80000, 3600, 0.5), null);
});

test("taker fee rounds up to the cent", () => {
  close(takerFee(10, 0.5), 0.18); // 0.175 -> 0.18
  close(takerFee(1, 0.5), 0.02); // 0.0175 -> 0.02
  close(takerFee(100, 0.5), 1.75); // exact
});

test("kelly", () => {
  close(kellyFraction(0.6, 0.5), 0.2);
  assert.equal(kellyFraction(0.4, 0.5), 0);
});

test("holds without edge, buys the cheap side", () => {
  assert.equal(decideBinary(0.5, 0.51, 0.51, 100, limits).action, "hold");
  const y = decideBinary(0.75, 0.6, 0.42, 100, limits);
  assert.equal(y.action, "buy_yes");
  assert.ok(y.contracts >= 1 && y.contracts <= 10);
  assert.equal(decideBinary(0.25, 0.42, 0.6, 100, limits).action, "buy_no");
});

test("skips near-certain prices", () => {
  assert.equal(decideBinary(0.999, 0.97, 0.04, 100, limits).action, "hold");
});

test("NO-basket arbitrage found when YES bids add up past $1", () => {
  // no asks 0.60 + 0.60 + 0.65 = 1.85 for a guaranteed $2 floor
  const legs = [
    { ticker: "A", noAsk: 0.6, size: 50 },
    { ticker: "B", noAsk: 0.6, size: 50 },
    { ticker: "C", noAsk: 0.65, size: 50 },
  ];
  const plan = planNoArb(legs, 0.07, 0.02, 10, 100)!;
  assert.ok(plan);
  assert.equal(plan.sets, 10);
  assert.equal(plan.legs.length, 3);
  assert.ok(plan.profit > 0.5 && plan.profit < 1.5);
  // payout floor (k-1) * sets minus cost equals the reported profit
  close(plan.profit, Math.round((2 * 10 - plan.cost) * 100) / 100, 0.011);
});

test("no arbitrage on a fair book", () => {
  const legs = [
    { ticker: "A", noAsk: 0.62, size: 50 },
    { ticker: "B", noAsk: 0.7, size: 50 },
    { ticker: "C", noAsk: 0.7, size: 50 },
  ];
  assert.equal(planNoArb(legs, 0.07, 0.02, 10, 100), null);
});

test("arbitrage respects available size and dollar cap", () => {
  const legs = [
    { ticker: "A", noAsk: 0.6, size: 4 },
    { ticker: "B", noAsk: 0.6, size: 50 },
    { ticker: "C", noAsk: 0.65, size: 50 },
  ];
  const plan = planNoArb(legs, 0.07, 0.02, 10, 100)!;
  assert.equal(plan.sets, 4);
  const capped = planNoArb(legs.map((l) => ({ ...l, size: 50 })), 0.07, 0.02, 10, 6)!;
  assert.ok(capped.cost <= 6);
});

test("ewma vol of a quiet series is small, noisy is bigger", () => {
  const quiet = Array.from({ length: 60 }, (_, i) => 80000 * (1 + 0.00001 * Math.sin(i)));
  const noisy = Array.from({ length: 60 }, (_, i) => 80000 * (1 + 0.002 * Math.sin(i)));
  assert.ok(ewmaVol(quiet) < ewmaVol(noisy));
});

test("cheap long shots need a bigger edge when configured", () => {
  const strict = { ...limits, cheapBelow: 0.3, cheapMinEdge: 0.08 };
  // NO @ 23¢ with fair 30% → ~+0.057 after fees: buys at the normal bar, holds under the long-shot bar
  assert.equal(decideBinary(0.7, 0.8, 0.23, 100, limits).action, "buy_no");
  const held = decideBinary(0.7, 0.8, 0.23, 100, strict);
  assert.equal(held.action, "hold");
  assert.match(held.reason, /long shot needs/);
  // A big enough edge on a cheap contract still trades
  assert.equal(decideBinary(0.6, 0.8, 0.23, 100, strict).action, "buy_no");
  // Mid-priced contracts are unaffected
  assert.equal(decideBinary(0.75, 0.6, 0.42, 100, strict).action, "buy_yes");
});

test("picks the side that clears its own bar, not just the larger edge", () => {
  const strict = { ...limits, cheapBelow: 0.3, cheapMinEdge: 0.2 };
  // YES @ 20¢ has the larger edge but fails the long-shot bar; NO @ 45¢ clears the normal bar
  const d = decideBinary(0.3, 0.2, 0.45, 100, { ...strict, minPrice: 0.05 });
  assert.notEqual(d.action, "buy_yes");
});

test("one-contract minimum: a good edge on a small bankroll still buys 1", () => {
  // $10 bankroll, quarter-Kelly sizes this to well under one contract
  const tiny = { ...limits, minEdge: 0.04 };
  assert.equal(decideBinary(0.6, 0.5, 0.52, 10, tiny).action, "hold");
  const d = decideBinary(0.6, 0.5, 0.52, 10, { ...tiny, minOneContract: true });
  assert.equal(d.action, "buy_yes");
  assert.equal(d.contracts, 1);
  // still needs the edge
  assert.equal(decideBinary(0.51, 0.5, 0.52, 10, { ...tiny, minOneContract: true }).action, "hold");
});
