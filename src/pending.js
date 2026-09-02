// What a notification is ABOUT (#51), and how many of them can be outstanding
// at once (#65).
//
// The service worker used to render two constants — "Front Desk" / "The board
// changed." — because a payload-less push carries nothing and the handler read a
// payload that is never sent. Fine for a board change and useless for the thing
// most worth sending: an approval whose 15-minute window has just opened.
//
// So the push stays payload-less and the worker FETCHES this on wake. That is
// what makes a bodyless push carry meaning, and it avoids RFC 8291 entirely:
// the notification's text arrives over https from the origin, not encrypted
// inside the push.
//
// ── ONE NOTIFICATION, MANY OUTSTANDING (#65 revises #51) ────────────────────
//
// #51 said "ONE SLOT, not a queue", and gave two reasons. They are about
// different things, and only one of them was about storage:
//
//   "a phone showing 3 approvals pending would be worse than one showing the
//    newest — the reader has to open the newest anyway"
//       → about the NOTIFICATION, and still right. `pending()` still answers
//         with exactly one thing, and the worker still renders one.
//
//   "a queue invites a stale entry outliving its ceremony. The TTL does the
//    pruning."
//       → still right, and now enforced per entry rather than per slot.
//
// What #51 did not anticipate is CONCURRENCY. It stored everything under one
// key, so a second ceremony opened while the first was still live overwrote it,
// and the first approval became invisible while remaining perfectly valid. That
// was harmless while ceremonies were serial. infra#560's intake shape opens one
// claim per repo — up to 41 — and would drop all but the last.
//
// So the storage becomes one entry per ceremony, each with its own TTL, and the
// display stays exactly as #51 designed it. `pendingApprovals()` is the whole
// set, for a UI that can show it; `pending()` is the newest, for the phone.

// Questions live in their own module and their own key space (#69). pending()
// folds them in because the phone gets ONE thing; nothing else here knows about
// them, and questions.js knows nothing about approvals.
//
// It asks for ONE question rather than for the open set, because this endpoint
// is unauthenticated: what it costs to answer is what an anonymous caller can
// make us spend, and reading the whole corpus to name one question grew that
// cost with every question ever asked.
import { oldestOpenQuestion } from "./questions.js";

/** Matches the keeper's ceremony window: an approval nobody can act on is not pending. */
export const APPROVAL_TTL_SECONDS = 900;

const PREFIX = "pending:approval:";

/**
 * The pre-#65 single slot. Still read, never written.
 *
 * A deploy lands between a push and its wake often enough that dropping this
 * would silently lose exactly one live approval — the one outstanding at the
 * moment of the rollout. It costs one `get` and expires on its own.
 */
const LEGACY_KEY = "pending:approval";

/** The keeper mints these as 16 random bytes, base64url — 22 characters. */
const RE_CEREMONY_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The ceremony id an approval URL names, or null if the URL is not one.
 *
 * The keeper builds every approval URL as `${origin}/a/${ceremonyId}`, so the
 * path shape is not a guess. Requiring it does two jobs: it is the storage key,
 * and it narrows what `validateApproval` accepts — before #65 any path on the
 * keeper's host passed, which is a weaker check than the host test alongside it
 * was doing.
 */
export function ceremonyIdFrom(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.hostname !== "keeper.bounded.tools") return null;
  const m = /^\/a\/([^/]+)$/.exec(u.pathname);
  if (!m) return null;
  const id = decodeURIComponent(m[1]);
  return RE_CEREMONY_ID.test(id) ? id : null;
}

export function validateApproval(input) {
  if (!input || typeof input !== "object") return { ok: false, error: "not an object" };
  const { title, body, url } = input;
  for (const [k, v] of [["title", title], ["body", body], ["url", url]]) {
    if (typeof v !== "string" || !v) return { ok: false, error: `missing ${k}` };
    if (v.length > 400) return { ok: false, error: `${k} too long` };
  }
  // The destination is where a human is sent to approve something. Anything but
  // the keeper would be this notification pointing a person at a page we do not
  // control, which is precisely the shape a phishing notice wants. Since #65 the
  // path must be an approval page too, not merely the right host.
  if (!ceremonyIdFrom(url)) {
    return { ok: false, error: "url must be an https keeper.bounded.tools approval address" };
  }
  return { ok: true, value: { title, body, url } };
}

export async function putApproval(kv, approval, now = Date.now) {
  const id = ceremonyIdFrom(approval.url);
  if (!id) throw new TypeError("putApproval: not an approval URL");
  // Keyed by ceremony, so re-pushing one approval updates it rather than
  // stacking a duplicate, and two live ceremonies cannot displace each other.
  await kv.put(`${PREFIX}${id}`, JSON.stringify({ ...approval, at: new Date(now()).toISOString() }), {
    expirationTtl: APPROVAL_TTL_SECONDS,
  });
}

/** One stored record, or null when it is missing or unreadable. */
function parse(raw) {
  if (!raw) return null;
  try {
    const a = JSON.parse(raw);
    if (!a || typeof a.url !== "string") return null;
    return { kind: "approval", title: a.title, body: a.body, url: a.url, at: a.at };
  } catch {
    // Unparseable is treated as absent rather than thrown: a bad record must not
    // stop the notification a reader can still act on.
    return null;
  }
}

/**
 * Every outstanding approval, newest first.
 *
 * PAGES, because the real KV `list()` does and code that forgets reads only the
 * first page (`test/fake-kv.mjs` exists to make that failure reproducible).
 *
 * Sorted by the stored `at` rather than by key, because ceremony ids are random
 * and their lexicographic order carries no time information. A record with no
 * usable `at` sorts last rather than being dropped — it is still an approval
 * somebody can act on.
 */
export async function pendingApprovals(kv) {
  if (!kv) return [];
  const out = [];
  let cursor;
  do {
    const page = await kv.list({ prefix: PREFIX, cursor });
    for (const { name } of page.keys) {
      const a = parse(await kv.get(name));
      if (a) out.push(a);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  const legacy = parse(await kv.get(LEGACY_KEY));
  if (legacy && !out.some((a) => a.url === legacy.url)) out.push(legacy);

  return out.sort((x, y) => {
    const a = Date.parse(x.at ?? "");
    const b = Date.parse(y.at ?? "");
    if (Number.isNaN(a) && Number.isNaN(b)) return 0;
    if (Number.isNaN(a)) return 1;
    if (Number.isNaN(b)) return -1;
    return b - a;
  });
}

/**
 * What the worker should show: ONE thing.
 *
 * The newest outstanding approval if there is one, then the oldest open
 * question (#69), and otherwise the board-changed default it always had — so
 * the old path keeps working rather than becoming a special case. #51's
 * reasoning stands: the reader has to open the newest anyway, so a phone that
 * announces a backlog is worse than one that announces the thing to do now.
 * `pendingApprovals()` and `questionViews()` are where the rest lives.
 *
 * AN APPROVAL OUTRANKS A QUESTION, and the reason is the WINDOW, not the
 * importance. An approval is actionable for fifteen minutes and then is not; a
 * question can be answered tomorrow. Showing the question first would spend the
 * one slot on the thing that will still be there later.
 *
 * The kinds stay distinct all the way to the device. A question rendered as an
 * approval is a lock screen asking for a Face ID that nothing is waiting on —
 * the rung confusion this whole split exists to prevent, made visible.
 */
export async function pending(kv, now = Date.now()) {
  const [newest] = await pendingApprovals(kv);
  if (newest) return newest;

  // Oldest first among questions: they do not expire out from under a reader,
  // so the one that has been waiting longest is the one to raise. The clock is
  // an argument because whether a question is still open is a judgement about a
  // moment, and a caller that cannot name the moment cannot test the judgement.
  const q = await oldestOpenQuestion(kv, now);
  if (q) return { kind: "question", title: "A question for you", body: q.prompt, url: q.url };

  return { kind: "board", title: "Front Desk", body: "The board changed.", url: "/" };
}
