// A QUESTION IS NOT AN APPROVAL (#69).
//
// /human is a verb a lane calls to put a question in front of a person and then
// EXIT. The person answers later — after lunch, or tomorrow. Two facts follow,
// and together they are why this is a SIBLING of pending.js rather than three
// more branches inside it:
//
//   THE RUNG. An approval is credential-grade: the keeper's ceremony window, a
//   passkey, `human-authorized`. An answer here is INFORMATION and caps at
//   `human-reviewed` — desk#65's committed vector, because a record whose
//   relying party is the requester can never say more than that. Nothing in
//   this file may be spent as an authorization, and no value it writes is ever
//   `human-authorized`.
//
//   THE URL RULE. pending.js pins an approval's destination to the keeper and
//   nothing else, because a notification pointing a person at a page we do not
//   control is the shape a phishing notice wants. A question is answered at
//   DESK. That is a SECOND rule, not a widening of the first: merging them into
//   one set of allowed origins would pass "desk is accepted" and "evil.example
//   is refused" while quietly letting an approval point at desk and a question
//   point at the keeper. Two files, two constants, two id shapes — so that
//   merge has to be a deliberate act rather than a tidy-up.
//
// The store is the same KV namespace, separated by prefix, as subscriptions
// (`sub:`) and approvals (`pending:approval:`) already are.

import { b64url } from "./push.js";
import { currentCredential } from "./login.js";

/** The rung an answer reaches, and the highest it ever can (desk#65). */
export const ANSWER_RUNG = "human-reviewed";

/** Nobody has looked at it. NOT a rung an answer can be read down to. */
export const UNREVIEWED = "unreviewed";

/**
 * How long a question stays ANSWERABLE.
 *
 * Deliberately not APPROVAL_TTL_SECONDS. 900 is the keeper's ceremony window —
 * an approval nobody can act on is not pending. A question has no ceremony and
 * no window to miss: the whole point of the verb is that the asker exits and
 * the person answers whenever they next look. A week is the span in which "I
 * never saw that" stops being the likely explanation.
 */
export const QUESTION_WINDOW_SECONDS = 7 * 24 * 60 * 60;

/**
 * How long the RECORD lives in KV — four times the answering window.
 *
 * These are two different clocks and the gap between them is load-bearing. KV
 * `expirationTtl` DELETES, and a deleted question reads as "no such question",
 * which is precisely not "the declared default fired". So the record outlives
 * its own deadline and the read path computes the state from the stored
 * deadline instead. Expiry here only reclaims space, long after anyone could
 * still be misled by the absence.
 */
export const QUESTION_TTL_SECONDS = 28 * 24 * 60 * 60;

const PREFIX = "question:";

/**
 * THE ASKABLE SET — one pointer per question a person could still answer.
 *
 * /pending is unauthenticated and is what the service worker fetches on every
 * push wake, so what it costs is what an anonymous caller can make us spend.
 * Reading every stored question to find the open ones made that cost grow with
 * ask volume for ever: records are kept for QUESTION_TTL_SECONDS, so a corpus
 * of hundreds of long-closed questions was hundreds of KV reads per wake, and
 * past the Workers subrequest ceiling the push handler falls back to "The board
 * changed." — the #51 defect, restored silently and only under load.
 *
 * So the candidate set is its own key space, and its TTL is the ANSWERING
 * WINDOW rather than the record's: exactly pending.js's "the TTL does the
 * pruning", with the window that belongs to this kind. The pointer expiring is
 * not the question vanishing — the record under `question:` outlives it four
 * times over and still reports `default-fired`. Nothing reads state from here.
 *
 * The key carries `asked_at` because KV lists lexicographically and an ISO-8601
 * UTC stamp sorts chronologically, so the OLDEST askable question is the FIRST
 * key — no full scan, and no sort over records we would have had to read first.
 *
 * There is no legacy path here and there must never be one: nothing has shipped
 * that wrote questions without a pointer.
 */
const OPEN_PREFIX = "open-question:";
const openKeyFor = (rec) => `${OPEN_PREFIX}${rec.asked_at}:${rec.id}`;

/**
 * Where a question is answered. A LITERAL, and it has to be.
 *
 * `surfaceFor()` gives desk no hostname of its own — desk is every host this
 * Worker answers on that is not issues/claims/prs, workers.dev previews
 * included. So "desk's own origin", derived from the request, is "any host we
 * are reachable at": a permissive check wearing a per-kind costume. The only
 * other pinned desk origin in this repo is oidc.js's NOTIFY_AUDIENCE, which is
 * the same string for a different reason (it is an OIDC audience); they are not
 * imported from one another so that changing one does not silently move the
 * other.
 */
const DESK_ORIGIN = "https://desk.bounded.tools";
const DESK_HOSTNAME = "desk.bounded.tools";

/** 16 random bytes, base64url — the same shape the keeper mints ceremony ids in. */
const RE_QUESTION_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The no-answer policies a question may declare. There is no fourth. */
export const NO_ANSWER_POLICIES = ["default", "block", "escalate"];

const MAX_TEXT = 400;
const MAX_CHOICE = 80;
const MAX_CHOICES = 8;

export function newQuestionId() {
  return b64url(crypto.getRandomValues(new Uint8Array(16)));
}

/**
 * The question id a URL names, or null if the URL is not one.
 *
 * The mirror of pending.js's `ceremonyIdFrom`, and every bit as narrow:
 * https only, exactly this hostname, exactly `/human/<id>`, and an id in the
 * minted charset. Anything else — including the keeper — is null.
 */
export function questionIdFrom(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.hostname !== DESK_HOSTNAME) return null;
  const m = /^\/human\/([^/]+)$/.exec(u.pathname);
  if (!m) return null;
  const id = decodeURIComponent(m[1]);
  return RE_QUESTION_ID.test(id) ? id : null;
}

export const questionUrlFor = (id) => `${DESK_ORIGIN}/human/${id}`;

/**
 * What a lane may ask.
 *
 * Every refusal names the field, because the caller is our own workflow and a
 * 400 it cannot explain surfaces to a maintainer as "the question did not go
 * out" with no way to find out why — the reasoning /subscribe already states.
 */
export function validateQuestion(input) {
  if (!input || typeof input !== "object") return { ok: false, error: "not an object" };
  const { prompt, choices, no_answer_policy: policy, no_answer_value: fallback, url } = input;

  if (typeof prompt !== "string" || !prompt) return { ok: false, error: "missing prompt" };
  if (prompt.length > MAX_TEXT) return { ok: false, error: "prompt too long" };

  let set = null;
  if (choices !== undefined && choices !== null) {
    if (!Array.isArray(choices) || !choices.length) return { ok: false, error: "choices must be a non-empty array" };
    if (choices.length > MAX_CHOICES) return { ok: false, error: "too many choices" };
    for (const c of choices) {
      if (typeof c !== "string" || !c) return { ok: false, error: "every choice must be a non-empty string" };
      if (c.length > MAX_CHOICE) return { ok: false, error: "choice too long" };
    }
    if (new Set(choices).size !== choices.length) return { ok: false, error: "choices must be distinct" };
    set = [...choices];
  }

  // REQUIRED, not defaulted. What happens when nobody answers is a decision the
  // asker owns and the record has to be able to state; inferring it here would
  // make the stored answer to "what if nobody replies" this file's guess.
  if (!NO_ANSWER_POLICIES.includes(policy)) {
    return { ok: false, error: `no_answer_policy must be one of ${NO_ANSWER_POLICIES.join(", ")}` };
  }
  let value = null;
  if (policy === "default") {
    if (typeof fallback !== "string" || !fallback) return { ok: false, error: "missing no_answer_value" };
    if (fallback.length > MAX_TEXT) return { ok: false, error: "no_answer_value too long" };
    // A default outside the declared choice set is one no human could have
    // picked — the record would carry an answer the question never offered.
    if (set && !set.includes(fallback)) return { ok: false, error: "no_answer_value is not one of the choices" };
    value = fallback;
  } else if (fallback !== undefined && fallback !== null) {
    return { ok: false, error: `no_answer_value is meaningless with policy ${policy}` };
  }

  // A caller does not choose where its question is answered — desk mints the
  // address because desk owns the id. A supplied `url` is CHECKED rather than
  // ignored: silently dropping it is how a caller comes to believe it set the
  // destination, and the url rule that is never exercised is the one that
  // quietly softens. Questions are desk-origin only; approvals stay keeper-only.
  if (url !== undefined && !questionIdFrom(url)) {
    return { ok: false, error: "url must be an https desk.bounded.tools question address" };
  }

  return { ok: true, value: { prompt, choices: set, no_answer_policy: policy, no_answer_value: value } };
}

/** Record a question and return the record — the id and url the asker needs. */
export async function putQuestion(kv, question, now = Date.now, mint = newQuestionId) {
  const id = mint();
  if (!RE_QUESTION_ID.test(id)) throw new TypeError("putQuestion: not a question id");
  const t = now();
  const rec = {
    id,
    prompt: question.prompt,
    choices: question.choices ?? null,
    no_answer_policy: question.no_answer_policy,
    no_answer_value: question.no_answer_value ?? null,
    url: questionUrlFor(id),
    asked_at: new Date(t).toISOString(),
    deadline: new Date(t + QUESTION_WINDOW_SECONDS * 1000).toISOString(),
    // Only ever written by a human going through the answer door. A fired
    // default does NOT populate this field — see `viewOf`.
    answer: null,
  };
  await kv.put(PREFIX + id, JSON.stringify(rec), { expirationTtl: QUESTION_TTL_SECONDS });
  // The record first: a pointer to a question that is not on file yet would be
  // raised by /pending as a notification nobody can open.
  // Empty value: the key carries the id and the order, and state is read from
  // the record so the two can never disagree.
  await kv.put(openKeyFor(rec), "", { expirationTtl: QUESTION_WINDOW_SECONDS });
  return rec;
}

/**
 * One stored record, or null when it is missing or unreadable.
 *
 * Unparseable is treated as ABSENT rather than thrown, matching pending.js: one
 * bad record must not suppress the questions a person could still answer.
 *
 * The url is re-checked on the way OUT, not only on the way in. This record
 * becomes a notification a person taps, and the store holds three kinds of
 * record written by more than one path; a question whose url is not a desk
 * question address is not a question we will point anyone at.
 */
function parse(raw) {
  if (!raw) return null;
  try {
    const q = JSON.parse(raw);
    if (!q || typeof q !== "object") return null;
    if (typeof q.id !== "string" || !RE_QUESTION_ID.test(q.id)) return null;
    if (questionIdFrom(q.url) !== q.id) return null;
    if (typeof q.prompt !== "string" || !q.prompt) return null;
    if (!NO_ANSWER_POLICIES.includes(q.no_answer_policy)) return null;
    return q;
  } catch {
    return null;
  }
}

export async function getQuestion(kv, id) {
  if (!kv || !RE_QUESTION_ID.test(String(id))) return null;
  return parse(await kv.get(PREFIX + id));
}

/**
 * Every question on file, newest first.
 *
 * PAGES, because the real KV `list()` does and code that forgets reads only the
 * first page (test/fake-kv.mjs exists to make that failure reproducible). There
 * is no legacy single-slot key here and there must never be one: the pre-#65
 * slot in pending.js is read-only compatibility for a rollout that already
 * happened, not a pattern.
 *
 * Sorted by `asked_at`, not by key: ids are random and their lexicographic
 * order carries no time. A record with no usable timestamp sorts LAST rather
 * than being dropped — it is still a question somebody was asked.
 */
export async function listQuestions(kv) {
  if (!kv) return [];
  const out = [];
  let cursor;
  do {
    const page = await kv.list({ prefix: PREFIX, cursor });
    for (const { name } of page.keys) {
      const q = parse(await kv.get(name));
      if (q) out.push(q);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return out.sort((x, y) => {
    const a = Date.parse(x.asked_at ?? "");
    const b = Date.parse(y.asked_at ?? "");
    if (Number.isNaN(a) && Number.isNaN(b)) return 0;
    if (Number.isNaN(a)) return 1;
    if (Number.isNaN(b)) return -1;
    return b - a;
  });
}

/**
 * The read shape — the ONE judgement both renderings are made from.
 *
 * "A human answered X" and "nobody answered and the declared default was X" are
 * DIFFERENT FIELDS here, never one field plus a guess:
 *
 *   answer        an object, or null. Written only by the answer door.
 *   default_fired a boolean the window and the policy decide.
 *   default_value the declared value, and only once it has actually fired.
 *
 * A reader that cannot tell those apart is output that reads as more than it
 * established. `rung` follows the same rule: `human-reviewed` only when a
 * person actually reviewed it, and never higher than that.
 */
export function viewOf(rec, now = Date.now()) {
  const answered = !!(rec.answer && typeof rec.answer.value === "string");
  const closes = Date.parse(rec.deadline ?? "");
  // An undatable deadline is treated as still open rather than as closed: firing
  // a default off a timestamp we could not read would be inventing the one fact
  // this record exists to keep straight.
  const closed = !Number.isNaN(closes) && closes <= now;
  const defaultFired = !answered && closed && rec.no_answer_policy === "default";

  const status = answered
    ? "answered"
    : !closed
      ? "open"
      : rec.no_answer_policy === "default"
        ? "default-fired"
        : rec.no_answer_policy === "block"
          ? "blocked"
          : "escalated";

  return {
    kind: "question",
    id: rec.id,
    prompt: rec.prompt,
    choices: rec.choices ?? null,
    url: rec.url,
    asked_at: rec.asked_at ?? null,
    deadline: rec.deadline ?? null,
    no_answer_policy: rec.no_answer_policy,
    no_answer_value: rec.no_answer_value ?? null,
    status,
    answer: answered ? { value: rec.answer.value, at: rec.answer.at ?? null, rung: ANSWER_RUNG } : null,
    default_fired: defaultFired,
    default_value: defaultFired ? rec.no_answer_value : null,
    rung: answered ? ANSWER_RUNG : UNREVIEWED,
  };
}

/** Every question as the read path sees it, newest first. */
export async function questionViews(kv, now = Date.now()) {
  return (await listQuestions(kv)).map((q) => viewOf(q, now));
}

/** The ones a person could still answer — what the phone has any business raising. */
export async function openQuestions(kv, now = Date.now()) {
  return (await questionViews(kv, now)).filter((v) => v.status === "open");
}

/**
 * The longest-waiting question a person could still answer, or null.
 *
 * What the phone's ONE slot is filled from, and deliberately not
 * `openQuestions()[…]`: that reads every record on file to answer a question
 * about a handful of them, on an endpoint anyone may call (see OPEN_PREFIX).
 * Here the pointer keys are already in ask order, so this is one list plus one
 * read of the record it lands on. It reads a second record only when a pointer
 * has outlived what it points at — an answered question deletes its own, and an
 * unanswerable one expires with the window, so that is the exception.
 *
 * TAKING THE OLDEST IS AN EXPLICIT COMPARISON, not "the last element of a
 * newest-first list". `listQuestions` sorts an undatable record LAST so it is
 * not dropped from the LISTING; reading that end as "oldest" turned the one
 * record we could not date into the longest-waiting one — and since an
 * unparseable deadline also never closes, it held the slot for ever and starved
 * every real question behind it. A record we cannot date cannot be the one that
 * has been waiting longest, so it is skipped here and stays readable at /human.
 *
 * The state still comes from the record through `viewOf`, so a question the
 * phone raises and a question /human calls open are the same judgement.
 */
export async function oldestOpenQuestion(kv, now = Date.now()) {
  if (!kv) return null;
  let cursor;
  do {
    const page = await kv.list({ prefix: OPEN_PREFIX, cursor });
    for (const { name } of page.keys) {
      // The id is the tail: `asked_at` holds colons, ids hold none.
      const id = name.slice(name.lastIndexOf(":") + 1);
      const rec = await getQuestion(kv, id);
      if (!rec || Number.isNaN(Date.parse(rec.asked_at ?? ""))) continue;
      const v = viewOf(rec, now);
      if (v.status === "open") return v;
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return null;
}

/**
 * THE ANSWER DOOR, AND THE ONE CREDENTIAL THAT OPENS IT (desk#65).
 *
 * desk#65 settled the credential split, and it is two credentials for two
 * purposes that must never be conflated:
 *
 *   desk login,       rp.id = desk.bounded.tools   gates VIEWING (and, here,
 *                                                  answering — same rung)
 *   keyholder passkey, rp.id = keeper.bounded.tools gates APPROVING, unchanged
 *
 * Desk login now exists (src/login.js) and this is the seam it was written for:
 * the predicate changed and nothing else did. What it asks is not "was a cookie
 * presented" but "is the credential that cookie names STILL LIVE" — the read
 * happens on every call, so a revoked credential loses its session at the next
 * request rather than at the cookie's expiry.
 *
 * It is deliberately NOT the OIDC door /human's ask side uses. That door
 * authenticates a WORKFLOW AT A REF — there is no claim shape in it for a
 * person — so admitting an answer through it would let a lane answer its own
 * question and have the record read as human-reviewed with no human involved.
 *
 * And desk must never verify APPROVAL assertions to open this: a record whose
 * relying party is the requester caps at `human-reviewed`, which is a committed
 * vector in claim-digest.vectors.json. Viewing and answering are fine at that
 * rung — an answer given through this door is still ANSWER_RUNG and nothing
 * here ever writes `human-authorized`. Approving stays at the keeper.
 */
export async function mayAnswer(request, env) {
  const who = await currentCredential(request, env);
  if (who.ok) return { ok: true, credential: who.credential };
  return {
    ok: false,
    // A DISCRIMINATOR, not a sentence to match on. 401 with no session, 403 with
    // one whose credential is no longer live, 503 on a deployment that cannot
    // check either — the call site maps it, and nothing string-matches a reason.
    status: who.status,
    clear: who.clear,
    reason:
      `${who.reason}. Answering needs desk login (rp.id desk.bounded.tools) — desk#65. ` +
      "No other credential is accepted here: an approval assertion caps at human-reviewed and belongs to the keeper.",
  };
}

/**
 * MAY THIS CALLER READ THE WHOLE CORPUS? Only a signed-in one (desk#65).
 *
 * `surfaceFor()` gives desk no hostname of its own and select.js keeps the
 * private projection off it entirely, so before login a collection route
 * published every question ever asked — prompt, choice set, declared default,
 * deadline, id and address, for QUESTION_TTL_SECONDS — to anyone who asked.
 * Enumeration is the half of that exposure which scales.
 *
 * WHAT THE GATE DOES AND DOES NOT CHANGE. One question stays readable at its own
 * address, signed in or not, and an unguessable address is still not a
 * credential: it is the capability the notification hands to the person, and it
 * bounds an exposure to whoever holds one link. /pending still names the one
 * question it is raising, by the same design that already names an approval's
 * title and keeper URL (#51). Only the CORPUS moved behind the login.
 *
 * Same predicate shape as `mayAnswer`, same admission re-read, and it gates the
 * listing only — not a wider set than it did when it refused everyone.
 */
export async function mayList(request, env) {
  const who = await currentCredential(request, env);
  if (who.ok) return { ok: true, credential: who.credential };
  return {
    ok: false,
    status: who.status,
    clear: who.clear,
    reason:
      `${who.reason}. The list of questions needs desk login (rp.id desk.bounded.tools) — desk#65. ` +
      "A question is readable at its own address; the corpus is not public.",
  };
}

/**
 * Record a person's answer.
 *
 * Returns `{ ok }` rather than throwing, because every refusal here is a
 * sentence the caller needs rather than a bug: the question is gone, someone
 * already answered, or the declared default has already fired and replacing it
 * would make the record say two things at once.
 *
 * NOTE the seam: this function stores an answer, it does not decide who may
 * give one. `mayAnswer` is that decision, and it refuses.
 */
export async function answerQuestion(kv, id, answer, now = Date.now) {
  if (!kv) return { ok: false, status: 503, error: "no question store is configured on this deployment" };
  const rec = await getQuestion(kv, id);
  if (!rec) return { ok: false, status: 404, error: "no such question" };

  const value = answer && answer.value;
  if (typeof value !== "string" || !value) return { ok: false, status: 400, error: "missing value" };
  if (value.length > MAX_TEXT) return { ok: false, status: 400, error: "value too long" };
  if (rec.choices && !rec.choices.includes(value)) {
    return { ok: false, status: 400, error: "value is not one of the choices" };
  }

  const view = viewOf(rec, now());
  if (view.answer) return { ok: false, status: 409, error: "already answered" };
  if (view.default_fired) return { ok: false, status: 409, error: "the declared default already fired" };

  const stored = {
    ...rec,
    // The rung is written by this file, not taken from the caller. A body that
    // claims a higher one changes nothing about what the record says.
    answer: { value, at: new Date(now()).toISOString(), rung: ANSWER_RUNG },
  };
  await kv.put(PREFIX + rec.id, JSON.stringify(stored), { expirationTtl: QUESTION_TTL_SECONDS });
  // An answered question is no longer askable, so it leaves the candidate set
  // now rather than at the end of the window. Best-effort: if this write is
  // lost the pointer expires on its own and `oldestOpenQuestion` re-checks the
  // record anyway, so the worst case is one wasted read, never a stale raise.
  await kv.delete(openKeyFor(rec));
  return { ok: true, value: viewOf(stored, now()) };
}
