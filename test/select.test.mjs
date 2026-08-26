import { test } from "node:test";
import assert from "node:assert/strict";
import { select, FeedError, DEFAULT_LIMIT } from "../src/select.js";

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
