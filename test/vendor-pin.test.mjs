// THE VENDORED VERIFIER MUST NOT DRIFT (desk#65, pattern: .github#310).
//
// src/vendor/webauthn.mjs is a byte-for-byte copy of infra's keeper verifier.
// The hazard vendoring creates is silent divergence, and it has bitten this org
// before: .github#310's vendored copy kept a pre-#706 classification for five
// days and nothing went red, because the copy was dead code nothing imported.
//
// So this file asserts three different things, and none of them substitutes for
// the others:
//   1. THE BYTES have not been edited here (the pin).
//   2. THE MODULE IS THE ONE THE CODE IMPORTS, and there is no second
//      WebAuthn verification anywhere in src/ (a pin on a file nothing imports
//      is .github#310 reproduced exactly).
//   3. THE BEHAVIOUR is still the eleven refusals it is vendored for — because a
//      hash gate cannot see a semantic change that a legitimate re-vendor
//      carries in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, existsSync, readdirSync } from "node:fs";

import * as vendored from "../src/vendor/webauthn.mjs";
import { b64, makeAuthenticator, unb64 } from "./authenticator.mjs";

const root = new URL("../", import.meta.url);
const vendorPath = new URL("src/vendor/webauthn.mjs", root);
const pin = JSON.parse(readFileSync(new URL("src/vendor/webauthn.pin.json", root), "utf8"));

test("THE VENDORED BYTES MATCH THE COMMITTED PIN", () => {
  // BYTES, not text: read as a Buffer with no encoding, so a line-ending or
  // whitespace change is still a change. A utf8 round-trip would let some of
  // them through.
  const digest = createHash("sha256").update(readFileSync(vendorPath)).digest("hex");
  assert.equal(digest, pin.sha256);
});

test("the pin is a pin, not an absence — undefined === undefined is green for ever", () => {
  // The failure this exists for: a gate comparing two missing values passes
  // permanently and looks like coverage.
  assert.match(pin.sha256, /^[0-9a-f]{64}$/);
  assert.equal(pin.file, "webauthn.mjs");
  assert.equal(pin.source.repo, "bounded-systems/infra");
  assert.match(pin.source.path, /keeper\/src\/webauthn\.mjs$/);
  // And it says what it does NOT prove, so nobody reads it as parity — including
  // the part that is unwatched: nothing in infra reconciles its copy against
  // this one, so a change THERE goes red nowhere.
  assert.match(pin.what_this_proves, /does NOT prove parity/i);
  assert.match(pin.what_nothing_proves_yet, /UNWATCHED/);
});

// The comparison the pin cannot make. Desk's CI has no keeper checkout, so this
// is conditional — and it is LOUD about which half ran rather than skipping in
// silence, because "green" must not mean two different things.
const infra = "/home/user/infra/cloudflare/keeper/src/webauthn.mjs";
const haveInfra = existsSync(infra);
test(
  haveInfra
    ? "and the copy is byte-identical to infra's, which is on disk here"
    : "NO KEEPER CHECKOUT ON DISK — parity with infra was NOT checked, only the pin",
  () => {
    if (!haveInfra) {
      // Not a skip: an assertion that records what was not proved.
      assert.equal(existsSync(infra), false);
      return;
    }
    assert.deepEqual(readFileSync(vendorPath), readFileSync(infra));
  },
);

test("the vendored module is the one the code imports, and the only verifier in src/", () => {
  const files = readdirSync(new URL("src/", root)).filter((f) => f.endsWith(".js"));
  const importers = files.filter((f) =>
    readFileSync(new URL(`src/${f}`, root), "utf8").includes("./vendor/webauthn.mjs"));
  assert.deepEqual(importers, ["webauthn.js"], "one wrapper, one import — see src/webauthn.js");

  // NO SECOND VERIFICATION. Comments are stripped first: this repo documents its
  // own invariants in prose, and a raw grep fires on the documentation — a trap
  // worker.test.mjs has recorded falling into three times.
  for (const f of files) {
    const code = readFileSync(new URL(`src/${f}`, root), "utf8")
      .split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    assert.ok(!/parseAuthenticatorData|cborDecode|rpIdHash|coseTo/.test(code),
      `${f} re-implements part of the verifier — that belongs upstream in infra`);
  }
});

test("the export surface is the committed one", () => {
  // So a copy that hashes differently AND has lost verifyAssertion fails here
  // with a readable message rather than as a TypeError three files away.
  assert.deepEqual(Object.keys(vendored).sort(), pin.exports);
});

// ── behavioural conformance ─────────────────────────────────────────────────
//
// The same branches the keeper's own suite pins, re-run against DESK's copy with
// desk's synthetic authenticator. A re-vendor that quietly changed one of these
// would pass the hash gate (the pin moves with it) and fail here.

const RP_ID = "desk.bounded.tools";
const ORIGIN = `https://${RP_ID}`;
// 32 random bytes, the size and the source a real ceremony mints from.
const CHALLENGE = b64(crypto.getRandomValues(new Uint8Array(32)));
const OTHER_CHALLENGE = b64(crypto.getRandomValues(new Uint8Array(32)));
const decode = (o) => ({
  attestationObject: o.attestationObject ? unb64(o.attestationObject) : undefined,
  authenticatorData: o.authenticatorData ? unb64(o.authenticatorData) : undefined,
  clientDataJSON: unb64(o.clientDataJSON),
  signature: o.signature ? unb64(o.signature) : undefined,
});

test("REGISTRATION refuses every branch it is vendored to refuse", async () => {
  const auth = await makeAuthenticator({ rpId: RP_ID });
  const base = { challenge: unb64(CHALLENGE), origin: ORIGIN, rpId: RP_ID };

  // The positive first, so the negatives below are not passing vacuously.
  const good = await vendored.verifyRegistration({ ...decode(await auth.register(CHALLENGE)), ...base });
  assert.equal(good.credentialId, auth.credentialId);
  assert.equal(good.publicKey.alg, "ES256");
  assert.equal(good.attestationFmt, "none");

  const cases = [
    ["challenge", await auth.register(OTHER_CHALLENGE), /challenge mismatch/],
    ["origin", await auth.register(CHALLENGE, { origin: "https://keeper.bounded.tools" }), /origin/],
    ["rpId", await auth.register(CHALLENGE, { rpId: "keeper.bounded.tools" }), /rpIdHash mismatch/],
    ["uv", await auth.register(CHALLENGE, { uv: false }), /UV not set/],
    ["up", await auth.register(CHALLENGE, { up: false }), /UP not set/],
  ];
  for (const [name, out, re] of cases) {
    await assert.rejects(() => vendored.verifyRegistration({ ...decode(out), ...base }), re, name);
  }
});

test("ASSERTION refuses every branch it is vendored to refuse", async () => {
  const auth = await makeAuthenticator({ rpId: RP_ID });
  const credential = { publicKey: auth.publicKeyJwk, signCount: 0 };
  const base = { credential, challenge: unb64(CHALLENGE), origin: ORIGIN, rpId: RP_ID };

  const good = await vendored.verifyAssertion({ ...decode(await auth.assert(CHALLENGE)), ...base });
  assert.equal(good.userVerified, true);
  assert.equal(good.signCountRegressed, false);

  const cases = [
    ["challenge", await auth.assert(OTHER_CHALLENGE), /challenge mismatch/],
    ["origin", await auth.assert(CHALLENGE, { origin: "https://keeper.bounded.tools" }), /origin/],
    ["rpId", await auth.assert(CHALLENGE, { rpId: "keeper.bounded.tools" }), /rpIdHash mismatch/],
    ["uv", await auth.assert(CHALLENGE, { uv: false }), /UV not set/],
    ["up", await auth.assert(CHALLENGE, { up: false }), /UP not set/],
    ["tampered signature", await auth.assert(CHALLENGE, { tamper: true }), /signature invalid/],
  ];
  for (const [name, out, re] of cases) {
    await assert.rejects(() => vendored.verifyAssertion({ ...decode(out), ...base }), re, name);
  }

  // Short authData is refused before anything is read out of it.
  const short = decode(await auth.assert(CHALLENGE));
  await assert.rejects(
    () => vendored.verifyAssertion({ ...base, ...short, authenticatorData: new Uint8Array(10) }),
    /too short/,
  );
});

/** Another base64url string that decodes to the SAME bytes, or null. */
function otherSpelling(b64) {
  const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
  const want = [...unb64(b64)];
  for (const ch of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_") {
    const candidate = b64.slice(0, -1) + ch;
    if (candidate !== b64 && same([...unb64(candidate)], want)) return candidate;
  }
  return null;
}

test("the challenge is compared as BYTES, so a second legal spelling still verifies", async () => {
  // The assertion that stops someone 'fixing' a spelling difference by comparing
  // strings, which would then refuse legitimate clients. A 32-byte challenge
  // leaves two slack bits in its last base64url character, so several strings
  // decode to the same bytes and a real client may send any of them.
  const auth = await makeAuthenticator({ rpId: RP_ID });
  const alt = otherSpelling(CHALLENGE);
  assert.ok(alt, "no alternate spelling exists — this test would be vacuous");
  const out = await auth.assert(CHALLENGE, { challengeText: alt });
  const res = await vendored.verifyAssertion({
    ...decode(out),
    credential: { publicKey: auth.publicKeyJwk, signCount: 0 },
    challenge: unb64(CHALLENGE),
    origin: ORIGIN,
    rpId: RP_ID,
  });
  assert.equal(res.userVerified, true);
});
