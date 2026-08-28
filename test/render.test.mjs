import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderIssues, renderClaims, renderPrs, renderOverview, renderUnavailable,
} from "../src/render.js";

const board = (o = {}) => ({
  generated_at: "2026-08-25T12:00:00Z", limit: 25,
  withheld: { todo_total: 10, claimed: 2, pull_requests: 3, unscored: 0, beyond_limit: 4 },
  items: [{ repo: "bounded-systems/prx", number: 434, title: "Cut it", url: "https://e/1", score: 17.3, labels: [] }],
  ...o,
});
const AT = Date.parse("2026-08-25T15:00:00Z"); // 3h after the stamp

// The point of the app: a static build could only print the stamp, because a
// relative age would be false the moment the page was cached.
test("states the age relative to the request, not to a build", () => {
  const html = renderIssues(board(), AT, 60);
  assert.match(html, /3 hours ago/);
  assert.match(html, /2026-08-25T12:00:00Z/);
  assert.doesNotMatch(html, /snapshot is old/);
});

test("says it is stale past the threshold, and how old", () => {
  const html = renderIssues(board(), Date.parse("2026-08-27T12:00:00Z"), 60);
  assert.match(html, /snapshot is old/);
  assert.match(html, /2 days ago/);
  assert.match(html, /stamp--stale/);
});

test("names the cache window, so the age cannot overclaim its precision", () => {
  assert.match(renderIssues(board(), AT, 60), /up to 60s/);
});

test("reports everything held back", () => {
  const html = renderIssues(board(), AT, 60);
  assert.match(html, /3 pull request\(s\)/);
  assert.match(html, /4 ranked below the 25 shown/);
});

test("an empty queue says so plainly", () => {
  const html = renderIssues(board({ items: [], withheld: { todo_total: 0 } }), AT, 60);
  assert.match(html, /Nothing claimable right now/);
});

// An unreadable board must never render as an empty one.
test("the unavailable page is not the empty-board page", () => {
  const html = renderUnavailable("feed responded 500");
  assert.match(html, /could not be read/);
  assert.match(html, /not an empty board/);
  assert.doesNotMatch(html, /Nothing claimable right now/);
  assert.match(html, /feed responded 500/);
});

test("escapes feed-supplied text", () => {
  const html = renderIssues(board({
    items: [{ repo: "r", number: 1, title: '<script>x</script>', url: 'https://e/"1', score: 1, labels: [] }],
  }), AT, 60);
  assert.doesNotMatch(html, /<script>x<\/script>/);
  assert.match(html, /&lt;script&gt;/);
});

// ── the issue queue references neither PRs nor claims (#480/#713, #7) ────────

test("the queue renders no PR tile — PRs live on their own page", () => {
  const html = renderIssues(board({ withheld: { todo_total: 10, claimed: 2, pull_requests: 0, unscored: 0, beyond_limit: 0 } }), AT, 60);
  assert.doesNotMatch(html, /PRs \(not claimable\)/);
  assert.match(html, /href="https:\/\/prs\.bounded\.tools"/);
});

test("a nonzero pull_requests count still surfaces in held-back — a regression must not hide", () => {
  assert.match(renderIssues(board(), AT, 60), /3 pull request\(s\)/);
});

// THE SPLIT (#7). The queue answers "what should I pick up" and nothing else:
// the claimed count is not a tile, not a held-back line, not a number anywhere
// on the page. What survives is a POINTER, the same shape #480 left for PRs.
test("the queue never prints the claimed count — that number is the claims page's", () => {
  const html = renderIssues(board(), AT, 60);
  assert.doesNotMatch(html, /already claimed/);
  assert.doesNotMatch(html, /2 claimed/);
  assert.match(html, /href="https:\/\/claims\.bounded\.tools"/);
  assert.match(html, /Issues — Bounded Systems/);
});

// A stale-lane board still shows a claimed count of 2 in its data; the page
// must not surface it under any state.
test("not even a stale queue leaks the claimed count", () => {
  const html = renderIssues(board(), Date.parse("2026-08-27T12:00:00Z"), 60);
  assert.doesNotMatch(html, /already claimed/);
});

// ── claims.bounded.tools (#7) ────────────────────────────────────────────────

const claims = (o = {}) => ({
  generated_at: "2026-08-25T12:00:00Z", count: 2, in_progress: 1,
  withheld: { finished: 3 },
  items: [
    { repo: "bounded-systems/prx", number: 434, title: "Cut it", url: "https://e/1", status: "In Progress", labels: [] },
    { repo: "bounded-systems/site", number: 9, title: "a <fix>", url: "https://e/2", status: "Todo", labels: [] },
  ],
  ...o,
});

test("the claims page renders rows without a marker, and the age", () => {
  const html = renderClaims(claims(), AT, 60);
  assert.match(html, /Claims — Bounded Systems/);
  assert.match(html, /prx · 434/);
  assert.match(html, /3 hours ago/);
  assert.match(html, /a &lt;fix&gt;/);   // escaping holds
});

// #10. The fixture items still CARRY `status`, so this fails if the renderer
// starts reading it again — a weaker test would just drop the field and pass
// for the wrong reason.
test("the claims page never renders the board's Status", () => {
  const html = renderClaims(claims(), AT, 60);
  assert.doesNotMatch(html, /In Progress/);
  assert.doesNotMatch(html, /Todo/);
});

// The slot means "the board's numeric rank" on issues.bounded.tools. Claims rows
// must omit it entirely rather than render it empty, or the two pages disagree
// about what the same position means.
test("the claims page emits no rank slot at all", () => {
  // The class is defined in the shared stylesheet either way, so this must
  // match the ROW MARKUP, not the CSS — a /row__score/ regex passes on the
  // <style> block and proves nothing.
  assert.doesNotMatch(renderClaims(claims(), AT, 60), /<div class="row__score">/);
  // ...while the issue queue, which does have a rank, still emits one.
  assert.match(renderIssues(board(), AT, 60), /<div class="row__score">/);
});

// The public feed drops assignees on purpose. A page that just omitted the name
// would read as "we didn't have room"; this one says the feed cannot answer it.
test("the claims page says it cannot name the claimant, and where the name is", () => {
  const html = renderClaims(claims(), AT, 60);
  assert.match(html, /never <em>by whom<\/em>/);
  assert.match(html, /does not carry assignees/);
  assert.match(html, /claim comment on the issue/);
});

test("finished claims are held back, and counted on a tile", () => {
  const html = renderClaims(claims(), AT, 60);
  // The count is a TILE now, not a footnote: nothing removes the `claimed`
  // label, so this number only grows until someone drains it.
  assert.match(html, /finished, still labelled/);
  assert.match(html, /<div class="tile__n">3<\/div>/);
  assert.match(html, /nothing removes it/);
  assert.doesNotMatch(
    renderClaims(claims({ withheld: { finished: 0 } }), AT, 60),
    /nothing removes it/,
  );
});

test("nothing claimed says the board is free, not that it is unreadable", () => {
  const html = renderClaims(claims({ count: 0, items: [], withheld: { finished: 0 } }), AT, 60);
  assert.match(html, /Nothing is claimed right now/);
  assert.doesNotMatch(html, /could not be read/);
});

// ── prs.bounded.tools ────────────────────────────────────────────────────────

const prs = (o = {}) => ({
  generated_at: "2026-08-25T12:00:00Z", count: 2, claimed: 1,
  items: [
    { repo: "bounded-systems/prx", number: 1001, title: "bump the bun-major group", url: "https://e/1", labels: [], claimed: true },
    { repo: "bounded-systems/site", number: 9, title: "a <fix>", url: "https://e/2", labels: [], claimed: false },
  ],
  ...o,
});

test("the PR page renders rows, the claimed marker, and the age", () => {
  const html = renderPrs(prs(), AT, 60);
  assert.match(html, /PRs — Bounded Systems/);
  assert.match(html, /bump the bun-major group/);
  assert.match(html, /#1001/);
  assert.match(html, /claimed/);
  assert.match(html, /3 hours ago/);
  assert.match(html, /a &lt;fix&gt;/);
  assert.match(html, /href="https:\/\/desk\.bounded\.tools"/);
});

test("an empty PR list says the backlog is drained, not nothing", () => {
  const html = renderPrs(prs({ count: 0, claimed: 0, items: [] }), AT, 60);
  assert.match(html, /No open pull requests/);
});

// ── desk.bounded.tools — the overview (#7) ───────────────────────────────────

const section = (key, host, o = {}) => ({
  key, host, ok: true, count: 2, shown: 1, generated_at: "2026-08-25T12:00:00Z",
  items: [{ repo: "bounded-systems/prx", number: 434, title: `${key} row`, url: "https://e/1", note: "n" }],
  ...o,
});
const overview = (o = {}) => ({
  ok: true, generated_at: "2026-08-25T12:00:00Z", head: 5,
  sections: [
    section("issues", "issues.bounded.tools"),
    section("claims", "claims.bounded.tools"),
    section("prs", "prs.bounded.tools"),
  ],
  ...o,
});

test("the overview shows all three, each linked to the host that owns it", () => {
  const html = renderOverview(overview(), AT, 60);
  assert.match(html, /Desk — Bounded Systems/);
  for (const [h, row] of [
    ["issues.bounded.tools", "issues row"],
    ["claims.bounded.tools", "claims row"],
    ["prs.bounded.tools", "prs row"],
  ]) {
    // Literal substring checks, not regexes built from data: hand-escaping a
    // string into a pattern is a thing to get wrong (CodeQL caught exactly that
    // here — the `.` was escaped and the backslash was not), and every one of
    // these assertions only ever wanted an exact match anyway.
    assert.ok(html.includes(`href="https://${h}"`), h);
    assert.ok(html.includes(row), row);
  }
});

// Quoting the newest would let a live feed vouch for one that stopped.
test("the overview says its age is the oldest of the feeds shown", () => {
  const html = renderOverview(overview(), AT, 60);
  assert.match(html, /Oldest feed projected at/);
  assert.match(html, /3 hours ago/);
  assert.match(html, /<strong>oldest<\/strong>/);
});

// Never a silent head: showing 1 of 2 has to say so.
test("a truncated section names the count and points at its host", () => {
  const html = renderOverview(overview(), AT, 60);
  assert.match(html, /Showing the first 1 of 2/);
});

test("a section showing everything says so instead of implying more", () => {
  const html = renderOverview(overview({
    sections: [section("issues", "issues.bounded.tools", { count: 1 })],
  }), AT, 60);
  assert.match(html, /All of them, in full/);
  assert.doesNotMatch(html, /Showing the first/);
});

// The overview is the one page that can be PARTLY unreadable. A failed section
// must not read as an empty one, and must not quietly vanish.
test("an unreadable section keeps its slot, says why, and is not shown as empty", () => {
  const html = renderOverview(overview({
    ok: false,
    sections: [
      section("issues", "issues.bounded.tools"),
      section("claims", "claims.bounded.tools"),
      { key: "prs", host: "prs.bounded.tools", ok: false, reason: "feed responded 500", count: null, items: [] },
    ],
  }), AT, 60);
  assert.match(html, /This section could not be read/);
  assert.match(html, /feed responded 500/);
  assert.match(html, /unreadable/);
  assert.doesNotMatch(html, /No open pull requests/);   // never the empty sentence
  assert.match(html, /This overview is incomplete/);
  assert.match(html, /issues row/);                     // the readable ones still render
});

test("an empty-but-readable section says the right empty sentence", () => {
  const html = renderOverview(overview({
    sections: [section("prs", "prs.bounded.tools", { count: 0, items: [] })],
  }), AT, 60);
  assert.match(html, /No open pull requests/);
  assert.doesNotMatch(html, /could not be read/);
});

test("an overview that could date nothing says that, rather than showing no stamp", () => {
  const html = renderOverview(overview({ ok: false, generated_at: null, sections: [] }), AT, 60);
  assert.match(html, /No section could be dated/);
  assert.match(html, /not that there is nothing to show/);
});

test("the overview escapes feed-supplied text", () => {
  const html = renderOverview(overview({
    sections: [section("issues", "issues.bounded.tools", {
      items: [{ repo: "r", number: 1, title: "<script>x</script>", url: 'https://e/"1', note: "n" }],
    })],
  }), AT, 60);
  assert.doesNotMatch(html, /<script>x<\/script>/);
  assert.match(html, /&lt;script&gt;/);
});

// ── every page says where the other three are ────────────────────────────────

test("each page links the other hosts and never links itself", () => {
  for (const [html, self] of [
    [renderIssues(board(), AT, 60), "issues"],
    [renderClaims(claims(), AT, 60), "claims"],
    [renderPrs(prs(), AT, 60), "prs"],
  ]) {
    for (const other of ["desk", "issues", "claims", "prs"].filter((h) => h !== self)) {
      assert.ok(html.includes(`href="https://${other}.bounded.tools"`), `${self} → ${other}`);
    }
    // Scope the negative to the cross-link footer line — the rest of the page
    // may legitimately link its own host — then check it literally.
    const also = html.match(/Also:.*?<\/p>/s)?.[0];
    assert.ok(also, `${self} renders no cross-link footer`);
    assert.ok(
      !also.includes(`href="https://${self}.bounded.tools"`),
      `${self} must not link itself in the footer`,
    );
  }
});

test("an empty section offers no 'all of them' line — there is nothing to offer", () => {
  const html = renderOverview(overview({
    sections: [section("prs", "prs.bounded.tools", { count: 0, items: [] })],
  }), AT, 60);
  assert.doesNotMatch(html, /All of them, in full/);
  assert.doesNotMatch(html, /Showing the first/);
  assert.match(html, /No open pull requests/);
});
