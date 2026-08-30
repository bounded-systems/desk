// The routing is the change (#7), so it is the thing under test: four hosts, one
// Worker, and a wrong turn here serves a reader the wrong page — or, in the case
// the feed guards exist for, the wrong FEED.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";
import { issuer } from "./oidc-fixture.mjs";
import { b64url } from "../src/push.js";
import { listSubscriptions } from "../src/subscriptions.js";

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
  return { map, put: async (k, v) => void map.set(k, v), get: async (k) => map.get(k) ?? null,
           delete: async (k) => void map.delete(k),
           list: async () => ({ keys: [...map.keys()].map((name) => ({ name })), list_complete: true }) };
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
    workflowRef: "bounded-systems/.github-private/.github/workflows/org-sync.yml@refs/heads/main",
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
