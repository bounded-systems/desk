import { test } from "node:test";
import assert from "node:assert/strict";
import {
  select, selectPrs, selectClaims, selectOverview,
  FeedError, DEFAULT_LIMIT, OVERVIEW_HEAD,
} from "../src/select.js";

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

test("selectPrs counts, carries the claim state, and invents nothing", () => {
  const r = selectPrs(prFeed([
    prItem({ number: 1, claim_check: { state: "non_compliant" } }),
    prItem({ number: 2, claim_check: { state: "compliant" } }),
  ]));
  assert.equal(r.count, 2);
  assert.equal(r.compliance.non_compliant, 1);
  assert.equal(r.compliance.compliant, 1);
  assert.equal(r.items.find((i) => i.number === 1).claim, "non_compliant");
  assert.equal(r.generated_at, "2026-08-27T22:00:00Z");
  for (const i of r.items) {
    assert.deepEqual(Object.keys(i).sort(), ["claim", "labels", "number", "repo", "title", "url"]);
  }
});

// EVERY STATE KEEPS A KEY, ZEROS INCLUDED. A count that appears only when
// non-zero reads as "no data" exactly when a consumer needs to see a zero — and
// the overview passes these through without recomputing, so a missing key would
// surface there as `undefined`.
test("selectPrs reports every state, including the ones nobody holds", () => {
  const r = selectPrs(prFeed([prItem({ number: 1, claim_check: { state: "compliant" } })]));
  assert.deepEqual(Object.keys(r.compliance).sort(),
    ["compliant", "non_compliant", "not_measured", "pending", "unknown"]);
  assert.equal(r.compliance.not_measured, 0);
});

// The feed and the Worker deploy independently, so the feed WILL be older than
// this code for some window. A page that 5xxs through it is a worse answer than
// one that says it does not know.
test("a feed with no claim_check degrades to unknown rather than throwing", () => {
  const r = selectPrs(prFeed([prItem({ number: 1 })]));
  assert.equal(r.items[0].claim, "unknown");
  assert.equal(r.compliance.unknown, 1);
});

// An unrecognised state from a newer producer must NOT silently become a column
// nobody designed, and must not be counted as compliant.
test("an unrecognised claim state is read as unknown, not passed through", () => {
  const r = selectPrs(prFeed([prItem({ number: 1, claim_check: { state: "quantum" } })]));
  assert.equal(r.items[0].claim, "unknown");
  assert.equal(r.compliance.unknown, 1);
  assert.equal(r.compliance.compliant, 0);
});

// `not_measured` is a repo that has not adopted the gate — .github-private#725's
// rollout metric. It must never be counted as a compliance failure.
test("not_measured is counted on its own, never as non_compliant", () => {
  const r = selectPrs(prFeed([prItem({ number: 1, claim_check: { state: "not_measured" } })]));
  assert.equal(r.compliance.not_measured, 1);
  assert.equal(r.compliance.non_compliant, 0);
});

// ── selectClaims (#7) ────────────────────────────────────────────────────────
//
// Claims left the issue queue and got their own host. The selector reads the
// SAME feed — a claim is a fact the board already carries about a row — so the
// two pages can never disagree about which snapshot they describe.

const claimed = (o = {}) =>
  item({ claimed: true, issue_state: "OPEN", fields: { Status: "Todo", Score: 1 }, ...o });

test("selectClaims refuses any feed that is not front-desk-public", () => {
  assert.throws(() => selectClaims(prFeed([])), FeedError);
  assert.throws(() => selectClaims(feed([], { feed: "front-desk" })), FeedError);
  assert.throws(() => selectClaims(null), FeedError);
});

test("selectClaims refuses a snapshot it cannot date", () => {
  assert.throws(() => selectClaims(feed([], { generated_at: "nope" })), FeedError);
});

test("selectClaims keeps only claimed rows", () => {
  const r = selectClaims(feed([claimed({ number: 1 }), item({ number: 2, claimed: false })]));
  assert.deepEqual(r.items.map((i) => i.number), [1]);
});

// A claim on finished work is a record, not a reservation — and the two ways a
// row can be finished are checked independently BECAUSE they disagree: a row can
// be closed on GitHub before the board sweep moves it to Done.
test("a claim on finished work is not a live claim, and is counted", () => {
  const r = selectClaims(feed([
    claimed({ number: 1 }),
    claimed({ number: 2, fields: { Status: "Done", Score: 0 } }),   // board says done
    claimed({ number: 3, issue_state: "CLOSED" }),                  // github says closed
  ]));
  assert.deepEqual(r.items.map((i) => i.number), [1]);
  assert.equal(r.count, 1);
  assert.equal(r.withheld.finished, 2);
});

test("selectClaims orders by repo then number, and ignores Status (#10)", () => {
  // Status values are deliberately adversarial here: under the old grouping the
  // In Progress row sorted first. It must not any more — the field was wrong on
  // all five live rows checked on 2026-08-28, so ordering by it sorted noise.
  const r = selectClaims(feed([
    claimed({ repo: "bounded-systems/b", number: 5, fields: { Status: "Todo" } }),
    claimed({ repo: "bounded-systems/a", number: 9, fields: { Status: "In Progress" } }),
    claimed({ repo: "bounded-systems/a", number: 2, fields: { Status: "Blocked" } }),
    claimed({ repo: "bounded-systems/a", number: 1, fields: { Status: "Todo" } }),
  ]));
  assert.deepEqual(r.items.map((i) => [i.repo, i.number]), [
    ["bounded-systems/a", 1],
    ["bounded-systems/a", 2],
    ["bounded-systems/a", 9],
    ["bounded-systems/b", 5],
  ]);
  assert.equal(r.in_progress, undefined, "in_progress must be gone from the JSON surface");
});

// `Done` stays load-bearing: it is a terminal signal, not a report of motion,
// and it is what holds finished claims out of the list.
test("selectClaims still holds back Status: Done after the ordering change", () => {
  const r = selectClaims(feed([
    claimed({ repo: "bounded-systems/a", number: 1, fields: { Status: "Done" } }),
    claimed({ repo: "bounded-systems/a", number: 2, fields: { Status: "Todo" } }),
  ]));
  assert.deepEqual(r.items.map((i) => i.number), [2]);
  assert.equal(r.withheld.finished, 1);
});

// The public filter deliberately drops `assignees`. The selector must not invent
// a claimant field, so the page cannot imply it knows who is on something.
test("selectClaims carries no claimant — the feed does not have one", () => {
  const r = selectClaims(feed([claimed()]));
  assert.deepEqual(Object.keys(r.items[0]).sort(), [
    "labels", "number", "repo", "title", "url",
  ]);
});

test("nothing claimed is a real answer, not an error", () => {
  const r = selectClaims(feed([item()]));
  assert.deepEqual(r.items, []);
  assert.equal(r.count, 0);
  assert.equal(r.withheld.finished, 0);
});

// ── selectOverview (#7) ──────────────────────────────────────────────────────

const ok = (value) => ({ ok: true, value });
const bad = (reason) => ({ ok: false, reason });

const boardFeed = feed([
  item({ number: 1, fields: { Status: "Todo", Score: 5 } }),
  item({ number: 2, fields: { Status: "Todo", Score: 9 } }),
  claimed({ number: 3, fields: { Status: "In Progress", Score: 1 } }),
]);
const outcomes = (o = {}) => ({
  issues: ok(select(boardFeed)),
  claims: ok(selectClaims(boardFeed)),
  prs: ok(selectPrs(prFeed([prItem({ number: 4 })]))),
  ...o,
});

test("the overview carries all three sections, in reading order", () => {
  const r = selectOverview(outcomes());
  assert.deepEqual(r.sections.map((s) => s.key), ["issues", "claims", "prs"]);
  assert.deepEqual(r.sections.map((s) => s.host), [
    "issues.bounded.tools", "claims.bounded.tools", "prs.bounded.tools",
  ]);
  assert.equal(r.ok, true);
});

// The whole point of composing rather than re-counting: the overview's number
// and the number on the host it links to are the same expression.
test("every count comes from the selector that owns it", () => {
  const r = selectOverview(outcomes());
  const by = Object.fromEntries(r.sections.map((s) => [s.key, s]));
  assert.equal(by.issues.count, select(boardFeed).items.length);
  assert.equal(by.claims.count, selectClaims(boardFeed).count);
  assert.equal(by.prs.count, 1);
});

test("a section that could not be read keeps its slot and its reason", () => {
  const r = selectOverview(outcomes({ prs: bad("feed responded 500 Internal Server Error") }));
  const prs = r.sections.find((s) => s.key === "prs");
  assert.equal(prs.ok, false);
  assert.equal(prs.count, null);          // never 0 — that would be a claim it cannot make
  assert.deepEqual(prs.items, []);
  assert.match(prs.reason, /500/);
  assert.equal(r.ok, false);              // the page as a whole did not succeed
  // and the sections that DID answer are untouched
  assert.equal(r.sections.find((s) => s.key === "issues").ok, true);
});

// Quoting the newest stamp would let a live PR feed vouch for a board projection
// that stopped yesterday.
test("the overview's age is the OLDEST readable stamp, not the newest", () => {
  const r = selectOverview({
    issues: ok(select(feed([], { generated_at: "2026-08-25T10:00:00Z" }))),
    claims: ok(selectClaims(feed([], { generated_at: "2026-08-25T10:00:00Z" }))),
    prs: ok(selectPrs(prFeed([], { generated_at: "2026-08-27T10:00:00Z" }))),
  });
  assert.equal(r.generated_at, "2026-08-25T10:00:00Z");
});

test("an overview with nothing readable states no age rather than inventing one", () => {
  const r = selectOverview({ issues: bad("x"), claims: bad("x"), prs: bad("x") });
  assert.equal(r.generated_at, null);
  assert.equal(r.ok, false);
});

test("each section shows only its head, and says how many it counted", () => {
  const many = feed(Array.from({ length: 12 }, (_, n) =>
    item({ number: n, fields: { Status: "Todo", Score: n } })));
  const r = selectOverview({
    issues: ok(select(many)), claims: ok(selectClaims(many)), prs: ok(selectPrs(prFeed([]))),
  });
  const issues = r.sections.find((s) => s.key === "issues");
  assert.equal(issues.items.length, OVERVIEW_HEAD);
  assert.equal(issues.count, 12);
  assert.equal(r.head, OVERVIEW_HEAD);
});
