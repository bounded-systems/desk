// The store (#37). Its two jobs are being idempotent and refusing what it
// cannot push to — both of which fail quietly if they fail at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  subscriptionKey,
  validateSubscription,
  putSubscription,
  listSubscriptions,
  deleteSubscription,
} from "../src/subscriptions.js";
import { fakeKv } from "./fake-kv.mjs";

const SUB = {
  endpoint: "https://fcm.googleapis.com/fcm/send/device-one",
  keys: { p256dh: "BPk_public", auth: "authsecret" },
};

test("the key is derived from the endpoint, so re-subscribing overwrites", async () => {
  const a = await subscriptionKey(SUB.endpoint);
  const b = await subscriptionKey(SUB.endpoint);
  assert.equal(a, b);
  assert.notEqual(a, await subscriptionKey("https://fcm.googleapis.com/fcm/send/device-two"));
  assert.match(a, /^sub:[0-9a-f]{64}$/);
  assert.ok(!a.includes("device-one"), "the raw endpoint must not appear in the key");
});

test("the same device subscribing twice is one record", async () => {
  const kv = fakeKv();
  await putSubscription(kv, SUB);
  await putSubscription(kv, SUB);
  assert.equal((await listSubscriptions(kv)).length, 1);
});

test("a subscription without keys is refused", () => {
  assert.equal(validateSubscription({ endpoint: "https://p.example/x" }).ok, false);
  assert.equal(validateSubscription({ endpoint: "https://p.example/x", keys: { p256dh: "a" } }).ok, false);
  assert.equal(validateSubscription({ ...SUB }).ok, true);
});

test("a non-https endpoint is refused — it would point the sender at any host", () => {
  const r = validateSubscription({ ...SUB, endpoint: "http://attacker.example/x" });
  assert.equal(r.ok, false);
  assert.match(r.error, /https/);
  assert.equal(validateSubscription({ ...SUB, endpoint: "not a url" }).ok, false);
  assert.equal(validateSubscription(null).ok, false);
});

test("an absurdly long endpoint is refused before it is stored", () => {
  const r = validateSubscription({ ...SUB, endpoint: "https://p.example/" + "x".repeat(2000) });
  assert.equal(r.ok, false);
  assert.match(r.error, /too long/);
});

test("listing pages, so a store larger than one KV page is fully read", async () => {
  const kv = fakeKv(2);
  for (let i = 0; i < 7; i++) {
    await putSubscription(kv, { ...SUB, endpoint: `https://fcm.googleapis.com/fcm/send/d${i}` });
  }
  assert.equal((await listSubscriptions(kv)).length, 7);
});

test("an unparseable record is dropped rather than failing every later send", async () => {
  const kv = fakeKv();
  await putSubscription(kv, SUB);
  await kv.put("sub:" + "0".repeat(64), "{not json");
  assert.equal((await listSubscriptions(kv)).length, 1);
  assert.equal(await kv.get("sub:" + "0".repeat(64)), null, "and is removed");
});

test("delete removes exactly the record named", async () => {
  const kv = fakeKv();
  const key = await putSubscription(kv, SUB);
  await putSubscription(kv, { ...SUB, endpoint: "https://fcm.googleapis.com/fcm/send/other" });
  await deleteSubscription(kv, key);
  const left = await listSubscriptions(kv);
  assert.equal(left.length, 1);
  assert.match(left[0].endpoint, /other$/);
});
