// What each host's page is a selection OF, and in what order.
//
// One Worker serves four hosts, and each one answers exactly one question:
//
//   issues.bounded.tools   what is worth picking up          select()
//   claims.bounded.tools   what someone is already on        selectClaims()
//   prs.bounded.tools      what is open and awaiting a check selectPrs()
//   desk.bounded.tools     all three at a glance, plus       selectOverview()
//                          repo health from the standard CI  selectCi()
//
// THE RANK IS THE BOARD'S. Nothing here scores. `Score` is carried through
// unchanged and only sorted on; a ranking computed here would be a different
// board wearing the same name. Where a page needs an order the board does not
// give — the claims list, the PR list — the order is a stated grouping over the
// board's own fields, never a number this file made up.
//
// EVERY SELECTOR NAMES THE FEED IT ACCEPTS, and refuses every other. The
// PRIVATE projection carries private repos' issue titles; only the filtered
// `front-desk-public` copy may reach a public page. Checking the feed's own
// name rather than trusting the configured URL is what makes a mistyped
// FEED_URL a 502 instead of a leak — and it is equally what stops the desk
// feed being rendered as PRs, which would present issues as changes.

/** Default number of rows the issue queue renders. The board is long; the head of it is the point. */
export const DEFAULT_LIMIT = 25;

/** Rows each overview section shows before deferring to that section's own host. */
export const OVERVIEW_HEAD = 5;

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

/** The shared guard: this must be the public board feed, and it must be dateable. */
function requireBoardFeed(feed, name, whatIsRendered) {
  if (!feed || feed.feed !== name) {
    throw new FeedError(
      `expected the '${name}' feed, got '${feed?.feed ?? "(unnamed)"}'. ` + whatIsRendered,
    );
  }
  if (!feed.generated_at || Number.isNaN(Date.parse(feed.generated_at))) {
    throw new FeedError(
      "the feed carries no parseable generated_at — refusing to render a page that cannot state its age.",
    );
  }
}

/**
 * Reduce the public feed to the claimable head of the board — issues.bounded.tools.
 *
 * Each exclusion is a rule, not a filter someone tuned until the list looked
 * right:
 *   - Status === "Todo"   — Done and In Progress are not work to pick up.
 *   - not claimed         — the feed's own flag. Someone else is on it.
 *   - type === "Issue"    — a PR is a change awaiting a check, not claimable work.
 *   - numeric Score       — the board's own ranking. An unscored row cannot be
 *                           placed against the others, and inventing a position
 *                           for it would be inventing a ranking.
 *
 * `withheld.claimed` is still COUNTED here even though the issues page no longer
 * prints it: the exclusion is real, /board.json consumers read it, and the
 * claims page is computed from the same number. What changed is where a reader
 * is sent to see it — not whether this selector knows it.
 */
export function select(feed, limit = DEFAULT_LIMIT) {
  requireBoardFeed(
    feed,
    "front-desk-public",
    "The private projection carries private titles and must never be rendered here.",
  );

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

// A claim is only live while the work is: the board's Status and the issue's own
// state each independently retire one. Both are checked because they can
// disagree — a row can be closed on GitHub before the board sweep moves it to
// Done — and a claims page that lists finished work is a page nobody trusts
// twice. The retired ones are counted, not dropped silently.
const isFinished = (i) => status(i) === "Done" || i.issue_state === "CLOSED";

// ORDERING IS repo THEN number, and deliberately says nothing (#10).
//
// This used to group by the board's `Status` — In Progress, then Blocked, then
// Todo — on the reasoning that "someone is on it" and "someone has it but has
// not started" are different answers to "is anyone moving on this". They are.
// `Status` just does not distinguish them: checked against reality on 2026-08-28,
// it was wrong on all five live rows, in both directions — two rows marked
// In Progress were finished or abandoned, three marked Todo had merged work.
// It is a hand-maintained field, so it goes stale exactly when a claim does.
//
// Ordering by it therefore sorted noise to the top. repo-then-number is
// arbitrary but STABLE and makes no claim it cannot keep. `Status` survives in
// this file for one job only — `isFinished`, where `Done` is a terminal signal
// rather than a report of motion.

/**
 * Reduce the public feed to what is currently claimed — claims.bounded.tools.
 *
 * Reads the SAME `front-desk-public` feed as the issue queue, because a claim is
 * a fact the board already carries about a row: splitting the hosts splits the
 * question, not the source of truth. Two feeds asserting who is on what is two
 * things to disagree.
 *
 * WHAT THIS CANNOT SAY. The public filter deliberately does not carry
 * `assignees` — publishing a roster of who is working on what is exactly what it
 * refused. So this page knows THAT a row is claimed and never BY WHOM, and the
 * render says so rather than letting a reader assume the names were omitted for
 * space.
 */
export function selectClaims(feed) {
  requireBoardFeed(
    feed,
    "front-desk-public",
    "The private projection carries private titles and must never be rendered here.",
  );

  const items = Array.isArray(feed.items) ? feed.items : [];
  const claimed = items.filter((i) => i.claimed === true);
  const live = claimed.filter((i) => !isFinished(i));
  const sorted = [...live].sort(
    (a, b) =>
      String(a.repo).localeCompare(String(b.repo)) || (a.number ?? 0) - (b.number ?? 0),
  );

  return {
    generated_at: feed.generated_at,
    count: sorted.length,
    withheld: {
      // Claims on work the board calls Done, or on issues GitHub calls closed.
      // A TILE since #10, not a footnote: the claim doors write the `claimed`
      // label and nothing removes it, so this number only grows — 104 of 111
      // claimed rows on 2026-08-28. Held back from the list (a finished claim is
      // a record, not a reservation) but shown as a count, because a number
      // nobody sees is a number nobody drains.
      finished: claimed.length - live.length,
    },
    items: sorted.map((i) => ({
      repo: i.repo,
      number: i.number,
      title: i.title,
      url: i.url,
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
/**
 * The claim-compliance states a PR row can be in, from the `pr-claim` gate
 * (`.github-private`#723) as published by `front-desk-feed`#7.
 *
 * `not_measured` IS NOT A FAILURE. It means no `pr-claim` check ran on that
 * head — the repo has not adopted the gate — which is `.github-private`#725's
 * rollout metric. Folding it in with `non_compliant` would turn a coverage gap
 * into an accusation against an author who did nothing wrong, and would make
 * the rollout look finished as repos adopt the check. `unknown` stays separate
 * for the mirror reason: "we could not tell" is not "there was nothing there".
 *
 * Listed rather than derived from the feed's own keys so an unrecognised state
 * arriving from a newer producer degrades to `unknown` instead of silently
 * adding a column nobody designed.
 */
export const CLAIM_STATES = ["compliant", "non_compliant", "not_measured", "pending", "unknown"];

export function selectPrs(feed) {
  requireBoardFeed(
    feed,
    "front-desk-prs-public",
    "Only the PR feed may be rendered here — any other feed is the wrong page's data.",
  );

  const items = Array.isArray(feed.items) ? feed.items : [];
  const sorted = [...items].sort((a, b) =>
    a.repo === b.repo
      ? (b.number ?? 0) - (a.number ?? 0)
      : String(a.repo).localeCompare(String(b.repo)),
  );

  // A feed that predates `claim_check` reads `unknown` rather than throwing.
  // The Worker and the feed deploy independently, so the feed WILL be older
  // than this code for some window, and a page that 5xxs through it would be a
  // worse answer than one that says it does not know.
  const stateOf = (i) => CLAIM_STATES.find((s) => s === i?.claim_check?.state) ?? "unknown";

  const compliance = Object.fromEntries(CLAIM_STATES.map((s) => [s, 0]));
  for (const i of items) compliance[stateOf(i)]++;

  return {
    generated_at: feed.generated_at,
    count: sorted.length,
    compliance,
    items: sorted.map((i) => ({
      repo: i.repo,
      number: i.number,
      title: i.title,
      url: i.url,
      labels: i.labels || [],
      claim: stateOf(i),
    })),
  };
}

// ── repo health (desk#81) ────────────────────────────────────────────────────

/**
 * Where the repo-standard conformance snapshot is published — `.github`#381's
 * lane, daily, as main plus one API commit on a branch of the repo that owns
 * the standard. Until a host of its own exists, the section links here.
 */
export const CI_SNAPSHOT_URL =
  "https://raw.githubusercontent.com/bounded-systems/.github/repo-standard-conformance/repo-standard-conformance.json";
export const CI_SECTION_HOST = "github.com/bounded-systems/.github";

/**
 * The finding codes the conformance lane emits, as sentences. A code this file
 * does not know passes through AS WRITTEN rather than being dropped: the lane
 * may grow a finding before this page learns its name, and an unnamed finding
 * is still a finding.
 */
export const FINDING_COPY = {
  "caller-absent": "does not call the standard CI",
  "pin-not-sha": "calls the standard at a ref that is not a commit SHA",
  "pull-request-missing": "the caller has no pull_request trigger",
  "pull-request-filtered": "the caller's pull_request trigger is path-filtered, so it does not report on every PR",
  "pull-request-no-synchronize": "the caller's pull_request trigger does not re-run on a push",
  "test-lane-absent": "carries a toolchain but no test lane — its tests, if any, gate nothing",
  "standard-run-red": "the latest standard run on its default branch is red",
};

/**
 * Reduce the conformance snapshot to the repos with findings — the fourth
 * section of desk.bounded.tools.
 *
 * NOTHING IS RE-COUNTED. `totals` are the lane's own and are carried through
 * as published; this page sorts and truncates. A FINDING is the repo's (no
 * caller, an unpinned ref, a red run); a GAP is the lane's (a listing it could
 * not read). The lane keeps them in separate fields and never sums them, and
 * neither does this — `count` is repos with findings, and the gaps ride along
 * in `totals` for the summary line to say out loud.
 *
 * Worst first: most findings, then name — the same order the lane publishes.
 */
export function selectCi(feed) {
  requireBoardFeed(
    feed,
    "repo-standard-conformance",
    "Only the conformance snapshot may be rendered as repo health — any other feed is the wrong page's data.",
  );

  const repos = Array.isArray(feed.repos) ? feed.repos : [];
  const t = feed.totals && typeof feed.totals === "object" ? feed.totals : {};
  const flagged = repos.filter((r) => Array.isArray(r.findings) && r.findings.length > 0);
  const sorted = [...flagged].sort(
    (a, b) => b.findings.length - a.findings.length || String(a.repo).localeCompare(String(b.repo)),
  );

  return {
    generated_at: feed.generated_at,
    href: CI_SNAPSHOT_URL,
    count: sorted.length,
    totals: {
      rows: t.rows ?? null,
      caller: t.caller ?? null,
      standard_run: t.standard_run ?? null,
      test_lane: t.test_lane ?? null,
      findings: t.findings ?? null,
      gaps: t.gaps ?? null,
    },
    // The one "is the org CI good" signal that exists today: the standard's
    // own selftest on main (`.github`#382 is what it still lacks).
    standard: feed.standard?.selftest?.state ?? null,
    items: sorted.map((r) => ({
      repo: r.repo,
      url: `https://github.com/${r.repo}`,
      findings: r.findings,
      summary: r.findings.map((f) => FINDING_COPY[f] || f).join("; "),
      standard_run: r.standard_run?.state ?? null,
    })),
  };
}

/**
 * Compose the four selections into the front door — desk.bounded.tools.
 *
 * TAKES OUTCOMES, NOT FEEDS, and that is the point: each section is fetched and
 * selected independently, so this function is where "one of the three could not
 * be read" is REPRESENTED rather than thrown. An overview that 502s in full
 * because the PR feed hiccuped tells a reader nothing about the two feeds that
 * answered; an overview that silently prints `0 open` for the feed it could not
 * read tells them something false. So a failed section keeps its slot, carries
 * its reason, and sets `ok: false` for the page — which the worker serves with a
 * 5xx, because a page that is missing a third of what it claims to summarise has
 * not succeeded.
 *
 * Each outcome is `{ ok: true, value }` or `{ ok: false, reason }`.
 *
 * NOTHING IS RE-COUNTED HERE. Every number comes from the selector that owns it,
 * so the overview and the host it links to cannot disagree — the only way to
 * make one page's "12 claimed" mean the same as another's is for both to be the
 * same expression.
 */
export function selectOverview({ issues, claims, prs, ci }, head = OVERVIEW_HEAD) {
  const section = (key, host, outcome, shape) =>
    outcome?.ok
      ? { key, host, ok: true, ...shape(outcome.value), generated_at: outcome.value.generated_at }
      : { key, host, ok: false, reason: outcome?.reason ?? "not read", count: null, items: [] };

  const sections = [
    section("issues", "issues.bounded.tools", issues, (d) => ({
      // The claimable count, not the board's Todo total: this row links to a page
      // that shows exactly these, and the two numbers must be the same number.
      count: d.withheld.todo_total - d.withheld.claimed - d.withheld.pull_requests,
      shown: d.items.length,
      items: d.items.slice(0, head).map((i) => ({
        repo: i.repo, number: i.number, title: i.title, url: i.url, note: i.score.toFixed(2),
      })),
    })),
    section("claims", "claims.bounded.tools", claims, (d) => ({
      count: d.count,
      shown: d.items.length,
      items: d.items.slice(0, head).map((i) => ({
        repo: i.repo, number: i.number, title: i.title, url: i.url, note: i.status,
      })),
    })),
    section("prs", "prs.bounded.tools", prs, (d) => ({
      count: d.count,
      shown: d.items.length,
      items: d.items.slice(0, head).map((i) => ({
        repo: i.repo, number: i.number, title: i.title, url: i.url, note: `#${i.number}`,
      })),
    })),
    // Repo health (desk#81). No host of its own yet, so `href` points at the
    // snapshot; rows are repos, not issues, so they carry no number.
    section("ci", CI_SECTION_HOST, ci, (d) => ({
      count: d.count,
      shown: d.items.length,
      href: d.href,
      totals: d.totals,
      standard: d.standard,
      items: d.items.slice(0, head).map((i) => ({
        repo: i.repo, number: null, title: i.summary, url: i.url, note: String(i.findings.length),
      })),
    })),
  ];

  // The OLDEST readable stamp, not the newest. The page shows three feeds side
  // by side, and the only freshness claim true of all of them is the age of the
  // stalest one — quoting the newest would let a live PR feed vouch for a board
  // projection that stopped yesterday.
  const stamps = sections
    .filter((s) => s.ok && s.generated_at)
    .map((s) => Date.parse(s.generated_at))
    .filter((t) => !Number.isNaN(t));

  return {
    ok: sections.every((s) => s.ok),
    generated_at: stamps.length ? new Date(Math.min(...stamps)).toISOString().replace(/\.\d{3}Z$/, "Z") : null,
    head,
    sections,
  };
}
