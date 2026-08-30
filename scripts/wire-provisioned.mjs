/**
 * Wire a provisioned KV namespace and VAPID public key into wrangler.jsonc (#39).
 *
 * THE LOGIC IS NOT IN THE WORKFLOW, deliberately — front-desk-projection.yml's
 * rule, for the same reason: a transform embedded in YAML is a transform nobody
 * can run, and this one edits the file that decides what the Worker is bound to.
 * A silent mis-edit here binds desk to the wrong store, which reads downstream
 * as "nobody has subscribed".
 *
 * Line-based rather than string-replace: the surrounding prose is long and gets
 * reflowed, and an anchor that matches a sentence would strand this the first
 * time someone rewraps a comment.
 *
 * Inputs come from the environment because they come from a minted run:
 *   KV_ID          the namespace id `wrangler kv namespace create` produced
 *   VAPID_PUBLIC   the 65-byte uncompressed P-256 point, base64url
 *   VAPID_SUBJECT  the mailto:/https: contact a push service can reach
 */

export function wire(source, { kvId, vapidPublic, vapidSubject }) {
  const lines = source.split("\n");

  // REFUSE TO WIRE TWICE. JSON tolerates a duplicate key by taking the last, so
  // a second pass would produce a file that parses fine and carries a dead
  // kv_namespaces block above the live one — the kind of config that reads as
  // correct until someone reads it. The workflow already guards this earlier;
  // this is the half that cannot be dispatched around.
  if (/^\s*"kv_namespaces"/m.test(source) || source.includes('"VAPID_PUBLIC_KEY"')) {
    throw new Error("wrangler.jsonc is already wired — refusing to write a second binding");
  }

  const varsAt = lines.findIndex((l) => l.trim() === '"vars": {');
  if (varsAt < 0) throw new Error('could not find the "vars" block in wrangler.jsonc');

  // The provisioning note says these are NOT YET DECLARED. Once they are,
  // leaving it would be a comment contradicting the lines directly below it —
  // the stale-doc rot this org keeps finding. Removed by RANGE, from the marker
  // to the vars block, so reflowed prose inside it does not strand the removal.
  const noteAt = lines.findIndex((l) => l.includes("── NOT YET DECLARED:"));
  if (noteAt >= 0 && noteAt < varsAt) lines.splice(noteAt, varsAt - noteAt);

  const at = lines.findIndex((l) => l.trim() === '"vars": {');
  lines.splice(at, 0,
    '  "kv_namespaces": [',
    "    // The Web Push subscription store (#37). Created by",
    "    // .github/workflows/provision.yml, which is the only thing that has ever",
    "    // held a credential able to make it.",
    `    { "binding": "SUBSCRIPTIONS", "id": "${kvId}" }`,
    "  ],",
    "");

  const varsLine = lines.findIndex((l) => l.trim() === '"vars": {');
  lines.splice(varsLine + 1, 0,
    "    // The VAPID public half — NOT a secret. It is served to every visitor",
    "    // inside /notify.js, and it is what each browser binds its subscription",
    "    // to. The private half is the Worker secret VAPID_PRIVATE_KEY, generated",
    "    // in-job and never printed.",
    "    //",
    "    // CHANGING THIS INVALIDATES EVERY STORED SUBSCRIPTION — a browser binds",
    "    // each one to the key it was created with, and there is no two-slot",
    "    // overlap here (contrast infra rotate-lease-key, whose slots are both",
    "    // live). Rotate on actual disclosure, never on a cadence.",
    `    "VAPID_PUBLIC_KEY": "${vapidPublic}",`,
    `    "VAPID_SUBJECT": "${vapidSubject}",`);

  return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const fs = await import("node:fs");
  const path = process.argv[2];
  if (!path) throw new Error("usage: wire-provisioned.mjs <wrangler.jsonc>");
  for (const k of ["KV_ID", "VAPID_PUBLIC", "VAPID_SUBJECT"]) {
    if (!process.env[k]) throw new Error(`${k} is unset — refusing to write a half-wired config`);
  }
  fs.writeFileSync(path, wire(fs.readFileSync(path, "utf8"), {
    kvId: process.env.KV_ID,
    vapidPublic: process.env.VAPID_PUBLIC,
    vapidSubject: process.env.VAPID_SUBJECT,
  }));
}
