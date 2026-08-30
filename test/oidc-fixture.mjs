// A synthetic GitHub OIDC issuer: a real RSA keypair producing real RS256
// signatures, so the verifier is exercised rather than mocked out. Same posture
// as the keeper's synthetic authenticator — the seam supplies the KEYS, never a
// shortcut past a verification step.
import { b64url } from "../src/push.js";
import { GH_ISSUER, NOTIFY_AUDIENCE, NOTIFY_WORKFLOW_REF } from "../src/oidc.js";

export { GH_ISSUER, NOTIFY_AUDIENCE, NOTIFY_WORKFLOW_REF };

export async function issuer(kid = "test-key-1") {
  const kp = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
  const jwks = [{ ...jwk, kid, alg: "RS256", use: "sig" }];

  /** Mint a token. Every field is overridable so a test can break exactly one. */
  async function mint({
    aud = NOTIFY_AUDIENCE,
    iss = GH_ISSUER,
    workflowRef = NOTIFY_WORKFLOW_REF,
    alg = "RS256",
    expIn = 300,
    iat = null,
    nbf = null,
    nowSeconds = Math.floor(Date.now() / 1000),
    signWith = kp.privateKey,
    header = {},
  } = {}) {
    const h = b64url(new TextEncoder().encode(JSON.stringify({ alg, kid, typ: "JWT", ...header })));
    const claims = {
      iss, aud,
      exp: nowSeconds + expIn,
      iat: iat ?? nowSeconds,
      repository: "bounded-systems/.github-private",
      repository_owner: "bounded-systems",
      job_workflow_ref: workflowRef,
    };
    if (nbf !== null) claims.nbf = nbf;
    const p = b64url(new TextEncoder().encode(JSON.stringify(claims)));
    const sig = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5", signWith, new TextEncoder().encode(`${h}.${p}`),
    );
    return `${h}.${p}.${b64url(sig)}`;
  }

  return { jwks, getJwks: async () => jwks, mint, keypair: kp, kid };
}
