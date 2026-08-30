// GitHub Actions OIDC, the caller's side of the door (#37).
//
// WHY NOT A SHARED SECRET. The sender has to prove it is the board's own lane
// and not anyone else who found the URL. A bearer token in a Worker secret
// would do that, and it is precisely the shape this org keeps removing: a
// credential with no attributable owner, valid until someone notices, and
// copyable by anything that ever reads it.
//
// An OIDC token is minted per run, expires in minutes, and carries
// `job_workflow_ref` — ONE workflow at ONE ref. That is the same pin
// `doors.json` uses to decide who may mint through the broker, so this endpoint
// is scoped the way every other capability in the org is scoped, and there is
// no secret to rotate, leak, or forget.
//
// The verification core is the broker's (`infra/cloudflare/broker/src/index.mjs`),
// deliberately: RS256 pinned, JWKS by kid with one rotation refetch, then the
// standard claims. Kept as its own file so the claim policy below — which
// workflow may notify — sits apart from the signature check and cannot be
// loosened by an edit meant for the other.

import { unb64url } from "./push.js";

export const GH_ISSUER = "https://token.actions.githubusercontent.com";
const JWKS_URL = `${GH_ISSUER}/.well-known/jwks`;

/**
 * The audience this endpoint pins. The caller must ask GitHub for a token with
 * exactly this `aud`, so a token minted for the broker — or for anything else —
 * cannot be replayed here.
 */
export const NOTIFY_AUDIENCE = "https://desk.bounded.tools";

/**
 * The one lane allowed to trigger a fan-out, pinned to `main`.
 *
 * A CONSTANT, NOT A VAR. This is a capability grant: an env override would let
 * the set of workflows that can notify every subscribed device widen without a
 * reviewed commit, which is the whole thing `doors.json` being a committed file
 * is for.
 */
export const NOTIFY_WORKFLOW_REF =
  "bounded-systems/.github-private/.github/workflows/front-desk-projection.yml@refs/heads/main";

const parseJson = (seg) => JSON.parse(new TextDecoder().decode(unb64url(seg)));

let jwksCache = null;
let jwksAt = 0;
async function fetchGitHubJwks(force = false, fetchImpl = fetch) {
  if (!force && jwksCache && Date.now() - jwksAt < 3_600_000) return jwksCache;
  const r = await fetchImpl(JWKS_URL);
  if (!r.ok) throw new Error("jwks fetch failed");
  jwksCache = (await r.json()).keys;
  jwksAt = Date.now();
  return jwksCache;
}

/**
 * Signature and standard claims. The per-caller policy is deliberately NOT here
 * — a relaxation meant for one consumer must not silently widen another.
 */
export async function verifyJwt(jwt, audience, { getJwks = fetchGitHubJwks, nowMs = Date.now } = {}) {
  const parts = String(jwt).split(".");
  if (parts.length !== 3) throw new Error("malformed jwt");
  const [h, p, sig] = parts;
  const header = parseJson(h);
  const payload = parseJson(p);

  // Pin the algorithm. Defeats alg-confusion ("none", HS256 against a public
  // key) regardless of what the verify step below would have done.
  if (header.alg !== "RS256") throw new Error("unexpected alg");

  let jwk = (await getJwks()).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await getJwks(true)).find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("unknown signing key");

  const pub = await crypto.subtle.importKey(
    "jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"],
  );
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5", pub, unb64url(sig), new TextEncoder().encode(`${h}.${p}`),
  );
  if (!ok) throw new Error("bad signature");

  const now = Math.floor(nowMs() / 1000);
  if (payload.iss !== GH_ISSUER) throw new Error("bad iss");
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(audience)) throw new Error("bad aud");
  if (typeof payload.exp !== "number" || payload.exp < now) throw new Error("expired");
  if (typeof payload.iat === "number" && payload.iat > now + 60) throw new Error("iat in future");
  if (typeof payload.nbf === "number" && payload.nbf > now) throw new Error("not yet valid");
  return payload;
}

/**
 * May this caller trigger a fan-out?
 *
 * `job_workflow_ref` rather than `workflow` or `repository`: the first names the
 * file AND the ref, so a fork, a branch, or another workflow in the same repo
 * does not satisfy it. The other two would each admit a caller we did not mean.
 */
export async function verifyNotifyCaller(jwt, opts = {}) {
  const claims = await verifyJwt(jwt, NOTIFY_AUDIENCE, opts);
  if (claims.job_workflow_ref !== NOTIFY_WORKFLOW_REF) throw new Error("workflow not allowed");
  return claims;
}
