// The routing is the change (#7), so it is the thing under test: four hosts, one
// Worker, and a wrong turn here serves a reader the wrong page — or, in the case
// the feed guards exist for, the wrong FEED.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";

const BOARD = {
  feed: "front-desk-public",
  generated_at: new Date().toISOString(),
  items: [
    { repo: "bounded-systems/prx", number: 1, title: "pick me up", url: "https://e/1",
      type: "Issue", claimed: false, issue_state: "OPEN", labels: [], fields: { Status: "Todo", Score: 9 } },
    { repo: "bounded-systems/prx", number: 2, title: "someone is on this one", url: "https://e/2",
      type: "Issue", claimed: true, issue_state: "OPEN", labels: [], fields: { Status: "In Progress", Score: 4 } },
  ],
};
const PRS = {
  feed: "front-desk-prs-public",
  generated_at: new Date().toISOString(),
  items: [{ repo: "bounded-systems/prx", number: 7, title: "a change", url: "https://e/7", labels: [], claimed: false }],
};

const ENV = {
  FEED_URL: "https://feed.example/board.json",
  PRS_FEED_URL: "https://feed.example/prs.json",
  DESK_LIMIT: "25",
};

let realFetch;
/** Serve each configured feed, or fail the one the test names. */
function stubFeeds({ fail = null, status = 500 } = {}) {
  globalThis.fetch = async (url) => {
    const which = url === ENV.FEED_URL ? "board" : "prs";
    if (fail === which) return new Response("nope", { status, statusText: "Server Error" });
    return new Response(JSON.stringify(which === "board" ? BOARD : PRS), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
}
beforeEach(() => { realFetch = globalThis.fetch; stubFeeds(); });
afterEach(() => { globalThis.fetch = realFetch; });

const get = (host, path = "/", env = ENV) =>
  worker.fetch(new Request(`https://${host}${path}`), env);

test("each host serves its own question", async () => {
  for (const [host, marker] of [
    ["issues.bounded.tools", /<h1>Issues<\/h1>/],
    ["claims.bounded.tools", /<h1>Claims<\/h1>/],
    ["prs.bounded.tools", /<h1>PRs<\/h1>/],
    ["desk.bounded.tools", /<h1>Desk<\/h1>/],
  ]) {
    const res = await get(host);
    assert.equal(res.status, 200, host);
    assert.match(await res.text(), marker, host);
  }
});

// A workers.dev preview URL has none of the four names. The front door is the
// safe default: it links to everything, so a reader who landed on an unnamed
// host is never stuck on a page that looks like the whole answer.
test("an unrecognised host gets the front door", async () => {
  const res = await get("bounded-desk.workers.dev");
  assert.match(await res.text(), /<h1>Desk<\/h1>/);
});

test("the host names are overridable, for a preview or a rename", async () => {
  const res = await get("preview.example", "/", { ...ENV, ISSUES_HOST: "preview.example" });
  assert.match(await res.text(), /<h1>Issues<\/h1>/);
});

// The claimed row must appear on exactly one page.
test("a claimed row is on the claims page and not in the queue", async () => {
  const issues = await (await get("issues.bounded.tools")).text();
  const claims = await (await get("claims.bounded.tools")).text();
  assert.match(issues, /pick me up/);
  assert.doesNotMatch(issues, /someone is on this one/);
  assert.match(claims, /someone is on this one/);
  assert.doesNotMatch(claims, /pick me up/);
});

test("/board.json serves that host's selection", async () => {
  const issues = await (await get("issues.bounded.tools", "/board.json")).json();
  assert.deepEqual(issues.items.map((i) => i.number), [1]);
  const claims = await (await get("claims.bounded.tools", "/board.json")).json();
  assert.deepEqual(claims.items.map((i) => i.number), [2]);
  const overview = await (await get("desk.bounded.tools", "/board.json")).json();
  assert.deepEqual(overview.sections.map((s) => s.key), ["issues", "claims", "prs"]);
});

test("/healthz does not touch the feed, so it answers when the feed does not", async () => {
  globalThis.fetch = async () => { throw new Error("the feed must not be read here"); };
  const res = await get("issues.bounded.tools", "/healthz");
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "ok\n");
});

// ── fail closed ──────────────────────────────────────────────────────────────

test("an unreadable feed is a 5xx that says so, never an empty list", async () => {
  stubFeeds({ fail: "board" });
  const res = await get("issues.bounded.tools");
  assert.equal(res.status, 502);
  const html = await res.text();
  assert.match(html, /could not be read/);
  assert.doesNotMatch(html, /Nothing claimable right now/);
});

test("a missing FEED_URL is the Worker's own fault, and says which var", async () => {
  const res = await get("claims.bounded.tools", "/", { ...ENV, FEED_URL: "" });
  assert.equal(res.status, 503);
  assert.match(await res.text(), /FEED_URL is not configured/);
});

// The guard that stops a mistyped URL putting private titles on a public page.
test("the wrong feed on a host is refused, not rendered", async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify(PRS), { status: 200 });      // PR feed served to the queue
  const res = await get("issues.bounded.tools");
  assert.equal(res.status, 502);
  assert.match(await res.text(), /expected the 'front-desk-public' feed/);
});

// The overview is the one page that can be PARTLY unreadable: the sections that
// answered are still worth showing, and the page is still not a success.
test("the overview renders what it could read and 502s on what it could not", async () => {
  stubFeeds({ fail: "prs" });
  const res = await get("desk.bounded.tools");
  assert.equal(res.status, 502);
  const html = await res.text();
  assert.match(html, /pick me up/);                 // the board sections survived
  assert.match(html, /This section could not be read/);
  assert.match(html, /This overview is incomplete/);
  assert.doesNotMatch(html, /No open pull requests/);
});

test("the overview reads the board feed once for both board-side sections", async () => {
  const seen = [];
  const inner = globalThis.fetch;
  globalThis.fetch = (url, init) => { seen.push(url); return inner(url, init); };
  await get("desk.bounded.tools");
  assert.deepEqual(seen.filter((u) => u === ENV.FEED_URL).length, 1);
});

test("a write method is refused before any feed is read", async () => {
  globalThis.fetch = async () => { throw new Error("must not be read"); };
  const res = await worker.fetch(
    new Request("https://desk.bounded.tools/", { method: "POST" }), ENV);
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "GET, HEAD");
});
