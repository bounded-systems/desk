// What a notification says (#51). The value here is that a bodyless push can
// carry meaning at all — before this every push rendered the same two constants.
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateApproval, putApproval, pending, APPROVAL_TTL_SECONDS } from "../src/pending.js";
import { fakeKv } from "./fake-kv.mjs";

const OK = {
  title: "Approve broker-deploy",
  body: "A run wants an account-wide Workers:Edit token.",
  url: "https://keeper.bounded.tools/a/abc123",
};

test("with nothing pending, the board default is served — the old path still works", async () => {
  const d = await pending(fakeKv());
  assert.equal(d.kind, "board");
  assert.equal(d.title, "Front Desk");
  assert.equal(d.body, "The board changed.");
});

test("with no store at all it still answers, rather than throwing at the worker", async () => {
  const d = await pending(undefined);
  assert.equal(d.kind, "board");
});

test("a recorded approval is what the worker then reads", async () => {
  const kv = fakeKv();
  await putApproval(kv, OK);
  const d = await pending(kv);
  assert.equal(d.kind, "approval");
  assert.equal(d.title, "Approve broker-deploy");
  assert.equal(d.url, "https://keeper.bounded.tools/a/abc123");
});

test("THE DESTINATION IS PINNED TO THE KEEPER", () => {
  // A notification that can point anywhere is a phishing notice with our icon
  // on it. Only the host that can actually take an approval is accepted.
  for (const url of [
    "https://evil.example/a/abc",
    "http://keeper.bounded.tools/a/abc",
    "https://keeper.bounded.tools.evil.example/a/abc",
    "https://desk.bounded.tools/a/abc",
  ]) {
    const r = validateApproval({ ...OK, url });
    assert.equal(r.ok, false, url);
    assert.match(r.error, /keeper\.bounded\.tools/);
  }
  assert.equal(validateApproval(OK).ok, true);
});

test("every field is required, and named when missing", () => {
  for (const k of ["title", "body", "url"]) {
    const bad = { ...OK };
    delete bad[k];
    const r = validateApproval(bad);
    assert.equal(r.ok, false);
    assert.match(r.error, new RegExp(k));
  }
  assert.equal(validateApproval(null).ok, false);
});

test("an absurd field is refused before it is stored", () => {
  assert.match(validateApproval({ ...OK, body: "x".repeat(500) }).error, /too long/);
});

test("the record expires with the ceremony it describes", async () => {
  const kv = fakeKv();
  let seen;
  await putApproval({ ...kv, put: async (k, v, o) => { seen = o; return kv.put(k, v); } }, OK);
  assert.equal(seen.expirationTtl, APPROVAL_TTL_SECONDS);
  assert.equal(APPROVAL_TTL_SECONDS, 900, "the keeper's window — an approval nobody can act on is not pending");
});

test("an unparseable record reads as nothing pending, not as a failure", async () => {
  const kv = fakeKv();
  await kv.put("pending:approval", "{not json");
  const d = await pending(kv);
  assert.equal(d.kind, "board", "a bad record must not stop the notification a reader can still act on");
});
