// Web Push, the sending half (#37).
//
// Everything here is pure or takes its I/O as an argument, because the parts
// that are easy to get wrong — the JWT's `aud`, the signature encoding, and
// above all which HTTP statuses mean "delete this subscription" — are exactly
// the parts a live push service will not tell you about twice.
//
// NO PAYLOAD ENCRYPTION, deliberately. RFC 8291's aes128gcm against the
// subscription's own p256dh/auth is the fiddliest part of Web Push and its
// failure mode is an opaque 400. A push with NO body is legal, wakes the
// service worker, and `sw.js` was already written to treat a bodyless push as
// a real one — so the worker fetches the board itself on wake. Encryption is
// what we take when we want the notification to render offline; it is not a
// prerequisite for the first one to arrive.

/** base64url, no padding — the encoding every part of VAPID uses. */
export function b64url(bytes) {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Inverse of b64url. Tolerates padding and the standard alphabet. */
export function unb64url(str) {
  const s = String(str).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * The `aud` claim is the PUSH SERVICE's origin — not ours, and not the full
 * endpoint path. Signing over our own origin produces a JWT every push service
 * rejects with a 401, which reads identically to a bad key.
 */
export function audienceFor(endpoint) {
  return new URL(endpoint).origin;
}

/**
 * Import the application-server keypair.
 *
 * WebCrypto cannot import a bare P-256 scalar: `importKey("raw", …)` accepts
 * public keys only. So the private half is assembled into a JWK alongside the
 * public point, which has a useful side effect — a public and private half that
 * are not actually a pair fail HERE, at startup, rather than as a 401 from a
 * push service an hour later.
 */
export async function importVapidKey(publicKeyB64url, privateKeyB64url, subtle = crypto.subtle) {
  const pub = unb64url(publicKeyB64url);
  if (pub.length !== 65 || pub[0] !== 0x04) {
    throw new Error("VAPID public key must be a 65-byte uncompressed P-256 point");
  }
  const d = unb64url(privateKeyB64url);
  if (d.length !== 32) throw new Error("VAPID private key must be a 32-byte P-256 scalar");
  return await subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      x: b64url(pub.slice(1, 33)),
      y: b64url(pub.slice(33, 65)),
      d: b64url(d),
      ext: false,
    },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

/** Push services reject an `exp` more than 24h out; 12 leaves room for clock skew. */
export const JWT_TTL_SECONDS = 12 * 60 * 60;

/**
 * A compact ES256 JWS. WebCrypto's ECDSA output is already the raw r‖s pair
 * JOSE wants, so there is no DER unwrapping here — and if that ever changes,
 * the signature length assertion in the tests is what says so.
 */
export async function signVapidJwt({ audience, subject, nowSeconds }, key, subtle = crypto.subtle) {
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  const header = b64url(new TextEncoder().encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64url(
    new TextEncoder().encode(JSON.stringify({ aud: audience, exp: now + JWT_TTL_SECONDS, sub: subject })),
  );
  const signingInput = new TextEncoder().encode(`${header}.${claims}`);
  const sig = await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, signingInput);
  return `${header}.${claims}.${b64url(sig)}`;
}

/**
 * What a push service's response means for the STORE — which is the only
 * decision here with a destructive branch, so it is the one that is spelled out.
 *
 *   gone   404/410 — the subscription is permanently dead. Delete it.
 *   ok     2xx     — accepted for delivery (not delivered; nothing reports that).
 *   retry  429/5xx — the service is busy or broken. Keep it; try later.
 *   error  4xx     — OUR fault: a bad JWT, a wrong key, a malformed request.
 *
 * The last row is the one that matters. 401 and 403 mean the VAPID key is
 * wrong, which is true for EVERY subscription at once — so treating them like
 * `gone` would empty the entire store on the first bad deploy, and the symptom
 * would be silence, which is also what a working system with nothing to say
 * looks like. Only 404 and 410 are ever allowed to delete.
 */
export function classifyPushStatus(status) {
  if (status === 404 || status === 410) return "gone";
  if (status >= 200 && status < 300) return "ok";
  if (status === 429 || status >= 500) return "retry";
  return "error";
}

/**
 * Deliver one payload-less push.
 *
 * `TTL` is required by RFC 8030 and some services 400 without it. An hour is
 * chosen over 0 so a phone that is merely asleep still gets the notification;
 * 0 would mean "deliver only if the device is connected this instant", which
 * for a board change is a silent drop for the most common case.
 */
export async function sendPush(endpoint, authorization, fetchImpl = fetch) {
  const res = await fetchImpl(endpoint, {
    method: "POST",
    // No content-length: it is a forbidden header name that the runtime sets
    // itself, and a POST with no body is already length 0. Setting it by hand
    // is either ignored or throws, depending on the runtime.
    headers: { authorization, ttl: "3600", urgency: "normal" },
  });
  return { status: res.status, outcome: classifyPushStatus(res.status) };
}

/**
 * One authorization header per push-service ORIGIN, not per subscription — a
 * JWT is bound to `aud`, and re-signing per endpoint would mean an ECDSA
 * signature for every device on a service that only needs one.
 */
export async function authorizationsByAudience(endpoints, { publicKey, key, subject, nowSeconds }) {
  const out = new Map();
  for (const endpoint of endpoints) {
    const aud = audienceFor(endpoint);
    if (out.has(aud)) continue;
    const jwt = await signVapidJwt({ audience: aud, subject, nowSeconds }, key);
    out.set(aud, `vapid t=${jwt}, k=${publicKey}`);
  }
  return out;
}
