// A SYNTHETIC AUTHENTICATOR — real ES256 over real WebAuthn byte layouts.
//
// Nothing here mocks the verifier. The vendored `src/vendor/webauthn.mjs` runs
// unmodified against these bytes, so a green login suite means a signature was
// verified, not that a stub agreed with itself. That is this repo's standing
// rule for crypto-dependent code (test/oidc-fixture.mjs: "the seam supplies the
// KEYS, never a shortcut past a verification step").
//
// PARAMETERISED BY rpId AND origin, unlike the keeper's version which pins its
// own. Desk needs to produce assertions for the WRONG relying party on purpose —
// an approval-scoped assertion must be mechanically unusable here, and that is
// only assertable if the harness can mint one.
//
// PROVENANCE, STATED RATHER THAN IMPLIED: the CBOR encoder, the raw→DER
// converter and the authData layout follow the shape of
// bounded-systems/infra → cloudflare/keeper/src/keeper.test.mjs:56-147, which
// exports none of them. This is therefore a SECOND copy of test-side machinery
// and it is NOT pinned. That is a deliberate line rather than an oversight: it
// produces INPUTS, so a divergence can only make desk's tests wrong about the
// vendored verifier, and test/vendor-pin.test.mjs re-runs the same negative
// branches the keeper's suite does specifically so a divergence shows up as a
// behavioural failure rather than as silence.

const te = new TextEncoder();
const sha256 = async (d) => new Uint8Array(await crypto.subtle.digest("SHA-256", d));

export const b64 = (buf) => {
  let s = "";
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
export const unb64 = (str) => {
  const s = String(str).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

function cborEncode(value) {
  const out = [];
  const head = (major, n) => {
    if (n < 24) out.push((major << 5) | n);
    else if (n < 256) out.push((major << 5) | 24, n);
    else if (n < 65536) out.push((major << 5) | 25, n >> 8, n & 0xff);
    else out.push((major << 5) | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
  };
  const enc = (v) => {
    if (typeof v === "number" && Number.isInteger(v)) {
      if (v >= 0) head(0, v);
      else head(1, -1 - v);
    } else if (v instanceof Uint8Array) {
      head(2, v.length);
      out.push(...v);
    } else if (typeof v === "string") {
      const b = te.encode(v);
      head(3, b.length);
      out.push(...b);
    } else if (v instanceof Map) {
      head(5, v.size);
      for (const [k, val] of v) { enc(k); enc(val); }
    } else {
      throw new Error("test cbor: unsupported");
    }
  };
  enc(value);
  return new Uint8Array(out);
}

function rawToDer(raw) {
  const int = (b) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v = b.slice(i);
    if (v[0] & 0x80) v = new Uint8Array([0, ...v]);
    return [0x02, v.length, ...v];
  };
  const r = int(raw.slice(0, 32));
  const s = int(raw.slice(32));
  return new Uint8Array([0x30, r.length + s.length, ...r, ...s]);
}

/**
 * One authenticator holding one ES256 credential.
 *
 * `opts` on each ceremony is the whole list of things a test can break, one at a
 * time: { up, uv, be, bs, signCount, origin, rpId, tamper, challengeText }.
 * `rpId` and `origin` default to the ones the authenticator was built with, so
 * an assertion aimed at the keeper is `{ rpId: "keeper.bounded.tools", origin:
 * "https://keeper.bounded.tools" }` and nothing else changes.
 */
export async function makeAuthenticator({ rpId = "desk.bounded.tools", origin = `https://${rpId}`, credentialId } = {}) {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const x = raw.slice(1, 33), y = raw.slice(33, 65);
  // A CHOSEN credential id models a HOSTILE registration: fmt "none" proves
  // nothing about key possession, so nothing stops an attestation from naming an
  // id that is already enrolled and trying to overwrite its public key.
  const credId = credentialId ? unb64(credentialId) : crypto.getRandomValues(new Uint8Array(16));
  const cose = new Map([[1, 2], [3, -7], [-1, 1], [-2, x], [-3, y]]);

  const flagsByte = ({ up = true, uv = true, be = true, bs = true, at = false }) =>
    (up ? 0x01 : 0) | (uv ? 0x04 : 0) | (be ? 0x08 : 0) | (bs ? 0x10 : 0) | (at ? 0x40 : 0);

  const authData = async (flags, signCount, attested, forRpId) => {
    const h = await sha256(te.encode(forRpId));
    const base = new Uint8Array([
      ...h, flags,
      (signCount >>> 24) & 0xff, (signCount >>> 16) & 0xff, (signCount >>> 8) & 0xff, signCount & 0xff,
    ]);
    if (!attested) return base;
    const coseBytes = cborEncode(cose);
    return new Uint8Array([
      ...base, ...new Uint8Array(16), credId.length >> 8, credId.length & 0xff, ...credId, ...coseBytes,
    ]);
  };

  // `challengeText` spells the challenge in the clientData as the caller says
  // rather than canonically — the only way to model a client that chose a
  // different legal base64url spelling of the same bytes.
  const clientData = (type, challenge, o, challengeText) =>
    te.encode(JSON.stringify({ type, challenge: challengeText ?? b64(challenge), origin: o, crossOrigin: false }));

  return {
    credentialId: b64(credId),
    publicKeyJwk: { kty: "EC", crv: "P-256", alg: "ES256", x: b64(x), y: b64(y) },
    async register(challengeB64, opts = {}) {
      const challenge = unb64(challengeB64);
      const ad = await authData(flagsByte({ ...opts, at: true }), 0, true, opts.rpId ?? rpId);
      return {
        attestationObject: b64(cborEncode(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", ad]]))),
        clientDataJSON: b64(clientData("webauthn.create", challenge, opts.origin ?? origin)),
      };
    },
    async assert(challengeB64, opts = {}) {
      const challenge = unb64(challengeB64);
      const ad = await authData(flagsByte(opts), opts.signCount ?? 0, false, opts.rpId ?? rpId);
      const cdj = clientData("webauthn.get", challenge, opts.origin ?? origin, opts.challengeText);
      const signed = new Uint8Array([...ad, ...(await sha256(cdj))]);
      const rawSig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, signed));
      const sig = opts.tamper ? rawToDer(crypto.getRandomValues(new Uint8Array(64))) : rawToDer(rawSig);
      return {
        credentialId: b64(credId),
        authenticatorData: b64(ad),
        clientDataJSON: b64(cdj),
        signature: b64(sig),
      };
    },
  };
}
