// What a notification says (#51). The value here is that a bodyless push can
// carry meaning at all — before this every push rendered the same two constants.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  APPROVAL_TTL_SECONDS,
  ceremonyIdFrom,
  pending,
  pendingApprovals,
  putApproval,
  validateApproval,
} from "../src/pending.js";
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

// ── many outstanding at once (#65) ───────────────────────────────────────────
//
// #51 stored every approval under one key. That was invisible while ceremonies
// were serial and wrong the moment two overlap: the second overwrote the first,
// and a live approval vanished while still being perfectly valid. These pin the
// storage change without touching what the phone renders.

const A = { ...OK, url: "https://keeper.bounded.tools/a/aaaAAA111" };
const B = { title: "Approve a claim on infra#560", body: "second ceremony", url: "https://keeper.bounded.tools/a/bbbBBB222" };

const at = (iso) => () => Date.parse(iso);

test("two live ceremonies do not displace each other", async () => {
  // The #51 bug, stated as a test: under one slot this returned 1.
  const kv = fakeKv();
  await putApproval(kv, A, at("2026-08-31T16:00:00Z"));
  await putApproval(kv, B, at("2026-08-31T16:05:00Z"));
  const all = await pendingApprovals(kv);
  assert.equal(all.length, 2);
  assert.deepEqual(all.map((x) => x.url).sort(), [A.url, B.url].sort());
});

test("the phone still shows exactly one thing, and it is the newest", async () => {
  // #51's display reasoning is kept, not reversed: the reader has to open the
  // newest anyway, so `pending()` still answers with one.
  const kv = fakeKv();
  await putApproval(kv, A, at("2026-08-31T16:00:00Z"));
  await putApproval(kv, B, at("2026-08-31T16:05:00Z"));
  const d = await pending(kv);
  assert.equal(d.kind, "approval");
  assert.equal(d.url, B.url);
});

test("newest wins regardless of insertion order — ceremony ids carry no time", async () => {
  // Sorting by key would be sorting by random bytes. `aaaAAA111` sorts before
  // `bbbBBB222`, so a key-ordered implementation passes the test above by luck
  // and fails this one.
  const kv = fakeKv();
  await putApproval(kv, B, at("2026-08-31T16:00:00Z"));
  await putApproval(kv, A, at("2026-08-31T16:05:00Z"));
  assert.equal((await pending(kv)).url, A.url);
});

test("re-pushing one ceremony updates it rather than stacking a duplicate", async () => {
  const kv = fakeKv();
  await putApproval(kv, A, at("2026-08-31T16:00:00Z"));
  await putApproval(kv, A, at("2026-08-31T16:05:00Z"));
  const all = await pendingApprovals(kv);
  assert.equal(all.length, 1);
  assert.equal(all[0].at, "2026-08-31T16:05:00.000Z");
});

test("every entry carries its own TTL, so one expiry cannot take the others", async () => {
  const seen = [];
  const kv = fakeKv();
  const spy = { ...kv, put: async (k, v, o) => { seen.push(o); return kv.put(k, v); } };
  await putApproval(spy, A);
  await putApproval(spy, B);
  assert.equal(seen.length, 2);
  for (const o of seen) assert.equal(o.expirationTtl, APPROVAL_TTL_SECONDS);
});

test("pendingApprovals PAGES — a queue longer than one page is not truncated", async () => {
  // fake-kv pages because the real KV does. The intake shape opens up to 41
  // ceremonies, so this is the case the feature exists for.
  const kv = fakeKv(2);
  for (let i = 0; i < 7; i++) {
    await putApproval(
      kv,
      { title: `t${i}`, body: `b${i}`, url: `https://keeper.bounded.tools/a/id${i}` },
      at(`2026-08-31T16:0${i}:00Z`),
    );
  }
  const all = await pendingApprovals(kv);
  assert.equal(all.length, 7);
  assert.equal(all[0].url, "https://keeper.bounded.tools/a/id6", "newest first");
});

test("a pre-#65 single-slot record is still surfaced after a deploy", async () => {
  // Dropping it would silently lose exactly one live approval: the one
  // outstanding at the moment of the rollout.
  const kv = fakeKv();
  await kv.put("pending:approval", JSON.stringify({ ...A, at: "2026-08-31T16:00:00Z" }));
  const d = await pending(kv);
  assert.equal(d.kind, "approval");
  assert.equal(d.url, A.url);
});

test("a legacy record is not double-counted once the same ceremony is re-pushed", async () => {
  const kv = fakeKv();
  await kv.put("pending:approval", JSON.stringify({ ...A, at: "2026-08-31T16:00:00Z" }));
  await putApproval(kv, A, at("2026-08-31T16:05:00Z"));
  const all = await pendingApprovals(kv);
  assert.equal(all.length, 1);
});

test("an unreadable record does not hide the ones a reader can still act on", async () => {
  const kv = fakeKv();
  await putApproval(kv, A, at("2026-08-31T16:00:00Z"));
  await kv.put("pending:approval:corrupt", "{not json");
  const all = await pendingApprovals(kv);
  assert.equal(all.length, 1);
  assert.equal(all[0].url, A.url);
});

test("a record with no usable timestamp sorts last but is never dropped", async () => {
  const kv = fakeKv();
  await kv.put("pending:approval:undated", JSON.stringify({ ...B, at: undefined }));
  await putApproval(kv, A, at("2026-08-31T16:00:00Z"));
  const all = await pendingApprovals(kv);
  assert.equal(all.length, 2);
  assert.equal(all[0].url, A.url);
  assert.equal(all[1].url, B.url);
});

// ── the URL is an approval PAGE, not merely the right host ───────────────────

test("the ceremony id is the path segment, and only that shape is an approval URL", () => {
  assert.equal(ceremonyIdFrom("https://keeper.bounded.tools/a/mS9zfMwXSsOyv2IeEVJymg"), "mS9zfMwXSsOyv2IeEVJymg");
  for (const bad of [
    "https://keeper.bounded.tools/",
    "https://keeper.bounded.tools/enroll",
    "https://keeper.bounded.tools/a/",
    "https://keeper.bounded.tools/a/one/two",
    "http://keeper.bounded.tools/a/abc",
    "https://keeper.bounded.tools.evil.test/a/abc",
    "https://desk.bounded.tools/a/abc",
    "not a url",
  ]) {
    assert.equal(ceremonyIdFrom(bad), null, bad);
  }
});

test("a keeper URL that is not an approval page is refused — #51 checked only the host", () => {
  const r = validateApproval({ ...OK, url: "https://keeper.bounded.tools/enroll" });
  assert.equal(r.ok, false);
  assert.match(r.error, /approval address/);
});

test("putApproval refuses a non-approval URL rather than inventing a key", async () => {
  await assert.rejects(
    () => putApproval(fakeKv(), { ...OK, url: "https://example.test/a/x" }),
    /not an approval URL/,
  );
});

test("valid JSON with no url is treated as absent — a notification must point somewhere", async () => {
  // Distinct from the corrupt-JSON case above: `{}` parses fine, so only the
  // shape guard stops it becoming an approval whose url is undefined — a
  // notification the reader can tap and land nowhere.
  const kv = fakeKv();
  await kv.put("pending:approval:empty", "{}");
  await kv.put("pending:approval:nulled", "null");
  assert.deepEqual(await pendingApprovals(kv), []);
  assert.equal((await pending(kv)).kind, "board");
});
