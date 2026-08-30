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

// ── The installable app, and the surfaces that must NOT become one (#766) ────
//
// Web Push on iOS needs a Home-Screen app backed by a manifest AND a registered
// service worker, and a service worker is script — which desk's CSP forbade.
// Three things therefore had to move together, and each can regress on its own:
// the assets must exist with the right content types, the CSP must permit script
// on desk, and it must STILL forbid it everywhere else.
//
// The last is the one worth guarding hardest. Four surfaces share this Worker,
// so a single header would have granted script to all four silently.

const STATIC_HOSTS = ["issues.bounded.tools", "claims.bounded.tools", "prs.bounded.tools"];

test("desk serves a real manifest, correctly typed", async () => {
  // The defect this replaces: every path fell through to the page, so
  // /manifest.json answered 200 with text/html. A status-only check reads that
  // as present, which is how it went unnoticed — so the TYPE is asserted, not
  // just the status.
  const res = await get("desk.bounded.tools", "/manifest.webmanifest");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^application\/manifest\+json/);
  const m = JSON.parse(await res.text());
  // `display: standalone` is the part iOS actually requires before it will
  // treat the pinned page as an app at all.
  assert.equal(m.display, "standalone");
  assert.equal(m.scope, "/");
  assert.equal(m.start_url, "/");
});

test("desk serves a service worker as JavaScript, uncached", async () => {
  const res = await get("desk.bounded.tools", "/sw.js");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^text\/javascript/);
  // A stale service worker outlives a deploy and keeps serving old behaviour to
  // an installed app — the hardest staleness to notice or clear from outside.
  assert.equal(res.headers.get("cache-control"), "no-store");
  const body = await res.text();
  assert.match(body, /addEventListener\("push"/);
  assert.match(body, /addEventListener\("notificationclick"/);
});

test("the service worker caches nothing", async () => {
  // Deliberate: the board's whole value is being current. A caching worker would
  // serve a stale board from the installed app with no staleness banner —
  // reintroducing offline exactly the defect this Worker exists to remove.
  const body = await (await get("desk.bounded.tools", "/sw.js")).text();
  for (const forbidden of ["caches.open", "cache.put", "cache.match", "addEventListener(\"fetch\""]) {
    assert.ok(!body.includes(forbidden), `service worker must not ${forbidden}`);
  }
});

test("desk's CSP permits script from self and nothing else", async () => {
  const csp = (await get("desk.bounded.tools")).headers.get("content-security-policy");
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /worker-src 'self'/);
  assert.match(csp, /manifest-src 'self'/);
  // No inline, no CDN. Everything is served from this origin, so nothing else
  // needs allowing — and 'unsafe-inline' for script is never introduced.
  assert.ok(!/script-src[^;]*unsafe-inline/.test(csp), "script must never be unsafe-inline");
  assert.ok(!/script-src[^;]*https?:/.test(csp), "no external script origin");
});

test("THE GUARD: the other three surfaces still run no script at all", async () => {
  // One Worker, four hosts. A single shared header would have granted script to
  // all four, and nothing on those pages needs it.
  for (const host of STATIC_HOSTS) {
    const csp = (await get(host)).headers.get("content-security-policy");
    assert.ok(!csp.includes("script-src"), `${host} must not grant script-src`);
    assert.match(csp, /default-src 'none'/, host);
  }
});

test("the app assets are desk-only", async () => {
  // claims/issues/prs are read-only boards with no reason to be installable;
  // offering a manifest there would prompt an install that gains nothing.
  for (const host of STATIC_HOSTS) {
    for (const path of ["/manifest.webmanifest", "/sw.js"]) {
      const res = await get(host, path);
      assert.notEqual(
        res.headers.get("content-type"),
        "application/manifest+json; charset=utf-8",
        `${host}${path} must not serve a manifest`,
      );
      assert.ok(!/^text\/javascript/.test(res.headers.get("content-type") ?? ""),
        `${host}${path} must not serve a service worker`);
    }
  }
});

test("the app routes are matched BEFORE the catch-all", async () => {
  // The ordering IS the fix. If these fall through, they answer 200 text/html —
  // the original defect, which looks like success to any status-only check.
  const res = await get("desk.bounded.tools", "/manifest.webmanifest");
  assert.ok(!/^text\/html/.test(res.headers.get("content-type")), "fell through to the page");
});
