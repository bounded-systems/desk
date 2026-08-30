// The fan-out (#37) — and specifically the one line in this codebase that can
// delete a subscription. Every test here is about when it must NOT run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { notifyAll } from "../src/notify.js";
import { putSubscription, listSubscriptions } from "../src/subscriptions.js";
import { b64url, importVapidKey } from "../src/push.js";
import { fakeKv } from "./fake-kv.mjs";

async function vapid() {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const publicKey = b64url(await crypto.subtle.exportKey("raw", kp.publicKey));
  const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  return { publicKey, key: await importVapidKey(publicKey, jwk.d), subject: "mailto:desk@bounded.tools" };
}

async function storeWith(kv, ...names) {
  for (const n of names) {
    await putSubscription(kv, {
      endpoint: `https://fcm.googleapis.com/fcm/send/${n}`,
      keys: { p256dh: "p", auth: "a" },
    });
  }
}

test("an empty store reports 0 of 0 rather than success", async () => {
  const census = await notifyAll(fakeKv(), await vapid(), async () => new Response(null, { status: 201 }));
  assert.deepEqual(census, { total: 0, sent: 0, pruned: 0, retry: 0, failed: 0 });
});

test("every stored device is pushed to once", async () => {
  const kv = fakeKv();
  await storeWith(kv, "a", "b", "c");
  const hit = [];
  const census = await notifyAll(kv, await vapid(), async (url) => {
    hit.push(url);
    return new Response(null, { status: 201 });
  });
  assert.equal(census.total, 3);
  assert.equal(census.sent, 3);
  assert.equal(new Set(hit).size, 3);
});

test("410 prunes the dead device and leaves the live ones", async () => {
  const kv = fakeKv();
  await storeWith(kv, "live", "dead");
  const census = await notifyAll(kv, await vapid(), async (url) =>
    new Response(null, { status: url.endsWith("dead") ? 410 : 201 }));
  assert.equal(census.pruned, 1);
  assert.equal(census.sent, 1);
  const left = await listSubscriptions(kv);
  assert.equal(left.length, 1);
  assert.match(left[0].endpoint, /live$/);
});

test("404 prunes too — the other permanent-gone status", async () => {
  const kv = fakeKv();
  await storeWith(kv, "dead");
  const census = await notifyAll(kv, await vapid(), async () => new Response(null, { status: 404 }));
  assert.equal(census.pruned, 1);
  assert.equal((await listSubscriptions(kv)).length, 0);
});

test("A WRONG VAPID KEY DELETES NOTHING — 403 for everyone is our fault, not theirs", async () => {
  const kv = fakeKv();
  await storeWith(kv, "a", "b", "c");
  const census = await notifyAll(kv, await vapid(), async () => new Response(null, { status: 403 }));
  assert.equal(census.failed, 3);
  assert.equal(census.pruned, 0);
  assert.equal((await listSubscriptions(kv)).length, 3, "one bad deploy must not empty the store");
});

test("a 500 is kept for later, not treated as gone", async () => {
  const kv = fakeKv();
  await storeWith(kv, "a");
  const census = await notifyAll(kv, await vapid(), async () => new Response(null, { status: 503 }));
  assert.equal(census.retry, 1);
  assert.equal((await listSubscriptions(kv)).length, 1);
});

test("a device that is merely offline is not deleted for it", async () => {
  const kv = fakeKv();
  await storeWith(kv, "a");
  const census = await notifyAll(kv, await vapid(), async () => { throw new TypeError("network"); });
  assert.equal(census.retry, 1);
  assert.equal(census.pruned, 0);
  assert.equal((await listSubscriptions(kv)).length, 1);
});
