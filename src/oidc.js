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
export const NOTIFY_WORKFLOW_REFS = [
  // The board projection — fans out "the board changed".
  "bounded-systems/.github-private/.github/workflows/front-desk-projection.yml@refs/heads/main",
  // The lane that opens desk's own Face ID ceremony, so an approval request can
  // reach a phone (#51). A SET rather than a second constant because an
  // approval notice comes from whichever lane opened the ceremony, and
  // infra#526's rule holds either way: a workflowRef pins ONE workflow, so each
  // caller is its own entry here. Adding one is a reviewed commit, which is the
  // whole point of it not being a var.
  "bounded-systems/desk/.github/workflows/deploy.yml@refs/heads/main",
  // infra's seven ceremony lanes, which now send their own approval notices.
  //
  // SEVEN ENTRIES FOR WHAT IS ONE CHANGE UPSTREAM, and that is infra#526 doing its
  // job rather than a redundancy worth collapsing. `job_workflow_ref` names a
  // FILE at a REF; there is no wildcard and no repository-level form, so the
  // only shorter spelling is one that matches on the repo — and infra carries
  // thirty workflows. Twenty-three of them are not on this list, nine of those
  // already request `id-token: write`, and any of the rest is one line away from
  // it: a repo-level grant would hand the fan-out to every lane in a repo that
  // applies Cloudflare state, not to seven reviewed ones. The list gets longer
  // as callers are added.
  // That is the cost of the pin being exact, and it is the cheaper side of the
  // trade: a list that grows by a reviewed line is visible, where a pattern that
  // stops growing is a grant nobody re-reads.
  //
  // Each is pinned to `refs/heads/main` for the same reason as the two above: a
  // branch or a fork mints a token with a different ref, so opening a PR against
  // infra cannot reach this endpoint.
  // The announce lane (.github#305). NOT a ceremony lane — it opens nothing and
  // approves nothing. It exists because a SESSION cannot reach this endpoint: a
  // session holds no Actions OIDC token, so `claim-ceremony.mjs` had no way to
  // tell a phone that the ceremony it just opened is waiting. Every claim
  // ceremony asks for a tap; none of them could ring. This lane is the one that
  // rings for them.
  //
  // Its inputs come from a session, which is the thing to look at twice — and
  // `validateApproval` is what makes it safe rather than anything here: the
  // notice's URL must be an https keeper.bounded.tools address, so a caller can
  // say THAT an approval is waiting and point at the keeper, and can point
  // nowhere else.
  "bounded-systems/.github/.github/workflows/announce-ceremony.yml@refs/heads/main",
  "bounded-systems/infra/.github/workflows/boot-deploy.yml@refs/heads/main",
  "bounded-systems/infra/.github/workflows/broker-deploy.yml@refs/heads/main",
  "bounded-systems/infra/.github/workflows/create-app.yml@refs/heads/main",
  "bounded-systems/infra/.github/workflows/keeper-deploy.yml@refs/heads/main",
  "bounded-systems/infra/.github/workflows/pathbase-door-deploy.yml@refs/heads/main",
  "bounded-systems/infra/.github/workflows/repo-admin-apply.yml@refs/heads/main",
  "bounded-systems/infra/.github/workflows/rotate-lease-key.yml@refs/heads/main",

  // The last two ceremony lanes outside infra (infra#553). Both open a keeper
  // ceremony and both announced only via a GitHub notification issue — batched,
  // routed wherever GitHub decides, and no use against a window that can be as
  // short as two minutes. Measured 2026-08-31: a bounded.tools deploy ceremony
  // opened, waited its full window, and reached no phone.
  //
  // These two are why the general claim was false. "A ceremony tells you it is
  // waiting" held for nine lanes out of eleven, and a guarantee with unmarked
  // exceptions is the thing this org spends its effort removing.
  "bounded-systems/bounded.tools/.github/workflows/deploy.yml@refs/heads/main",
  "bounded-systems/front-desk-scheduler/.github/workflows/lease-deploy.yml@refs/heads/main",
];

/** Kept for callers that want the projection specifically. */
export const NOTIFY_WORKFLOW_REF = NOTIFY_WORKFLOW_REFS[0];

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
  if (!NOTIFY_WORKFLOW_REFS.includes(claims.job_workflow_ref)) throw new Error("workflow not allowed");
  return claims;
}
