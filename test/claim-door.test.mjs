// THE CLAIM DOOR THIS REPO NOW CARRIES, AND THE TWO WAYS IT ROTS SILENTLY (#91).
//
// `.github/workflows/claim-ticket.yml` is a second handle on a door whose
// design lives in `bounded-systems/.github`. Two properties make that safe
// rather than a fork, and neither of them fails loudly on its own:
//
//   1. THE VERIFIER IS FETCHED, NOT VENDORED. `claim-authorization.mjs` and
//      `claim-digest.mjs` are checked out from the pinned `.github` at job
//      time. A copy committed here would grade a passkey signature against
//      bytes nobody agreed to, and would do it quietly — `.github`#310's
//      vendored verifier held a superseded rung classification for five days
//      with every check green, because nothing imported it.
//
//   2. THE CHECKOUT REF AND THE ACTION PIN ARE ONE SHA. Dependabot bumps a
//      `uses:` pin; it cannot see a `ref:`. Without this file a routine bump
//      splits the verifier from the broker action and nothing says so.
//
// Plus the pin hygiene the org requires of every workflow, asserted repo-wide
// rather than on the two new files, because "every action is SHA-pinned" is a
// claim about the repo and a check that only looks at today's files stops being
// evidence for it the moment someone adds tomorrow's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../", import.meta.url).pathname;
const workflowDir = join(root, ".github/workflows");
const workflows = readdirSync(workflowDir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
const read = (f) => readFileSync(join(workflowDir, f), "utf8");

const claimTicket = read("claim-ticket.yml");
const announce = read("announce-ceremony.yml");

// A `uses:` KEY — optionally the first entry of a step list. Deliberately not a
// bare /uses:/, which also matches the word in prose; these files carry a lot
// of prose and a check that trips on a comment is a check people delete.
const USES = /^[ \t]*-?[ \t]*uses:[ \t]*(\S+)/gm;
const usesIn = (text) => [...text.matchAll(USES)].map((m) => m[1]);

test("every action and reusable workflow in this repo is pinned to a 40-hex SHA", () => {
  const unpinned = [];
  for (const file of workflows) {
    for (const ref of usesIn(read(file))) {
      // A local path reference (`./.github/actions/...`) carries no ref and is
      // this repo's own committed bytes — nothing to pin.
      if (ref.startsWith("./")) continue;
      if (!/@[0-9a-f]{40}$/.test(ref)) unpinned.push(`${file}: ${ref}`);
    }
  }
  assert.deepEqual(unpinned, [], `not pinned to a commit SHA:\n${unpinned.join("\n")}`);
});

test("the pinned workflows are not an empty set — an absent glob is green for ever", () => {
  // The failure this exists for: a directory rename makes the loop above iterate
  // over nothing and pass permanently, which looks exactly like coverage.
  assert.ok(workflows.length >= 5, `only ${workflows.length} workflow files found`);
  assert.ok(usesIn(claimTicket).length >= 3, "claim-ticket.yml resolves fewer refs than it should");
});

test("THE VERIFIER IS FETCHED, NOT VENDORED — no copy of it is committed here", () => {
  for (const name of ["claim-authorization.mjs", "claim-digest.mjs", "claim-digest.vectors.json"]) {
    assert.equal(
      existsSync(join(root, name)),
      false,
      `${name} is committed in desk — the claim door must run .github's copy, not a fork of it`,
    );
    assert.equal(existsSync(join(root, "src", name)), false, `src/${name} is committed in desk`);
  }
  // And the door must actually still fetch it.
  assert.match(claimTicket, /repository:\s*bounded-systems\/\.github/);
  assert.match(claimTicket, /run:\s*node claim-authorization\.mjs/);
});

test("the .github checkout ref and the broker-gh-token pin are the SAME sha", () => {
  const checkout = claimTicket.match(/^\s*ref:\s*([0-9a-f]{40})\s*$/m);
  assert.ok(checkout, "claim-ticket.yml no longer checks out .github at a 40-hex ref");

  const action = claimTicket.match(
    /uses:\s*bounded-systems\/\.github\/\.github\/actions\/broker-gh-token@([0-9a-f]{40})/,
  );
  assert.ok(action, "claim-ticket.yml no longer resolves broker-gh-token at a 40-hex pin");

  assert.equal(
    checkout[1],
    action[1],
    "the verifier checkout and the broker action are pinned to different commits of .github — " +
      "bump both together, or say in the diff why they may differ",
  );
});

test("the claim values come from the DOOR's inputs, never from the token", () => {
  // The one property the whole authorization leg exists to protect: the token
  // contributes only the anti-replay values, so a token minted for some other
  // claim cannot be spent here. `.github` asserts these exact three lines
  // against its own copy of the workflow; this copy needs its own assertion,
  // because a passing test over there says nothing about the file over here.
  assert.match(claimTicket, /CLAIM_REPO:\s*\$\{\{\s*inputs\.repo\s*\}\}/);
  assert.match(claimTicket, /CLAIM_ISSUE:\s*\$\{\{\s*inputs\.issue\s*\}\}/);
  assert.match(claimTicket, /CLAIMANT:\s*\$\{\{\s*inputs\.claimant\s*\}\}/);
});

test("the keeper is an https literal, not a variable that can be left unset", () => {
  // #253: it was `vars.KEEPER_URL` when the leg first landed and the variable
  // did not exist, so every supplied token failed on "KEEPER_URL is unset" and
  // the input was decorative. A literal cannot be un-set from a settings page.
  const m = claimTicket.match(/^\s*KEEPER_URL:\s*(.+)$/m);
  assert.ok(m, "claim-ticket.yml no longer sets KEEPER_URL for the authorization step");
  assert.match(m[1].trim(), /^"https:\/\/\S+"$/, `KEEPER_URL is ${m[1].trim()}, not an https literal`);
});

test("the door takes all four inputs, and every one is required", () => {
  // A claim input that quietly became optional is a door that grades a weaker
  // record than the caller thinks it presented. `human_authorization` above all:
  // absent is a red run and there is no break-glass (#264).
  for (const name of ["repo", "issue", "claimant", "human_authorization"]) {
    const block = claimTicket.match(new RegExp(`^      ${name}:\\n([\\s\\S]*?)(?=^      \\w|^\\n*\\w)`, "m"));
    assert.ok(block, `claim-ticket.yml no longer declares the '${name}' input`);
    assert.match(block[1], /required:\s*true/, `input '${name}' is not required`);
  }
});

test("id-token: write is granted at the job, and is not the workflow default", () => {
  // The brief for both files: default `permissions: { contents: read }`, and the
  // OIDC grant only where a mint needs it. A top-level `id-token: write` would
  // hand it to every job a future edit adds.
  for (const [name, text] of [
    ["claim-ticket.yml", claimTicket],
    ["announce-ceremony.yml", announce],
  ]) {
    const top = text.match(/^permissions:\n((?:[ \t]+\S.*\n)+)/m);
    assert.ok(top, `${name} has no top-level permissions block`);
    assert.doesNotMatch(top[1], /id-token/, `${name} grants id-token at the top level`);
    assert.match(top[1], /contents:\s*read/, `${name}'s default is not contents: read`);
    assert.match(text, /^\s+id-token:\s*write/m, `${name} never grants id-token to the job that mints`);
  }
});

test("announce-ceremony treats desk's own designed refusals as green, not as retry-me", () => {
  // 403 means this lane's ref is not in NOTIFY_WORKFLOW_REFS yet, 405 that the
  // deployed Worker predates /approval. Both are fixed by a desk deploy, so a
  // red run would be telling the caller to retry something that cannot succeed.
  // The catch-all stays red: a notify lane that notified nobody must not pass.
  assert.match(announce, /403\|404\|405\|503\)/);
  assert.match(announce, /exit 1/);
});
