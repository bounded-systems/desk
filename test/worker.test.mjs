// The routing is the change (#7), so it is the thing under test: four hosts, one
// Worker, and a wrong turn here serves a reader the wrong page — or, in the case
// the feed guards exist for, the wrong FEED.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";
import { issuer } from "./oidc-fixture.mjs";
import { b64url } from "../src/push.js";
import { listSubscriptions } from "../src/subscriptions.js";
import { FOREST } from "../src/tokens.js";
import { pendingApprovals } from "../src/pending.js";
import { questionIdFrom, questionUrlFor } from "../src/questions.js";

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

/** Not a real key — nothing in the browser half validates it, only substitutes it. */
const TEST_VAPID_PUBLIC = "BExampleTestPublicKeyValue";
/** A KV stand-in, per test, so one test's subscriptions never reach another's. */
const kvStub = () => {
  const map = new Map();
  // What each request COSTS. /pending and /human are unauthenticated, so the
  // number of reads an anonymous caller can provoke is a property under test,
  // not an implementation detail.
  const counts = { get: 0, list: 0, put: 0, delete: 0 };
  return {
    map,
    counts,
    // The options bag matters: putApproval passes expirationTtl, and a stub that
    // drops it would let a record outlive the ceremony it describes.
    put: async (k, v, _opts) => { counts.put++; map.set(k, v); },
    get: async (k) => { counts.get++; return map.get(k) ?? null; },
    delete: async (k) => { counts.delete++; map.delete(k); },
    // HONOUR THE PREFIX, as real KV does. A stub that ignores it returned
    // `pending:approval` as if it were a subscription, and the fan-out then tried
    // to parse "undefined" as a push endpoint. The store holds more than one kind
    // of record now, so the filter is load-bearing rather than decorative.
    //
    // AND SORT, as real KV does: the askable-set keys carry `asked_at` and are
    // read in listing order, so a stub that returned insertion order would let
    // an ordering bug through by handing back the order the test happened to
    // write in.
    list: async ({ prefix = "" } = {}) => {
      counts.list++;
      return {
        keys: [...map.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name })),
        list_complete: true,
      };
    },
  };
};
const KEYED_ENV = { ...ENV, VAPID_PUBLIC_KEY: TEST_VAPID_PUBLIC, SUBSCRIPTIONS: kvStub() };

const post = (host, path, body, env) =>
  worker.fetch(new Request(`https://${host}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }), env);

const SUBSCRIPTION = {
  endpoint: "https://fcm.googleapis.com/fcm/send/a-device",
  keys: { p256dh: "BPublic", auth: "authsecret" },
};

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

test("the service worker caches NO BOARD — one page, and it is the offline one", async () => {
  // This narrows a rule rather than dropping it. #766 forbade caching outright,
  // for a reason that still holds: the board's whole value is being current, and
  // a caching worker would serve a stale one from an installed app with no
  // staleness banner — the defect this Worker exists to remove, reintroduced
  // offline.
  //
  // What that rule could not express is the difference between caching the board
  // and caching a page that says the board could not be read. The second is the
  // same fail-closed move every stamp here makes; forbidding it left an offline
  // launch showing the browser's error page instead. So the invariant is now
  // stated as what it always meant.
  const body = await (await get("desk.bounded.tools", "/sw.js")).text();
  const code = body.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");

  assert.equal((code.match(/\.add\(|cache\.put\(/g) || []).length, 1, "exactly one cached entry");
  // The cache name is a constant in the worker, so match the declaration rather
  // than the call site — asserting the literal at caches.open() pins a detail
  // that is free to change without changing what is cached.
  assert.match(code, /const SHELL = "front-desk-offline-v1"/);
  assert.match(code, /caches\.open\(SHELL\)/);
  assert.match(code, /\.add\("\/offline"\)/);

  // NOTHING IS WRITTEN TO THE CACHE AT RUNTIME. A blacklist of strings was the
  // wrong shape here — it tripped on "/pending", which the push handler FETCHES
  // and never caches, confusing a mention with a write. The invariant is that
  // the only entry is the one added at install, so there is no runtime put at
  // all: the board can never enter the cache because nothing ever puts it there.
  assert.ok(!/cache\.put\(|caches\.match\([^)]*request/.test(code), "no runtime cache writes");

  // And the fetch handler declines everything that is not a navigation, so the
  // feed reads, /pending and the icons are untouched.
  assert.match(code, /mode !== "navigate"/);
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

// ── The notification opt-in (#766) ───────────────────────────────────────────
//
// The control is useless without script, a service worker and an installed app,
// and a dead button is worse than none — this page's whole posture is that it
// never shows something it cannot vouch for. So the assertions are about what it
// refuses to promise as much as what it serves.

test("desk serves the opt-in script as JavaScript", async () => {
  const res = await get("desk.bounded.tools", "/notify.js");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^text\/javascript/);
});

test("the opt-in script is desk-only, like the other app assets", async () => {
  for (const host of STATIC_HOSTS) {
    const res = await get(host, "/notify.js");
    assert.ok(!/^text\/javascript/.test(res.headers.get("content-type") ?? ""),
      `${host} must not serve the opt-in script`);
  }
});

test("every unavailable path ends in a sentence, not silence", async () => {
  // Permission can be unavailable in ways that look identical from outside: no
  // support, not installed, already denied. Each must say which.
  const js = await (await get("desk.bounded.tools", "/notify.js")).text();
  assert.match(js, /cannot deliver web notifications/);
  assert.match(js, /Add to Home Screen/);
  assert.match(js, /blocked for this site/);
  assert.match(js, /Permission was not granted/);
});

test("the button is only offered when pressing it can do something", async () => {
  const js = await (await get("desk.bounded.tools", "/notify.js", KEYED_ENV)).text();
  // `denied` is not re-promptable — offering the button there would offer a
  // no-op — so that branch must pass `false` for the button.
  assert.match(js, /permission === "denied"[\s\S]{0,200}show\([^)]*false\)/);
  assert.match(js, /permission === "granted"[\s\S]{0,800}show\([^)]*false\)/);
});

test("with no keypair configured it says so, and offers no button (#37)", async () => {
  // The banner this replaces said "the sender is still being built". The sender
  // now exists, so that sentence would itself be the false statement — but a
  // deploy with no VAPID key still cannot subscribe anyone, and saying nothing
  // about it would be the same false-green one layer down: an inert path
  // reading as wired (#779), a summary reporting health it never measured
  // (#809).
  const js = await (await get("desk.bounded.tools", "/notify.js")).text();
  assert.match(js, /var VAPID_PUBLIC_KEY = "";/);
  assert.match(js, /no signing key is configured/);

  // Comments stripped first: the script EXPLAINS why it must not overclaim, so
  // a check over the whole file would fire on its own documentation — and
  // deleting the explanation would be the cheapest route to green. Same trap
  // _workflow-lint.yml records for shellcheck directives in prose.
  const code = js.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  assert.ok(!/you'?re all set/i.test(code));
});

test("with a keypair it actually subscribes rather than only registering", async () => {
  const js = await (await get("desk.bounded.tools", "/notify.js", KEYED_ENV)).text();
  assert.match(js, new RegExp(`var VAPID_PUBLIC_KEY = "${TEST_VAPID_PUBLIC}";`));
  assert.match(js, /pushManager\.subscribe\(/);
  assert.match(js, /userVisibleOnly: true/);
  assert.match(js, /fetch\("\/subscribe"/);
  // The old banner promised nothing would arrive. Keeping it once the sender
  // exists would be a lie in the other direction.
  assert.ok(!/Delivery is not switched on yet/.test(js));
});

test("an already-permitted device still subscribes — permission is not a subscription", async () => {
  // The case this exists for: a device that granted permission BEFORE the
  // sender shipped has permission and no subscription, and would otherwise
  // read "enabled" forever while receiving nothing.
  const js = await (await get("desk.bounded.tools", "/notify.js", KEYED_ENV)).text();
  const granted = js.slice(js.indexOf('permission === "granted"'), js.indexOf('permission === "denied"'));
  assert.match(granted, /subscribeAndStore/);
});

test("the opt-in block is rendered on desk and on no other host", async () => {
  const deskHtml = await (await get("desk.bounded.tools")).text();
  assert.match(deskHtml, /id="notify"/);
  assert.match(deskHtml, /src="\/notify\.js"/);
  for (const host of STATIC_HOSTS) {
    const html = await (await get(host)).text();
    assert.ok(!/id="notify"/.test(html), `${host} must not render the opt-in`);
    assert.ok(!/notify\.js/.test(html), `${host} must not load script`);
  }
});

test("the block ships hidden — a dead control must not appear without script", async () => {
  const deskHtml = await (await get("desk.bounded.tools")).text();
  assert.match(deskHtml, /<section class="notify" id="notify" hidden>/);
});

// ── /subscribe, the one write this Worker accepts (#37) ──────────────────────

test("a valid subscription is stored", async () => {
  const env = { ...ENV, VAPID_PUBLIC_KEY: TEST_VAPID_PUBLIC, SUBSCRIPTIONS: kvStub() };
  const res = await post("desk.bounded.tools", "/subscribe", SUBSCRIPTION, env);
  assert.equal(res.status, 201);
  assert.equal(env.SUBSCRIPTIONS.map.size, 1);
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("the same device posting twice stays one record", async () => {
  const env = { ...ENV, VAPID_PUBLIC_KEY: TEST_VAPID_PUBLIC, SUBSCRIPTIONS: kvStub() };
  await post("desk.bounded.tools", "/subscribe", SUBSCRIPTION, env);
  await post("desk.bounded.tools", "/subscribe", SUBSCRIPTION, env);
  assert.equal(env.SUBSCRIPTIONS.map.size, 1);
});

test("a missing store is a 503 naming the Worker's own gap, not a 4xx blaming the device", async () => {
  const res = await post("desk.bounded.tools", "/subscribe", SUBSCRIPTION, { ...ENV, VAPID_PUBLIC_KEY: TEST_VAPID_PUBLIC });
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /subscription store/);
});

test("a missing key is also a 503 — subscribing against no key stores a dead record", async () => {
  const res = await post("desk.bounded.tools", "/subscribe", SUBSCRIPTION, { ...ENV, SUBSCRIPTIONS: kvStub() });
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /signing key/);
});

test("every refusal names what is wrong, because our own script is the caller", async () => {
  const env = () => ({ ...ENV, VAPID_PUBLIC_KEY: TEST_VAPID_PUBLIC, SUBSCRIPTIONS: kvStub() });
  for (const [body, pattern] of [
    ["{not json", /not JSON/],
    [{ keys: { p256dh: "a", auth: "b" } }, /endpoint/],
    [{ endpoint: "https://p.example/x" }, /keys/],
    [{ ...SUBSCRIPTION, endpoint: "http://attacker.example/x" }, /https/],
  ]) {
    const res = await post("desk.bounded.tools", "/subscribe", body, env());
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, pattern);
  }
});

test("an oversized body is refused before it is parsed", async () => {
  const env = { ...ENV, VAPID_PUBLIC_KEY: TEST_VAPID_PUBLIC, SUBSCRIPTIONS: kvStub() };
  const res = await post("desk.bounded.tools", "/subscribe", "x".repeat(5000), env);
  assert.equal(res.status, 413);
  assert.equal(env.SUBSCRIPTIONS.map.size, 0);
});

test("/subscribe exists on desk and nowhere else", async () => {
  for (const host of STATIC_HOSTS) {
    const env = { ...ENV, VAPID_PUBLIC_KEY: TEST_VAPID_PUBLIC, SUBSCRIPTIONS: kvStub() };
    const res = await post(host, "/subscribe", SUBSCRIPTION, env);
    assert.equal(res.status, 404, `${host} must not take subscriptions`);
    assert.equal(env.SUBSCRIPTIONS.map.size, 0, `${host} must not have stored one`);
  }
});

test("the method gate still holds for everything that is not /subscribe", async () => {
  const res = await post("desk.bounded.tools", "/", SUBSCRIPTION, KEYED_ENV);
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "GET, HEAD");
});

// ── /notify, the fan-out trigger (#37) ───────────────────────────────────────
//
// ONE issuer for this whole file: src/oidc.js caches the JWKS for an hour, so a
// second issuer here would be verified against the first one's keys and every
// test after it would fail for the wrong reason.
const ISS = await issuer();

/** A real P-256 pair — the endpoint imports it, so a fake one fails at import. */
async function vapidEnv(extra = {}) {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const pub = b64url(await crypto.subtle.exportKey("raw", kp.publicKey));
  const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  return {
    ...ENV,
    VAPID_PUBLIC_KEY: pub,
    VAPID_PRIVATE_KEY: jwk.d,
    VAPID_SUBJECT: "mailto:desk@bounded.tools",
    // Not a real secret and not a real key: the session MAC is HMAC over this
    // string, so any string works and a test that needed a specific one would be
    // testing the string. The gated routes need it present, because a deploy
    // without it refuses everything (test/login.test.mjs pins that).
    SESSION_SECRET: "test-session-secret",
    SUBSCRIPTIONS: kvStub(),
    ...extra,
  };
}

/** Serve GitHub's JWKS from the fixture, and every push endpoint with `status`. */
function stubOidcAndPush({ status = 201 } = {}) {
  globalThis.fetch = async (url) => {
    const href = typeof url === "string" ? url : url.url;
    if (href.includes("/.well-known/jwks")) {
      return new Response(JSON.stringify({ keys: ISS.jwks }), { status: 200 });
    }
    return new Response(null, { status });
  };
}

const notify = (token, env, host = "desk.bounded.tools") =>
  worker.fetch(new Request(`https://${host}/notify`, {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  }), env);

async function seed(env, ...names) {
  for (const n of names) {
    await worker.fetch(new Request("https://desk.bounded.tools/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        endpoint: `https://fcm.googleapis.com/fcm/send/${n}`,
        keys: { p256dh: "p", auth: "a" },
      }),
    }), env);
  }
}

test("the pinned lane triggers a fan-out and gets the census back", async () => {
  const env = await vapidEnv();
  await seed(env, "a", "b");
  stubOidcAndPush();
  const res = await notify(await ISS.mint(), env);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { total: 2, sent: 2, pruned: 0, retry: 0, failed: 0 });
});

test("a dead device is pruned by a real fan-out, not just in the unit test", async () => {
  const env = await vapidEnv();
  await seed(env, "dead");
  stubOidcAndPush({ status: 410 });
  const res = await notify(await ISS.mint(), env);
  assert.equal((await res.json()).pruned, 1);
  assert.equal((await listSubscriptions(env.SUBSCRIPTIONS)).length, 0);
});

test("no token is a 401, and a token from the wrong workflow is a 403", async () => {
  const env = await vapidEnv();
  stubOidcAndPush();
  assert.equal((await notify(null, env)).status, 401);

  const wrong = await ISS.mint({
    workflowRef: "bounded-systems/infra/.github/workflows/cloudflare-apply.yml@refs/heads/main",
  });
  const res = await notify(wrong, env);
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /workflow not allowed/);
});

test("nothing is sent when the caller is refused", async () => {
  const env = await vapidEnv();
  await seed(env, "a");
  let pushes = 0;
  globalThis.fetch = async (url) => {
    const href = typeof url === "string" ? url : url.url;
    if (href.includes("/.well-known/jwks")) return new Response(JSON.stringify({ keys: ISS.jwks }), { status: 200 });
    pushes++;
    return new Response(null, { status: 201 });
  };
  await notify(await ISS.mint({ aud: "cloudflare-workers-deploy-broker" }), env);
  assert.equal(pushes, 0, "authorization must be settled before anything is pushed");
});

test("a mismatched keypair is a 503 here, not a 401 from every push service later", async () => {
  const good = await vapidEnv();
  const other = await vapidEnv();
  const env = { ...good, VAPID_PRIVATE_KEY: other.VAPID_PRIVATE_KEY };
  stubOidcAndPush();
  const res = await notify(await ISS.mint(), env);
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /keypair is unusable/);
});

test("missing configuration is a 503 naming which piece", async () => {
  stubOidcAndPush();
  const full = await vapidEnv();
  const token = await ISS.mint();
  for (const [drop, pattern] of [
    ["SUBSCRIPTIONS", /subscription store/],
    ["VAPID_PRIVATE_KEY", /signing keypair/],
    ["VAPID_SUBJECT", /subject contact/],
  ]) {
    const env = { ...full };
    delete env[drop];
    const res = await notify(token, env);
    assert.equal(res.status, 503, drop);
    assert.match((await res.json()).error, pattern, drop);
  }
});

test("/notify exists on desk and nowhere else", async () => {
  const env = await vapidEnv();
  stubOidcAndPush();
  const token = await ISS.mint();
  for (const host of STATIC_HOSTS) {
    assert.equal((await notify(token, env, host)).status, 404, host);
  }
});

// ── the icon, and the manifest that was never linked (#51) ───────────────────

test("the Home Screen icon is served, not a letter", async () => {
  const svg = await get("desk.bounded.tools", "/icon.svg");
  assert.equal(svg.status, 200);
  assert.match(svg.headers.get("content-type"), /image\/svg\+xml/);
  const body = await svg.text();
  // The two details a 32px reconstruction lost: the door's gap, and the rounded
  // square inside it.
  assert.match(body, /M57\.5 81/);
  assert.match(body, /L42\.5 81/);
  assert.match(body, /width="12" height="12"/);

  for (const [path, size] of [["/icon-200.png", 200], ["/icon-460.png", 460], ["/icon-1024.png", 1024]]) {
    const res = await get("desk.bounded.tools", path);
    assert.equal(res.status, 200, path);
    assert.equal(res.headers.get("content-type"), "image/png", path);
    const b = new Uint8Array(await res.arrayBuffer());
    assert.ok(b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47, `${path} is a PNG`);
    // Width lives at byte 16 of a PNG, big-endian — read the pixels, not the name.
    const w = (b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19];
    assert.equal(w, size, `${path} really is ${size}px`);
  }
});

test("THE MANIFEST LEADS WITH A PNG — iOS cannot render an SVG icon", async () => {
  // Leading with the vector is how a phone ends up with no icon at all and falls
  // back to the first letter of the name. Everything that understands SVG picks
  // the best match rather than the first entry, so this costs those clients
  // nothing and gives the one with no fallback something it can use.
  const m = await (await get("desk.bounded.tools", "/manifest.webmanifest")).json();
  assert.equal(m.icons[0].type, "image/png", "the first entry must be raster");
  assert.ok(m.icons.some((i) => i.type === "image/svg+xml"), "the vector is still offered");
  for (const i of m.icons) {
    // Declaring only "any" makes Android draw a white plate behind a full-bleed
    // icon; the avatar bleeds to the edge deliberately.
    assert.match(i.purpose, /maskable/);
  }
});

test("the conventional apple-touch-icon paths serve a PNG, not the page", async () => {
  // iOS reaches for these by name when the <link> does not resolve. They fell
  // through to the catch-all and answered 200 with text/html — a web page served
  // as a PNG, the same wrong-content-type 200 #766 named, in the two paths a
  // phone asks for rather than reads from markup.
  for (const path of ["/apple-touch-icon.png", "/apple-touch-icon-precomposed.png"]) {
    const res = await get("desk.bounded.tools", path);
    assert.equal(res.status, 200, path);
    assert.equal(res.headers.get("content-type"), "image/png", path);
    const b = new Uint8Array(await res.arrayBuffer());
    assert.ok(b[0] === 0x89 && b[1] === 0x50, `${path} is a PNG`);
  }
});

test("an open page is told to refresh when a push arrives", async () => {
  // Without this the notification says the board changed and the board in front
  // of the reader still does not — the page is rendered once and nothing polls.
  const sw = await (await get("desk.bounded.tools", "/sw.js")).text();
  assert.match(sw, /clients\.matchAll/);
  assert.match(sw, /front-desk:refresh/);

  const js = await (await get("desk.bounded.tools", "/notify.js", KEYED_ENV)).text();
  assert.match(js, /front-desk:refresh/, "the page listens for it");
  // And a push may never arrive — the device was off, or nobody is subscribed —
  // so returning to a stale page reloads it too.
  assert.match(js, /visibilitychange/);
  assert.match(js, /location\.reload\(\)/);
});

test("THE PAGE LINKS THE MANIFEST — it never did, which is why iOS showed a letter", async () => {
  const html = await (await get("desk.bounded.tools")).text();
  assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest">/);
  // Separate and not redundant: iOS reads apple-touch-icon for the Home Screen
  // and does not take manifest icons for that purpose.
  assert.match(html, /<link rel="apple-touch-icon" href="\/icon-460\.png">/);
});

test("the app-shell head appears on desk and on no other host", async () => {
  for (const host of STATIC_HOSTS) {
    const html = await (await get(host)).text();
    assert.ok(!/rel="manifest"/.test(html), `${host} must not offer an install`);
    assert.ok(!/apple-touch-icon/.test(html), host);
  }
});

test("the static hosts 404 the app-shell paths instead of serving a page as one", async () => {
  // #766 fixed this for desk and left the other three: every path fell through
  // to the board, so /manifest.webmanifest answered 200 with text/html. A check
  // that only reads the status would call the asset present.
  for (const host of STATIC_HOSTS) {
    for (const path of ["/manifest.webmanifest", "/sw.js", "/notify.js", "/icon.svg",
                        "/icon-1024.png", "/apple-touch-icon.png"]) {
      const res = await get(host, path);
      assert.equal(res.status, 404, `${host}${path}`);
    }
    assert.equal((await get(host)).status, 200, `${host} still renders its board`);
  }
});

// ── approvals reach a phone (#51) ────────────────────────────────────────────

const APPROVAL = {
  title: "Approve broker-deploy",
  body: "A run wants an account-wide Workers:Edit token.",
  url: "https://keeper.bounded.tools/a/abc123",
};

const approve = (body, env, host = "desk.bounded.tools", token = null) =>
  worker.fetch(new Request(`https://${host}/approval`, {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}`, "content-type": "application/json" }
                   : { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }), env);

test("/pending serves the board default until something is pending", async () => {
  const env = await vapidEnv();
  const d = await (await get("desk.bounded.tools", "/pending", env)).json();
  assert.equal(d.kind, "board");
  assert.equal(d.body, "The board changed.");
});

test("an approval is recorded and fanned out, and /pending then names it", async () => {
  const env = await vapidEnv();
  await seed(env, "a");
  stubOidcAndPush();
  const res = await approve(APPROVAL, env, "desk.bounded.tools", await ISS.mint());
  assert.equal(res.status, 200);
  assert.equal((await res.json()).sent, 1, "the approval went out to the subscribed device");

  const d = await (await get("desk.bounded.tools", "/pending", env)).json();
  assert.equal(d.kind, "approval");
  assert.equal(d.title, "Approve broker-deploy");
  assert.equal(d.url, APPROVAL.url);
});

test("it is RECORDED BEFORE it is sent", async () => {
  // Otherwise the worker wakes, fetches /pending, finds nothing, and tells the
  // reader the board changed when what happened is someone needs a Face ID.
  const env = await vapidEnv();
  await seed(env, "a");
  let pendingAtPushTime = null;
  globalThis.fetch = async (url) => {
    const href = typeof url === "string" ? url : url.url;
    if (href.includes("/.well-known/jwks")) return new Response(JSON.stringify({ keys: ISS.jwks }), { status: 200 });
    // Read through the module rather than a hardcoded key: #65 moved storage
    // from one slot to one entry per ceremony, and a test that pins the layout
    // fails on a refactor that keeps the invariant it actually cares about.
    pendingAtPushTime = (await pendingApprovals(env.SUBSCRIPTIONS)).length;
    return new Response(null, { status: 201 });
  };
  await approve(APPROVAL, env, "desk.bounded.tools", await ISS.mint());
  assert.equal(pendingAtPushTime, 1, "the record must exist before the push leaves");
});

test("an unauthorized caller records nothing and sends nothing", async () => {
  const env = await vapidEnv();
  await seed(env, "a");
  stubOidcAndPush();
  assert.equal((await approve(APPROVAL, env)).status, 401);
  const wrong = await ISS.mint({ workflowRef: "bounded-systems/desk/.github/workflows/evil.yml@refs/heads/main" });
  assert.equal((await approve(APPROVAL, env, "desk.bounded.tools", wrong)).status, 403);
  assert.equal(await env.SUBSCRIPTIONS.get("pending:approval"), null, "nothing was recorded");
});

test("a destination that is not the keeper is refused", async () => {
  const env = await vapidEnv();
  stubOidcAndPush();
  const res = await approve({ ...APPROVAL, url: "https://evil.example/a/x" }, env, "desk.bounded.tools", await ISS.mint());
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /keeper/);
});

test("/approval exists on desk and nowhere else", async () => {
  const env = await vapidEnv();
  stubOidcAndPush();
  const token = await ISS.mint();
  for (const host of STATIC_HOSTS) {
    assert.equal((await approve(APPROVAL, env, host, token)).status, 404, host);
  }
});

test("the service worker fetches what to say, and always ends in a notification", async () => {
  const sw = await (await get("desk.bounded.tools", "/sw.js")).text();
  assert.match(sw, /fetch\("\/pending"/);
  // Every branch must reach showNotification: iOS revokes permission from an app
  // that receives a push and shows nothing.
  const branches = sw.slice(sw.indexOf('addEventListener("push"'), sw.indexOf('addEventListener("notificationclick"'));
  // Comments stripped first. The handler EXPLAINS that every branch must end in
  // showNotification, so counting the raw text counts the explanation — the same
  // trap the opt-in's honesty test records, and one this test fell into.
  const code = branches.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  assert.equal((code.match(/showNotification/g) || []).length, 1, "one call, reached from every path");
  assert.match(code, /catch/, "a failed fetch still notifies");
});

test("an off-origin approval link opens rather than focusing a desk tab", async () => {
  // Focusing an existing window would drop the reader somewhere other than the
  // tap promised — the keeper is a different origin.
  const sw = await (await get("desk.bounded.tools", "/sw.js")).text();
  assert.match(sw, /offOrigin/);
});

// ── the installed app (#51) ──────────────────────────────────────────────────

test("the manifest has a stable id, so start_url can move without orphaning installs", async () => {
  const m = await (await get("desk.bounded.tools", "/manifest.webmanifest")).json();
  assert.equal(m.id, "/");
  assert.equal(m.start_url, "/");
});

test("the splash colour is the brand green, not a page background", async () => {
  // background_color cannot be media-queried — one value serves both launches.
  // The light page colour meant a dark-mode launch flashed #fbfaf8.
  //
  // FOREST rather than the literal, which this test used to type. The literal
  // was correct, and that was the problem: it was a FOURTH copy of #0C5A42
  // (tokens.js, worker.js, icons.test.mjs, here) in a change whose whole point
  // is that the value is transcribed nowhere. Typing it here would mean a brand
  // release that retunes `color.forest` shows up as this test failing — which
  // reads as "the manifest broke" when what actually happened is "the brand
  // moved". The contract this test owns is that the splash is the BRAND GREEN
  // and that both fields carry the same one; that the brand green is still what
  // the package says is tokens.test.mjs's drift check, and it is the only place
  // that comparison belongs.
  const m = await (await get("desk.bounded.tools", "/manifest.webmanifest")).json();
  assert.equal(m.background_color, FOREST);
  assert.equal(m.theme_color, FOREST);
});

test("shortcuts stay inside scope, or a launcher silently ignores them", async () => {
  const m = await (await get("desk.bounded.tools", "/manifest.webmanifest")).json();
  assert.equal(m.shortcuts.length, 3);
  for (const sc of m.shortcuts) {
    // issues/claims/prs are separate ORIGINS; a shortcut to one would be out of
    // scope and dropped without a word. These land on the overview's own
    // anchors, which link on to the host.
    assert.ok(sc.url.startsWith("/#"), `${sc.url} must be same-origin and in scope`);
    assert.ok(sc.short_name.length <= 12, "launchers truncate hard");
  }
});

test("the sections carry the anchors those shortcuts point at", async () => {
  const html = await (await get("desk.bounded.tools")).text();
  for (const key of ["issues", "claims", "prs"]) {
    assert.match(html, new RegExp(`id="${key}"`), `#${key} must exist to jump to`);
  }
});

test("viewport-fit=cover is set, or the safe-area padding is inert", async () => {
  // env(safe-area-inset-*) resolves to 0 without it, so the insets #33 added
  // computed as plus-zero and iOS letterboxed the page instead.
  const html = await (await get("desk.bounded.tools")).text();
  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /env\(safe-area-inset-top\)/);
});

test("theme-color is given per scheme", async () => {
  const html = await (await get("desk.bounded.tools")).text();
  assert.match(html, /theme-color" media="\(prefers-color-scheme: light\)"/);
  assert.match(html, /theme-color" media="\(prefers-color-scheme: dark\)"/);
});

test("/offline says what it does not know, and shows no board", async () => {
  const res = await get("desk.bounded.tools", "/offline");
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /You are offline/);
  assert.match(html, /no cached copy is kept/);
  // BODY ONLY. Checking the whole document matched `.sec__more` in the inlined
  // stylesheet — the page's own scaffolding, not its content. Same trap as the
  // showNotification count, which matched the comment explaining itself.
  const body = html.slice(html.indexOf("<body>"));
  assert.ok(!/<section class="sec"/.test(body), "no board sections");
  assert.ok(!/sec__more/.test(body), "no row listings");
});

test("the worker caches ONE page and intercepts only navigations", async () => {
  const sw = await (await get("desk.bounded.tools", "/sw.js")).text();
  const code = sw.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  // Caching the board would serve a stale one from an installed app with no way
  // to caveat it — the defect the live Worker exists to remove, offline.
  assert.equal((code.match(/\.add\(/g) || []).length, 1, "exactly one cached entry");
  assert.match(code, /"\/offline"/);
  assert.match(code, /mode !== "navigate"/, "everything else goes to the network");
  assert.ok(!/board\.json/.test(code), "the board is never cached");
});

// ── /human: a question in front of a person (#69) ────────────────────────────
//
// The verb is ask-and-exit, so the two halves are tested apart: a lane may ASK
// through the OIDC door, and nobody may ANSWER through it — or through any
// other door — until desk login lands (desk#65).

const ASK = {
  prompt: "Should the intake lane keep opening one issue per repo?",
  choices: ["yes", "no"],
  no_answer_policy: "default",
  no_answer_value: "no",
};

const ask = (body, env, host = "desk.bounded.tools", token = null) =>
  worker.fetch(new Request(`https://${host}/human`, {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}`, "content-type": "application/json" }
                   : { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }), env);

/** The rendered state, extracted from the element — not matched across the page. */
const stateOf = (html) => (html.match(/q__state" data-status="([a-z-]+)"/) || [])[1];

/**
 * What the CARD SAYS, as opposed to what its data attribute reports.
 *
 * The parity test used to compare `data-status` alone, so every human-visible
 * sentence on the card was unpinned: a fired default could announce "A person
 * answered." while /human.json correctly reported `default-fired`, and the
 * suite stayed green. The attribute is for machines; these two read the parts a
 * person actually reads.
 */
const headOf = (html) =>
  (html.match(/q__state" data-status="[a-z-]+">\s*<strong>([^<]*)<\/strong>/) || [])[1];
/** The value line: its label, the value itself, and who it is attributed to. */
const valueOf = (html) => {
  const m = html.match(
    /<p class="q__value"><span class="visually-hidden">([^<]*)<\/span><span class="q__value-t">([^<]*)<\/span>\s*<span class="muted"> — ([^<]*)<\/span>/,
  );
  return m ? { label: m[1].trim(), value: m[2], attribution: m[3].trim() } : null;
};

/** One sentence per state, and no state may borrow another's. */
const HEADS = {
  open: "Waiting for a person.",
  answered: "A person answered.",
  "default-fired": "Nobody answered. The declared default fired.",
  blocked: "Nobody answered, and the asker declared block.",
  escalated: "Nobody answered, and the asker declared escalate.",
};

/**
 * Put one record straight in the store, to reach a state the CLOCK owns.
 *
 * The deadline is relative to now, not a literal: a fixed date drifts into the
 * past and turns an "open" fixture into an expired one, which here would flip
 * the very distinction under test rather than failing loudly.
 */
const ago = (days) => new Date(Date.now() - days * 86400000).toISOString();
const ahead = (days) => new Date(Date.now() + days * 86400000).toISOString();
const seedQuestion = async (env, rec) => {
  const full = {
    choices: null, no_answer_policy: "block", no_answer_value: null, answer: null,
    url: questionUrlFor(rec.id), asked_at: ago(9), deadline: ago(2), ...rec,
  };
  await env.SUBSCRIPTIONS.put(`question:${rec.id}`, JSON.stringify(full));
  // BOTH keys, because putQuestion writes both: a helper that seeded only the
  // record would make /pending look broken here and, worse, could make a real
  // regression in the pointer write invisible.
  //
  // ONLY WHILE IT IS STILL ASKABLE. The pointer's TTL is the answering window,
  // so KV has already dropped it for a question past its deadline; the stub has
  // no expiry, so the deadline stands in for it here.
  if (Date.parse(full.deadline) > Date.now()) {
    await env.SUBSCRIPTIONS.put(`open-question:${full.asked_at}:${rec.id}`, "");
  }
};

test("a lane asks, and gets back the id and the address a person answers at", async () => {
  const env = await vapidEnv();
  await seed(env, "a");
  stubOidcAndPush();
  const res = await ask(ASK, env, "desk.bounded.tools", await ISS.mint());
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.match(body.url, /^https:\/\/desk\.bounded\.tools\/human\/[A-Za-z0-9_-]{1,64}$/);
  assert.equal(questionIdFrom(body.url), body.id);
  assert.equal(body.no_answer_policy, "default");
  assert.equal(body.notified.sent, 1, "and the phone was told");

  const q = await (await get("desk.bounded.tools", `/human/${body.id}.json`, env)).json();
  assert.equal(q.kind, "question");
  assert.equal(q.status, "open");
  assert.equal(q.prompt, ASK.prompt);
});

test("the question is on file even when the push could not leave", async () => {
  // A VAPID misconfiguration does not un-ask the question, and answering the
  // lane 503 would tell it the ask was refused when it was recorded.
  const env = { ...ENV, SUBSCRIPTIONS: kvStub() };
  stubOidcAndPush();
  const res = await ask(ASK, env, "desk.bounded.tools", await ISS.mint());
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.match(body.notified.error, /signing keypair/);
  assert.equal((await (await get("desk.bounded.tools", `/human/${body.id}.json`, env)).json()).status, "open");
});

test("an unauthorized asker records nothing", async () => {
  const env = await vapidEnv();
  stubOidcAndPush();
  assert.equal((await ask(ASK, env)).status, 401);
  const wrong = await ISS.mint({ workflowRef: "bounded-systems/desk/.github/workflows/evil.yml@refs/heads/main" });
  assert.equal((await ask(ASK, env, "desk.bounded.tools", wrong)).status, 403);
  // Read the STORE, not /human.json: the corpus route is shut (desk#65), so a
  // refusal there would pass this test no matter what the asker wrote.
  assert.deepEqual([...env.SUBSCRIPTIONS.map.keys()].filter((k) => k.startsWith("question:")), []);
});

test("every refusal names the field, because our own lane is the caller", async () => {
  const env = await vapidEnv();
  stubOidcAndPush();
  const token = await ISS.mint();
  const err = async (body) => (await (await ask(body, env, "desk.bounded.tools", token)).json()).error;
  assert.match(await err({ ...ASK, no_answer_policy: undefined }), /no_answer_policy/);
  assert.match(await err({ ...ASK, prompt: "" }), /prompt/);
  assert.match(await err({ ...ASK, no_answer_value: "maybe" }), /not one of the choices/);
  assert.match(await err("{not json"), /not JSON/);
  assert.equal((await ask("x".repeat(5000), env, "desk.bounded.tools", token)).status, 413);
  // A question address the caller tried to choose is refused, not ignored.
  assert.match(await err({ ...ASK, url: "https://keeper.bounded.tools/a/abc123" }), /desk\.bounded\.tools/);
});

test("/human exists on desk and nowhere else", async () => {
  const env = await vapidEnv();
  stubOidcAndPush();
  const token = await ISS.mint();
  for (const host of STATIC_HOSTS) {
    assert.equal((await ask(ASK, env, host, token)).status, 404, host);
    // AND the reads 404 rather than falling through to that host's board — a
    // question URL with three impostor resolutions is phishing-shaped.
    for (const path of ["/human", "/human.json", "/human/abc123", "/human/abc123.json"]) {
      const res = await get(host, path, env);
      assert.equal(res.status, 404, `${host}${path}`);
      assert.ok(!/<h1>/.test(await res.text()), `${host}${path} must not serve a board`);
    }
  }
});

test("the method gate is not loosened by the new writes", async () => {
  const env = await vapidEnv();
  const res = await post("desk.bounded.tools", "/", ASK, env);
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "GET, HEAD");
});

// ── nobody may answer yet (desk#65) ──────────────────────────────────────────

test("THE ANSWER ROUTE REFUSES, names desk#65, and stores nothing", async () => {
  const env = await vapidEnv();
  stubOidcAndPush();
  const body = await (await ask(ASK, env, "desk.bounded.tools", await ISS.mint())).json();

  for (const token of [null, await ISS.mint()]) {
    const res = await worker.fetch(new Request(`https://desk.bounded.tools/human/${body.id}/answer`, {
      method: "POST",
      headers: token ? { authorization: `Bearer ${token}`, "content-type": "application/json" }
                     : { "content-type": "application/json" },
      body: JSON.stringify({ value: "yes" }),
    }), env);
    // 401 now, not the old 501: desk login exists (desk#65), so there IS a
    // credential to present and the status may invite it. And an OIDC token —
    // the door the ASK uses — still must not open it, or a lane answers its own
    // question and the record reads as human-reviewed with no human involved.
    assert.equal(res.status, 401);
    assert.match((await res.json()).error, /desk#65/);
    assert.ok(!res.headers.getSetCookie().length, "a refusal mints no session");
  }
  const after = await (await get("desk.bounded.tools", `/human/${body.id}.json`, env)).json();
  assert.equal(after.answer, null);
  assert.equal(after.status, "open");
});

test("the card offers no control it cannot honour", async () => {
  const env = await vapidEnv();
  await seedQuestion(env, { id: "q1", prompt: "a question" });
  const page = await (await get("desk.bounded.tools", "/human/q1", env)).text();
  const body = page.slice(page.indexOf("<body>"));
  assert.ok(!/<form/.test(body), "form-action is 'none' on every surface — a form here would be inert");
  assert.ok(!/<button/.test(body), "a dead button is worse than none");
  // Desk login exists now, and this page still offers no control: form-action is
  // 'none' on every surface, so the sentence says where answering happens rather
  // than pretending a button could.
  assert.match(body, /POST \/human\/&lt;id&gt;\/answer/);
  assert.match(body, /desk#65/);
});

// ── one judgement, two renderings (#69, rule 2) ──────────────────────────────

test("A HUMAN AND AN AGENT CANNOT DISAGREE about what happened to a question", async () => {
  const env = await vapidEnv();
  await seedQuestion(env, { id: "open1", prompt: "still open", deadline: ahead(5) });
  await seedQuestion(env, {
    id: "said1", prompt: "a person said no", no_answer_policy: "default", no_answer_value: "yes",
    answer: { value: "no", at: ago(1), rung: "human-reviewed" },
  });
  await seedQuestion(env, {
    id: "fired1", prompt: "nobody said anything", no_answer_policy: "default", no_answer_value: "yes",
  });
  await seedQuestion(env, { id: "blocked1", prompt: "nothing proceeds", no_answer_policy: "block" });
  await seedQuestion(env, { id: "escalated1", prompt: "goes elsewhere", no_answer_policy: "escalate" });

  for (const id of ["open1", "said1", "fired1", "blocked1", "escalated1"]) {
    const j = await (await get("desk.bounded.tools", `/human/${id}.json`, env)).json();
    const h = await (await get("desk.bounded.tools", `/human/${id}`, env)).text();
    assert.equal(stateOf(h), j.status, `${id}: the card and the JSON report one state`);

    // THE PROSE, not only the attribute. `data-status` is for machines; a
    // person reads the sentence, and a card whose sentence disagrees with the
    // JSON is exactly the disagreement rule 2 forbids — it was simply invisible
    // to a test that compared the attribute alone.
    assert.equal(headOf(h), HEADS[j.status], `${id}: the card's sentence is the one for its state`);
    for (const [status, head] of Object.entries(HEADS)) {
      if (status !== j.status) assert.ok(!h.includes(head), `${id}: reads as ${status}`);
    }

    // AND THE VALUE. "A person answered no" and "nobody answered and the asker
    // had declared yes" must not be able to render as each other, so the value
    // the card shows and the value the JSON reports are compared as well as the
    // state — said1 is answered "no" against a declared default of "yes"
    // precisely so the two cannot be confused for each other here.
    const shown = valueOf(h);
    if (j.answer) {
      assert.deepEqual(shown, { label: "Answer:", value: j.answer.value, attribution: "given by a person" }, id);
    } else if (j.default_fired) {
      assert.deepEqual(
        shown,
        { label: "Default:", value: j.default_value, attribution: "declared in advance, not given by anyone" },
        id,
      );
    } else {
      // block and escalate substitute NOTHING, and neither does an open
      // question. A value line here would be a value nobody chose.
      assert.equal(shown, null, `${id}: no value was given or declared, so none is shown`);
      assert.equal(j.answer, null);
      assert.equal(j.default_value, null);
    }
  }
});

test("'a person answered X' and 'nobody answered and the default was X' RENDER DIFFERENTLY", async () => {
  const env = await vapidEnv();
  await seedQuestion(env, {
    id: "said1", prompt: "p", no_answer_policy: "default", no_answer_value: "yes",
    answer: { value: "yes", at: ago(1), rung: "human-reviewed" },
  });
  await seedQuestion(env, { id: "fired1", prompt: "p", no_answer_policy: "default", no_answer_value: "yes" });

  const said = await (await get("desk.bounded.tools", "/human/said1", env)).text();
  const fired = await (await get("desk.bounded.tools", "/human/fired1", env)).text();
  assert.equal(stateOf(said), "answered");
  assert.equal(stateOf(fired), "default-fired");
  // Same value, "yes", in both. Only the sentences tell them apart.
  assert.match(said, /given by a person/);
  assert.match(fired, /declared in advance, not given by anyone/);
  assert.ok(!/given by a person/.test(fired), "a fired default must never read as an answer");

  const j = await (await get("desk.bounded.tools", "/human/fired1.json", env)).json();
  assert.equal(j.answer, null);
  assert.equal(j.default_fired, true);
  assert.equal(j.default_value, "yes");
  assert.equal(j.rung, "unreviewed", "nobody reviewed it, so it is not human-reviewed");
});

test("an answer is never presented as an authorization", async () => {
  const env = await vapidEnv();
  await seedQuestion(env, {
    id: "said1", prompt: "p", answer: { value: "yes", at: ago(1), rung: "human-reviewed" },
  });
  const j = await (await get("desk.bounded.tools", "/human/said1.json", env)).json();
  assert.equal(j.rung, "human-reviewed");
  assert.ok(!JSON.stringify(j).includes("authorized"));
  const h = await (await get("desk.bounded.tools", "/human/said1", env)).text();
  assert.match(h, /not an approval and authorizes nothing/);
});

test("the card is not cached stale", async () => {
  const env = await vapidEnv();
  await seedQuestion(env, { id: "open1", prompt: "one", deadline: ahead(5) });
  // ttl 0, like /pending: a card cached for EDGE_TTL keeps saying "waiting for a
  // person" for a minute after a person answered.
  for (const path of ["/human/open1", "/human/open1.json"]) {
    const res = await get("desk.bounded.tools", path, env);
    assert.equal(res.status, 200, path);
    assert.equal(res.headers.get("cache-control"), "public, max-age=0", path);
  }
});

// ── the corpus is not public (desk#65) ───────────────────────────────────────
//
// desk has no login and no hostname of its own, so a collection route on it
// published every prompt, choice set, declared default, deadline, id and
// address a lane had ever asked, for as long as the record lived. The answer
// door was shut on exactly the reasoning that desk login gates VIEWING; the
// view half was not, and enumeration is the half that scales.
test("THE WHOLE CORPUS IS NOT HANDED OUT to a caller desk cannot name", async () => {
  const env = await vapidEnv();
  await seedQuestion(env, {
    id: "leak1", prompt: "Rotate the leaked deploy key now, or wait for Tuesday?",
    choices: ["now", "tuesday"], no_answer_policy: "default", no_answer_value: "tuesday",
    deadline: ahead(5),
  });

  for (const path of ["/human.json", "/human"]) {
    const res = await get("desk.bounded.tools", path, env);
    // 401, the same status and the same seam shape as the answer door: desk
    // login exists (desk#65), so the status invites the credential that opens it.
    assert.equal(res.status, 401, path);
    // A cookie decides this body, so it never goes to a shared cache.
    assert.equal(res.headers.get("cache-control"), "no-store", path);
    assert.equal(res.headers.get("vary"), "cookie", path);
    const body = await res.text();
    assert.ok(!body.includes("Rotate the leaked deploy key"), `${path} leaked the prompt`);
    assert.ok(!body.includes("tuesday"), `${path} leaked the declared default`);
    assert.ok(!body.includes("leak1"), `${path} leaked the id — and so the address`);
    assert.match(body, /desk#65/, path);
  }

  // NOT "there are none". A caller told the corpus is empty stops looking; the
  // refusal has to be distinguishable from an empty board.
  const j = await (await get("desk.bounded.tools", "/human.json", env)).json();
  assert.equal(j.questions, undefined);
  assert.equal(j.kind, "closed");
  const h = await (await get("desk.bounded.tools", "/human", env)).text();
  assert.match(h, /not an empty list/);
  assert.ok(!/data-status/.test(h), "no question state is reported by a page that reports no questions");

  // And the one address a person was actually given still works — otherwise the
  // notification points at a page nobody can read, and the verb is dead.
  const one = await get("desk.bounded.tools", "/human/leak1.json", env);
  assert.equal(one.status, 200);
  assert.equal((await one.json()).prompt, "Rotate the leaked deploy key now, or wait for Tuesday?");
});

test("refusing the corpus does not read it — the store is not paged at all", async () => {
  // The refusal is ahead of the store, so an anonymous caller cannot spend our
  // KV reads on a listing they are not getting.
  const env = await vapidEnv();
  for (let i = 0; i < 5; i++) await seedQuestion(env, { id: `q${i}`, prompt: `p${i}` });
  const before = { ...env.SUBSCRIPTIONS.counts };
  await get("desk.bounded.tools", "/human.json", env);
  assert.deepEqual(env.SUBSCRIPTIONS.counts, before, "a shut door read nothing");
});

test("no such question is its own sentence, in both renderings", async () => {
  const env = await vapidEnv();
  const res = await get("desk.bounded.tools", "/human/doesnotexist.json", env);
  assert.equal(res.status, 404);
  assert.match((await res.json()).error, /no such question/);
  const h = await get("desk.bounded.tools", "/human/doesnotexist", env);
  assert.equal(h.status, 404);
  const body = await h.text();
  assert.match(body, /could not be read/);
  assert.ok(!/data-status/.test(body), "no state is reported for a question that is not there");
});

test("caller-supplied question text cannot break out of the card", async () => {
  const env = await vapidEnv();
  await seedQuestion(env, { id: "x1", prompt: "<script>x</script>", choices: ["<b>y</b>"] });
  const h = await (await get("desk.bounded.tools", "/human/x1", env)).text();
  assert.doesNotMatch(h, /<script>x<\/script>/);
  assert.match(h, /&lt;script&gt;/);
  assert.match(h, /&lt;b&gt;y&lt;\/b&gt;/);
});

test("A PUSH WAKE COSTS THE SAME whether five questions are on file or five hundred", async () => {
  // /pending is unauthenticated and is what the service worker fetches on every
  // wake. Reading every stored question to find the open ones made an anonymous
  // GET cost one KV read per question ever asked — records live 28 days, so the
  // fan grew with ask volume, and past the Workers subrequest ceiling /pending
  // fails and the phone falls back to "The board changed." (#51's own defect).
  const env = await vapidEnv();
  for (let i = 0; i < 200; i++) await seedQuestion(env, { id: `closed${String(i).padStart(3, "0")}`, prompt: `p${i}` });
  await seedQuestion(env, { id: "live1", prompt: "the one still open", deadline: ahead(3) });

  env.SUBSCRIPTIONS.counts.get = 0;
  const d = await (await get("desk.bounded.tools", "/pending", env)).json();
  assert.equal(d.body, "the one still open");
  assert.ok(env.SUBSCRIPTIONS.counts.get <= 5,
    `one wake should cost a handful of reads, not the corpus — it cost ${env.SUBSCRIPTIONS.counts.get}`);

  // And the 200 closed records are still on file, still describable: bounding
  // the wake must not have been done by throwing the corpus away.
  assert.equal((await (await get("desk.bounded.tools", "/human/closed000.json", env)).json()).status, "blocked");
});

test("a question is announced as a question, never as an approval", async () => {
  const env = await vapidEnv();
  await seedQuestion(env, { id: "open1", prompt: "who owns this?", deadline: ahead(5) });
  const d = await (await get("desk.bounded.tools", "/pending", env)).json();
  assert.equal(d.kind, "question");
  assert.equal(d.body, "who owns this?");
  assert.equal(d.url, questionUrlFor("open1"));
});
