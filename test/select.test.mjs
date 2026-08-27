import { test } from "node:test";
import assert from "node:assert/strict";
import { select, selectPrs, FeedError, DEFAULT_LIMIT } from "../src/select.js";

const item = (o = {}) => ({
  repo: "bounded-systems/x", number: 1, title: "t", url: "u",
  type: "Issue", claimed: false, labels: [],
  fields: { Status: "Todo", Score: 1 },
  ...o,
});
const feed = (items, o = {}) => ({
  feed: "front-desk-public", generated_at: "2026-08-25T22:52:11Z", items, ...o,
});

// The private projection carries private repos' issue titles. The feed names
// itself; this guard is why a misconfigured FEED_URL cannot leak them.
test("refuses any feed that is not front-desk-public", () => {
  assert.throws(() => select(feed([], { feed: "front-desk" })), FeedError);
  assert.throws(() => select({ items: [] }), FeedError);
  assert.throws(() => select(null), FeedError);
});

test("refuses a snapshot it cannot date", () => {
  assert.throws(() => select(feed([], { generated_at: undefined })), FeedError);
  assert.throws(() => select(feed([], { generated_at: "not a date" })), FeedError);
});

test("keeps only unclaimed, scored, Todo issues", () => {
  const r = select(feed([
    item({ number: 1 }),
    item({ number: 2, fields: { Status: "Done", Score: 9 } }),
    item({ number: 3, claimed: true }),
    item({ number: 4, type: "PullRequest" }),
    item({ number: 5, fields: { Status: "Todo" } }),           // unscored
  ]));
  assert.deepEqual(r.items.map((i) => i.number), [1]);
  assert.deepEqual(r.withheld, {
    todo_total: 4, claimed: 1, pull_requests: 1, unscored: 1, beyond_limit: 0,
  });
});

test("orders by the board's own Score, descending", () => {
  const r = select(feed([
    item({ number: 1, fields: { Status: "Todo", Score: 3 } }),
    item({ number: 2, fields: { Status: "Todo", Score: 17.3 } }),
    item({ number: 3, fields: { Status: "Todo", Score: 9.5 } }),
  ]));
  assert.deepEqual(r.items.map((i) => i.number), [2, 3, 1]);
  assert.deepEqual(r.items.map((i) => i.score), [17.3, 9.5, 3]);
});

// Never a silent cap — the count held back is part of the output.
test("truncates to the limit and reports what that hid", () => {
  const items = Array.from({ length: 30 }, (_, n) =>
    item({ number: n, fields: { Status: "Todo", Score: n } }));
  const r = select(feed(items), 25);
  assert.equal(r.items.length, 25);
  assert.equal(r.withheld.beyond_limit, 5);
  assert.equal(r.limit, 25);
  assert.equal(select(feed(items)).limit, DEFAULT_LIMIT);
});

test("an empty board is a real answer, not an error", () => {
  const r = select(feed([]));
  assert.deepEqual(r.items, []);
  assert.equal(r.withheld.todo_total, 0);
});

// ── selectPrs (#480/#713) ────────────────────────────────────────────────────

const prItem = (o = {}) => ({
  repo: "bounded-systems/x", number: 1, title: "t", url: "u",
  labels: [], claimed: false, ...o,
});
const prFeed = (items, o = {}) => ({
  feed: "front-desk-prs-public", generated_at: "2026-08-27T22:00:00Z", items, ...o,
});

// The two selectors must refuse each other's feed: the desk feed rendered on
// the PR page would present issues as PRs, and the PR feed on the desk would
// be a ranking that does not exist.
test("selectPrs refuses any feed that is not front-desk-prs-public", () => {
  assert.throws(() => selectPrs(prFeed([], { feed: "front-desk-public" })), FeedError);
  assert.throws(() => selectPrs({ items: [] }), FeedError);
  assert.throws(() => selectPrs(null), FeedError);
});

test("select refuses the PR feed", () => {
  assert.throws(() => select(prFeed([])), FeedError);
});

test("selectPrs refuses a snapshot it cannot date", () => {
  assert.throws(() => selectPrs(prFeed([], { generated_at: undefined })), FeedError);
  assert.throws(() => selectPrs(prFeed([], { generated_at: "nope" })), FeedError);
});

test("selectPrs sorts by repo, newest number first within a repo", () => {
  const r = selectPrs(prFeed([
    prItem({ repo: "bounded-systems/b", number: 2 }),
    prItem({ repo: "bounded-systems/a", number: 7 }),
    prItem({ repo: "bounded-systems/b", number: 9 }),
  ]));
  assert.deepEqual(r.items.map((i) => [i.repo, i.number]), [
    ["bounded-systems/a", 7],
    ["bounded-systems/b", 9],
    ["bounded-systems/b", 2],
  ]);
});

test("selectPrs counts, carries claimed, and invents nothing", () => {
  const r = selectPrs(prFeed([
    prItem({ number: 1, claimed: true }),
    prItem({ number: 2 }),
  ]));
  assert.equal(r.count, 2);
  assert.equal(r.claimed, 1);
  assert.equal(r.items.find((i) => i.number === 2).claimed, false);
  assert.equal(r.items.find((i) => i.number === 1).claimed, true);
  assert.equal(r.generated_at, "2026-08-27T22:00:00Z");
  for (const i of r.items) {
    assert.deepEqual(Object.keys(i).sort(), ["claimed", "labels", "number", "repo", "title", "url"]);
  }
});
