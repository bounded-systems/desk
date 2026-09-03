// What a QUESTION is, and the four things it must never be confused with (#69):
// an approval, a guess about who answered, a record that vanishes when nobody
// does, and one page of a listing.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ANSWER_RUNG,
  UNREVIEWED,
  QUESTION_TTL_SECONDS,
  QUESTION_WINDOW_SECONDS,
  answerQuestion,
  getQuestion,
  listQuestions,
  mayAnswer,
  mayList,
  oldestOpenQuestion,
  openQuestions,
  putQuestion,
  questionIdFrom,
  questionUrlFor,
  questionViews,
  validateQuestion,
  viewOf,
} from "../src/questions.js";
import { APPROVAL_TTL_SECONDS, ceremonyIdFrom, pending, pendingApprovals, putApproval, validateApproval } from "../src/pending.js";
import { fakeKv } from "./fake-kv.mjs";

const ASK = {
  prompt: "Should the intake lane keep opening one issue per repo?",
  choices: ["yes", "no"],
  no_answer_policy: "default",
  no_answer_value: "no",
};

const at = (iso) => () => Date.parse(iso);
const T0 = "2026-09-01T09:00:00Z";
const ids = (...names) => {
  let i = 0;
  return () => names[i++];
};

// ── the rung split (#69) ─────────────────────────────────────────────────────

test("AN ANSWER IS INFORMATION, AND THE RECORD SAYS SO IN A FIELD", async () => {
  // The whole constraint: nothing a reader takes from here may be spent as an
  // authorization, and nothing stored should let one be mistaken for it.
  const kv = fakeKv();
  const rec = await putQuestion(kv, validateQuestion(ASK).value, at(T0), ids("q1"));
  const answered = await answerQuestion(kv, "q1", { value: "yes" }, at("2026-09-01T10:00:00Z"));
  assert.equal(answered.ok, true);
  assert.equal(answered.value.answer.rung, "human-reviewed");
  assert.equal(answered.value.rung, ANSWER_RUNG);
  assert.equal(ANSWER_RUNG, "human-reviewed", "desk#65 caps it here and cannot cap it higher");
  // Nothing anywhere in the stored record or the view is authorization-shaped.
  assert.ok(!(await kv.get("question:q1")).includes("human-authorized"));
  assert.ok(!JSON.stringify(answered.value).includes("authorized"));
  assert.equal(rec.url, questionUrlFor("q1"));
});

test("a caller cannot talk its way up a rung", async () => {
  const kv = fakeKv();
  await putQuestion(kv, validateQuestion(ASK).value, at(T0), ids("q1"));
  const r = await answerQuestion(
    kv,
    "q1",
    { value: "yes", rung: "human-authorized", aal: "aal2" },
    at("2026-09-01T10:00:00Z"),
  );
  assert.equal(r.value.answer.rung, ANSWER_RUNG, "the rung is written here, never taken from the body");
  assert.equal(JSON.parse(await kv.get("question:q1")).answer.rung, ANSWER_RUNG);
});

test("THE ANSWER DOOR REFUSES A CALLER IT CANNOT NAME, and says which credential it wants", async () => {
  // An UNCONFIGURED deploy refuses rather than admits: no signing key means the
  // predicate cannot check a session, and "cannot check" must never read as "no
  // check needed". 503 names which piece, as every other missing binding does.
  const unconfigured = await mayAnswer(new Request("https://desk.bounded.tools/human/q1/answer", { method: "POST" }), {});
  assert.equal(unconfigured.ok, false);
  assert.equal(unconfigured.status, 503);
  assert.match(unconfigured.reason, /signing key/);

  // A configured deploy with no cookie: 401, and the sentence names the one
  // credential that opens it. NOT 501 any more — there IS something to present.
  const r = await mayAnswer(
    new Request("https://desk.bounded.tools/human/q1/answer", { method: "POST" }),
    { SESSION_SECRET: "s", SUBSCRIPTIONS: fakeKv() },
  );
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
  assert.match(r.reason, /desk#65/);
  assert.match(r.reason, /desk login/);
  // The rungs stay where they are: this door is below `human-authorized` and its
  // refusal must not borrow that vocabulary.
  assert.ok(!r.reason.includes("authorized"));

  // A NULL request and a NULL env fail closed rather than throwing — both are
  // reachable (a call site that forgot an argument is a bug, not an admission).
  assert.equal((await mayAnswer(null, null)).ok, false);
});

// ── a human answer and a fired default are DIFFERENT FACTS (#69, rule 3) ─────

test("a fired default is not an answer, and does not populate the answer field", async () => {
  const kv = fakeKv();
  await putQuestion(kv, validateQuestion(ASK).value, at(T0), ids("q1"));
  const rec = await getQuestion(kv, "q1");

  const open = viewOf(rec, Date.parse("2026-09-01T10:00:00Z"));
  assert.equal(open.status, "open");
  assert.equal(open.default_fired, false);
  assert.equal(open.default_value, null);
  assert.equal(open.answer, null);
  assert.equal(open.rung, UNREVIEWED);

  const late = viewOf(rec, Date.parse("2026-09-30T10:00:00Z"));
  assert.equal(late.status, "default-fired");
  assert.equal(late.default_fired, true);
  assert.equal(late.default_value, "no");
  assert.equal(late.answer, null, "NOBODY ANSWERED — the answer field must stay empty");
  assert.equal(late.rung, UNREVIEWED, "a default nobody reviewed is not human-reviewed");
});

test("a human answer sets the answer field and fires no default", async () => {
  const kv = fakeKv();
  await putQuestion(kv, validateQuestion(ASK).value, at(T0), ids("q1"));
  await answerQuestion(kv, "q1", { value: "no" }, at("2026-09-01T10:00:00Z"));
  // Same value the default would have produced — which is exactly the case a
  // reader must still be able to tell apart.
  const v = viewOf(await getQuestion(kv, "q1"), Date.parse("2026-09-30T10:00:00Z"));
  assert.equal(v.status, "answered");
  assert.equal(v.answer.value, "no");
  assert.equal(v.default_fired, false);
  assert.equal(v.default_value, null);
  assert.equal(v.rung, ANSWER_RUNG);
});

test("block and escalate substitute nothing at all", async () => {
  for (const [policy, status] of [["block", "blocked"], ["escalate", "escalated"]]) {
    const kv = fakeKv();
    const asked = validateQuestion({ prompt: "p", no_answer_policy: policy });
    assert.equal(asked.ok, true, policy);
    await putQuestion(kv, asked.value, at(T0), ids("q1"));
    const v = viewOf(await getQuestion(kv, "q1"), Date.parse("2026-09-30T10:00:00Z"));
    assert.equal(v.status, status);
    assert.equal(v.default_fired, false);
    assert.equal(v.default_value, null);
    assert.equal(v.answer, null);
  }
});

test("EVERY QUESTION DECLARES ITS POLICY — there is no default policy", () => {
  const { no_answer_policy: _drop, no_answer_value: _drop2, ...bare } = ASK;
  const r = validateQuestion(bare);
  assert.equal(r.ok, false);
  assert.match(r.error, /no_answer_policy/);
  assert.equal(validateQuestion({ ...ASK, no_answer_policy: "shrug" }).ok, false);
  // "default" without a value is a policy that cannot fire.
  assert.match(validateQuestion({ ...ASK, no_answer_value: undefined }).error, /no_answer_value/);
  // A default outside the choice set is one no person could have picked.
  assert.match(validateQuestion({ ...ASK, no_answer_value: "maybe" }).error, /not one of the choices/);
  // And a value with a policy that ignores it is a caller misreading the verb.
  assert.match(
    validateQuestion({ prompt: "p", no_answer_policy: "block", no_answer_value: "no" }).error,
    /meaningless/,
  );
});

test("every other field is named when it is wrong", () => {
  assert.match(validateQuestion({ ...ASK, prompt: "" }).error, /prompt/);
  assert.match(validateQuestion({ ...ASK, prompt: "x".repeat(401) }).error, /too long/);
  assert.match(validateQuestion({ ...ASK, choices: [] }).error, /choices/);
  assert.match(validateQuestion({ ...ASK, choices: ["a", "a"] }).error, /distinct/);
  assert.match(validateQuestion({ ...ASK, choices: ["a", 2] }).error, /choice/);
  assert.equal(validateQuestion(null).ok, false);
  // No choice set at all is fine — a free-text question is still a question.
  assert.equal(validateQuestion({ prompt: "why?", no_answer_policy: "escalate" }).ok, true);
});

// ── TTL is a different class from approvals (#69, rule 4) ────────────────────

test("the record OUTLIVES its own answering window, so expiry can still be described", async () => {
  const kv = fakeKv();
  // PER KEY, not "the last put wins": a question writes the record AND its
  // askable-set pointer, and the whole point is that they expire on different
  // clocks. A spy that keeps one options bag would have read the pointer's TTL
  // as the record's and called that green.
  const seen = new Map();
  const spy = { ...kv, put: async (k, v, o) => { seen.set(k, o); return kv.put(k, v); } };
  await putQuestion(spy, validateQuestion(ASK).value, at(T0), ids("q1"));

  assert.equal(seen.get("question:q1").expirationTtl, QUESTION_TTL_SECONDS);
  // The pointer is the ASKABLE set, so it dies with the window it describes —
  // and its death is not the question's: the record above outlives it.
  const pointer = [...seen.keys()].find((k) => k !== "question:q1");
  assert.equal(seen.get(pointer).expirationTtl, QUESTION_WINDOW_SECONDS);
  assert.notEqual(QUESTION_TTL_SECONDS, APPROVAL_TTL_SECONDS, "900 is the keeper's ceremony window, not a question's");
  assert.ok(QUESTION_TTL_SECONDS > QUESTION_WINDOW_SECONDS,
    "KV expiry DELETES: a record that dies with its window reads as 'no such question', not 'the default fired'");
  assert.ok(QUESTION_WINDOW_SECONDS > APPROVAL_TTL_SECONDS * 100, "a question may be answered tomorrow");

  // The record is still there, and still says what happened, long after the
  // window shut.
  const v = viewOf(await getQuestion(kv, "q1"), Date.parse(T0) + QUESTION_WINDOW_SECONDS * 1000 + 1);
  assert.equal(v.status, "default-fired");
});

test("an unreadable deadline leaves the question open rather than firing a default", async () => {
  // Firing off a timestamp we could not parse would invent the one fact this
  // record exists to keep straight.
  const kv = fakeKv();
  await putQuestion(kv, validateQuestion(ASK).value, at(T0), ids("q1"));
  const rec = { ...(await getQuestion(kv, "q1")), deadline: "not a date" };
  const v = viewOf(rec, Date.parse("2027-01-01T00:00:00Z"));
  assert.equal(v.status, "open");
  assert.equal(v.default_fired, false);
});

test("answering is refused once the declared default has fired", async () => {
  const kv = fakeKv();
  await putQuestion(kv, validateQuestion(ASK).value, at(T0), ids("q1"));
  const r = await answerQuestion(kv, "q1", { value: "yes" }, at("2026-09-30T00:00:00Z"));
  assert.equal(r.ok, false);
  assert.equal(r.status, 409);
  assert.match(r.error, /default already fired/);
  // Under block/escalate nothing fired, so a late answer is still meaningful.
  await putQuestion(kv, validateQuestion({ prompt: "p", no_answer_policy: "block" }).value, at(T0), ids("q2"));
  assert.equal((await answerQuestion(kv, "q2", { value: "late" }, at("2026-09-30T00:00:00Z"))).ok, true);
});

test("an answer is not overwritable, and an unknown id is not invented", async () => {
  const kv = fakeKv();
  await putQuestion(kv, validateQuestion(ASK).value, at(T0), ids("q1"));
  await answerQuestion(kv, "q1", { value: "yes" }, at("2026-09-01T10:00:00Z"));
  const second = await answerQuestion(kv, "q1", { value: "no" }, at("2026-09-01T11:00:00Z"));
  assert.equal(second.ok, false);
  assert.equal(second.status, 409);
  assert.equal(viewOf(await getQuestion(kv, "q1")).answer.value, "yes");

  const missing = await answerQuestion(kv, "nope", { value: "yes" }, at(T0));
  assert.equal(missing.status, 404);
  assert.equal(await kv.get("question:nope"), null);
});

test("an answer outside the declared choice set is refused", async () => {
  const kv = fakeKv();
  await putQuestion(kv, validateQuestion(ASK).value, at(T0), ids("q1"));
  const r = await answerQuestion(kv, "q1", { value: "maybe" }, at("2026-09-01T10:00:00Z"));
  assert.equal(r.ok, false);
  assert.match(r.error, /not one of the choices/);
  assert.match((await answerQuestion(kv, "q1", {}, at(T0))).error, /value/);
});

// ── the url rule is PER KIND, and neither kind is weakened (#69, rule 1) ─────

test("a question address is desk, an approval address is the keeper, AND NEITHER ACCEPTS THE OTHER", () => {
  const q = "https://desk.bounded.tools/human/abc123";
  const a = "https://keeper.bounded.tools/a/abc123";

  assert.equal(questionIdFrom(q), "abc123");
  assert.equal(ceremonyIdFrom(a), "abc123");

  // The failure a single shared set of allowed origins would pass: both of
  // these stay false, in both directions.
  assert.equal(questionIdFrom(a), null, "a question is never answered at the keeper");
  assert.equal(ceremonyIdFrom(q), null, "an approval never points at desk");
  assert.equal(validateQuestion({ ...ASK, url: a }).ok, false);
  assert.equal(validateApproval({ title: "t", body: "b", url: q }).ok, false);
});

test("the question url rule is host-, scheme- AND path-shaped, like the keeper's", () => {
  for (const bad of [
    "https://evil.example/human/abc",
    "http://desk.bounded.tools/human/abc",
    "https://desk.bounded.tools.evil.example/human/abc",
    "https://desk.bounded.tools/human",
    "https://desk.bounded.tools/human/",
    "https://desk.bounded.tools/human/a/b",
    "https://desk.bounded.tools/human/" + "x".repeat(65),
    "https://desk.bounded.tools/human/has spaces",
    "not a url",
    "",
  ]) {
    assert.equal(questionIdFrom(bad), null, bad);
    assert.equal(validateQuestion({ ...ASK, url: bad }).ok, false, bad);
  }
});

test("a stored question pointing anywhere but desk reads as absent", async () => {
  // The check is on the way OUT as well as in: this record becomes a link a
  // person taps, and one store holds three kinds of record.
  const kv = fakeKv();
  await kv.put("question:evil", JSON.stringify({
    id: "evil", prompt: "tap me", no_answer_policy: "block",
    url: "https://evil.example/human/evil", asked_at: T0, deadline: "2026-09-08T09:00:00Z", answer: null,
  }));
  assert.equal(await getQuestion(kv, "evil"), null);
  assert.deepEqual(await listQuestions(kv), []);
});

// ── listing pages, and the prefixes stay disjoint (#69, rule 5) ──────────────

test("listQuestions PAGES — a page-sized listing is not the whole listing", async () => {
  const kv = fakeKv(2);
  for (let i = 0; i < 7; i++) {
    await putQuestion(kv, validateQuestion({ prompt: `q${i}`, no_answer_policy: "block" }).value,
      at(`2026-09-01T09:0${i}:00Z`), ids(`id${i}`));
  }
  const all = await listQuestions(kv);
  assert.equal(all.length, 7);
  assert.equal(all[0].prompt, "q6", "newest first");
});

test("newest first regardless of insertion order — ids carry no time", async () => {
  // Sorting by key sorts by random bytes. `aaa` sorts before `bbb`, so a
  // key-ordered implementation passes the test above by luck and fails this one.
  const kv = fakeKv();
  await putQuestion(kv, validateQuestion({ prompt: "older", no_answer_policy: "block" }).value, at("2026-09-01T09:00:00Z"), ids("bbb"));
  await putQuestion(kv, validateQuestion({ prompt: "newer", no_answer_policy: "block" }).value, at("2026-09-01T10:00:00Z"), ids("aaa"));
  assert.equal((await listQuestions(kv))[0].prompt, "newer");
});

test("a question with no usable timestamp sorts last but is never dropped", async () => {
  const kv = fakeKv();
  await putQuestion(kv, validateQuestion({ prompt: "dated", no_answer_policy: "block" }).value, at(T0), ids("q1"));
  await kv.put("question:undated", JSON.stringify({
    id: "undated", prompt: "undated", no_answer_policy: "block",
    url: questionUrlFor("undated"), asked_at: undefined, deadline: undefined, answer: null,
  }));
  const all = await listQuestions(kv);
  assert.equal(all.length, 2);
  assert.equal(all[1].prompt, "undated");
});

test("an unreadable record does not hide the questions a person can still answer", async () => {
  const kv = fakeKv();
  await putQuestion(kv, validateQuestion(ASK).value, at(T0), ids("q1"));
  await kv.put("question:corrupt", "{not json");
  await kv.put("question:empty", "{}");
  const all = await listQuestions(kv);
  assert.equal(all.length, 1);
  assert.equal(all[0].id, "q1");
});

test("THE THREE KINDS IN ONE NAMESPACE STAY OUT OF EACH OTHER'S LISTINGS", async () => {
  // The fan-out already broke once on a stub that ignored prefixes. `question:`
  // is neither a prefix of nor prefixed by `sub:` or `pending:approval`.
  const kv = fakeKv(2);
  await putQuestion(kv, validateQuestion(ASK).value, at(T0), ids("q1"));
  await putApproval(kv, { title: "t", body: "b", url: "https://keeper.bounded.tools/a/cer1" }, at(T0));
  await kv.put("sub:deadbeef", JSON.stringify({ endpoint: "https://push.example/x" }));

  assert.deepEqual((await listQuestions(kv)).map((q) => q.id), ["q1"]);
  assert.deepEqual((await pendingApprovals(kv)).map((a) => a.url), ["https://keeper.bounded.tools/a/cer1"]);
});

test("openQuestions is only the ones a person could still answer", async () => {
  const kv = fakeKv();
  await putQuestion(kv, validateQuestion(ASK).value, at(T0), ids("open1"));
  await putQuestion(kv, validateQuestion({ ...ASK, prompt: "old" }).value, at("2026-01-01T00:00:00Z"), ids("closed1"));
  await putQuestion(kv, validateQuestion({ ...ASK, prompt: "done" }).value, at(T0), ids("done1"));
  await answerQuestion(kv, "done1", { value: "yes" }, at("2026-09-01T10:00:00Z"));

  const now = Date.parse("2026-09-01T12:00:00Z");
  assert.deepEqual((await openQuestions(kv, now)).map((q) => q.id), ["open1"]);
  assert.equal((await questionViews(kv, now)).length, 3, "the rest are still on file, just not open");
});

// ── what the phone shows: still ONE thing (#51, extended by #69) ─────────────

test("an approval OUTRANKS a question — its window closes and a question's does not", async () => {
  const kv = fakeKv();
  await putQuestion(kv, validateQuestion(ASK).value, at(T0), ids("q1"));
  await putApproval(kv, { title: "Approve broker-deploy", body: "b", url: "https://keeper.bounded.tools/a/cer1" }, at(T0));
  const d = await pending(kv);
  assert.equal(d.kind, "approval");
  assert.equal(d.url, "https://keeper.bounded.tools/a/cer1");
});

// THE CLOCK IS AN ARGUMENT, in every one of these. Whether a question is still
// open is a judgement about a moment; measured against the wall clock instead,
// these fixtures were open until 2026-09-08 and the suite went red on a date
// with no code change — and the expired case degraded the other way, asserting
// "board" vacuously because both fixtures had expired.
const NOW = Date.parse("2026-09-02T09:00:00Z");

test("with no approval outstanding, the phone raises the longest-waiting question", async () => {
  const kv = fakeKv();
  await putQuestion(kv, validateQuestion({ ...ASK, prompt: "asked first" }).value, at("2026-09-01T09:00:00Z"), ids("q1"));
  await putQuestion(kv, validateQuestion({ ...ASK, prompt: "asked second" }).value, at("2026-09-01T10:00:00Z"), ids("q2"));
  const d = await pending(kv, NOW);
  assert.equal(d.kind, "question", "NOT 'approval' — a phone must not render a question as a Face ID prompt");
  assert.equal(d.body, "asked first");
  assert.equal(d.url, questionUrlFor("q1"));

  // ANTI-VACUITY: the same fixtures a week later are all closed, and then the
  // board default is the honest answer rather than an accident of the date.
  const after = await pending(kv, Date.parse("2026-09-09T09:00:00Z"));
  assert.equal(after.kind, "board");
});

test("an answered or expired question is not raised, and the board default returns", async () => {
  const kv = fakeKv();
  await putQuestion(kv, validateQuestion(ASK).value, at("2026-01-01T00:00:00Z"), ids("stale"));
  await putQuestion(kv, validateQuestion(ASK).value, at(T0), ids("done"));
  await answerQuestion(kv, "done", { value: "yes" }, at("2026-09-01T10:00:00Z"));
  // Both are seeded OPEN at NOW and closed only by what happened to them, so
  // this cannot pass by everything having expired.
  const d = await pending(kv, NOW);
  assert.equal(d.kind, "board", "nothing is waiting on a person, so there is nothing to raise");
  // ANTI-VACUITY: each is excluded for ITS OWN reason at this clock, not because
  // the fixtures have all drifted past their window.
  assert.deepEqual(
    Object.fromEntries((await questionViews(kv, NOW)).map((q) => [q.id, q.status])),
    { done: "answered", stale: "default-fired" },
  );
});

// ── what the phone's one slot costs, and what may fill it ────────────────────

test("AN UNDATED QUESTION DOES NOT TAKE THE SLOT, and does not hold it for ever", async () => {
  // `listQuestions` sorts a record it cannot date LAST so the listing does not
  // drop it. Reading that end as "the oldest" made the one record we could not
  // date the longest-waiting one — and since an unparseable deadline never
  // closes either, it kept the single slot for ever and starved every real
  // question behind it.
  const kv = fakeKv();
  await kv.put("question:undated", JSON.stringify({
    id: "undated", prompt: "UNDATED", choices: null, no_answer_policy: "block",
    no_answer_value: null, url: questionUrlFor("undated"), answer: null,
  }));
  await kv.put("open-question:undated", "");
  await putQuestion(kv, validateQuestion({ ...ASK, prompt: "a real one" }).value, at(T0), ids("q1"));

  const d = await pending(kv, NOW);
  assert.equal(d.body, "a real one", "the datable question is the one that has demonstrably been waiting");
  // Ten years on it still is not raised — the undatable record never closes, so
  // "it will fall out of the window eventually" is not true of it.
  assert.notEqual((await pending(kv, Date.parse("2036-01-01T00:00:00Z"))).body, "UNDATED");
  // And it is still READABLE. Not raising it is not dropping it.
  assert.ok((await listQuestions(kv)).some((q) => q.id === "undated"));
});

test("naming the oldest open question does not read the whole corpus", async () => {
  // /pending is unauthenticated and is what the service worker fetches on every
  // push wake, so its cost is what an anonymous caller can make us spend. With
  // the records kept for QUESTION_TTL_SECONDS and only the ANSWERING WINDOW
  // bounding openness, reading every record to find the open ones grew that
  // cost with every question ever asked — past the subrequest ceiling, /pending
  // fails and the phone is back to "The board changed.", the #51 defect.
  const kv = fakeKv();
  let gets = 0;
  const counting = { ...kv, get: async (k) => { gets++; return kv.get(k); } };
  for (let i = 0; i < 120; i++) {
    await putQuestion(kv, validateQuestion(ASK).value, at("2026-01-01T00:00:00Z"), ids(`old${String(i).padStart(3, "0")}`));
  }
  // Every one of them is long closed, and their POINTERS are gone with the
  // window they described — the record survives, which is what lets /human
  // still say "the declared default fired".
  for (let i = 0; i < 120; i++) await kv.delete(`open-question:2026-01-01T00:00:00.000Z:old${String(i).padStart(3, "0")}`);
  await putQuestion(kv, validateQuestion({ ...ASK, prompt: "the only open one" }).value, at(T0), ids("live"));

  gets = 0;
  const d = await pending(counting, NOW);
  assert.equal(d.body, "the only open one");
  assert.ok(gets <= 3, `one question should cost a couple of reads, not the corpus — it cost ${gets}`);
  assert.equal((await questionViews(kv, NOW)).length, 121, "and every record is still on file");
});

test("the askable set PAGES, and an answered question leaves it", async () => {
  // One key per page, the way `test/fake-kv.mjs` exists to force: code that
  // reads only the first page would find the oldest by luck of the page break.
  const kv = fakeKv(1);
  await putQuestion(kv, validateQuestion({ ...ASK, prompt: "first" }).value, at("2026-09-01T09:00:00Z"), ids("q1"));
  await putQuestion(kv, validateQuestion({ ...ASK, prompt: "second" }).value, at("2026-09-01T10:00:00Z"), ids("q2"));

  assert.equal((await oldestOpenQuestion(kv, NOW)).prompt, "first");
  await answerQuestion(kv, "q1", { value: "yes" }, at("2026-09-01T11:00:00Z"));
  // Not "at the end of the window": an answered question stops being askable
  // the moment it is answered, and the pointer goes with it.
  assert.ok(![...kv.map.keys()].some((k) => k.startsWith("open-question:") && k.endsWith(":q1")));
  assert.equal((await oldestOpenQuestion(kv, NOW)).prompt, "second");
});

// ── the corpus is not public (desk#65) ───────────────────────────────────────

test("LISTING THE CORPUS NEEDS THE SAME CREDENTIAL ANSWERING DOES", async () => {
  // Before desk#65 a collection route on a public surface published every
  // prompt, choice set, declared default and address ever asked. `mayAnswer`'s
  // own comment says desk login gates VIEWING; this is the view half of it, and
  // it is the SAME predicate shape rather than a second policy.
  const may = await mayList(null, null);
  assert.equal(may.ok, false);
  assert.equal(may.status, 401);
  assert.match(may.reason, /desk#65/);
  assert.match(may.reason, /not public/);
  // The rungs stay where they are: this is not a door an approval opens either.
  assert.ok(!may.reason.includes("authorized"));

  // And an empty env is a refusal, not a throw and not an admission.
  assert.equal((await mayList(new Request("https://desk.bounded.tools/human.json"), {})).ok, false);
});
