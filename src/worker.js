// The Front Desk, live — four hosts, one Worker.
//
// A static page can only ever state the age it had when it was built, which is
// why the site's generated /desk carried a hand-piped snapshot and eventually
// rendered its own "this snapshot is old" banner while the projection lane was
// running perfectly well. The board refreshes hourly; the site deploys behind a
// hermetic build, Sigstore signing and an approval gate. Those two cadences do
// not belong on the same rope.
//
// So: fetch the already-filtered public feed per request, cache it briefly at
// the edge, and render. The board's own ranking is carried through untouched.
//
// ONE QUESTION PER HOST, selected by hostname so a reader cannot reach the
// wrong page by path:
//
//   issues.bounded.tools   what is worth picking up
//   claims.bounded.tools   what is already spoken for
//   prs.bounded.tools      what is open and awaiting a check
//   desk.bounded.tools     all three at a glance, and the default for any other
//                          hostname this Worker answers on (a workers.dev
//                          preview above all) — the front door is the safe thing
//                          to serve when the host does not say which page it is.
//
// FAIL CLOSED. Every failure — feed unreachable, wrong feed, undatable snapshot
// — renders "the board could not be read" with a 5xx, never an empty list. A
// board that cannot be read and a board with nothing on it are different
// sentences, and only one of them is ever true. The overview is the one page
// that can be PARTLY unreadable, and it fails closed per section: the sections
// that answered are rendered, the one that did not says so in its own words, and
// the whole page is still served with a 5xx, because a summary missing a third
// of what it summarises has not succeeded.

import {
  select,
  selectClaims,
  selectPrs,
  selectOverview,
  DEFAULT_LIMIT,
  FeedError,
} from "./select.js";
import {
  renderIssues,
  renderClaims,
  renderPrs,
  renderOverview,
  renderUnavailable,
} from "./render.js";
import { validateSubscription, putSubscription } from "./subscriptions.js";
import { notifyAll } from "./notify.js";
import { importVapidKey } from "./push.js";
import { verifyNotifyCaller } from "./oidc.js";
import { AVATAR_SVG, ICON_PNGS, iconBytes } from "./icons.js";
import { validateApproval, putApproval, pending } from "./pending.js";

// ── The installable app (#766) ───────────────────────────────────────────────
//
// iOS serves Web Push ONLY to a site added to the Home Screen and backed by a
// manifest plus a registered service worker. Pinning the page gives none of that
// on its own, which is why the pinned app has never been able to notify.
//
// `display: standalone` is the part iOS requires; the rest is what makes the
// installed app look like the page rather than a browser chrome around it.
const MANIFEST = {
  name: "Front Desk — Bounded Systems",
  short_name: "Desk",
  description: "What is worth picking up, what is spoken for, and what awaits a check.",
  start_url: "/",
  scope: "/",
  display: "standalone",
  // Matches the page's own light/dark grounds in render.js. A mismatch here is
  // visible as a flash of the wrong colour on launch.
  background_color: "#fbfaf8",
  theme_color: "#0C5A42",
  // The bounded.tools mark (#51). Empty until now, which is why iOS showed the
  // app as a grey letter "D" — the first character of the name, its fallback
  // when a manifest offers nothing.
  //
  // "any maskable" on both: the icons bleed to the edge, so a launcher may mask
  // them to any shape without clipping the glyph. Declaring only "any" makes
  // Android draw a white plate behind them instead.
  // The SVG FIRST: it is the icon of record and scales to whatever a launcher
  // asks for, so there is no size to keep in sync with a file. The PNG is the
  // fallback for anything that will not take vector — iOS above all, which reads
  // apple-touch-icon rather than this list for the Home Screen.
  //
  // "any maskable" on both: the avatar bleeds to the edge, so a launcher may cut
  // it to any shape without clipping the glyph. Declaring only "any" makes
  // Android draw a white plate behind a full-bleed icon.
  icons: [
    { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" },
    { src: "/icon-1024.png", sizes: "1024x1024", type: "image/png", purpose: "any maskable" },
  ],
};

// THE SERVICE WORKER, deliberately minimal and deliberately NOT a cache.
//
// Its only job today is to exist and to be able to receive a push, because that
// is what iOS requires before it will grant permission at all. It caches
// nothing: the board is a live read whose whole value is being current, and a
// caching worker would serve a stale board from an installed app with no
// staleness banner to warn about it — reintroducing, offline, precisely the
// defect the live Worker was built to remove.
//
// `push` renders a notification; `notificationclick` focuses an existing window
// rather than opening a second one.
const SERVICE_WORKER = `// Front Desk service worker. Generated by src/worker.js; do not edit in place.
self.addEventListener("install", (e) => { self.skipWaiting(); });
self.addEventListener("activate", (e) => { e.waitUntil(self.clients.claim()); });

self.addEventListener("push", (event) => {
  // WE SEND NO PAYLOAD, so what this notification is ABOUT is fetched from the
  // origin on wake (#51). Before that it rendered two constants and every push
  // said "The board changed." — true for a board change and wrong for an
  // approval, which is the message most worth sending.
  //
  // A push with no body, or one we cannot describe, must STILL notify: a silent
  // push is indistinguishable from a broken one, and iOS revokes permission from
  // an app that receives pushes and shows nothing. So every branch here ends in
  // showNotification.
  event.waitUntil((async () => {
    let d = { title: "Front Desk", body: "The board changed.", url: "/" };
    try {
      const res = await fetch("/pending", { cache: "no-store" });
      if (res.ok) {
        const j = await res.json();
        if (j && j.title && j.body) d = { title: j.title, body: j.body, url: j.url || "/" };
      }
    } catch (_) {
      // Offline, or the origin is down. Fall through to the default rather than
      // showing nothing.
    }
    await self.registration.showNotification(d.title, {
      body: d.body,
      // One tag, so a second push replaces the first rather than stacking. What
      // a reader wants is the current state, not a history.
      tag: "front-desk",
      data: { url: d.url },
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil((async () => {
    // An approval points at the keeper, which is a DIFFERENT origin — focusing an
    // existing desk window would silently drop the reader somewhere else than
    // the tap promised. So an off-origin target always opens.
    const offOrigin = /^https:\/\//.test(target) && !target.startsWith(self.location.origin);
    if (!offOrigin) {
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const c of all) { if ("focus" in c) return c.focus(); }
    }
    if (self.clients.openWindow) return self.clients.openWindow(target);
  })());
});
`;

// The opt-in script (#766). Served from this origin so `script-src 'self'` is
// the whole grant — no CDN, no inline, no 'unsafe-inline'.
//
// EVERY BRANCH ENDS IN A SENTENCE THE READER CAN ACT ON. A control that silently
// does nothing is this page's cardinal sin, and notification permission has
// several ways to be unavailable that look identical from the outside: no
// service worker support, not installed to the Home Screen, already denied, or
// simply not yet asked. Each gets its own message, and the BUTTON only appears
// when pressing it can actually do something.
//
// The iOS rule is stated rather than discovered: Web Push there works only from
// a Home-Screen app, so a visitor in Safari is told to install rather than left
// with a button that no-ops.
const NOTIFY_JS = `// Front Desk notification opt-in. Generated by src/worker.js; do not edit in place.
(function () {
  var box = document.getElementById("notify");
  var msg = document.getElementById("notify-state");
  var btn = document.getElementById("notify-btn");
  if (!box || !msg || !btn) return;

  // Substituted per request by src/worker.js. Empty means no keypair is
  // configured on this deploy — see the CONFIGURED branch below.
  var VAPID_PUBLIC_KEY = "__VAPID_PUBLIC_KEY__";

  function show(text, withButton) {
    box.hidden = false;
    msg.textContent = text;
    btn.hidden = !withButton;
  }

  // applicationServerKey wants raw bytes, not the base64url string the rest of
  // VAPID is written in.
  function keyBytes(s) {
    var b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
    var out = new Uint8Array(b.length);
    for (var i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
    return out;
  }

  // Subscribe if this device has not already, then hand the subscription to the
  // origin. getSubscription() first because re-subscribing an already-subscribed
  // device returns the same endpoint, and POSTing it again is a wasted round
  // trip rather than a second device.
  function subscribeAndStore(reg) {
    return reg.pushManager.getSubscription().then(function (existing) {
      if (existing) return existing;
      return reg.pushManager.subscribe({
        // Required, and iOS refuses the subscription without it: every push we
        // send must result in a visible notification.
        userVisibleOnly: true,
        applicationServerKey: keyBytes(VAPID_PUBLIC_KEY),
      });
    }).then(function (sub) {
      return fetch("/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(sub),
      }).then(function (res) {
        if (!res.ok) throw new Error("the board did not accept this device (HTTP " + res.status + ")");
        return sub;
      });
    });
  }

  if (!("serviceWorker" in navigator) || !("Notification" in window) || !("PushManager" in window)) {
    show("This browser cannot deliver web notifications.", false);
    return;
  }

  // iOS grants Web Push only to a Home-Screen app. standalone is the reliable
  // tell; display-mode covers the browsers that report it properly.
  var installed = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  var iOSish = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
               (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (iOSish && !installed) {
    show("On iPhone and iPad, notifications work only once this page is added to the Home Screen. Share \u2192 Add to Home Screen, then open it from there.", false);
    return;
  }

  // NO KEYPAIR ON THIS DEPLOY. Said plainly rather than offering a button that
  // would fail inside pushManager.subscribe() with a DOMException naming
  // applicationServerKey — accurate, and meaningless to the person reading it.
  if (!VAPID_PUBLIC_KEY) {
    show("Notifications are not switched on for this deployment yet \u2014 no signing key is configured.", false);
    return;
  }

  if (Notification.permission === "granted") {
    // Permission is not a subscription, and this is the branch where they come
    // apart: a device that granted permission before the sender existed has one
    // and not the other, and would otherwise sit here reading "enabled" forever
    // while receiving nothing. Subscribing is idempotent, so this is safe to run
    // on every load.
    navigator.serviceWorker.register("/sw.js").then(subscribeAndStore).then(function () {
      show("Notifications are enabled for this device.", false);
    }).catch(function (e) {
      show("Notifications are permitted, but this device is not subscribed: " + e.message, false);
    });
    return;
  }
  if (Notification.permission === "denied") {
    // Not re-promptable: the browser will ignore requestPermission() from here
    // on, so offering the button would be offering a no-op.
    show("Notifications are blocked for this site in your browser settings. They have to be re-enabled there.", false);
    return;
  }

  show("Get told when the board changes \u2014 what is claimed, and what is open.", true);
  btn.addEventListener("click", function () {
    btn.disabled = true;
    Notification.requestPermission().then(function (result) {
      if (result !== "granted") {
        show("Permission was not granted, so nothing will be sent.", false);
        return;
      }
      return navigator.serviceWorker.register("/sw.js").then(subscribeAndStore).then(function () {
        show("Notifications are on for this device.", false);
      });
    }).catch(function (e) {
      show("Could not enable notifications: " + e.message, false);
      btn.disabled = false;
    });
  });
})();
`;

/** Hostnames, and the env var that may override each for a preview or a rename. */
const HOSTS = {
  issues: { env: "ISSUES_HOST", default: "issues.bounded.tools" },
  claims: { env: "CLAIMS_HOST", default: "claims.bounded.tools" },
  prs: { env: "PRS_HOST", default: "prs.bounded.tools" },
};

/** Seconds the rendered page may be reused at the edge. */
const EDGE_TTL = 60;

// CSP IS PER SURFACE, NOT GLOBAL (#766).
//
// claims/issues/prs stay exactly as they were: entirely self-contained, no
// scripts, no external assets. `desk` needs script to be an installable app at
// all — iOS serves Web Push only to a Home-Screen app backed by a manifest AND a
// registered service worker, and a service worker is script. So desk, and only
// desk, gets `script-src 'self'`.
//
// Scoping it this way is the direction the maintainer set — "JavaScript on
// select domains like desk, be specific about which and from where" — and it is
// the same reasoning `boot` used when it took the STRICTEST of the six policies
// rather than copying a sibling's: choose a policy per surface, do not propagate
// one. Four surfaces share this Worker, so a single header here would have
// silently granted script to all four.
//
// 'self' ONLY. No CDN, no inline: the service worker and its registration are
// served from this origin, so nothing else needs to be allowed, and `'unsafe-
// inline'` for script is never introduced. `connect-src 'self'` is what lets the
// registration talk to this origin; the push SUBSCRIPTION endpoint lives at the
// browser's push service, which is reached by the service worker rather than by
// page script and so needs no grant here.
const CSP_STATIC =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'";
const CSP_APP =
  "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; " +
  "connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'";

const html = (body, status, ttl, surface = null) =>
  new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": status === 200 ? `public, max-age=${ttl}` : "no-store",
      "content-security-policy": surface === "overview" ? CSP_APP : CSP_STATIC,
      "referrer-policy": "strict-origin-when-cross-origin",
      "x-content-type-options": "nosniff",
    },
  });

const json = (body, status, ttl) =>
  new Response(JSON.stringify(body, null, 2) + "\n", {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": status === 200 ? `public, max-age=${ttl}` : "no-store",
    },
  });

/** Which page this request is for. Unknown hosts get the front door. */
function surfaceFor(hostname, env) {
  for (const [name, h] of Object.entries(HOSTS)) {
    if (hostname === (env[h.env] || h.default)) return name;
  }
  return "overview";
}

/**
 * Fetch one feed. Returns `{ ok: true, value }` or `{ ok: false, reason }` —
 * never throws, because the overview needs a failure it can RENDER rather than
 * one that takes the whole page down.
 */
async function readFeed(url, what) {
  if (!url) return { ok: false, reason: `${what} is not configured for this Worker.` };
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json", "user-agent": "bounded-systems-desk" },
      // Collapse the stampede: many readers in the same minute cost one origin
      // read, and the rendered page is cached for the same window anyway.
      cf: { cacheTtl: EDGE_TTL, cacheEverything: true },
    });
    if (!res.ok) return { ok: false, reason: `feed responded ${res.status} ${res.statusText}` };
    return { ok: true, value: await res.json() };
  } catch (err) {
    return { ok: false, reason: `feed unreachable: ${err.message}` };
  }
}

/**
 * Run a selector over a feed outcome, keeping the outcome shape.
 *
 * A FeedError is the guard doing its job (wrong feed, undatable snapshot);
 * anything else is a bug here. Both are "cannot stand behind this", so both fail
 * closed — but they stay distinguishable in the reason line, because "the feed
 * is the wrong one" and "this code threw" send you to different places.
 */
function selected(feed, fn) {
  if (!feed.ok) return feed;
  try {
    return { ok: true, value: fn(feed.value) };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof FeedError ? err.message : `unexpected: ${err.message}`,
    };
  }
}

// The public half of the VAPID keypair, substituted into the served script.
//
// Its ABSENCE is a supported state, not a broken one: this Worker deploys
// before the keypair exists, and a page that offered a notification button
// against no key would fail inside pushManager.subscribe() with a DOMException
// about applicationServerKey. Empty here makes the script say so in a sentence
// instead.
export function notifyScript(env) {
  return NOTIFY_JS.replace("__VAPID_PUBLIC_KEY__", env.VAPID_PUBLIC_KEY || "");
}

/** Longest subscribe body worth reading — a real one is a few hundred bytes. */
const MAX_SUBSCRIBE_BODY = 4096;

/**
 * Take one device's subscription.
 *
 * Every refusal names what is missing, because the caller is our own script and
 * a 400 it cannot explain surfaces to the reader as "this device is not
 * subscribed" with no way to find out why.
 */
export async function handleSubscribe(request, env) {
  const no = (status, error) =>
    new Response(JSON.stringify({ error }) + "\n", {
      status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });

  // The store is a binding, and bindings are configuration — an absent one is
  // this Worker's own fault, so it is a 503 rather than a 4xx blaming the
  // device. 503 is also what tells the script to report honestly rather than
  // claim the device is on.
  if (!env.SUBSCRIPTIONS) return no(503, "no subscription store is configured on this deployment");
  if (!env.VAPID_PUBLIC_KEY) return no(503, "no signing key is configured on this deployment");

  const body = await request.text();
  if (body.length > MAX_SUBSCRIBE_BODY) return no(413, "subscription too large");
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return no(400, "body is not JSON");
  }
  const checked = validateSubscription(parsed);
  if (!checked.ok) return no(400, checked.error);

  await putSubscription(env.SUBSCRIPTIONS, checked.value);
  return new Response(JSON.stringify({ ok: true }) + "\n", {
    status: 201,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}


/**
 * Fan out to every subscribed device.
 *
 * AUTHORIZED BY A GITHUB ACTIONS OIDC TOKEN, not a shared secret — see
 * src/oidc.js for why. The token is minted per run, expires in minutes, and is
 * pinned to one workflow at one ref, so there is no standing credential here to
 * leak or rotate.
 *
 * Returns the census rather than 204, because "sent 0 of 0" and "sent 0 of 12"
 * are different facts and the caller's job summary is where anyone would notice
 * the difference.
 */
export async function handleNotify(request, env) {
  const no = (status, error) =>
    new Response(JSON.stringify({ error }) + "\n", {
      status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });

  if (!env.SUBSCRIPTIONS) return no(503, "no subscription store is configured on this deployment");
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
    return no(503, "no signing keypair is configured on this deployment");
  }
  if (!env.VAPID_SUBJECT) return no(503, "no VAPID subject contact is configured on this deployment");

  const auth = request.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return no(401, "an Actions OIDC bearer token is required");
  try {
    await verifyNotifyCaller(token);
  } catch (e) {
    // 403 rather than 401: the token was read and rejected. A caller that
    // cannot tell "no token" from "wrong workflow" debugs the wrong half.
    return no(403, `caller not authorized: ${e.message}`);
  }

  let key;
  try {
    key = await importVapidKey(env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  } catch (e) {
    // A mismatched pair fails here rather than as a 401 from every push service
    // an hour later — which would look exactly like a dead subscription list.
    return no(503, `the configured VAPID keypair is unusable: ${e.message}`);
  }

  const census = await notifyAll(env.SUBSCRIPTIONS, {
    publicKey: env.VAPID_PUBLIC_KEY,
    key,
    subject: env.VAPID_SUBJECT,
  });
  return new Response(JSON.stringify(census, null, 2) + "\n", {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}


/**
 * Record an approval request and fan it out (#51).
 *
 * Same OIDC door as /notify — the caller is a pinned workflow, not a secret —
 * and deliberately the same fan-out, so an approval reaches exactly the devices
 * a board change would. What differs is only that /pending now has something to
 * say when the worker wakes.
 */
export async function handleApproval(request, env) {
  const no = (status, error) =>
    new Response(JSON.stringify({ error }) + "\n", {
      status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });

  if (!env.SUBSCRIPTIONS) return no(503, "no subscription store is configured on this deployment");

  const auth = request.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return no(401, "an Actions OIDC bearer token is required");
  try {
    await verifyNotifyCaller(token);
  } catch (e) {
    return no(403, `caller not authorized: ${e.message}`);
  }

  const body = await request.text();
  if (body.length > 4096) return no(413, "approval too large");
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return no(400, "body is not JSON");
  }
  const checked = validateApproval(parsed);
  if (!checked.ok) return no(400, checked.error);

  // RECORD BEFORE SENDING. A push whose /pending is still empty renders the
  // board default — the reader is told the board changed when what actually
  // happened is that someone needs a Face ID.
  await putApproval(env.SUBSCRIPTIONS, checked.value);

  return await handleNotify(request, env);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ── the one write this Worker accepts (#37) ─────────────────────────────
    //
    // Ahead of the method gate below, because that gate is otherwise correct:
    // every other surface here is a read, and a board that accepted writes
    // generally would be a different kind of thing. This is the exception, so
    // it is spelled out as one rather than by loosening the rule.
    //
    // desk ONLY, and the surface check is not a formality: claims/issues/prs
    // serve no notify.js and have no reason to take a subscription, so an
    // endpoint answering there could only be something else's mistake.
    if (url.pathname === "/subscribe" && request.method === "POST") {
      if (surfaceFor(url.hostname, env) !== "overview") {
        return new Response("not found\n", { status: 404, headers: { "cache-control": "no-store" } });
      }
      return await handleSubscribe(request, env);
    }

    // Record an approval request, then fan out (#51). Same door as /notify.
    if (url.pathname === "/approval" && request.method === "POST") {
      if (surfaceFor(url.hostname, env) !== "overview") {
        return new Response("not found\n", { status: 404, headers: { "cache-control": "no-store" } });
      }
      return await handleApproval(request, env);
    }

    // The fan-out trigger (#37). Same surface rule, same reason.
    if (url.pathname === "/notify" && request.method === "POST") {
      if (surfaceFor(url.hostname, env) !== "overview") {
        return new Response("not found\n", { status: 404, headers: { "cache-control": "no-store" } });
      }
      return await handleNotify(request, env);
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
    }
    // A liveness probe that does NOT touch the feed, so "is the worker up" and
    // "is the board readable" stay separately answerable.
    if (url.pathname === "/healthz") {
      return new Response("ok\n", { status: 200, headers: { "cache-control": "no-store" } });
    }

    const surface = surfaceFor(url.hostname, env);

    // ── The installable-app surface, desk only (#766) ────────────────────────
    //
    // These must be matched BEFORE the catch-all below, and that ordering is the
    // whole bug they fix: every path fell through to the page, so
    // /manifest.json, /sw.js and /service-worker.js all answered 200 with
    // text/html. A 200 that returns the wrong content type is worse than a 404 —
    // a check that only looks at the status reads the asset as present, which is
    // exactly how this went unnoticed.
    //
    // desk ONLY. claims/issues/prs are read-only boards with no reason to be
    // installable, and serving them a manifest would offer an install prompt for
    // a page that gains nothing from it.
    if (surface === "overview") {
      if (url.pathname === "/manifest.webmanifest") {
        return new Response(JSON.stringify(MANIFEST, null, 2) + "\n", {
          headers: {
            // The registered type. Serving a manifest as application/json works
            // in some browsers and not others; naming it correctly costs
            // nothing and removes a class of "works on my device".
            "content-type": "application/manifest+json; charset=utf-8",
            "cache-control": "public, max-age=3600",
            "x-content-type-options": "nosniff",
          },
        });
      }
      if (url.pathname === "/notify.js") {
        return new Response(notifyScript(env), {
          headers: {
            "content-type": "text/javascript; charset=utf-8",
            "cache-control": "public, max-age=300",
            "x-content-type-options": "nosniff",
          },
        });
      }
      // The icons (#51). desk has no static-assets pipeline, so they are served
      // from the bundle. Immutable for a year: the bytes only change when the
      // mark does, and a stale icon on a Home Screen is very hard to clear.
      if (url.pathname === "/icon.svg") {
        return new Response(AVATAR_SVG, {
          headers: {
            "content-type": "image/svg+xml; charset=utf-8",
            "cache-control": "public, max-age=31536000, immutable",
            "x-content-type-options": "nosniff",
          },
        });
      }
      const icon = url.pathname.match(/^\/icon-(460|1024)\.png$/);
      if (icon) {
        return new Response(iconBytes(ICON_PNGS[icon[1]]), {
          headers: {
            "content-type": "image/png",
            "cache-control": "public, max-age=31536000, immutable",
            "x-content-type-options": "nosniff",
          },
        });
      }
      // What the service worker fetches on wake (#51). Public and no-store: it
      // carries only what a notification will display, and the notification is
      // already going to every subscribed device. NOT the store, NOT the keys.
      if (url.pathname === "/pending") {
        return json(await pending(env.SUBSCRIPTIONS), 200, 0);
      }
      if (url.pathname === "/sw.js") {
        return new Response(SERVICE_WORKER, {
          headers: {
            "content-type": "text/javascript; charset=utf-8",
            // NO-STORE, deliberately. A stale service worker outlives a deploy
            // and keeps serving old behaviour to an installed app, which is the
            // hardest kind of staleness to notice or to clear from the outside.
            // The browser re-checks it on its own schedule; do not also cache it.
            "cache-control": "no-store",
            // Default scope is the directory the script is served from, so a
            // root-served worker already controls the whole origin. Stated
            // explicitly so a later move into /static/ does not silently narrow
            // it.
            "service-worker-allowed": "/",
            "x-content-type-options": "nosniff",
          },
        });
      }
    }

    // THE APP-SHELL PATHS 404 ON THE STATIC HOSTS (#51). desk got this right in
    // #766; the other three never did, and every path on them still falls
    // through to the board — so /manifest.webmanifest, /sw.js and now
    // /icon-192.png each answer 200 with text/html. That is the failure #766's
    // own comment names: "a 200 that returns the wrong content type is worse
    // than a 404 — a check that only looks at the status reads the asset as
    // present". A browser asked to install from issues.bounded.tools would parse
    // a page as a manifest.
    if (/^\/(manifest\.webmanifest|sw\.js|notify\.js|icon\.svg|icon-(460|1024)\.png)$/.test(url.pathname)) {
      return new Response("not found\n", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      });
    }

    const wantsJson = url.pathname === "/board.json";
    const limit = Number(env.DESK_LIMIT) > 0 ? Number(env.DESK_LIMIT) : DEFAULT_LIMIT;

    // ── the front door: all three, each fetched and judged on its own ────────
    if (surface === "overview") {
      // No destination is baked in: where the filtered feeds are published is a
      // maintainer decision (see site#241), so they arrive as configuration and
      // an absent one is reported rather than guessed at.
      const [board, prsFeed] = await Promise.all([
        readFeed(env.FEED_URL, "FEED_URL"),
        readFeed(env.PRS_FEED_URL, "PRS_FEED_URL"),
      ]);
      // Both issue-side sections read the SAME feed — one origin read, and the
      // two pages can never disagree about which snapshot they are describing.
      const overview = selectOverview({
        issues: selected(board, (f) => select(f, limit)),
        claims: selected(board, selectClaims),
        prs: selected(prsFeed, selectPrs),
      });
      const status = overview.ok ? 200 : 502;
      return wantsJson
        ? json(overview, status, EDGE_TTL)
        : html(renderOverview(overview, Date.now(), EDGE_TTL), status, EDGE_TTL, "overview");
    }

    // ── a single-question host ───────────────────────────────────────────────
    const feedVar = surface === "prs" ? "PRS_FEED_URL" : "FEED_URL";
    const feed = await readFeed(env[feedVar], feedVar);
    const outcome = selected(
      feed,
      surface === "issues" ? (f) => select(f, limit) : surface === "claims" ? selectClaims : selectPrs,
    );

    if (!outcome.ok) {
      // A missing config is the Worker's own fault (503); an unreadable or wrong
      // feed is upstream (502). Both render the same page — it is the reason
      // line that tells them apart, and a reader who cannot see the status still
      // gets the sentence.
      const status = env[feedVar] ? 502 : 503;
      return wantsJson
        ? json({ error: outcome.reason }, status, EDGE_TTL)
        : html(renderUnavailable(outcome.reason), status, EDGE_TTL);
    }

    // JSON for anything that would rather read the board than look at it.
    if (wantsJson) return json(outcome.value, 200, EDGE_TTL);

    const render =
      surface === "issues" ? renderIssues : surface === "claims" ? renderClaims : renderPrs;
    return html(render(outcome.value, Date.now(), EDGE_TTL), 200, EDGE_TTL);
  },
};
