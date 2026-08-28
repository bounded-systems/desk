// The Front Desk, live — four hosts, one Worker.
//
// A static page can only ever state the age it had when it was built, which is
// why the site's generated /desk carried a hand-piped snapshot and eventually
// rendered its own "this snapshot is old" banner while the projection lane was
// running perfectly well. The board refreshes hourly; the site deploys behind a
// hermetic build, Sigstore signing and an approval gate. Those two cadences do
// not belong on the same rope.
//
// So: fetch the already-filtered public feed per request, cache it briefly at
// the edge, and render. The board's own ranking is carried through untouched.
//
// ONE QUESTION PER HOST, selected by hostname so a reader cannot reach the
// wrong page by path:
//
//   issues.bounded.tools   what is worth picking up
//   claims.bounded.tools   what is already spoken for
//   prs.bounded.tools      what is open and awaiting a check
//   desk.bounded.tools     all three at a glance, and the default for any other
//                          hostname this Worker answers on (a workers.dev
//                          preview above all) — the front door is the safe thing
//                          to serve when the host does not say which page it is.
//
// FAIL CLOSED. Every failure — feed unreachable, wrong feed, undatable snapshot
// — renders "the board could not be read" with a 5xx, never an empty list. A
// board that cannot be read and a board with nothing on it are different
// sentences, and only one of them is ever true. The overview is the one page
// that can be PARTLY unreadable, and it fails closed per section: the sections
// that answered are rendered, the one that did not says so in its own words, and
// the whole page is still served with a 5xx, because a summary missing a third
// of what it summarises has not succeeded.

import {
  select,
  selectClaims,
  selectPrs,
  selectOverview,
  DEFAULT_LIMIT,
  FeedError,
} from "./select.js";
import {
  renderIssues,
  renderClaims,
  renderPrs,
  renderOverview,
  renderUnavailable,
} from "./render.js";

/** Hostnames, and the env var that may override each for a preview or a rename. */
const HOSTS = {
  issues: { env: "ISSUES_HOST", default: "issues.bounded.tools" },
  claims: { env: "CLAIMS_HOST", default: "claims.bounded.tools" },
  prs: { env: "PRS_HOST", default: "prs.bounded.tools" },
};

/** Seconds the rendered page may be reused at the edge. */
const EDGE_TTL = 60;

const html = (body, status, ttl) =>
  new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": status === 200 ? `public, max-age=${ttl}` : "no-store",
      // The page is entirely self-contained: no scripts, no external assets.
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'",
      "referrer-policy": "strict-origin-when-cross-origin",
      "x-content-type-options": "nosniff",
    },
  });

const json = (body, status, ttl) =>
  new Response(JSON.stringify(body, null, 2) + "\n", {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": status === 200 ? `public, max-age=${ttl}` : "no-store",
    },
  });

/** Which page this request is for. Unknown hosts get the front door. */
function surfaceFor(hostname, env) {
  for (const [name, h] of Object.entries(HOSTS)) {
    if (hostname === (env[h.env] || h.default)) return name;
  }
  return "overview";
}

/**
 * Fetch one feed. Returns `{ ok: true, value }` or `{ ok: false, reason }` —
 * never throws, because the overview needs a failure it can RENDER rather than
 * one that takes the whole page down.
 */
async function readFeed(url, what) {
  if (!url) return { ok: false, reason: `${what} is not configured for this Worker.` };
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json", "user-agent": "bounded-systems-desk" },
      // Collapse the stampede: many readers in the same minute cost one origin
      // read, and the rendered page is cached for the same window anyway.
      cf: { cacheTtl: EDGE_TTL, cacheEverything: true },
    });
    if (!res.ok) return { ok: false, reason: `feed responded ${res.status} ${res.statusText}` };
    return { ok: true, value: await res.json() };
  } catch (err) {
    return { ok: false, reason: `feed unreachable: ${err.message}` };
  }
}

/**
 * Run a selector over a feed outcome, keeping the outcome shape.
 *
 * A FeedError is the guard doing its job (wrong feed, undatable snapshot);
 * anything else is a bug here. Both are "cannot stand behind this", so both fail
 * closed — but they stay distinguishable in the reason line, because "the feed
 * is the wrong one" and "this code threw" send you to different places.
 */
function selected(feed, fn) {
  if (!feed.ok) return feed;
  try {
    return { ok: true, value: fn(feed.value) };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof FeedError ? err.message : `unexpected: ${err.message}`,
    };
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
    }
    // A liveness probe that does NOT touch the feed, so "is the worker up" and
    // "is the board readable" stay separately answerable.
    if (url.pathname === "/healthz") {
      return new Response("ok\n", { status: 200, headers: { "cache-control": "no-store" } });
    }

    const surface = surfaceFor(url.hostname, env);
    const wantsJson = url.pathname === "/board.json";
    const limit = Number(env.DESK_LIMIT) > 0 ? Number(env.DESK_LIMIT) : DEFAULT_LIMIT;

    // ── the front door: all three, each fetched and judged on its own ────────
    if (surface === "overview") {
      // No destination is baked in: where the filtered feeds are published is a
      // maintainer decision (see site#241), so they arrive as configuration and
      // an absent one is reported rather than guessed at.
      const [board, prsFeed] = await Promise.all([
        readFeed(env.FEED_URL, "FEED_URL"),
        readFeed(env.PRS_FEED_URL, "PRS_FEED_URL"),
      ]);
      // Both issue-side sections read the SAME feed — one origin read, and the
      // two pages can never disagree about which snapshot they are describing.
      const overview = selectOverview({
        issues: selected(board, (f) => select(f, limit)),
        claims: selected(board, selectClaims),
        prs: selected(prsFeed, selectPrs),
      });
      const status = overview.ok ? 200 : 502;
      return wantsJson
        ? json(overview, status, EDGE_TTL)
        : html(renderOverview(overview, Date.now(), EDGE_TTL), status, EDGE_TTL);
    }

    // ── a single-question host ───────────────────────────────────────────────
    const feedVar = surface === "prs" ? "PRS_FEED_URL" : "FEED_URL";
    const feed = await readFeed(env[feedVar], feedVar);
    const outcome = selected(
      feed,
      surface === "issues" ? (f) => select(f, limit) : surface === "claims" ? selectClaims : selectPrs,
    );

    if (!outcome.ok) {
      // A missing config is the Worker's own fault (503); an unreadable or wrong
      // feed is upstream (502). Both render the same page — it is the reason
      // line that tells them apart, and a reader who cannot see the status still
      // gets the sentence.
      const status = env[feedVar] ? 502 : 503;
      return wantsJson
        ? json({ error: outcome.reason }, status, EDGE_TTL)
        : html(renderUnavailable(outcome.reason), status, EDGE_TTL);
    }

    // JSON for anything that would rather read the board than look at it.
    if (wantsJson) return json(outcome.value, 200, EDGE_TTL);

    const render =
      surface === "issues" ? renderIssues : surface === "claims" ? renderClaims : renderPrs;
    return html(render(outcome.value, Date.now(), EDGE_TTL), 200, EDGE_TTL);
  },
};
