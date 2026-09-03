// DESK LOGIN (desk#65) — the credential that gates VIEWING, and the five ways
// it must not be got around.
//
// Nothing here mocks the verifier: test/authenticator.mjs produces real ES256
// signatures over real WebAuthn byte layouts and the vendored copy verifies
// them, so "the login works" means a signature was checked rather than that a
// stub agreed with itself. The keeper is the ONE thing stubbed — it is another
// Worker over HTTP — and where it is stubbed the test says what the real one
// would have decided.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";
import { fakeKv } from "./fake-kv.mjs";
import { makeAuthenticator, unb64 } from "./authenticator.mjs";
import {
  CEREMONY_TTL_SECONDS,
  COOKIE_NAME,
  DESK_CREDENTIAL_REQUEST_V1,
  KEEPER_ORIGIN,
  PENDING_TTL_SECONDS,
  RP_ID,
  RP_ORIGIN,
  SESSION_TTL_SECONDS,
  activate,
  currentCredential,
  endSessions,
  getCredential,
  loginFinish,
  loginStart,
  mintSession,
  registerFinish,
  registerStart,
  revokeCredential,
} from "../src/login.js";
import { APPROVAL_TTL_SECONDS, putApproval } from "../src/pending.js";
import { QUESTION_TTL_SECONDS, putQuestion, validateQuestion } from "../src/questions.js";

const HOST = "desk.bounded.tools";
const STATIC_HOSTS = ["issues.bounded.tools", "claims.bounded.tools", "prs.bounded.tools"];
const GRANT = "Z3JhbnQtaWQtZnJvbS10aGUta2VlcGVy";
const KEYHOLDER = "a2V5aG9sZGVyLWNyZWQ";

const env = (extra = {}) => ({
  FEED_URL: "https://feed.example/board.json",
  PRS_FEED_URL: "https://feed.example/prs.json",
  SESSION_SECRET: "test-session-secret",
  SUBSCRIPTIONS: fakeKv(),
  ...extra,
});

/** The keeper, standing in for the real one. Records what it was asked. */
function keeper({ ok = true, status = 200, error = "no", seen = [] } = {}) {
  return async (url, init) => {
    seen.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(ok ? { redeemed: { credentialId: KEYHOLDER } } : { error }), {
      status: ok ? 200 : status,
      headers: { "content-type": "application/json" },
    });
  };
}

/** Register a credential. It is PENDING when this returns, always. */
async function register(kv, label = "a phone", opts = {}) {
  const auth = await makeAuthenticator(opts);
  const start = await registerStart(kv, { label });
  assert.equal(start.ok, true, start.reason);
  const made = await auth.register(start.value.challenge, opts);
  const fin = await registerFinish(kv, { ceremonyId: start.value.ceremonyId, ...made });
  return { auth, fin, credentialId: fin.ok ? fin.value.credentialId : null };
}

/** Register and then activate — a credential that may actually sign in. */
async function enrol(kv, label = "a phone") {
  const { auth, credentialId } = await register(kv, label);
  const done = await activate(kv, { credentialId, authorizationId: GRANT }, Date.now(), keeper());
  assert.equal(done.ok, true, done.reason);
  return { auth, credentialId };
}

/** One whole login ceremony, end to end. */
async function signIn(kv, e, auth, opts = {}, now = Date.now()) {
  const start = await loginStart(kv, {}, now);
  assert.equal(start.ok, true, start.reason);
  const got = await auth.assert(start.value.challenge, opts);
  return loginFinish(kv, { ceremonyId: start.value.ceremonyId, ...got }, e, now);
}

const cookieOf = (fin) => fin.cookie.slice(0, fin.cookie.indexOf(";"));

const req = (e, path, { method = "GET", body, cookie, host = HOST } = {}) =>
  worker.fetch(
    new Request(`https://${host}${path}`, {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
    }),
    e,
  );

/** Every route a session is supposed to gate. The loop is the point: a route
 * wired to the cookie parser but not to the admission check only shows up here. */
const GATED_GETS = ["/human.json", "/human", "/queue", "/queue.json"];

// ── A. A PENDING CREDENTIAL AUTHENTICATES NOTHING ───────────────────────────
//
// This is the security crux desk#65 did not answer: a login whose enrolment is
// open proves nothing, because the first visitor becomes the owner.

test("A REGISTERED CREDENTIAL IS PENDING IN THE STORE, and pending is not enumerated", async () => {
  const kv = fakeKv();
  const { credentialId } = await register(kv);
  // The STORE, not the response body: a handler could say "pending" and write
  // anything.
  const stored = JSON.parse(kv.map.get(`login-cred:${credentialId}`));
  assert.equal(stored.status, "pending");
  assert.equal(stored.rpId, RP_ID);
  assert.equal(stored.approvedBy, undefined, "nobody approved it");

  // And it cannot even be offered to a browser: with only pending credentials on
  // file there is nothing to log in as, so no ceremony opens at all.
  const start = await loginStart(kv);
  assert.equal(start.ok, false);
  assert.match(start.reason, /no credential is live/);
});

test("A PENDING CREDENTIAL WITH A PERFECT SIGNATURE IS STILL REFUSED", async () => {
  const kv = fakeKv();
  const e = env({ SUBSCRIPTIONS: kv });
  await enrol(kv, "the live one"); // so a ceremony can be opened at all
  const { auth, credentialId } = await register(kv, "the pending one");

  const fin = await signIn(kv, e, auth);
  assert.equal(fin.ok, false);
  assert.equal(fin.status, 403);
  // Refused for BEING PENDING, not by accident: the signature was valid, the
  // challenge was right and UV was set. A reason mentioning the signature would
  // mean this passed for the wrong reason.
  assert.match(fin.reason, /not activated/);
  assert.ok(!/signature/.test(fin.reason), fin.reason);
  assert.equal(fin.cookie, undefined);

  // ANTI-VACUITY: the SAME authenticator, once a keeper grant activates it,
  // signs in. Without this, "pending cannot authenticate" would also pass on an
  // implementation where nothing can.
  const done = await activate(kv, { credentialId, authorizationId: GRANT }, Date.now(), keeper());
  assert.equal(done.ok, true);
  const second = await signIn(kv, e, auth);
  assert.equal(second.ok, true, second.reason);
  assert.ok(second.cookie);
});

test("the pending credential is refused over HTTP too, and nothing is written", async () => {
  const kv = fakeKv();
  const e = env({ SUBSCRIPTIONS: kv });
  await enrol(kv, "the live one");
  const { auth } = await register(kv, "the pending one");

  const start = await loginStart(kv);
  const got = await auth.assert(start.value.challenge);
  const before = { ...kv.counts };
  const res = await req(e, "/login/finish", { method: "POST", body: { ceremonyId: start.value.ceremonyId, ...got } });
  // 403, not 401: a credential WAS presented and read.
  assert.equal(res.status, 403);
  assert.deepEqual(res.headers.getSetCookie(), [], "a refusal mints no session");
  assert.equal(kv.counts.put, before.put, "a refused login stores nothing");

  // And with no cookie in hand every gated route still refuses.
  for (const path of GATED_GETS) {
    assert.ok([401, 403].includes((await req(e, path)).status), path);
  }
});

// ── activation: the grant is the whole gate ─────────────────────────────────

test("ACTIVATION NEEDS A KEEPER GRANT, and every refusal leaves the credential pending", async () => {
  const kv = fakeKv();
  const { credentialId } = await register(kv);
  const stillPending = async (why) =>
    assert.equal((await getCredential(kv, credentialId)).status, "pending", why);

  // No grant at all.
  const none = await activate(kv, { credentialId }, Date.now(), keeper());
  assert.equal(none.ok, false);
  assert.equal(none.status, 400);
  await stillPending("no grant");

  // A grant the keeper refuses — bound to a different request, already redeemed
  // and expired are all ITS judgement, not desk's, and desk carries the sentence
  // rather than paraphrasing it.
  for (const error of [
    "authorization is bound to a different request",
    "authorization unknown or already redeemed",
    "authorization expired",
  ]) {
    const out = await activate(kv, { credentialId, authorizationId: GRANT }, Date.now(), keeper({ ok: false, status: 403, error }));
    assert.equal(out.ok, false);
    assert.match(out.reason, new RegExp(error.split(" ")[1]));
    await stillPending(error);
  }

  // The keeper unreachable is a refusal, not an admission.
  const down = await activate(kv, { credentialId, authorizationId: GRANT }, Date.now(), async () => {
    throw new Error("connect ECONNREFUSED");
  });
  assert.equal(down.ok, false);
  assert.equal(down.status, 502);
  await stillPending("keeper down");

  // NOT ESTABLISHED, and the test says so rather than hiding it: the keeper does
  // not yet know this request type, so the real /redeem answers 422 until the
  // infra PR lands. Desk refuses and surfaces the sentence verbatim.
  const unknown = await activate(kv, { credentialId, authorizationId: GRANT }, Date.now(),
    keeper({ ok: false, status: 422, error: `unknown request type '${DESK_CREDENTIAL_REQUEST_V1}'` }));
  assert.equal(unknown.status, 422);
  assert.match(unknown.reason, /unknown request type/);
  await stillPending("keeper does not know the type yet");
});

test("the activation request is REBUILT FROM THE STORED RECORD, never taken from the caller", async () => {
  const kv = fakeKv();
  const { credentialId } = await register(kv, "the real label");
  const seen = [];
  await activate(
    kv,
    // A caller trying to describe itself: a different label, a different id, and
    // a request of its own. None of it is read.
    { credentialId, authorizationId: GRANT, label: "something a keyholder would approve", request: { v: "anything" } },
    Date.now(),
    keeper({ seen }),
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, `${KEEPER_ORIGIN}/redeem`);
  assert.deepEqual(seen[0].body.request, {
    v: DESK_CREDENTIAL_REQUEST_V1,
    // rpId is IN the request so the human approving it sees a desk viewing
    // credential rather than what would read as a keeper enrolment.
    rpId: RP_ID,
    credentialId,
    alg: "ES256",
    label: "the real label",
  });
  assert.equal(seen[0].body.requestType, DESK_CREDENTIAL_REQUEST_V1);
});

test("a pending credential cannot activate itself, and an activated one cannot be re-activated", async () => {
  const kv = fakeKv();
  // A store whose ONLY credential is the pending one: if the design let a
  // credential vouch for itself, this is where it would show.
  const { credentialId } = await register(kv);
  const refusing = keeper({ ok: false, status: 403, error: "authorization unknown or already redeemed" });
  assert.equal((await activate(kv, { credentialId, authorizationId: GRANT }, Date.now(), refusing)).ok, false);
  assert.equal((await getCredential(kv, credentialId)).status, "pending");

  const done = await activate(kv, { credentialId, authorizationId: GRANT }, Date.now(), keeper());
  assert.equal(done.value.approvedBy, KEYHOLDER, "which keyholder let it in is recorded");
  // Live is not pending, so there is nothing left to promote — a second grant
  // cannot be spent here.
  const again = await activate(kv, { credentialId, authorizationId: GRANT }, Date.now(), keeper());
  assert.equal(again.ok, false);
  assert.equal(again.status, 404);
});

test("A REGISTRATION CANNOT OVERWRITE AN ENROLLED CREDENTIAL", async () => {
  const kv = fakeKv();
  const { credentialId } = await enrol(kv, "the real device");
  const before = kv.map.get(`login-cred:${credentialId}`);

  // fmt "none" attests nothing, so an attestation may name any credential id it
  // likes — including one already live. If registration overwrote the record,
  // this would replace a live credential's PUBLIC KEY with the attacker's and
  // keep its live status: a complete takeover with no keeper involved.
  const { fin } = await register(kv, "an impostor", { credentialId });
  assert.equal(fin.ok, false);
  assert.equal(fin.status, 409);
  assert.equal(kv.map.get(`login-cred:${credentialId}`), before, "the enrolled record is untouched");
  assert.equal((await getCredential(kv, credentialId)).label, "the real device");
});

// ── C. REPLAY ───────────────────────────────────────────────────────────────

test("A CAPTURED ASSERTION CANNOT BE REPLAYED", async () => {
  const kv = fakeKv();
  const e = env({ SUBSCRIPTIONS: kv });
  const { auth } = await enrol(kv);

  const start = await loginStart(kv);
  const got = await auth.assert(start.value.challenge);
  const body = { ceremonyId: start.value.ceremonyId, ...got };

  const first = await loginFinish(kv, body, e);
  assert.equal(first.ok, true, first.reason);

  const second = await loginFinish(kv, { ...body }, e);
  assert.equal(second.ok, false);
  assert.match(second.reason, /unknown or already used/);
  assert.ok(!/signature/.test(second.reason), "refused as spent, not as forged");
  assert.equal(second.cookie, undefined);

  // The MECHANISM, not only the symptom: the challenge is gone from the store.
  assert.ok(![...kv.map.keys()].some((k) => k.startsWith("login-cer:")));
});

test("CONSUME BEFORE VERIFY — a failed attempt burns the challenge", async () => {
  const kv = fakeKv();
  const e = env({ SUBSCRIPTIONS: kv });
  const { auth } = await enrol(kv);

  const start = await loginStart(kv);
  const tampered = await auth.assert(start.value.challenge, { tamper: true });
  const bad = await loginFinish(kv, { ceremonyId: start.value.ceremonyId, ...tampered }, e);
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /signature invalid/);

  // The good assertion for the SAME challenge is now worthless. Verify-then-
  // consume would have left that challenge open to whoever captured a valid
  // assertion during the failed attempt.
  const good = await auth.assert(start.value.challenge);
  const after = await loginFinish(kv, { ceremonyId: start.value.ceremonyId, ...good }, e);
  assert.equal(after.ok, false);
  assert.match(after.reason, /unknown or already used/);
});

test("a challenge expires, and its record's TTL is the ceremony's own clock", async () => {
  const kv = fakeKv();
  const e = env({ SUBSCRIPTIONS: kv });
  const { auth } = await enrol(kv);
  const T0 = Date.parse("2026-09-03T09:00:00Z");

  const start = await loginStart(kv, {}, T0);
  const got = await auth.assert(start.value.challenge);
  const late = await loginFinish(kv, { ceremonyId: start.value.ceremonyId, ...got }, e, T0 + CEREMONY_TTL_SECONDS * 1000 + 1);
  assert.equal(late.ok, false);
  assert.match(late.reason, /expired/);

  // PER KEY, because a login writes a ceremony record and (on success) a
  // credential record on different clocks; a spy keeping one options bag would
  // read one TTL as the other's and call that green.
  const seen = new Map();
  const spy = { ...kv, put: async (k, v, o) => { seen.set(k, o); return kv.put(k, v); } };
  const s2 = await registerStart(spy, { label: "x" }, T0);
  const cerKey = [...seen.keys()].find((k) => k.startsWith("login-cer:"));
  assert.equal(seen.get(cerKey).expirationTtl, CEREMONY_TTL_SECONDS);
  assert.ok(s2.ok);
  // Three different clocks that must not be tidied into one.
  assert.notEqual(CEREMONY_TTL_SECONDS, APPROVAL_TTL_SECONDS);
  assert.notEqual(CEREMONY_TTL_SECONDS, QUESTION_TTL_SECONDS);
  assert.ok(CEREMONY_TTL_SECONDS < APPROVAL_TTL_SECONDS, "a tap takes seconds; a window is minutes");
});

test("A PENDING CREDENTIAL EXPIRES; A LIVE ONE DOES NOT", async () => {
  const kv = fakeKv();
  const seen = new Map();
  const spy = { ...kv, put: async (k, v, o) => { seen.set(k, o); return kv.put(k, v); } };
  const { credentialId } = await register(spy);

  // Registration is open, so an anonymous caller with a soft authenticator can
  // write pending records as fast as it can sign. The TTL is what bounds the
  // store — and it bounds it without ever refusing a real enrolment, which a cap
  // would not.
  assert.equal(seen.get(`login-cred:${credentialId}`).expirationTtl, PENDING_TTL_SECONDS);
  assert.ok(PENDING_TTL_SECONDS > CEREMONY_TTL_SECONDS * 100, "a keyholder may be asleep");

  await activate(spy, { credentialId, authorizationId: GRANT }, Date.now(), keeper());
  // A live credential that expired on its own would silently un-enrol a person.
  // The bag itself is no longer empty — every credential put carries the status
  // index `liveCredentials` reads — so this asserts the TTL, not the bag.
  assert.equal(seen.get(`login-cred:${credentialId}`).expirationTtl, undefined, "activation makes it durable");

  await revokeCredential(spy, credentialId);
  assert.equal(seen.get(`login-cred:${credentialId}`).expirationTtl, undefined,
    "and a revocation that expired would let the id be registered again");
});

// ── D. THE CHALLENGE IS BOUND TO THE ATTEMPT ────────────────────────────────

test("TWO CEREMONIES CANNOT BE CROSSED", async () => {
  const kv = fakeKv();
  const e = env({ SUBSCRIPTIONS: kv });
  const { auth } = await enrol(kv);

  const a = await loginStart(kv);
  const b = await loginStart(kv);
  assert.notEqual(a.value.challenge, b.value.challenge, "each attempt gets its own challenge");

  const signedForB = await auth.assert(b.value.challenge);
  const crossed = await loginFinish(kv, { ceremonyId: a.value.ceremonyId, ...signedForB }, e);
  assert.equal(crossed.ok, false);
  assert.match(crossed.reason, /challenge mismatch/);

  const signedForA = await auth.assert(a.value.challenge);
  const other = await loginFinish(kv, { ceremonyId: b.value.ceremonyId, ...signedForA }, e);
  assert.equal(other.ok, false);
  assert.match(other.reason, /challenge mismatch/);
});

test("the challenge is the server's, 32 random bytes, and never the caller's", async () => {
  const kv = fakeKv();
  await enrol(kv);
  const mine = "Y2hvc2VuLWJ5LXRoZS1jYWxsZXItbm90LXRoZS1zZXJ2ZXI";
  const a = await loginStart(kv, { challenge: mine });
  assert.notEqual(a.value.challenge, mine, "a challenge you were handed is a name the caller chose");
  assert.equal(unb64(a.value.challenge).length, 32);
  const b = await loginStart(kv, {});
  assert.notEqual(a.value.challenge, b.value.challenge);
});

test("the relying party is DESK, and an approval-scoped assertion is unusable here", async () => {
  const kv = fakeKv();
  const e = env({ SUBSCRIPTIONS: kv });
  assert.equal(RP_ID, "desk.bounded.tools");
  assert.equal(RP_ORIGIN, "https://desk.bounded.tools");

  const { auth } = await enrol(kv);
  // Desk MUST NEVER verify an approval assertion (desk#65). Stated in prose it
  // is a convention; these three make it mechanical.
  for (const [name, opts, re] of [
    ["keeper origin", { origin: "https://keeper.bounded.tools" }, /origin/],
    ["keeper rp.id", { rpId: "keeper.bounded.tools" }, /rpIdHash mismatch/],
    ["no user verification", { uv: false }, /UV not set/],
  ]) {
    const out = await signIn(kv, e, auth, opts);
    assert.equal(out.ok, false, name);
    assert.match(out.reason, re, name);
  }

  // And on the way OUT: a stored record scoped to another relying party reads as
  // ABSENT rather than as a usable credential.
  const raw = JSON.parse(kv.map.get([...kv.map.keys()].find((k) => k.startsWith("login-cred:"))));
  kv.map.set(`login-cred:${raw.credentialId}`, JSON.stringify({ ...raw, rpId: "keeper.bounded.tools" }));
  assert.equal(await getCredential(kv, raw.credentialId), null);
});

// ── B. THE COOKIE ───────────────────────────────────────────────────────────

test("THE SESSION COOKIE CARRIES NO SECRET AND NO KEEPER MATERIAL", async () => {
  const kv = fakeKv();
  const e = env({ SUBSCRIPTIONS: kv });
  const { auth, credentialId } = await enrol(kv);
  const start = await loginStart(kv);
  const got = await auth.assert(start.value.challenge);
  const res = await req(e, "/login/finish", { method: "POST", body: { ceremonyId: start.value.ceremonyId, ...got } });
  assert.equal(res.status, 200);

  // getSetCookie(), not get(): undici joins multiple cookies with ", " and a
  // second cookie would hide inside the first one's string.
  const cookies = res.headers.getSetCookie();
  assert.equal(cookies.length, 1);
  const raw = cookies[0];

  assert.ok(raw.startsWith(`${COOKIE_NAME}=`));
  assert.match(COOKIE_NAME, /^__Host-/, "the browser then enforces Secure, Path=/ and no Domain");
  for (const attr of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/"]) {
    assert.ok(raw.includes(attr), `${attr} is missing`);
  }
  // The VALUE, not the presence: an attribute that exists and reads 2592000 is
  // how a thirty-day session ships looking short-lived.
  assert.equal(Number(/Max-Age=(\d+)/.exec(raw)[1]), SESSION_TTL_SECONDS);
  assert.ok(SESSION_TTL_SECONDS <= 12 * 60 * 60, "short-lived means short");
  // One Worker serves four hostnames in one zone; a Domain would hand desk's
  // session to issues/claims/prs.
  assert.ok(!/Domain=/i.test(raw), "no Domain attribute");
  assert.equal(res.headers.get("cache-control"), "no-store");

  // WHAT IS IN IT. deepEqual on the key set, because that is the only form that
  // fails when a future field is ADDED.
  const value = raw.slice(raw.indexOf("=") + 1, raw.indexOf(";"));
  const payload = JSON.parse(new TextDecoder().decode(unb64(value.slice(0, value.indexOf(".")))));
  assert.deepEqual(Object.keys(payload).sort(), ["cid", "ep", "exp", "iat", "sid", "v"]);
  assert.equal(payload.cid, credentialId);

  const stored = await getCredential(kv, credentialId);
  for (const secret of [stored.publicKey.x, stored.publicKey.y, stored.publicKey.crv, start.value.challenge, start.value.ceremonyId, GRANT, KEYHOLDER, e.SESSION_SECRET]) {
    assert.ok(!raw.includes(secret), `the cookie carries ${secret}`);
  }
});

test("a forged cookie is refused before the store is read", async () => {
  const kv = fakeKv();
  const e = env({ SUBSCRIPTIONS: kv });
  const { auth } = await enrol(kv);
  const fin = await signIn(kv, e, auth);
  const good = cookieOf(fin);

  // The FIRST character of the MAC changed, not the last: base64url's last
  // character of a 32-byte value carries two slack bits, so four spellings
  // decode to the same MAC and a test that flipped it there passed only about
  // fifteen times in sixteen. (Found by running the suite twice.)
  const dot = good.indexOf(".");
  const flipped = good.slice(0, dot + 1) + (good[dot + 1] === "A" ? "B" : "A") + good.slice(dot + 2);
  assert.notEqual(flipped, good);
  const before = { ...kv.counts };
  const res = await req(e, "/queue.json", { cookie: flipped });
  assert.equal(res.status, 401);
  assert.deepEqual(kv.counts, before, "a forged cookie read nothing");

  // ANTI-VACUITY: the unflipped one is admitted, and DOES cost a read.
  const ok = await req(e, "/queue.json", { cookie: good });
  assert.equal(ok.status, 200);
  assert.ok(kv.counts.get > before.get);
});

test("a session naming a credential that is not there admits nobody", async () => {
  const kv = fakeKv();
  const e = env({ SUBSCRIPTIONS: kv });
  await enrol(kv);
  const forged = await mintSession(e.SESSION_SECRET, "bm90LWEtcmVhbC1jcmVkZW50aWFs");
  const res = await req(e, "/queue.json", { cookie: `${COOKIE_NAME}=${forged.value}` });
  assert.equal(res.status, 403);
});

test("an expired session is refused even though its MAC is good", async () => {
  const kv = fakeKv();
  const e = env({ SUBSCRIPTIONS: kv });
  const { credentialId } = await enrol(kv);
  // Minted in the past, so its own `exp` has passed — the clock is an argument
  // to mintSession because the HTTP boundary has no clock to inject.
  const old = await mintSession(e.SESSION_SECRET, credentialId, Date.now() - (SESSION_TTL_SECONDS + 60) * 1000);
  const res = await req(e, "/queue.json", { cookie: `${COOKIE_NAME}=${old.value}` });
  assert.equal(res.status, 401);
  assert.deepEqual(res.headers.getSetCookie().length, 1, "and the dead cookie is cleared");
  assert.match(res.headers.getSetCookie()[0], /Max-Age=0/);
});

test("logout clears the cookie with the SAME attributes it was set with", async () => {
  const e = env();
  const res = await req(e, "/login/logout", { method: "POST" });
  assert.equal(res.status, 200);
  const raw = res.headers.getSetCookie()[0];
  // A clear whose attributes do not match the original does not clear.
  for (const attr of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/", "Max-Age=0"]) {
    assert.ok(raw.includes(attr), `${attr} is missing from the clear`);
  }
  assert.ok(!/Domain=/i.test(raw));
});

test("no login route and no cookie exists on the static hosts", async () => {
  const e = env();
  for (const host of STATIC_HOSTS) {
    for (const path of ["/login/start", "/login/finish", "/login/register/start", "/login/activate", "/login/logout"]) {
      const res = await req(e, path, { method: "POST", body: {}, host });
      assert.equal(res.status, 404, `${host}${path}`);
      assert.deepEqual(res.headers.getSetCookie(), [], `${host}${path} minted a cookie`);
    }
    for (const path of ["/queue", "/queue.json", "/login", "/login/start"]) {
      const res = await req(e, path, { host });
      // 404, not the board: a page inviting a passkey at an origin the
      // credential was never scoped to is worse than a missing page.
      assert.equal(res.status, 404, `${host}${path}`);
      assert.ok(!/<h1>/.test(await res.text()), `${host}${path} served a board`);
    }
  }
});

// ── E. REVOCATION IS CHECKED AT ADMISSION ───────────────────────────────────
//
// The one assertion that separates "checked when the cookie was issued" from
// "checked". A long-lived grant that nothing re-reads is how a revoked keyholder
// keeps their access.

test("A REVOKED CREDENTIAL LOSES ITS SESSION AT THE NEXT REQUEST, on every gated route", async () => {
  const kv = fakeKv();
  const e = env({ SUBSCRIPTIONS: kv });
  const { auth, credentialId } = await enrol(kv);
  const fin = await signIn(kv, e, auth);
  const cookie = cookieOf(fin);

  // ANTI-VACUITY FIRST: while it is live, every gated route serves.
  for (const path of GATED_GETS) {
    assert.equal((await req(e, path, { cookie })).status, 200, `${path} while live`);
  }

  await revokeCredential(kv, credentialId);

  // The SAME cookie, no clock advance, still well inside its Max-Age.
  for (const path of GATED_GETS) {
    const res = await req(e, path, { cookie });
    assert.equal(res.status, 403, `${path} after revocation`);
    // The refusal names re-authentication and clears the dead cookie, rather
    // than reading as "no such route".
    assert.match(await res.clone().text(), /sign in again/);
    assert.match(res.headers.getSetCookie()[0], /Max-Age=0/);
  }
});

test("a credential DEMOTED to pending also loses its session, not only a revoked one", async () => {
  const kv = fakeKv();
  const e = env({ SUBSCRIPTIONS: kv });
  const { auth, credentialId } = await enrol(kv);
  const cookie = cookieOf(await signIn(kv, e, auth));
  assert.equal((await req(e, "/queue.json", { cookie })).status, 200);

  const rec = JSON.parse(kv.map.get(`login-cred:${credentialId}`));
  kv.map.set(`login-cred:${credentialId}`, JSON.stringify({ ...rec, status: "pending" }));
  assert.equal((await req(e, "/queue.json", { cookie })).status, 403);

  // And a status nobody has heard of is not live either — the test is POSITIVE
  // (`=== "live"`), so a half-written or migrated record fails closed.
  kv.map.set(`login-cred:${credentialId}`, JSON.stringify({ ...rec, status: "LIVE" }));
  assert.equal((await req(e, "/queue.json", { cookie })).status, 403);
  delete rec.status;
  kv.map.set(`login-cred:${credentialId}`, JSON.stringify(rec));
  assert.equal((await req(e, "/queue.json", { cookie })).status, 403);
});

test("THE STORE IS READ ON EVERY ADMISSION, not once and remembered", async () => {
  const kv = fakeKv();
  const e = env({ SUBSCRIPTIONS: kv });
  const { auth } = await enrol(kv);
  const cookie = cookieOf(await signIn(kv, e, auth));

  const first = { ...kv.counts };
  assert.equal((await req(e, "/queue.json", { cookie })).status, 200);
  const second = { ...kv.counts };
  assert.ok(second.get > first.get, "the first gated request read the credential");
  assert.equal((await req(e, "/queue.json", { cookie })).status, 200);
  // A memoised lookup is exactly the defect: without this, (E) above passes on
  // an implementation that happens to re-read today and caches tomorrow.
  assert.ok(kv.counts.get > second.get, "and so did the second");
});

test("an unconfigured deploy refuses every gated route rather than admitting", async () => {
  const kv = fakeKv();
  const { auth } = await enrol(kv);
  const complete = env({ SUBSCRIPTIONS: kv });
  const cookie = cookieOf(await signIn(kv, complete, auth));

  const noKey = { ...complete };
  delete noKey.SESSION_SECRET;
  for (const path of GATED_GETS) {
    const res = await req(noKey, path, { cookie });
    assert.equal(res.status, 503, path);
    assert.match(await res.text(), /signing key/, path);
  }
  // A valid cookie against a deployment with no store is a refusal too.
  const noStore = { ...complete, SUBSCRIPTIONS: undefined };
  assert.equal((await currentCredential(new Request(`https://${HOST}/`), noStore)).ok, false);
});

test("REVOCATION IS BEHIND THE SESSION, and an anonymous caller cannot spend one", async () => {
  const kv = fakeKv();
  const e = env({ SUBSCRIPTIONS: kv });
  const { auth, credentialId } = await enrol(kv);

  const anon = await req(e, "/login/revoke", { method: "POST", body: { credentialId } });
  assert.equal(anon.status, 401);
  assert.equal((await getCredential(kv, credentialId)).status, "live", "a shut door revoked nothing");

  const cookie = cookieOf(await signIn(kv, e, auth));
  const done = await req(e, "/login/revoke", { method: "POST", body: { credentialId }, cookie });
  assert.equal(done.status, 200);
  assert.equal((await getCredential(kv, credentialId)).status, "revoked");
  // And the session it was spent from is gone at the very next request — the
  // admission re-read makes revoking yourself immediate rather than eventual.
  assert.equal((await req(e, "/queue.json", { cookie })).status, 403);
});

test("A LOGIN THAT RACED A REVOCATION DOES NOT PUT THE CREDENTIAL BACK", async () => {
  const kv = fakeKv();
  const e = env({ SUBSCRIPTIONS: kv });
  const { auth, credentialId } = await enrol(kv);

  const start = await loginStart(kv, {}, Date.now());
  // signCount > 0 is a HARDWARE authenticator — the only shape that reaches the
  // write-back at all, since a synced passkey reports 0 forever and skips it.
  const got = await auth.assert(start.value.challenge, { signCount: 7 });

  // The revocation lands after loginFinish has read the credential and before it
  // writes: the assertion verifies against a snapshot that is already stale. In
  // production the same window is wall-clock rather than microseconds, because a
  // colo can serve the pre-revocation record from KV's edge cache.
  const realGet = kv.get.bind(kv);
  let raced = false;
  kv.get = async (k) => {
    const value = await realGet(k);
    if (!raced && k === `login-cred:${credentialId}`) {
      raced = true;
      await revokeCredential(kv, credentialId);
    }
    return value;
  };
  const fin = await loginFinish(kv, { ceremonyId: start.value.ceremonyId, ...got }, e, Date.now());
  kv.get = realGet;
  assert.ok(raced, "the interposed revocation ran");

  // THE STORE, not the response: the defect is a write, and it is invisible in
  // what loginFinish returns.
  const after = await getCredential(kv, credentialId);
  assert.equal(after.status, "revoked", "the sign-count write-back must not resurrect it");
  assert.equal(typeof after.revokedAt, "number", "and must not erase the evidence");
  // Whatever cookie that ceremony minted, the admission re-read refuses it —
  // which is the claim the write-back was quietly falsifying.
  if (fin.ok) assert.equal((await req(e, "/queue.json", { cookie: cookieOf(fin) })).status, 403);
});

test("the sign count is still recorded on a login that raced nothing", async () => {
  const kv = fakeKv();
  const e = env({ SUBSCRIPTIONS: kv });
  const { auth, credentialId } = await enrol(kv);

  assert.ok((await signIn(kv, e, auth, { signCount: 7 })).ok);
  assert.equal((await getCredential(kv, credentialId)).signCount, 7, "recorded, not enforced");
  // And the re-read did not cost the record its status index — a credential that
  // fell out of `allowCredentials` after its first sign-in would be a silent
  // half-failure, since loginFinish would still admit it.
  assert.deepEqual(kv.meta.get(`login-cred:${credentialId}`), { status: "live" });
  assert.equal((await loginStart(kv, {}, Date.now())).value.allowCredentials.length, 1);

  // A synced passkey reports 0 forever: nothing is written, and the recorded
  // counter is not destroyed.
  assert.ok((await signIn(kv, e, auth, { signCount: 0 })).ok);
  assert.equal((await getCredential(kv, credentialId)).signCount, 7);
});

test("an activation cannot promote a credential revoked while the grant was in flight", async () => {
  const kv = fakeKv();
  const { credentialId } = await register(kv);

  // The keeper round trip is the widest window in the module. Revoking inside it
  // models a keyholder who changed their mind after approving — and the grant is
  // spent by then, so refusing is the only safe answer.
  const racing = async (url, init) => {
    await revokeCredential(kv, credentialId);
    return keeper()(url, init);
  };
  const out = await activate(kv, { credentialId, authorizationId: GRANT }, Date.now(), racing);
  assert.equal(out.ok, false);
  assert.equal(out.status, 409);
  assert.equal((await getCredential(kv, credentialId)).status, "revoked");
  assert.equal((await loginStart(kv, {}, Date.now())).ok, false, "and nothing is live to sign in");
});

// The mirror of the test above, and the reason the re-read compares the status
// to what it was rather than to a set of allowed values. Once `revoked` became
// activatable (the desk#65 lockout fix), "is it still activatable?" would have
// admitted BOTH races — a withdrawal landing during a pending activation, and a
// second grant landing during a re-admission. Only equality refuses both.
test("a re-admission cannot spend a second grant on a credential someone else already re-admitted", async () => {
  const kv = fakeKv();
  const { credentialId } = await register(kv);
  await activate(kv, { credentialId, authorizationId: GRANT }, Date.now(), keeper());
  await revokeCredential(kv, credentialId);

  // Two keyholders re-admit the same credential at once; the slower grant is
  // spent and must promote nothing, because the record it was redeemed against
  // is not the record that is there now.
  const racing = async (url, init) => {
    await activate(kv, { credentialId, authorizationId: GRANT }, Date.now(), keeper());
    return keeper()(url, init);
  };
  const out = await activate(kv, { credentialId, authorizationId: GRANT }, Date.now(), racing);
  assert.equal(out.ok, false);
  assert.equal(out.status, 409);
  assert.equal((await getCredential(kv, credentialId)).status, "live", "the FIRST re-admission stands");
});

// ── F. THE DOOR'S COST IS NOT THE ATTACKER'S TO CHOOSE ──────────────────────
//
// Registration is open, unauthenticated and unrated by design — the gate is the
// activation, not the registration. So anything /login/start does PER REGISTERED
// RECORD is a lever an anonymous caller holds, and the Worker's subrequest cap
// turns it into a lockout: no login means no /queue, no /human listing, no
// answer route, and no /login/revoke to clear the spam.

test("REGISTRATION SPAM DOES NOT MAKE THE LOGIN DOOR MORE EXPENSIVE", async () => {
  const kv = fakeKv();
  await enrol(kv);

  const SPAM = 400;
  for (let i = 0; i < SPAM; i++) {
    const { fin } = await register(kv, `spam ${i}`);
    assert.equal(fin.ok, true, fin.reason);
  }

  kv.counts.get = 0;
  kv.counts.list = 0;
  const start = await loginStart(kv, {}, Date.now());
  assert.equal(start.ok, true, start.reason);
  assert.equal(start.value.allowCredentials.length, 1, "the pending records are still not enumerated");
  // The bound is ACTIVATED credentials, which only a keeper grant can grow —
  // not registered ones, which anyone can. The constant is slack for the
  // implementation, not a budget: what fails here is O(spam).
  assert.ok(kv.counts.get < 10, `reads scaled with the spam: ${kv.counts.get} for ${SPAM} pending records`);
  // Honest about what is NOT fixed: list() still walks the whole prefix, at one
  // subrequest per page rather than per record.
  assert.ok(kv.counts.list <= 2, `lists: ${kv.counts.list}`);
});

// ── the answer door, now that it has a credential ───────────────────────────

test("THE ANSWER DOOR OPENS FOR A SESSION AND FOR NOTHING ELSE", async () => {
  const kv = fakeKv();
  const e = env({ SUBSCRIPTIONS: kv });
  const { auth } = await enrol(kv);
  const cookie = cookieOf(await signIn(kv, e, auth));
  const ask = validateQuestion({ prompt: "ship it?", choices: ["yes", "no"], no_answer_policy: "block" }).value;
  const q = await putQuestion(kv, ask);

  const anon = await req(e, `/human/${q.id}/answer`, { method: "POST", body: { value: "yes" } });
  assert.equal(anon.status, 401);
  // The seam is `mayAnswer`, and it is consulted before the body is read: a door
  // that is shut stores nothing a caller sent it.
  assert.equal(JSON.parse(kv.map.get(`question:${q.id}`)).answer, null);

  const res = await req(e, `/human/${q.id}/answer`, { method: "POST", body: { value: "yes" }, cookie });
  assert.equal(res.status, 200);
  const stored = JSON.parse(kv.map.get(`question:${q.id}`));
  assert.equal(stored.answer.value, "yes");
  // The RUNG does not move because a passkey was involved: this credential gates
  // viewing, and an answer is still information.
  assert.equal(stored.answer.rung, "human-reviewed");
});

// ── the queue (desk#65's actual ask) ────────────────────────────────────────

test("THE QUEUE IS THE WHOLE PENDING SET, and only to a signed-in reader", async () => {
  const kv = fakeKv();
  const e = env({ SUBSCRIPTIONS: kv });
  const { auth } = await enrol(kv);
  await putApproval(kv, { title: "Rotate the leaked deploy key", body: "claim 41 of 41", url: `${KEEPER_ORIGIN}/a/aaa111` });
  await putApproval(kv, { title: "Deploy the keeper", body: "infra#560", url: `${KEEPER_ORIGIN}/a/bbb222` });

  // LOGGED OUT: not an empty queue, and nothing about any ceremony.
  const out = await req(e, "/queue");
  assert.equal(out.status, 401);
  const shut = await out.text();
  assert.match(shut, /not an empty queue/);
  for (const leak of ["Rotate the leaked deploy key", "aaa111", "bbb222", "infra#560"]) {
    assert.ok(!shut.includes(leak), `the shut queue leaked ${leak}`);
  }
  assert.equal(out.headers.get("cache-control"), "no-store");
  assert.equal(out.headers.get("vary"), "cookie");

  const j = await (await req(e, "/queue.json")).json();
  assert.equal(j.kind, "closed");
  assert.equal(j.approvals, undefined);

  // SIGNED IN: both entries, newest first, each a link to the keeper.
  const cookie = cookieOf(await signIn(kv, e, auth));
  const open = await req(e, "/queue.json", { cookie });
  assert.equal(open.status, 200);
  const body = await open.json();
  assert.equal(body.kind, "queue");
  assert.equal(body.approvals.length, 2);
  // ONLY title, body, url and the time it was raised — no ceremony material.
  assert.deepEqual(Object.keys(body.approvals[0]).sort(), ["at", "body", "kind", "title", "url"]);
  for (const a of body.approvals) assert.match(a.url, /^https:\/\/keeper\.bounded\.tools\/a\//);

  const page = await (await req(e, "/queue", { cookie })).text();
  assert.match(page, /Rotate the leaked deploy key/);
  assert.match(page, /keeper\.bounded\.tools\/a\/aaa111/);
  // NO BATCH CONTROL, and no control at all: rows 5-6 of the infra#555 chain are
  // display → intent, and one button meaning yes to a set attacks both.
  assert.ok(!/approve all/i.test(page));
  assert.ok(!/<form/.test(page.slice(page.indexOf("<body>"))));
  assert.ok(!/<button/.test(page.slice(page.indexOf("<body>"))));
});

test("the queue does not link a stored url that is not a keeper ceremony", async () => {
  const kv = fakeKv();
  const e = env({ SUBSCRIPTIONS: kv });
  const { auth } = await enrol(kv);
  await putApproval(kv, { title: "real", body: "b", url: `${KEEPER_ORIGIN}/a/ccc333` });
  // Written straight into the store, past validateApproval, which is untouched:
  // the on-the-way-out check is what makes a record that got in some other way
  // unlinkable rather than merely unlikely.
  kv.map.set("pending:approval:evil", JSON.stringify({ title: "tap here", body: "b", url: "https://evil.example/a/x", at: new Date().toISOString() }));

  const cookie = cookieOf(await signIn(kv, e, auth));
  const body = await (await req(e, "/queue.json", { cookie })).json();
  assert.equal(body.approvals.length, 1);
  assert.equal(body.approvals[0].title, "real");
  assert.ok(!(await (await req(e, "/queue", { cookie })).text()).includes("evil.example"));
});

test("an empty queue says so, and says it differently from a shut one", async () => {
  const kv = fakeKv();
  const e = env({ SUBSCRIPTIONS: kv });
  const { auth } = await enrol(kv);
  const cookie = cookieOf(await signIn(kv, e, auth));
  const page = await (await req(e, "/queue", { cookie })).text();
  assert.match(page, /Nothing is waiting/);
  assert.ok(!/not an empty queue/.test(page), "'none pending' and 'not yours to read' are different sentences");
});

test("/pending is untouched — still anonymous, still one thing", async () => {
  const kv = fakeKv();
  const e = env({ SUBSCRIPTIONS: kv });
  await putApproval(kv, { title: "an approval", body: "b", url: `${KEEPER_ORIGIN}/a/ddd444` });
  const res = await req(e, "/pending");
  // The service worker fetches this on every push wake with no credential. The
  // queue is a NEW route; gating this one would break the notification.
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.kind, "approval");
  assert.equal(body.title, "an approval");
});

// ── logout actually invalidates, and revocation kills live cookies (desk#65 review) ──
//
// Three reviewers found that `sid` was minted into every cookie and never stored
// or consulted, so signing out cleared the browser's copy and invalidated
// nothing: a cookie captured beforehand kept admitting for the full 8 hours.
// These pin the epoch that fixes it. Each one FAILS if the check is removed.

test("a cookie minted before logout stops admitting after it", async () => {
  const kv = fakeKv();
  const cred = { credentialId: "AAAA", rpId: RP_ID, status: "live", sessionEpoch: 0 };
  await kv.put(`login-cred:${cred.credentialId}`, JSON.stringify(cred));
  const env = { SESSION_SECRET: "s3cret", SUBSCRIPTIONS: kv };

  const before = await mintSession(env.SESSION_SECRET, cred.credentialId, Date.now(), 0);
  const withCookie = { headers: { get: (h) => (h === "cookie" ? `__Host-desk_session=${before.value}` : null) } };

  assert.equal((await currentCredential(withCookie, env)).ok, true, "admits before logout");
  await endSessions(kv, cred.credentialId);
  const after = await currentCredential(withCookie, env);
  assert.equal(after.ok, false, "THE POINT: the same cookie no longer admits");
  assert.equal(after.status, 401);
  assert.equal(after.clear, true, "and the browser is told to drop it");
});

test("revocation also bumps the epoch, so a re-activated credential cannot resurrect old sessions", async () => {
  const kv = fakeKv();
  const cred = { credentialId: "BBBB", rpId: RP_ID, status: "live", sessionEpoch: 0 };
  await kv.put(`login-cred:${cred.credentialId}`, JSON.stringify(cred));
  const env = { SESSION_SECRET: "s3cret", SUBSCRIPTIONS: kv };

  const old = await mintSession(env.SESSION_SECRET, cred.credentialId, Date.now(), 0);
  await revokeCredential(kv, cred.credentialId);
  // THE REAL RE-ACTIVATION, not a hand-written imitation of one. This test used
  // to put the record back to `live` itself and call that "the shape a future
  // re-activation would take" — which tested the fixture, not the code. Now that
  // `activate()` admits a revoked credential, exercise it.
  const back = await activate(kv, { credentialId: cred.credentialId, authorizationId: GRANT }, Date.now(), keeper());
  assert.equal(back.ok, true, "a keeper grant re-admits a revoked credential");
  assert.equal((await getCredential(kv, cred.credentialId)).status, "live");

  const req = { headers: { get: (h) => (h === "cookie" ? `__Host-desk_session=${old.value}` : null) } };
  assert.equal((await currentCredential(req, env)).ok, false, "a cookie from before the revocation stays dead");
});

// desk#65 carried item, now closed. `/login/revoke` is gated on a live session
// rather than a grant — deliberately, so revocation stays reachable when the
// keeper is down, which is the incident where it is most wanted. The cost was
// that one stolen session could withdraw every enrolled credential and the
// lockout was PERMANENT. Making the withdrawal recoverable by the keeper closes
// that without handing the thief anything: re-admission costs a grant, and a
// stolen desk session can approve nothing, here or at the keeper.
test("a revoked credential is recoverable BY A KEEPER GRANT, and by nothing else", async () => {
  const kv = fakeKv();
  const { credentialId } = await register(kv);
  await activate(kv, { credentialId, authorizationId: GRANT }, Date.now(), keeper());
  await revokeCredential(kv, credentialId);
  assert.equal((await getCredential(kv, credentialId)).status, "revoked");

  // A refused grant leaves it revoked. This is the anti-vacuity half: without
  // it, "revoked credentials can be re-admitted" would pass for a version that
  // re-admitted them unconditionally.
  const refusing = keeper({ ok: false, status: 403, error: "authorization unknown or already redeemed" });
  const denied = await activate(kv, { credentialId, authorizationId: GRANT }, Date.now(), refusing);
  assert.equal(denied.ok, false);
  assert.equal((await getCredential(kv, credentialId)).status, "revoked", "a refused grant changes nothing");

  const back = await activate(kv, { credentialId, authorizationId: GRANT }, Date.now(), keeper());
  assert.equal(back.ok, true);
  const rec = await getCredential(kv, credentialId);
  assert.equal(rec.status, "live");
  assert.ok(rec.reactivatedAt, "the re-admission is recorded");
  assert.equal(rec.revokedAt, undefined, "`revokedAt` means CURRENTLY withdrawn, so it is cleared");
});

test("re-activation does not roll the epoch back", async () => {
  // The bug this pins is a plausible tidy-up: writing a fresh record on
  // re-admission, or resetting `sessionEpoch` to 0, would resurrect every
  // session the revocation killed. `revokeCredential` bumps the epoch for
  // exactly this reason, so the bump must survive the round trip.
  const kv = fakeKv();
  const { credentialId } = await register(kv);
  await activate(kv, { credentialId, authorizationId: GRANT }, Date.now(), keeper());
  await revokeCredential(kv, credentialId);
  const revoked = await getCredential(kv, credentialId);
  await activate(kv, { credentialId, authorizationId: GRANT }, Date.now(), keeper());
  const relived = await getCredential(kv, credentialId);
  assert.equal(relived.sessionEpoch, revoked.sessionEpoch, "the epoch carries forward unchanged");
  assert.ok(relived.sessionEpoch > 0, "and it is the BUMPED one, not a default zero");
});

test("an epoch-less cookie is honoured, so a deploy does not sign everyone out", async () => {
  // Backwards compatibility, stated as a test rather than trusted: readSession
  // defaults a missing `ep` to 0, and a record that has never been bumped is
  // also 0, so the comparison admits.
  const kv = fakeKv();
  await kv.put("login-cred:CCCC", JSON.stringify({ credentialId: "CCCC", rpId: RP_ID, status: "live" }));
  const env = { SESSION_SECRET: "s3cret", SUBSCRIPTIONS: kv };
  const s = await mintSession(env.SESSION_SECRET, "CCCC", Date.now(), 0);
  const req = { headers: { get: (h) => (h === "cookie" ? `__Host-desk_session=${s.value}` : null) } };
  assert.equal((await currentCredential(req, env)).ok, true);
});
