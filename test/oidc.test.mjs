// The door on /notify (#37). Every test here is a way in that must stay shut.
import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyJwt, verifyNotifyCaller, NOTIFY_AUDIENCE, NOTIFY_WORKFLOW_REF } from "../src/oidc.js";
import { issuer } from "./oidc-fixture.mjs";

test("a token from the pinned workflow, at the pinned audience, is accepted", async () => {
  const iss = await issuer();
  const claims = await verifyNotifyCaller(await iss.mint(), { getJwks: iss.getJwks });
  assert.equal(claims.job_workflow_ref, NOTIFY_WORKFLOW_REF);
});

test("another workflow in the same repo is refused", async () => {
  const iss = await issuer();
  const jwt = await iss.mint({
    workflowRef: "bounded-systems/.github-private/.github/workflows/org-sync.yml@refs/heads/main",
  });
  await assert.rejects(() => verifyNotifyCaller(jwt, { getJwks: iss.getJwks }), /workflow not allowed/);
});

test("the SAME workflow on another ref is refused — the pin includes the ref", async () => {
  const iss = await issuer();
  const jwt = await iss.mint({ workflowRef: NOTIFY_WORKFLOW_REF.replace("refs/heads/main", "refs/heads/attacker") });
  await assert.rejects(() => verifyNotifyCaller(jwt, { getJwks: iss.getJwks }), /workflow not allowed/);
});

test("a token minted for another audience cannot be replayed here", async () => {
  // The broker's audience is the realistic one: the projection lane already
  // mints a token for it in the same job.
  const iss = await issuer();
  const jwt = await iss.mint({ aud: "cloudflare-workers-deploy-broker" });
  await assert.rejects(() => verifyNotifyCaller(jwt, { getJwks: iss.getJwks }), /bad aud/);
});

test("aud as an array is accepted when ours is in it", async () => {
  const iss = await issuer();
  const jwt = await iss.mint({ aud: ["something-else", NOTIFY_AUDIENCE] });
  assert.ok(await verifyNotifyCaller(jwt, { getJwks: iss.getJwks }));
});

test("alg is pinned to RS256, so 'none' and HS256 are refused", async () => {
  // The signature is a REAL RS256 one in each case — only the header lies. So
  // this pins the header check specifically, not some downstream failure that
  // would happen to also reject these.
  const iss = await issuer();
  for (const alg of ["none", "HS256", "RS512"]) {
    const jwt = await iss.mint({ alg });
    await assert.rejects(() => verifyNotifyCaller(jwt, { getJwks: iss.getJwks }), /unexpected alg/, alg);
  }
});

test("a signature from the wrong key is refused", async () => {
  const iss = await issuer();
  const other = await issuer();
  // Signed by `other`, but presented against `iss`'s JWKS under the same kid.
  const jwt = await other.mint();
  await assert.rejects(() => verifyNotifyCaller(jwt, { getJwks: iss.getJwks }), /bad signature/);
});

test("an expired token is refused", async () => {
  const iss = await issuer();
  const jwt = await iss.mint({ expIn: -1 });
  await assert.rejects(() => verifyNotifyCaller(jwt, { getJwks: iss.getJwks }), /expired/);
});

test("a token issued in the future is refused", async () => {
  const iss = await issuer();
  const now = Math.floor(Date.now() / 1000);
  const jwt = await iss.mint({ iat: now + 600 });
  await assert.rejects(() => verifyNotifyCaller(jwt, { getJwks: iss.getJwks }), /iat in future/);
});

test("a not-yet-valid token is refused", async () => {
  const iss = await issuer();
  const jwt = await iss.mint({ nbf: Math.floor(Date.now() / 1000) + 600 });
  await assert.rejects(() => verifyNotifyCaller(jwt, { getJwks: iss.getJwks }), /not yet valid/);
});

test("a foreign issuer is refused even with a valid signature", async () => {
  const iss = await issuer();
  const jwt = await iss.mint({ iss: "https://token.actions.githubusercontent.example" });
  await assert.rejects(() => verifyNotifyCaller(jwt, { getJwks: iss.getJwks }), /bad iss/);
});

test("a malformed token is refused before anything is parsed as a claim", async () => {
  const iss = await issuer();
  for (const bad of ["", "a.b", "not-a-jwt", "a.b.c.d"]) {
    await assert.rejects(() => verifyNotifyCaller(bad, { getJwks: iss.getJwks }), /malformed jwt/);
  }
});

test("an unknown kid triggers exactly one refetch, for key rotation", async () => {
  const iss = await issuer("rotated-in");
  let calls = 0;
  const getJwks = async (force) => {
    calls++;
    // The first read predates the rotation; the forced one sees the new key.
    return force ? iss.jwks : [];
  };
  const jwt = await iss.mint();
  assert.ok(await verifyJwt(jwt, NOTIFY_AUDIENCE, { getJwks }));
  assert.equal(calls, 2, "one miss, one forced refetch");
});

test("a kid that is unknown even after the refetch is refused", async () => {
  const iss = await issuer();
  const jwt = await iss.mint();
  await assert.rejects(
    () => verifyJwt(jwt, NOTIFY_AUDIENCE, { getJwks: async () => [] }),
    /unknown signing key/,
  );
});
