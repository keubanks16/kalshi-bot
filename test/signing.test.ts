import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify, constants } from "node:crypto";
import { KalshiClient, importPrivateKey, sign } from "../src/kalshi.ts";

function verifyPss(publicPem: string, message: string, sigB64: string): boolean {
  return verify("sha256", Buffer.from(message), { key: publicPem, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, Buffer.from(sigB64, "base64"));
}

for (const type of ["pkcs1", "pkcs8"] as const) {
  test(`RSA-PSS signature verifies (${type} PEM) and ignores the query string`, async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type, format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const key = await importPrivateKey(privateKey);
    assert.equal(key.kind, "rsa");
    const sig = await sign(key, "1703123456789", "GET", "/trade-api/v2/portfolio/orders?limit=5");
    assert.ok(verifyPss(publicKey, "1703123456789GET/trade-api/v2/portfolio/orders", sig));
  });
}

test("PEM pasted with literal \\n still imports", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const key = await importPrivateKey(privateKey.trim().replace(/\n/g, "\\n"));
  assert.equal(key.kind, "rsa");
});

test("client signs the full /trade-api/v2 path", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const c = new KalshiClient("https://external-api.demo.kalshi.co/trade-api/v2", "key-id", await importPrivateKey(privateKey));
  const h = await c.headers("GET", "/portfolio/balance");
  assert.equal(h["KALSHI-ACCESS-KEY"], "key-id");
  assert.ok(verifyPss(publicKey, `${h["KALSHI-ACCESS-TIMESTAMP"]}GET/trade-api/v2/portfolio/balance`, h["KALSHI-ACCESS-SIGNATURE"]));
});

test("no auth headers without a key", async () => {
  const c = new KalshiClient("https://external-api.kalshi.com/trade-api/v2");
  assert.equal((await c.headers("GET", "/markets"))["KALSHI-ACCESS-KEY"], undefined);
});
