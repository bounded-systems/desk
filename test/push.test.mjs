// The parts of Web Push that fail silently (#37): the JWT's audience, the
// signature encoding, and which statuses are allowed to delete a subscription.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  b64url,
  unb64url,
  audienceFor,
  importVapidKey,
  signVapidJwt,
  classifyPushStatus,
  sendPush,
  authorizationsByAudience,
  JWT_TTL_SECONDS,
} from "../src/push.js";

/** A real P-256 pair, generated per run — nothing here is a fixture to leak. */
async function keypair() {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const raw = await crypto.subtle.exportKey("raw", kp.publicKey);
  const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  return { publicKey: b64url(raw), privateKey: jwk.d, verifyKey: kp.publicKey };
}

test("base64url round-trips, and drops padding", () => {
  const bytes = new Uint8Array([0, 1, 250, 251, 252, 253, 254, 255]);
  const enc = b64url(bytes);
  assert.ok(!enc.includes("="), "padding must be stripped");
  assert.ok(!/[+/]/.test(enc), "must use the URL alphabet");
  assert.deepEqual([...unb64url(enc)], [...bytes]);
});

test("aud is the push service's origin, not the endpoint and not ours", () => {
  assert.equal(audienceFor("https://fcm.googleapis.com/fcm/send/abc123"), "https://fcm.googleapis.com");
  assert.equal(audienceFor("https://web.push.apple.com/QRSTUV/xyz"), "https://web.push.apple.com");
});

test("a key pair that is not actually a pair is refused at import", async () => {
  const a = await keypair();
  const b = await keypair();
  await assert.rejects(() => importVapidKey(a.publicKey, b.privateKey), /./);
});

test("a public key that is not a 65-byte uncompressed point is refused", async () => {
  const { privateKey } = await keypair();
  await assert.rejects(() => importVapidKey(b64url(new Uint8Array(64)), privateKey), /65-byte/);
});

test("a private scalar of the wrong length is refused", async () => {
  const { publicKey } = await keypair();
  await assert.rejects(() => importVapidKey(publicKey, b64url(new Uint8Array(31))), /32-byte/);
});

test("the JWT is ES256 over aud/exp/sub, and verifies against the public half", async () => {
  const { publicKey, privateKey, verifyKey } = await keypair();
  const key = await importVapidKey(publicKey, privateKey);
  const now = 1_700_000_000;
  const jwt = await signVapidJwt(
    { audience: "https://fcm.googleapis.com", subject: "mailto:desk@bounded.tools", nowSeconds: now },
    key,
  );

  const [h, c, sig] = jwt.split(".");
  assert.deepEqual(JSON.parse(new TextDecoder().decode(unb64url(h))), { typ: "JWT", alg: "ES256" });
  const claims = JSON.parse(new TextDecoder().decode(unb64url(c)));
  assert.equal(claims.aud, "https://fcm.googleapis.com");
  assert.equal(claims.sub, "mailto:desk@bounded.tools");
  assert.equal(claims.exp, now + JWT_TTL_SECONDS);

  // Raw r‖s, not DER — 64 bytes exactly. If WebCrypto ever changed this, every
  // push would 401 and nothing else here would notice.
  assert.equal(unb64url(sig).length, 64);

  const ok = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    verifyKey,
    unb64url(sig),
    new TextEncoder().encode(`${h}.${c}`),
  );
  assert.ok(ok, "the signature must verify against the advertised public key");
});

test("exp stays inside the 24h every push service enforces", () => {
  assert.ok(JWT_TTL_SECONDS < 24 * 60 * 60, "an exp past 24h is rejected with a 400");
});

test("only 404 and 410 are allowed to mean 'delete this subscription'", () => {
  assert.equal(classifyPushStatus(404), "gone");
  assert.equal(classifyPushStatus(410), "gone");

  // THE ROW THAT MATTERS. 401/403 mean our VAPID key is wrong, which is true of
  // every subscription at once — classifying them as `gone` would empty the
  // whole store on one bad deploy, and the symptom would be silence.
  assert.equal(classifyPushStatus(401), "error");
  assert.equal(classifyPushStatus(403), "error");
  assert.equal(classifyPushStatus(400), "error");

  assert.equal(classifyPushStatus(201), "ok");
  assert.equal(classifyPushStatus(429), "retry");
  assert.equal(classifyPushStatus(503), "retry");
});

test("a push carries no body and the TTL a sleeping phone needs", async () => {
  let seen;
  const res = await sendPush("https://push.example/x", "vapid t=j, k=p", async (url, init) => {
    seen = { url, init };
    return new Response(null, { status: 201 });
  });
  assert.equal(res.outcome, "ok");
  assert.equal(seen.init.method, "POST");
  assert.equal(seen.init.body, undefined, "v1 sends no payload");
  assert.equal(seen.init.headers.ttl, "3600");
  assert.ok(!("content-length" in seen.init.headers), "forbidden header, set by the runtime");
  assert.equal(seen.init.headers.authorization, "vapid t=j, k=p");
});

test("one signature per push service, not per device", async () => {
  const { publicKey, privateKey } = await keypair();
  const key = await importVapidKey(publicKey, privateKey);
  const auths = await authorizationsByAudience(
    [
      "https://fcm.googleapis.com/a",
      "https://fcm.googleapis.com/b",
      "https://web.push.apple.com/c",
    ],
    { publicKey, key, subject: "mailto:desk@bounded.tools" },
  );
  assert.equal(auths.size, 2, "three devices on two services need two JWTs");
  assert.match(auths.get("https://fcm.googleapis.com"), /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);
});
