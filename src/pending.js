// What a notification is ABOUT (#51).
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
// ONE SLOT, not a queue. A phone showing "3 approvals pending" would be worse
// than one showing the newest — the reader has to open the newest anyway, and a
// queue invites a stale entry outliving its ceremony. The TTL does the pruning.

/** Matches the keeper's ceremony window: an approval nobody can act on is not pending. */
export const APPROVAL_TTL_SECONDS = 900;

const KEY = "pending:approval";

export function validateApproval(input) {
  if (!input || typeof input !== "object") return { ok: false, error: "not an object" };
  const { title, body, url } = input;
  for (const [k, v] of [["title", title], ["body", body], ["url", url]]) {
    if (typeof v !== "string" || !v) return { ok: false, error: `missing ${k}` };
    if (v.length > 400) return { ok: false, error: `${k} too long` };
  }
  let u;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, error: "url is not a URL" };
  }
  // The destination is where a human is sent to approve something. Anything but
  // the keeper would be this notification pointing a person at a page we do not
  // control, which is precisely the shape a phishing notice wants.
  if (u.protocol !== "https:" || u.hostname !== "keeper.bounded.tools") {
    return { ok: false, error: "url must be an https keeper.bounded.tools address" };
  }
  return { ok: true, value: { title, body, url } };
}

export async function putApproval(kv, approval, now = Date.now) {
  await kv.put(KEY, JSON.stringify({ ...approval, at: new Date(now()).toISOString() }), {
    expirationTtl: APPROVAL_TTL_SECONDS,
  });
}

/**
 * What the worker should show. An outstanding approval if there is one, and
 * otherwise the board-changed default it always had — so the old path keeps
 * working rather than becoming a special case.
 */
export async function pending(kv) {
  if (kv) {
    const raw = await kv.get(KEY);
    if (raw) {
      try {
        const a = JSON.parse(raw);
        return { kind: "approval", title: a.title, body: a.body, url: a.url, at: a.at };
      } catch {
        // Unparseable is treated as absent rather than thrown: a bad record must
        // not stop the board notification a reader can still act on.
      }
    }
  }
  return { kind: "board", title: "Front Desk", body: "The board changed.", url: "/" };
}
