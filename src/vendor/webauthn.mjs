/**
 * @module
 * WebAuthn parsing + verification for the keeper — no dependency, WebCrypto only.
 *
 * WHY HAND-ROLLED RATHER THAN A LIBRARY. This Worker is the org's relying party:
 * the code in this file decides whether a human authorized a privileged action.
 * The popular WebAuthn libraries pull in CBOR/ASN.1 dependency trees that nobody
 * here would ever read, and the whole premise of the keeper (control 2 —
 * "verified by a relying party the requester does not control") collapses a
 * little every time unreviewed code sits on the verification path. The subset a
 * relying party actually needs is small: one CBOR decoder for two structures,
 * one authenticator-data layout, one signature format conversion. All of it is
 * specified bytes-first in WebAuthn L2 and testable with keys generated in the
 * test itself.
 *
 * WHAT IS DELIBERATELY NOT HERE:
 *   - Attestation-statement verification. Enrollment identity comes from the
 *     enrollment token (control 1: a named person, revocable), not from device
 *     attestation — iCloud-synced passkeys attest as "none" anyway. Accepting
 *     fmt "none" is recorded, not hidden: the credential record carries
 *     `attestationFmt` so a later ratchet can require more.
 *   - Sign-count ENFORCEMENT. Synced passkeys (the enrollment device is an
 *     iPhone) legitimately report 0 forever; treating that as a clone signal
 *     would refuse every real assertion. The count is RECORDED and a regression
 *     (nonzero going backwards) is flagged in the result rather than silently
 *     dropped, so policy can act on it without this module deciding policy.
 */

// ── bytes ────────────────────────────────────────────────────────────────────

export const b64url = {
  encode(buf) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  decode(s) {
    if (typeof s !== "string" || /[^A-Za-z0-9_-]/.test(s)) {
      throw new Error("not base64url");
    }
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  },
};

const eq = (a, b) => {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
};

const sha256 = async (data) => new Uint8Array(await crypto.subtle.digest("SHA-256", data));

// ── CBOR (decode only, the subset WebAuthn emits) ───────────────────────────
//
// attestationObject and COSE keys use: unsigned/negative ints, byte strings,
// text strings, arrays, maps. No floats, no tags, no indefinite lengths — an
// authenticator emitting those is out of spec and refusal is the right answer.

export function cborDecode(bytes) {
  let i = 0;
  const need = (n) => {
    if (i + n > bytes.length) throw new Error("cbor: truncated");
  };
  const uintN = (n) => {
    need(n);
    let v = 0;
    for (let k = 0; k < n; k++) v = v * 256 + bytes[i + k];
    i += n;
    return v;
  };
  const head = () => {
    need(1);
    const b = bytes[i++];
    const major = b >> 5;
    const info = b & 0x1f;
    let arg;
    if (info < 24) arg = info;
    else if (info === 24) arg = uintN(1);
    else if (info === 25) arg = uintN(2);
    else if (info === 26) arg = uintN(4);
    else if (info === 27) arg = uintN(8);
    else throw new Error("cbor: indefinite/reserved length unsupported");
    return { major, arg };
  };
  const item = () => {
    const { major, arg } = head();
    switch (major) {
      case 0: return arg;
      case 1: return -1 - arg;
      case 2: { need(arg); const v = bytes.slice(i, i + arg); i += arg; return v; }
      case 3: { need(arg); const v = new TextDecoder().decode(bytes.slice(i, i + arg)); i += arg; return v; }
      case 4: { const a = []; for (let k = 0; k < arg; k++) a.push(item()); return a; }
      case 5: {
        const m = new Map();
        for (let k = 0; k < arg; k++) {
          const key = item();
          m.set(key, item());
        }
        return m;
      }
      case 7: {
        if (arg === 20) return false;
        if (arg === 21) return true;
        if (arg === 22) return null;
        throw new Error("cbor: simple/float unsupported");
      }
      default: throw new Error("cbor: tags unsupported");
    }
  };
  const value = item();
  return { value, bytesRead: i };
}

// ── authenticator data ──────────────────────────────────────────────────────

export const FLAGS = Object.freeze({ UP: 0x01, UV: 0x04, BE: 0x08, BS: 0x10, AT: 0x40, ED: 0x80 });

export function parseAuthenticatorData(bytes) {
  if (bytes.length < 37) throw new Error("authData: too short");
  const rpIdHash = bytes.slice(0, 32);
  const flags = bytes[32];
  const signCount = (bytes[33] << 24 | bytes[34] << 16 | bytes[35] << 8 | bytes[36]) >>> 0;
  const out = {
    rpIdHash,
    flags,
    signCount,
    userPresent: !!(flags & FLAGS.UP),
    userVerified: !!(flags & FLAGS.UV),
    backupEligible: !!(flags & FLAGS.BE),
    backupState: !!(flags & FLAGS.BS),
  };
  if (flags & FLAGS.AT) {
    if (bytes.length < 37 + 18) throw new Error("authData: attested data truncated");
    const credIdLen = (bytes[53] << 8) | bytes[54];
    const credId = bytes.slice(55, 55 + credIdLen);
    if (credId.length !== credIdLen) throw new Error("authData: credential id truncated");
    const { value: cose } = cborDecode(bytes.slice(55 + credIdLen));
    out.credentialId = credId;
    out.credentialPublicKey = cose;
  }
  return out;
}

// ── COSE key → WebCrypto key ────────────────────────────────────────────────
//
// ES256 (the algorithm every Apple passkey uses) plus RS256 (Windows Hello),
// nothing else. An unknown algorithm is a refusal, not a fallback: silently
// accepting a weaker alg is how downgrade bugs are born.

export const SUPPORTED_ALGS = Object.freeze([-7, -257]); // ES256, RS256

export async function coseToCryptoKey(cose) {
  if (!(cose instanceof Map)) throw new Error("cose: not a map");
  const kty = cose.get(1);
  const alg = cose.get(3);
  if (alg === -7) {
    if (kty !== 2 || cose.get(-1) !== 1) throw new Error("cose: ES256 requires EC2/P-256");
    const x = cose.get(-2), y = cose.get(-3);
    if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array) || x.length !== 32 || y.length !== 32) {
      throw new Error("cose: bad EC coordinates");
    }
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "EC", crv: "P-256", x: b64url.encode(x), y: b64url.encode(y) },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    return { key, alg: "ES256" };
  }
  if (alg === -257) {
    if (kty !== 3) throw new Error("cose: RS256 requires RSA kty");
    const n = cose.get(-1), e = cose.get(-2);
    if (!(n instanceof Uint8Array) || !(e instanceof Uint8Array)) throw new Error("cose: bad RSA parts");
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: b64url.encode(n), e: b64url.encode(e) },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return { key, alg: "RS256" };
  }
  throw new Error(`cose: unsupported alg ${alg}`);
}

/** Export the COSE key as a storable JWK, so the credential record is inspectable. */
export function coseToStoredJwk(cose) {
  const alg = cose.get(3);
  if (alg === -7) {
    return { kty: "EC", crv: "P-256", alg: "ES256", x: b64url.encode(cose.get(-2)), y: b64url.encode(cose.get(-3)) };
  }
  if (alg === -257) {
    return { kty: "RSA", alg: "RS256", n: b64url.encode(cose.get(-1)), e: b64url.encode(cose.get(-2)) };
  }
  throw new Error(`cose: unsupported alg ${alg}`);
}

export async function storedJwkToCryptoKey(jwk) {
  if (jwk.alg === "ES256") {
    const key = await crypto.subtle.importKey(
      "jwk", { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y },
      { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"],
    );
    return { key, alg: "ES256" };
  }
  if (jwk.alg === "RS256") {
    const key = await crypto.subtle.importKey(
      "jwk", { kty: "RSA", n: jwk.n, e: jwk.e },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"],
    );
    return { key, alg: "RS256" };
  }
  throw new Error("stored key: unsupported alg");
}

// ── signature format ────────────────────────────────────────────────────────
//
// WebAuthn ECDSA signatures arrive ASN.1/DER; WebCrypto verifies raw r||s.
// Minimal DER walk — two INTEGERs in a SEQUENCE, nothing else accepted.

export function derToRaw(der, size = 32) {
  if (der[0] !== 0x30) throw new Error("der: not a sequence");
  let i = 2;
  if (der[1] & 0x80) i = 2 + (der[1] & 0x7f);
  const readInt = () => {
    if (der[i++] !== 0x02) throw new Error("der: expected integer");
    let len = der[i++];
    if (len & 0x80) { const n = len & 0x7f; len = 0; for (let k = 0; k < n; k++) len = len * 256 + der[i++]; }
    let v = der.slice(i, i + len);
    i += len;
    while (v.length > size && v[0] === 0x00) v = v.slice(1);
    if (v.length > size) throw new Error("der: integer too long");
    const out = new Uint8Array(size);
    out.set(v, size - v.length);
    return out;
  };
  const r = readInt();
  const s = readInt();
  const raw = new Uint8Array(size * 2);
  raw.set(r, 0);
  raw.set(s, size);
  return raw;
}

// ── the two ceremonies ──────────────────────────────────────────────────────

function parseClientData(clientDataJSON, { type, challenge, origin }) {
  let cd;
  try {
    cd = JSON.parse(new TextDecoder().decode(clientDataJSON));
  } catch {
    throw new Error("clientData: not JSON");
  }
  if (cd.type !== type) throw new Error(`clientData: type ${cd.type}, want ${type}`);
  // The challenge comparison IS the transaction binding — the single line that
  // separates human-authorized from human-authenticated. Compare decoded bytes,
  // not strings: two base64url spellings of the same bytes must not diverge.
  if (!eq(b64url.decode(cd.challenge), challenge)) throw new Error("clientData: challenge mismatch");
  if (cd.origin !== origin) throw new Error(`clientData: origin ${cd.origin}, want ${origin}`);
  return cd;
}

/**
 * Verify a registration (`navigator.credentials.create()` response).
 * Enrollment challenges are server-random — registration binds an identity,
 * not a transaction, so a random nonce is the correct challenge here and a
 * digest would be theater.
 */
export async function verifyRegistration({ attestationObject, clientDataJSON, challenge, origin, rpId }) {
  parseClientData(clientDataJSON, { type: "webauthn.create", challenge, origin });
  const { value: att } = cborDecode(attestationObject);
  if (!(att instanceof Map)) throw new Error("attestationObject: not a map");
  const authData = parseAuthenticatorData(att.get("authData"));
  if (!eq(authData.rpIdHash, await sha256(new TextEncoder().encode(rpId)))) {
    throw new Error("registration: rpIdHash mismatch");
  }
  if (!authData.userPresent) throw new Error("registration: UP not set");
  if (!authData.userVerified) throw new Error("registration: UV not set — userVerification must be required");
  if (!authData.credentialId) throw new Error("registration: no attested credential data");
  // Refuse an unsupported algorithm at ENROLLMENT, where the human can retry,
  // rather than at assertion time, where a privileged action is waiting.
  await coseToCryptoKey(authData.credentialPublicKey);
  return {
    credentialId: b64url.encode(authData.credentialId),
    publicKey: coseToStoredJwk(authData.credentialPublicKey),
    signCount: authData.signCount,
    backupEligible: authData.backupEligible,
    backupState: authData.backupState,
    attestationFmt: att.get("fmt") ?? "unknown",
  };
}

/**
 * Verify an assertion (`navigator.credentials.get()` response) against a
 * stored credential. `challenge` is the request digest — the caller computes
 * it from the canonical request, never accepts it from the network.
 */
export async function verifyAssertion({ credential, authenticatorData, clientDataJSON, signature, challenge, origin, rpId }) {
  parseClientData(clientDataJSON, { type: "webauthn.get", challenge, origin });
  const authData = parseAuthenticatorData(authenticatorData);
  if (!eq(authData.rpIdHash, await sha256(new TextEncoder().encode(rpId)))) {
    throw new Error("assertion: rpIdHash mismatch");
  }
  if (!authData.userPresent) throw new Error("assertion: UP not set");
  if (!authData.userVerified) throw new Error("assertion: UV not set — presence is not authorization (control 5)");

  const { key, alg } = await storedJwkToCryptoKey(credential.publicKey);
  const signedBytes = new Uint8Array(authenticatorData.length + 32);
  signedBytes.set(authenticatorData, 0);
  signedBytes.set(await sha256(clientDataJSON), authenticatorData.length);

  let ok;
  if (alg === "ES256") {
    ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" }, key, derToRaw(signature), signedBytes,
    );
  } else {
    ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, signedBytes);
  }
  if (!ok) throw new Error("assertion: signature invalid");

  return {
    userVerified: true,
    backupEligible: authData.backupEligible,
    backupState: authData.backupState,
    signCount: authData.signCount,
    // Recorded, not enforced — see the module header. A synced passkey reports
    // 0 forever; only a nonzero counter moving BACKWARDS is anomalous.
    signCountRegressed: credential.signCount > 0 && authData.signCount > 0 && authData.signCount <= credential.signCount,
  };
}
