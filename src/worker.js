// The Front Desk, live.
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
// FAIL CLOSED. Every failure — feed unreachable, wrong feed, undatable snapshot
// — renders "the board could not be read" with a 5xx, never an empty list. A
// board that cannot be read and a board with nothing on it are different
// sentences, and only one of them is ever true.

import { select, selectPrs, DEFAULT_LIMIT, FeedError } from "./select.js";
import { renderBoard, renderPrs, renderUnavailable } from "./render.js";

/** The hostname that serves the PR list instead of the board (#480/#713). */
const PRS_HOST_DEFAULT = "prs.bounded.tools";

/** Seconds the rendered board may be reused at the edge. */
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

    // One Worker, two hosts: the desk renders the claimable board, the prs
    // host renders the open-PR list (#480/#713). Selected by hostname so a
    // reader cannot reach the wrong page by path — and each host has its own
    // feed, each feed names itself, and each selector refuses the other's.
    const isPrs = url.hostname === (env.PRS_HOST || PRS_HOST_DEFAULT);

    // No destination is baked in: where the filtered feed is published is a
    // maintainer decision (see site#241), so it arrives as configuration and the
    // worker refuses rather than guessing.
    const feedUrl = isPrs ? env.PRS_FEED_URL : env.FEED_URL;
    if (!feedUrl) {
      return html(
        renderUnavailable(
          `${isPrs ? "PRS_FEED_URL" : "FEED_URL"} is not configured for this Worker.`,
        ),
        503,
        EDGE_TTL,
      );
    }

    const limit = Number(env.DESK_LIMIT) > 0 ? Number(env.DESK_LIMIT) : DEFAULT_LIMIT;

    let feed;
    try {
      const res = await fetch(feedUrl, {
        headers: { accept: "application/json", "user-agent": "bounded-systems-desk" },
        // Collapse the stampede: many readers in the same minute cost one origin
        // read, and the rendered page is cached for the same window anyway.
        cf: { cacheTtl: EDGE_TTL, cacheEverything: true },
      });
      if (!res.ok) {
        return html(
          renderUnavailable(`feed responded ${res.status} ${res.statusText}`),
          502,
          EDGE_TTL,
        );
      }
      feed = await res.json();
    } catch (err) {
      return html(renderUnavailable(`feed unreachable: ${err.message}`), 502, EDGE_TTL);
    }

    let board;
    try {
      board = isPrs ? selectPrs(feed) : select(feed, limit);
    } catch (err) {
      // A FeedError is the guard doing its job (wrong feed, undatable snapshot);
      // anything else is a bug here. Both are "cannot stand behind this", so both
      // fail closed — but they are distinguishable in the reason line.
      const why = err instanceof FeedError ? err.message : `unexpected: ${err.message}`;
      return html(renderUnavailable(why), 502, EDGE_TTL);
    }

    // JSON for anything that would rather read the board than look at it.
    if (url.pathname === "/board.json") {
      return new Response(JSON.stringify(board, null, 2) + "\n", {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": `public, max-age=${EDGE_TTL}`,
        },
      });
    }

    return html(
      isPrs ? renderPrs(board, Date.now(), EDGE_TTL) : renderBoard(board, Date.now(), EDGE_TTL),
      200,
      EDGE_TTL,
    );
  },
};
