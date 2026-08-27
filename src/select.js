// What counts as claimable work, and in what order.
//
// This is a FAITHFUL PORT of scripts/trim-front-desk.mjs from bounded-systems/site,
// which is itself the same line front-desk.sh holds for a session. The three
// readers of the board — the shell script, the site generator, and this app —
// must agree about what "claimable" means, or the page and the session that
// reads it are looking at different boards while using the same word.
//
// THE RANK IS THE BOARD'S. Nothing here scores. `Score` is carried through
// unchanged and only sorted on; a ranking computed here would be a different
// board wearing the same name.

/** Default number of rows rendered. The board is long; the head of it is the point. */
export const DEFAULT_LIMIT = 25;

const status = (i) => (i.fields || {}).Status || null;
const scoreOf = (i) => {
  const s = (i.fields || {}).Score;
  return typeof s === "number" ? s : null;
};

/**
 * Thrown when the feed cannot be trusted to describe the board. Never rendered
 * as an empty list: "nothing claimable" and "the board could not be read" are
 * different sentences, and only one of them is ever true here.
 */
export class FeedError extends Error {}

/**
 * Reduce the public feed to the claimable head of the board.
 *
 * Each exclusion is a rule, not a filter someone tuned until the list looked
 * right:
 *   - Status === "Todo"   — Done and In Progress are not work to pick up.
 *   - not claimed         — the feed's own flag. Someone else is on it.
 *   - type === "Issue"    — a PR is a change awaiting a check, not claimable work.
 *   - numeric Score       — the board's own ranking. An unscored row cannot be
 *                           placed against the others, and inventing a position
 *                           for it would be inventing a ranking.
 */
export function select(feed, limit = DEFAULT_LIMIT) {
  // The PRIVATE projection carries private repos' issue titles. Only the
  // filtered feed may reach a public page, and the feed says which one it is —
  // so check, rather than trust the URL someone configured.
  if (!feed || feed.feed !== "front-desk-public") {
    throw new FeedError(
      `expected the 'front-desk-public' feed, got '${feed?.feed ?? "(unnamed)"}'. ` +
        "The private projection carries private titles and must never be rendered here.",
    );
  }
  if (!feed.generated_at || Number.isNaN(Date.parse(feed.generated_at))) {
    throw new FeedError(
      "the feed carries no parseable generated_at — refusing to render a board that cannot state its age.",
    );
  }

  const items = Array.isArray(feed.items) ? feed.items : [];
  const todo = items.filter((i) => status(i) === "Todo");
  const unclaimed = todo.filter((i) => !i.claimed);
  const issues = unclaimed.filter((i) => i.type === "Issue");
  const ranked = issues
    .filter((i) => scoreOf(i) !== null)
    .sort((a, b) => scoreOf(b) - scoreOf(a));

  return {
    generated_at: feed.generated_at,
    limit,
    // Every number the page needs in order to be honest about what it is NOT
    // showing. Never a silent cap.
    withheld: {
      todo_total: todo.length,
      claimed: todo.length - unclaimed.length,
      pull_requests: unclaimed.length - issues.length,
      unscored: issues.length - ranked.length,
      beyond_limit: Math.max(0, ranked.length - limit),
    },
    items: ranked.slice(0, limit).map((i) => ({
      repo: i.repo,
      number: i.number,
      title: i.title,
      url: i.url,
      score: scoreOf(i),
      labels: i.labels || [],
    })),
  };
}

/**
 * Reduce the PR feed to the list prs.bounded.tools renders (#480/#713).
 *
 * No ranking and no limit: the feed lists changes awaiting a check, the board
 * does not rank them, and inventing an order beyond "newest first per repo"
 * would be inventing a ranking. The upstream filter already reduced the feed
 * to OPEN PRs in public repos; this guard exists so a misconfigured URL —
 * the desk feed above all, whose rows this page must never present as PRs —
 * fails closed rather than rendering the wrong feed.
 */
export function selectPrs(feed) {
  if (!feed || feed.feed !== "front-desk-prs-public") {
    throw new FeedError(
      `expected the 'front-desk-prs-public' feed, got '${feed?.feed ?? "(unnamed)"}'. ` +
        "Only the PR feed may be rendered here — any other feed is the wrong page's data.",
    );
  }
  if (!feed.generated_at || Number.isNaN(Date.parse(feed.generated_at))) {
    throw new FeedError(
      "the feed carries no parseable generated_at — refusing to render a list that cannot state its age.",
    );
  }

  const items = Array.isArray(feed.items) ? feed.items : [];
  const sorted = [...items].sort((a, b) =>
    a.repo === b.repo
      ? (b.number ?? 0) - (a.number ?? 0)
      : String(a.repo).localeCompare(String(b.repo)),
  );
  return {
    generated_at: feed.generated_at,
    count: sorted.length,
    claimed: items.filter((i) => i.claimed).length,
    items: sorted.map((i) => ({
      repo: i.repo,
      number: i.number,
      title: i.title,
      url: i.url,
      labels: i.labels || [],
      claimed: !!i.claimed,
    })),
  };
}
