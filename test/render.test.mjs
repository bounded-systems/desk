import { test } from "node:test";
import assert from "node:assert/strict";
import { renderBoard, renderPrs, renderUnavailable } from "../src/render.js";

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
  const html = renderBoard(board(), AT, 60);
  assert.match(html, /3 hours ago/);
  assert.match(html, /2026-08-25T12:00:00Z/);
  assert.doesNotMatch(html, /snapshot is old/);
});

test("says it is stale past the threshold, and how old", () => {
  const html = renderBoard(board(), Date.parse("2026-08-27T12:00:00Z"), 60);
  assert.match(html, /snapshot is old/);
  assert.match(html, /2 days ago/);
  assert.match(html, /stamp--stale/);
});

test("names the cache window, so the age cannot overclaim its precision", () => {
  assert.match(renderBoard(board(), AT, 60), /up to 60s/);
});

test("reports everything held back", () => {
  const html = renderBoard(board(), AT, 60);
  assert.match(html, /2 already claimed/);
  assert.match(html, /3 pull request\(s\)/);
  assert.match(html, /4 ranked below the 25 shown/);
});

test("an empty board says so plainly", () => {
  const html = renderBoard(board({ items: [], withheld: { todo_total: 0 } }), AT, 60);
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
  const html = renderBoard(board({
    items: [{ repo: "r", number: 1, title: '<script>x</script>', url: 'https://e/"1', score: 1, labels: [] }],
  }), AT, 60);
  assert.doesNotMatch(html, /<script>x<\/script>/);
  assert.match(html, /&lt;script&gt;/);
});

// ── the desk no longer references PRs; the PR page does (#480/#713) ─────────

test("the board renders no PR tile — PRs live on their own page", () => {
  const html = renderBoard(board({ withheld: { todo_total: 10, claimed: 2, pull_requests: 0, unscored: 0, beyond_limit: 0 } }), AT, 60);
  assert.doesNotMatch(html, /PRs \(not claimable\)/);
  assert.match(html, /href="https:\/\/prs\.bounded\.tools"/);
});

test("a nonzero pull_requests count still surfaces in held-back — a regression must not hide", () => {
  const html = renderBoard(board(), AT, 60);
  assert.match(html, /3 pull request\(s\)/);
});

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
  // escaping holds on titles
  assert.match(html, /a &lt;fix&gt;/);
  assert.match(html, /href="https:\/\/desk\.bounded\.tools"/);
});

test("an empty PR list says the backlog is drained, not nothing", () => {
  const html = renderPrs(prs({ count: 0, claimed: 0, items: [] }), AT, 60);
  assert.match(html, /No open pull requests/);
});
