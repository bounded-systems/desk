// DESK LOGIN — the credential that gates VIEWING, and never approving (desk#65).
//
// ── TWO CREDENTIALS, TWO PURPOSES ───────────────────────────────────────────
//
//   desk login,        rp.id = desk.bounded.tools     gates VIEWING
//   keyholder passkey, rp.id = keeper.bounded.tools   gates APPROVING
//
// Desk MUST NEVER verify an approval assertion. keeper#641 keeps that rp.id
// narrow on purpose, and a record whose relying party is the requester caps at
// `human-reviewed` — a committed vector in claim-digest.vectors.json. Viewing is
// fine at that rung. Approving is not, and stays at the keeper: tapping an entry
// in the queue still goes to keeper.bounded.tools/a/<id>, exactly as before.
//
// So the rp.id and the origin here are LITERALS. `surfaceFor()` gives desk no
// hostname of its own — desk is every host this Worker answers on that is not
// issues/claims/prs, workers.dev previews included — so an rp.id derived from
// the request would let a preview host nominate itself as the relying party.
// The vendored verifier compares both by exact equality, which is what makes
// that a real hole rather than a theoretical one. questions.js pins DESK_ORIGIN
// for the same reason and they are deliberately not imported from one another.
//
// ── ENROLMENT IS GATED, WHICH IS THE WHOLE SECURITY ARGUMENT ────────────────
//
// A login whose enrolment is open proves nothing: the first visitor becomes the
// owner, and every gate downstream is then decoration. So registration produces
// a credential with status `pending` that can do NOTHING, and only an
// ACTIVATION that redeems a keeper grant promotes it to `live`. That mirrors
// the keeper's own answer to the same question (`enrollActivate`, infra#482).
//
// A pending credential is inert twice over: it is not listed in
// `allowCredentials`, and `loginFinish` refuses it after a VALID signature.
// The first is advice to a browser; the second is the enforcement.
//
// LIVENESS IS TESTED POSITIVELY (`status === "live"`), not by excluding
// "pending". The keeper's `listCredentials` uses the negative test because it
// has bootstrap records that carry no status at all; desk has no such legacy, so
// a negative test here would be fail-OPEN for a half-written or migrated record.
//
// ── WHAT IS NOT ESTABLISHED ─────────────────────────────────────────────────
//
// Activation needs the keeper to canonicalize a request type it does not yet
// know (see DESK_CREDENTIAL_REQUEST_V1). Until that infra PR lands, /redeem
// answers 422 and activation refuses. That is the correct failure direction —
// no desk credential goes live — but it does mean this path is unexercised
// against a real keeper, and no desk credential can be activated today.
import { b64url, verifyAssertion, verifyRegistration } from "./webauthn.js";

/** The relying party. Literal, for the reason in the header. */
export const RP_ID = "desk.bounded.tools";
export const RP_ORIGIN = `https://${RP_ID}`;

/**
 * Where a grant is redeemed. A literal too, and for oidc.js's reason rather
 * than the one above: an env override would let the thing desk trusts to
 * approve its own logins be moved without a reviewed commit.
 */
export const KEEPER_ORIGIN = "https://keeper.bounded.tools";

/**
 * How long a ceremony's challenge is good for.
 *
 * The keeper's window (CEREMONY_TTL_MS, 120_000) for the same reason it chose
 * it: a person taps a passkey in seconds, and every second past that is
 * replay surface. Deliberately NOT APPROVAL_TTL_SECONDS (900, the ceremony
 * window an approval has to be acted on in) and not QUESTION_* — three
 * different clocks that must not be tidied into one.
 */
export const CEREMONY_TTL_SECONDS = 120;

/**
 * How long a session cookie is good for.
 *
 * Long enough that a person is not re-tapping a passkey between opening the
 * queue and acting on an entry; short enough that a stolen cookie dies the same
 * day. REVOCATION DOES NOT WAIT FOR IT: the credential is re-read as live on
 * every admission (see `currentCredential`), so this bound only limits theft of
 * the cookie itself, never the lifetime of a withdrawn credential.
 */
export const SESSION_TTL_SECONDS = 8 * 60 * 60;

/**
 * How long an UNACTIVATED credential sits in the store.
 *
 * Registration is open — it has to be, since the thing that gates enrolment is
 * the activation and not the registration — so an anonymous caller can write
 * pending records with a soft authenticator as fast as it can sign. Durable
 * pending records would make that unbounded growth in the same namespace the
 * device subscriptions live in.
 *
 * A cap would have been the other answer and is worse: it turns the same spam
 * into a DENIAL of registration, with no way to clear the slots. A TTL bounds
 * the store without ever blocking a real enrolment — a person activates within
 * minutes of registering, and a day is generous for "the keyholder was asleep".
 * Activation re-writes the record WITHOUT a TTL, so a live credential is durable
 * and only this inert state expires.
 *
 * This is not rate limiting, and desk has none: an anonymous caller can still
 * make us spend a write per registration. Bounding the STORE is what is claimed
 * here, nothing more.
 */
export const PENDING_TTL_SECONDS = 24 * 60 * 60;

/**
 * The request type an activation redeems.
 *
 * NOT `bounded.enroll-request.v1`. Its fields (v/person/credentialId/alg/label)
 * are not rp-scoped, so a desk credential could be squeezed into one — and the
 * human approving it would be shown what reads as a KEEPER enrolment. That
 * attacks rows 5-6 of the infra#555 chain (display → intent), the two links
 * this whole design treats as the weakest, in order to save an infra PR.
 *
 * So: a new type, whose canonicalization must be added to REQUEST_TYPES in
 * infra (`cloudflare/keeper/src/core.mjs`). It is NOT a new keeper endpoint —
 * /redeem already exists — but it is upstream work, and until it lands
 * `typeFor` throws 422 and `activate` below refuses with the keeper's own
 * sentence. Nothing here forges past that.
 */
export const DESK_CREDENTIAL_REQUEST_V1 = "bounded.desk-credential.v1";

/** The cookie. `__Host-` is enforced by the browser: Secure, Path=/, no Domain. */
export const COOKIE_NAME = "__Host-desk_session";

// KV prefixes. Neither is a prefix of the other, and neither is a prefix of
// `sub:`, `question:`, `open-question:` or `pending:approval` — the
// `pending:approval`/`pending:approval:` pair is this store's committed example
// of what a prefix collision costs (pending.js).
const CRED_PREFIX = "login-cred:";
const CER_PREFIX = "login-cer:";

/** base64url, 16 or 32 bytes — the shape ids and challenges take everywhere here. */
const RE_B64URL = /^[A-Za-z0-9_-]{1,512}$/;
const MAX_LABEL = 80;

const refuse = (status, reason, extra = {}) => ({ ok: false, status, reason, ...extra });

/** A sentence that never says "authorized": this door is below that rung. */
const NOT_SIGNED_IN = "sign in with a desk passkey (rp.id desk.bounded.tools) to read this — desk#65";

const randomB64 = (n) => b64url.encode(crypto.getRandomValues(new Uint8Array(n)));

const credKey = (id) => CRED_PREFIX + id;

/**
 * THE ONE WAY A CREDENTIAL RECORD IS WRITTEN.
 *
 * Every put carries `{ status }` as KV list metadata, because `liveCredentials`
 * reads that to decide which keys are worth a get. A put that forgot it would
 * drop a live credential out of `allowCredentials` while it still signed in, so
 * there is one writer here rather than four call sites that each remember. The
 * metadata is an INDEX, never the decision: what it points at is still read and
 * status-checked.
 */
async function putCredential(kv, rec, opts = {}) {
  await kv.put(credKey(rec.credentialId), JSON.stringify(rec), { ...opts, metadata: { status: rec.status } });
}

/** Bytes from a network-supplied base64url string, or null. Strict: the
 * vendored decoder rejects padding and anything outside the alphabet. */
function bytes(value) {
  if (typeof value !== "string" || value === "") return null;
  try {
    return b64url.decode(value);
  } catch {
    return null;
  }
}

/**
 * One credential record, or null.
 *
 * The id is shape-checked before it is concatenated into a key, so a caller
 * cannot reach a record in another prefix by naming one.
 */
export async function getCredential(kv, credentialId) {
  if (!kv || typeof credentialId !== "string" || !RE_B64URL.test(credentialId)) return null;
  const raw = await kv.get(credKey(credentialId));
  if (!raw) return null;
  try {
    const rec = JSON.parse(raw);
    // A record whose relying party is anything but desk reads as ABSENT rather
    // than as a usable credential. Nothing writes such a record today; the check
    // is the on-the-way-out half of "desk never verifies an approval assertion",
    // so a keeper-scoped record copied into this store is unusable rather than
    // merely unlikely.
    if (!rec || rec.rpId !== RP_ID || rec.credentialId !== credentialId) return null;
    return rec;
  } catch {
    return null;
  }
}

/** Every credential that may sign in. PAGES, because real KV list() does. */
export async function liveCredentials(kv) {
  if (!kv) return [];
  const out = [];
  let cursor;
  do {
    const page = await kv.list({ prefix: CRED_PREFIX, cursor });
    for (const { name, metadata } of page.keys) {
      // SKIP WITHOUT READING what the index already says is not live. Registration
      // is open and unrated (see PENDING_TTL_SECONDS), so an ANONYMOUS caller
      // decides how many keys sit under this prefix; a get per key made every
      // /login/start cost one KV subrequest per credential ever registered, and a
      // few thousand pending records take the login door past the Worker's
      // subrequest cap — locking the keyholder out of the one route that can
      // revoke them (desk#65 review). Reads are now bounded by the number of
      // ACTIVATED credentials, which only a keeper grant can grow.
      //
      // A key with NO metadata is still read: this filter may only save work, not
      // decide liveness, and nothing outside `putCredential` writes these keys.
      // The list itself still scales with the store, at one subrequest per 1000
      // keys rather than per key; that is a bound, not a fix for spam.
      if (metadata && metadata.status !== "live") continue;
      const rec = await getCredential(kv, name.slice(CRED_PREFIX.length));
      // POSITIVE test — see the header. A record with a missing, misspelled or
      // half-written status is not live.
      if (rec && rec.status === "live") out.push(rec);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

/**
 * The single-use consume: read, then delete, then verify.
 *
 * CONSUME FIRST, VERIFY SECOND — the keeper's documented ordering. A failed
 * verification BURNS the nonce; the other way round, anyone who captured a valid
 * assertion during a failed attempt could keep presenting it against a challenge
 * that stayed open.
 *
 * HONEST ABOUT THE MECHANISM: KV's delete() returns nothing, so this is not the
 * atomic compare-and-delete the keeper gets from Durable Object storage. Two
 * finishes racing the same challenge could both read it. Sequential replay — the
 * threat this is here for — is refused, because the second read finds nothing.
 */
async function consume(kv, key) {
  const raw = await kv.get(key);
  if (!raw) return null;
  await kv.delete(key);
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function startCeremony(kv, record, now) {
  const ceremonyId = randomB64(16);
  const challenge = randomB64(32);
  await kv.put(
    CER_PREFIX + ceremonyId,
    JSON.stringify({ ...record, challenge, expiresAt: now + CEREMONY_TTL_SECONDS * 1000 }),
    { expirationTtl: CEREMONY_TTL_SECONDS },
  );
  return { ceremonyId, challenge };
}

async function takeCeremony(kv, ceremonyId, kind, now) {
  if (typeof ceremonyId !== "string" || !RE_B64URL.test(ceremonyId)) {
    return { ok: false, error: refuse(403, "ceremony unknown or already used") };
  }
  const cer = await consume(kv, CER_PREFIX + ceremonyId);
  if (!cer || cer.kind !== kind) return { ok: false, error: refuse(403, "ceremony unknown or already used") };
  if (now > cer.expiresAt) return { ok: false, error: refuse(403, "ceremony expired") };
  return { ok: true, value: cer };
}

// ── registration: anyone may ask, nobody is admitted by asking ──────────────

export async function registerStart(kv, { label } = {}, now = Date.now()) {
  if (!kv) return refuse(503, "no credential store is configured on this deployment");
  if (typeof label !== "string" || !label.trim() || label.length > MAX_LABEL) {
    return refuse(400, `label must be a string of 1..${MAX_LABEL} characters`);
  }
  const { ceremonyId, challenge } = await startCeremony(kv, { kind: "register", label: label.trim() }, now);
  return {
    ok: true,
    status: 200,
    value: {
      ceremonyId,
      challenge,
      rpId: RP_ID,
      origin: RP_ORIGIN,
      // The vendored verifier REFUSES a registration with UV unset, so a client
      // that asks for anything weaker fails at the end of the ceremony instead
      // of the start. Said here so it cannot be got wrong quietly.
      userVerification: "required",
    },
  };
}

export async function registerFinish(kv, body = {}, now = Date.now()) {
  if (!kv) return refuse(503, "no credential store is configured on this deployment");
  const taken = await takeCeremony(kv, body.ceremonyId, "register", now);
  if (!taken.ok) return taken.error;

  const attestationObject = bytes(body.attestationObject);
  const clientDataJSON = bytes(body.clientDataJSON);
  if (!attestationObject || !clientDataJSON) return refuse(400, "attestationObject and clientDataJSON must be base64url");

  let reg;
  try {
    reg = await verifyRegistration({
      attestationObject,
      clientDataJSON,
      challenge: b64url.decode(taken.value.challenge),
      origin: RP_ORIGIN,
      rpId: RP_ID,
    });
  } catch (e) {
    // The verifier throws on every failure and never returns a boolean, so a
    // registration handler without this catch is a registration handler that
    // 500s instead of refusing.
    return refuse(403, `registration refused: ${e.message}`);
  }

  if (!RE_B64URL.test(reg.credentialId)) return refuse(400, "credential id is not base64url");
  if (await kv.get(credKey(reg.credentialId))) return refuse(409, "that credential id is already registered");

  const credential = {
    credentialId: reg.credentialId,
    label: taken.value.label,
    rpId: RP_ID,
    // INERT. It authenticates nothing until a keeper grant promotes it.
    status: "pending",
    publicKey: reg.publicKey,
    alg: reg.publicKey.alg,
    signCount: reg.signCount,
    backupEligible: reg.backupEligible,
    backupState: reg.backupState,
    attestationFmt: reg.attestationFmt,
    registeredAt: now,
  };
  // A pending credential EXPIRES; a live one does not — see PENDING_TTL_SECONDS.
  await putCredential(kv, credential, { expirationTtl: PENDING_TTL_SECONDS });
  return {
    ok: true,
    status: 201,
    value: {
      credentialId: credential.credentialId,
      status: "pending",
      // What a keyholder will be asked to approve. Informational: activation
      // rebuilds this from the STORED record and never accepts it from a caller.
      activation: { requestType: DESK_CREDENTIAL_REQUEST_V1, request: deskCredentialRequestFor(credential) },
    },
  };
}

/**
 * The request an activation is bound to — rebuilt from the stored record every
 * time, never taken from the device asking to be let in.
 *
 * `rpId` is in it deliberately: it is the field that lets the human approving
 * this see that they are activating a DESK VIEWING credential and not a keeper
 * enrolment. That distinction is the reason this is a new request type at all.
 */
export function deskCredentialRequestFor(credential) {
  return {
    v: DESK_CREDENTIAL_REQUEST_V1,
    rpId: credential.rpId,
    credentialId: credential.credentialId,
    alg: credential.alg,
    label: credential.label,
  };
}

// The two states a keeper grant may promote to `live`.
//
// `revoked` is in here deliberately (desk#65 carried item). Revocation is gated
// on a live session, not on a grant, because a rule that needed the keeper to be
// up would put revocation out of reach in exactly the incident where it is
// wanted. The stated cost was that ONE STOLEN SESSION COULD WITHDRAW EVERY
// ENROLLED CREDENTIAL and the lockout was permanent, since nothing could undo a
// revocation.
//
// Making a withdrawal recoverable BY THE KEEPER closes that without weakening
// anything: re-activation still costs a grant, so a stolen desk session — which
// can approve nothing, here or at the keeper — cannot perform one. No new
// authority is created; the authority that already decides who may hold a
// credential simply also decides who may hold one again.
const ACTIVATABLE = new Set(["pending", "revoked"]);

/**
 * Promote a pending — or re-admit a revoked — credential by redeeming a keeper grant.
 *
 * `fetchImpl` is a seam for tests, not for configuration: the keeper's origin is
 * a literal above, so nothing a caller sends decides who is asked.
 */
export async function activate(kv, { credentialId, authorizationId } = {}, now = Date.now(), fetchImpl = fetch) {
  if (!kv) return refuse(503, "no credential store is configured on this deployment");
  if (typeof authorizationId !== "string" || !RE_B64URL.test(authorizationId)) {
    return refuse(400, "authorizationId must be base64url");
  }
  const pending = await getCredential(kv, credentialId);
  if (!pending || !ACTIVATABLE.has(pending.status)) {
    return refuse(404, "no pending or revoked credential by that id");
  }

  let res;
  let body;
  try {
    res = await fetchImpl(`${KEEPER_ORIGIN}/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        authorizationId,
        requestType: DESK_CREDENTIAL_REQUEST_V1,
        request: deskCredentialRequestFor(pending),
      }),
    });
    body = await res.json();
  } catch (e) {
    // The keeper being unreachable leaves the credential pending, which is the
    // safe direction: an activation that could not be checked did not happen.
    return refuse(502, `the keeper could not be reached: ${e.message}`);
  }
  if (!res.ok) {
    // Surfaced verbatim, including the 422 that says the keeper does not know
    // this request type yet (see DESK_CREDENTIAL_REQUEST_V1). A refusal that
    // paraphrased it would hide exactly the dependency that is missing.
    return refuse(res.status === 422 ? 422 : 403, `the keeper refused the grant: ${(body && body.error) || res.status}`);
  }

  const record = (body && body.redeemed) || {};
  // RE-READ ACROSS THE KEEPER ROUND TRIP. `pending` was read before a network
  // call — the widest window in this module — and promoting from that snapshot
  // would let an activation RESURRECT a credential revoked while the grant was in
  // flight, since the write lands after the revocation (desk#65 review; the same
  // shape as loginFinish's write-back below). Refusing here spends the grant
  // without promoting anything, which is the safe direction: the credential stays
  // whatever the store now says it is.
  // THE STATUS MUST BE UNCHANGED, not merely activatable. Both halves matter and
  // the second one is not obvious:
  //
  //   pending  -> still pending  -> live      a normal activation
  //   revoked  -> still revoked  -> live      a DELIBERATE re-admission
  //   pending  -> revoked in flight -> 409    a revocation must win the race
  //   revoked  -> live in flight    -> 409    someone else already re-admitted it
  //
  // Admitting any activatable status here would have made the third line legal,
  // because `revoked` is now in ACTIVATABLE — a grant redeemed against a PENDING
  // record would have overridden a withdrawal that landed during the round trip.
  // That is the `live <- revoked` transition three reviewers flagged on desk#65,
  // reintroduced through the front door by the fix for the lockout. Caught by the
  // test written for the original: "an activation cannot promote a credential
  // revoked while the grant was in flight".
  //
  // The distinction the equality encodes: re-admission is an ACT, begun against a
  // record already revoked, not an outcome a race can produce.
  const current = await getCredential(kv, pending.credentialId);
  if (!current || current.status !== pending.status) {
    return refuse(409, `that credential is no longer ${pending.status} — it changed while the grant was being redeemed`);
  }

  const live = {
    ...current,
    status: "live",
    // The only durable evidence of WHICH keyholder let this credential in.
    approvedBy: typeof record.credentialId === "string" ? record.credentialId : null,
    activatedAt: now,
  };
  // RE-ACTIVATION KEEPS THE EPOCH IT INHERITED. `revokeCredential` bumped
  // `sessionEpoch`, and `...current` carries that bump forward — so every cookie
  // minted before the withdrawal stays refused at admission. Resetting or
  // omitting it here would resurrect exactly the sessions revocation existed to
  // kill, which is why revokeCredential bumps it rather than relying on `status`
  // alone. Do not "tidy" this into a fresh epoch.
  if (current.status === "revoked") {
    live.reactivatedAt = now;
    // Cleared so `revokedAt` always means "currently withdrawn, since". The
    // history is not lost: `reactivatedAt` records that this happened, and the
    // bumped epoch is durable evidence that a withdrawal took effect.
    delete live.revokedAt;
  }
  // No expirationTtl, deliberately: the pending record carried one and this
  // write is what makes the credential durable.
  await putCredential(kv, live);
  return { ok: true, status: 200, value: { credentialId: live.credentialId, status: "live", approvedBy: live.approvedBy } };
}

/**
 * Sign out — and make it MEAN something.
 *
 * Bumps the credential's `sessionEpoch`, so every cookie minted before this
 * moment is refused at admission (see `currentCredential`). Clearing the
 * browser's copy alone would leave a captured cookie admitting for the rest of
 * SESSION_TTL_SECONDS, which is what "logout" must not mean (desk#65 review).
 *
 * BEST EFFORT, DELIBERATELY. The route clears the cookie whether or not this
 * succeeds: a store that cannot be written must never leave a person unable to
 * drop their own session locally. The failure direction is "signed out here,
 * still valid elsewhere" -- weaker than we want, and strictly better than
 * refusing to sign out at all.
 */
export async function endSessions(kv, credentialId, now = Date.now()) {
  if (!kv || typeof credentialId !== "string") return { ok: false };
  const rec = await getCredential(kv, credentialId);
  if (!rec) return { ok: false };
  await putCredential(kv, { ...rec, sessionEpoch: (rec.sessionEpoch || 0) + 1, signedOutAt: now });
  return { ok: true, sessionEpoch: (rec.sessionEpoch || 0) + 1 };
}

/**
 * Withdraw a credential.
 *
 * The record is KEPT, marked `revoked`, rather than deleted: a deleted record
 * reads as "never enrolled", and it would let the same credential id be
 * registered again as pending. Revocation is evidence.
 *
 * Gated on a live session (see the route), not on a keeper grant. Revoking only
 * ever REMOVES access, so the fail-safe direction is to make it reachable — and
 * a rule that needed the keeper to be up would put revocation out of reach in
 * exactly the incident where it is wanted. The cost is honest and stated: a
 * stolen desk session can lock the keyholder out of desk's viewing surface. It
 * cannot approve anything, here or at the keeper.
 */
export async function revokeCredential(kv, credentialId, now = Date.now()) {
  if (!kv) return refuse(503, "no credential store is configured on this deployment");
  const rec = await getCredential(kv, credentialId);
  if (!rec) return refuse(404, "no such credential");
  if (rec.status === "revoked") return { ok: true, status: 200, value: { credentialId, status: "revoked" } };
  // Durable too: a revocation that expired would let the same credential id be
  // registered again as pending, and the evidence would be gone.
  // Bump the epoch too: status alone already refuses at admission, but a
  // credential that is later re-activated must not resurrect the sessions it
  // held before it was withdrawn.
  await putCredential(kv, { ...rec, status: "revoked", revokedAt: now, sessionEpoch: (rec.sessionEpoch || 0) + 1 });
  return { ok: true, status: 200, value: { credentialId, status: "revoked" } };
}

// ── login ───────────────────────────────────────────────────────────────────

export async function loginStart(kv, _body = {}, now = Date.now()) {
  if (!kv) return refuse(503, "no credential store is configured on this deployment");
  const live = await liveCredentials(kv);
  // No credential can sign in, so say so rather than opening a ceremony nothing
  // can finish. The keeper answers its equivalent with a 503 for the same reason.
  if (live.length === 0) return refuse(503, "no credential is live on this deployment");
  const { ceremonyId, challenge } = await startCeremony(kv, { kind: "login" }, now);
  return {
    ok: true,
    status: 200,
    value: {
      ceremonyId,
      // Server-random, minted here, single-use. Nothing a caller sends is ever
      // treated as a challenge: a challenge you were handed is a name the
      // caller chose, and every later assertion against it is pre-computable.
      challenge,
      rpId: RP_ID,
      // Advice to a browser, and ONLY that. A pending credential is absent from
      // this list, but the enforcement is the lookup in loginFinish.
      allowCredentials: live.map((c) => ({ type: "public-key", id: c.credentialId })),
      userVerification: "required",
    },
  };
}

/**
 * Finish a login and mint a session.
 *
 * The order is the security property: consume the ceremony, resolve the
 * credential and REFUSE ANYTHING NOT LIVE, and only then verify the signature.
 */
export async function loginFinish(kv, body = {}, env = {}, now = Date.now()) {
  if (!kv) return refuse(503, "no credential store is configured on this deployment");
  if (!env.SESSION_SECRET) return refuse(503, "no session signing key is configured on this deployment");
  const taken = await takeCeremony(kv, body.ceremonyId, "login", now);
  if (!taken.ok) return taken.error;

  const authenticatorData = bytes(body.authenticatorData);
  const clientDataJSON = bytes(body.clientDataJSON);
  const signature = bytes(body.signature);
  if (!authenticatorData || !clientDataJSON || !signature) {
    return refuse(400, "authenticatorData, clientDataJSON and signature must be base64url");
  }

  const credential = await getCredential(kv, body.credentialId);
  if (!credential) return refuse(403, "no credential is registered at that id");
  if (credential.status === "pending") {
    // ITS OWN SENTENCE, not a generic refusal. The person who just registered
    // has to be told that a keyholder must approve the credential — and the
    // disclosure is small: it is told only to whoever can already produce a
    // valid assertion from that authenticator.
    return refuse(403, "that credential is registered but not activated: a keyholder must approve it before it can sign in");
  }
  if (credential.status !== "live") return refuse(403, `that credential is ${credential.status}`);

  let result;
  try {
    result = await verifyAssertion({
      credential,
      authenticatorData,
      clientDataJSON,
      signature,
      challenge: b64url.decode(taken.value.challenge),
      origin: RP_ORIGIN,
      rpId: RP_ID,
    });
  } catch (e) {
    return refuse(403, `assertion refused: ${e.message}`);
  }

  // RECORDED, NOT ENFORCED — the vendored module's policy, kept. A synced
  // passkey reports 0 forever, so writing a 0 back would destroy a real counter
  // and refusing on a regression would refuse every iCloud passkey.
  //
  // AND RE-READ BEFORE WRITING. `credential` is a snapshot taken before the
  // signature was verified; writing it back WHOLE was the only live←revoked
  // transition in this module — a revocation that landed during the ceremony was
  // reverted and its `revokedAt` erased, so the admission re-read this whole
  // design rests on went back to admitting (desk#65 review). Writing the counter
  // onto what the store CURRENTLY says never invents a live record.
  //
  // Not atomic, and said plainly: KV has no compare-and-set and its reads are
  // eventually consistent, so a revocation can still land inside this narrower
  // window. What is established is that no write here promotes a record the last
  // read did not already find live.
  if (result.signCount > 0) {
    const fresh = await getCredential(kv, credential.credentialId);
    if (fresh && fresh.status === "live") {
      await putCredential(kv, {
        ...fresh,
        signCount: result.signCount,
        ...(result.signCountRegressed ? { signCountRegressedAt: now } : {}),
      });
    }
  }

  const session = await mintSession(env.SESSION_SECRET, credential.credentialId, now, credential.sessionEpoch || 0);
  return {
    ok: true,
    status: 200,
    value: { credentialId: credential.credentialId, label: credential.label, expiresAt: session.payload.exp * 1000 },
    cookie: sessionCookie(session.value),
  };
}

// ── the session cookie ──────────────────────────────────────────────────────
//
// Signed, HttpOnly, SameSite=Strict, Secure, short-lived — and CHECKED AT
// ADMISSION, which is the part that is not a header. What it carries is an
// opaque session id, the credential id and two timestamps: NEVER the public key,
// NEVER the challenge, NEVER anything from the keeper. A cookie that carried the
// credential's own material would make the browser's copy as good as the store's.
//
// No Domain attribute, and `__Host-` makes the browser enforce that: one Worker
// serves four hostnames in one zone, and a Domain would hand desk's session to
// issues/claims/prs.

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function mintSession(secret, credentialId, now = Date.now(), epoch = 0) {
  const payload = {
    v: 1,
    sid: randomB64(16),
    cid: credentialId,
    // THE EPOCH IS WHAT MAKES LOGOUT MEAN SOMETHING (desk#65 review). Without it
    // `sid` was minted into every cookie and never stored or consulted, so
    // signing out cleared the browser's copy and invalidated nothing: a cookie
    // captured beforehand kept admitting for the full SESSION_TTL_SECONDS.
    //
    // Server-side session records would also fix it and cost a KV write per
    // login and a read per admission. This costs NEITHER: admission already
    // re-reads the credential, so comparing one number it already has in hand is
    // free. Bumping `sessionEpoch` on the record invalidates every cookie minted
    // before the bump, which is exactly what logout and revocation both need.
    ep: epoch,
    iat: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + SESSION_TTL_SECONDS,
  };
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), body));
  return { value: `${b64url.encode(body)}.${b64url.encode(mac)}`, payload };
}

/** The signed payload, or null. Pure crypto: it reads no store. */
export async function readSession(secret, raw, now = Date.now()) {
  if (!secret || typeof raw !== "string") return null;
  const dot = raw.indexOf(".");
  if (dot < 1) return null;
  const body = bytes(raw.slice(0, dot));
  const mac = bytes(raw.slice(dot + 1));
  if (!body || !mac) return null;
  // crypto.subtle.verify, not a string compare of two MACs.
  if (!(await crypto.subtle.verify("HMAC", await hmacKey(secret), mac, body))) return null;
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return null;
  }
  if (!payload || payload.v !== 1 || typeof payload.cid !== "string" || !RE_B64URL.test(payload.cid)) return null;
  if (typeof payload.exp !== "number" || now / 1000 >= payload.exp) return null;
  // An older cookie carries no `ep`. Treated as epoch 0 rather than rejected, so
  // this change does not sign everyone out on deploy -- and a bump still
  // invalidates it, because any bump makes the record's epoch exceed 0.
  if (payload.ep === undefined) payload.ep = 0;
  if (typeof payload.ep !== "number") return null;
  return payload;
}

const ATTRS = "Path=/; Secure; HttpOnly; SameSite=Strict";
export const sessionCookie = (value) => `${COOKIE_NAME}=${value}; ${ATTRS}; Max-Age=${SESSION_TTL_SECONDS}`;
/** The SAME attribute set, or the browser keeps the cookie it was told to drop. */
export const clearedCookie = () => `${COOKIE_NAME}=; ${ATTRS}; Max-Age=0`;

function cookieValue(request, name) {
  const header = request && request.headers && typeof request.headers.get === "function"
    ? request.headers.get("cookie")
    : null;
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/**
 * WHO IS ASKING — re-read from the store, on EVERY request.
 *
 * This is the admission check, and it is the difference between a grant that was
 * checked once and a grant that is checked. A long-lived cookie that nothing
 * re-reads is how a revoked keyholder keeps their access; the org decision on
 * exactly this ("revocation check at admission — mandatory for any long-lived
 * grant") is why the credential lookup is here and not at issue time only.
 *
 * FAILS CLOSED on a null request, an absent env, an absent binding and an absent
 * signing key. An unconfigured deploy refuses; it never admits.
 */
export async function currentCredential(request, env, now = Date.now()) {
  if (!request || !env) return refuse(401, NOT_SIGNED_IN);
  if (!env.SESSION_SECRET) return refuse(503, "no session signing key is configured on this deployment");
  if (!env.SUBSCRIPTIONS) return refuse(503, "no credential store is configured on this deployment");

  const raw = cookieValue(request, COOKIE_NAME);
  if (!raw) return refuse(401, NOT_SIGNED_IN);
  // The MAC is checked BEFORE the store is touched, so a forged cookie costs no
  // KV read — otherwise an anonymous caller has a free read amplifier.
  const session = await readSession(env.SESSION_SECRET, raw, now);
  if (!session) return refuse(401, `${NOT_SIGNED_IN} (the session is expired or unreadable)`, { clear: true });

  const credential = await getCredential(env.SUBSCRIPTIONS, session.cid);
  if (!credential || credential.status !== "live") {
    return refuse(403, "that credential is no longer live on this deployment — sign in again", { clear: true });
  }
  // THE EPOCH CHECK, and it costs nothing: the record is already in hand. A
  // cookie minted before the last logout or revocation is refused here even
  // though its MAC is valid and it has not expired. See mintSession.
  if ((session.ep || 0) < (credential.sessionEpoch || 0)) {
    return refuse(401, `${NOT_SIGNED_IN} (that session was signed out)`, { clear: true });
  }
  return { ok: true, status: 200, credential, session };
}

/**
 * MAY THIS CALLER READ THE PENDING-APPROVALS QUEUE? (desk#65)
 *
 * A named predicate of the same shape as `mayAnswer`/`mayList`, because the
 * queue is a third thing behind the same gate and a gate spelled out inline at
 * one route is a gate nobody can find. It gates VIEWING the set; approving any
 * entry in it still happens at the keeper, under the other credential.
 */
export async function mayViewQueue(request, env) {
  const who = await currentCredential(request, env);
  if (!who.ok) return who;
  return { ok: true, credential: who.credential };
}
