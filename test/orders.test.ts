import { test } from "node:test";
import assert from "node:assert/strict";
import { KalshiClient, fromV2, orderFilled, v2Side } from "../src/kalshi.ts";

function capture(reply: unknown) {
  const calls: { method: string; url: string; body: any }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ method: String(init.method), url, body: init.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify(reply), { status: 201 });
  }) as unknown as typeof fetch;
  return { client: new KalshiClient("https://example.test/trade-api/v2", "", null, fetchFn), calls };
}

test("V2 quotes from the YES side: buying NO at 30¢ is an ask at 70¢", () => {
  assert.deepEqual(v2Side("yes", 0.42), { side: "bid", price: "0.4200" });
  assert.deepEqual(v2Side("no", 0.3), { side: "ask", price: "0.7000" });
  assert.deepEqual(v2Side("no", 0.07), { side: "ask", price: "0.9300" }); // no float noise like 0.92999999
});

test("taker buy goes to the V2 endpoint as immediate-or-cancel and reads fills and fees", async () => {
  const { client, calls } = capture({ order_id: "o1", fill_count: "4.00", remaining_count: "0.00", average_fill_price: "0.3000", average_fee_paid: "0.0150", ts_ms: 1 });
  const o = await client.createOrder("KXETH15M-X", "no", 4.9, 0.3, "cid-1");
  assert.equal(calls[0].method, "POST");
  assert.match(calls[0].url, /\/trade-api\/v2\/portfolio\/events\/orders$/);
  assert.deepEqual(calls[0].body, {
    ticker: "KXETH15M-X",
    side: "ask",
    price: "0.7000",
    count: "4.00",
    self_trade_prevention_type: "taker_at_cross",
    client_order_id: "cid-1",
    time_in_force: "immediate_or_cancel",
  });
  assert.equal(o.order_id, "o1");
  assert.equal(orderFilled(o), 4);
  assert.equal(Number(o.taker_fees_dollars), 0.06);
  assert.equal(o.status, "executed");
});

test("maker bid rests post-only with Kalshi's own expiry", async () => {
  const { client, calls } = capture({ order_id: "m1", fill_count: "0.00", remaining_count: "5.00", ts_ms: 1 });
  const o = await client.createMakerOrder("KXNCAAFGAME-Y", "yes", 5, 0.55, 1760000000.7, "cid-2");
  assert.equal(calls[0].body.side, "bid");
  assert.equal(calls[0].body.price, "0.5500");
  assert.equal(calls[0].body.time_in_force, "good_till_canceled");
  assert.equal(calls[0].body.post_only, true);
  assert.equal(calls[0].body.expiration_time, 1760000000);
  assert.equal(calls[0].body.cancel_order_on_pause, true);
  assert.equal(o.status, "resting");
  assert.equal(orderFilled(o), 0);
  assert.equal(o.taker_fees_dollars, undefined);
});

test("unfilled immediate-or-cancel reads as cancelled", () => {
  assert.equal(fromV2({ order_id: "x", fill_count: "0.00", remaining_count: "0.00" }, 3, "immediate_or_cancel").status, "canceled");
});

test("cancel uses the V2 endpoint with the market for routing, then the caller reads the order", async () => {
  const { client, calls } = capture({ order_id: "m1", reduced_by: "5.00", ts_ms: 1 });
  assert.equal(await client.cancelOrder("m1", "KXNCAAFGAME-Y"), null);
  assert.equal(calls[0].method, "DELETE");
  assert.match(calls[0].url, /\/portfolio\/events\/orders\/m1\?market_ticker=KXNCAAFGAME-Y$/);
});
