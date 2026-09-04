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
  selectCi,
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
  renderOffline,
  renderHuman,
  renderQueue,
} from "./render.js";
import { validateSubscription, putSubscription } from "./subscriptions.js";
import { notifyAll } from "./notify.js";
import { importVapidKey } from "./push.js";
import { verifyNotifyCaller } from "./oidc.js";
import { AVATAR_SVG, ICON_PNGS, iconBytes } from "./icons.js";
import { FOREST } from "./tokens.js";
import { validateApproval, putApproval, pending, pendingApprovals, ceremonyIdFrom } from "./pending.js";
import {
  activate,
  clearedCookie,
  currentCredential,
  endSessions,
  loginFinish,
  loginStart,
  mayViewQueue,
  registerFinish,
  registerStart,
  revokeCredential,
} from "./login.js";
import {
  validateQuestion,
  putQuestion,
  getQuestion,
  questionViews,
  viewOf,
  answerQuestion,
  mayAnswer,
  mayList,
} from "./questions.js";

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
  // A STABLE IDENTITY, independent of start_url. Without `id` the identity IS
  // start_url, so changing where the app opens later would make every launcher
  // treat it as a different app — orphaning installs rather than updating them.
  // It is a bare string, never a URL to fetch.
  id: "/",
  start_url: "/",
  scope: "/",
  display: "standalone",
  // Matches the page's own light/dark grounds in render.js. A mismatch here is
  // visible as a flash of the wrong colour on launch.
  // THE SPLASH IS THE BRAND GREEN, not the page background, and that is a
  // deliberate choice rather than an oversight. background_color paints the
  // launch screen and CANNOT be media-queried — one value serves both schemes.
  // Using the light page colour meant a dark-mode launch flashed #fbfaf8 before
  // the dark page painted. The green matches the icon plate and theme_color, so
  // the launch reads as the app opening rather than as a page loading, and it is
  // wrong in neither scheme instead of right in one.
  // FOREST, not a literal: this is the same value the icon plate carries and the
  // same one icons.test.mjs pins the avatar to, so it has to come from the same
  // place the avatar's bytes do (src/tokens.js, generated from the brand
  // package). It was the ONE colour desk had already transcribed correctly —
  // which is the argument for the change rather than against it, since nothing
  // said so and nothing would have noticed the day it stopped being true.
  background_color: FOREST,
  theme_color: FOREST,
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
  // PNG FIRST, and that ordering is the fix rather than a preference. iOS reads
  // this list for an installed app and CANNOT render an SVG icon; offering the
  // vector first is how a phone ends up with no icon at all and falls back to
  // the first letter of the name. Everything that understands SVG will still
  // pick it — a browser chooses the best match, not the first entry — so
  // leading with the raster costs nothing and stops the one client that has no
  // fallback from having none.
  icons: [
    { src: "/icon-200.png", sizes: "200x200", type: "image/png", purpose: "any maskable" },
    { src: "/icon-1024.png", sizes: "1024x1024", type: "image/png", purpose: "any maskable" },
    { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" },
  ],

  // Long-press the icon. SAME-ORIGIN ANCHORS, not the other hosts: a shortcut
  // outside `scope` is silently ignored, and issues/claims/prs are separate
  // origins. So these jump to the overview's own sections, each of which links
  // on to its host — one tap further, and it actually works.
  shortcuts: [
    { name: "Issues — what to pick up", short_name: "Issues", url: "/#issues" },
    { name: "Claims — what is spoken for", short_name: "Claims", url: "/#claims" },
    { name: "PRs — what awaits a check", short_name: "PRs", url: "/#prs" },
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

// THE ONE THING THIS CACHES, and it is deliberately not the board.
//
// Caching the board would serve a stale one from an installed app with no
// staleness banner to warn about it — reintroducing offline exactly the defect
// the live Worker exists to remove. So the cache holds a single page that says
// the board could not be read, and holds nothing else, ever.
//
// Without it an offline launch shows the browser's own error page: an app that
// looks broken rather than one that is telling you something. Failing closed in
// its own words is the same thing every stamp on this board does.
const SHELL = "front-desk-offline-v1";

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    // THE OFFLINE PAGE MUST NOT BE ABLE TO BLOCK PUSH (#60). This awaited a
    // single fetch, so one failed /offline rejected install, the worker never
    // activated, and every wait on an active worker hung forever — a dead
    // enable button with no message, which is this page's cardinal sin.
    // The cache is a nicety; activating is the contract.
    try {
      const c = await caches.open(SHELL);
      await c.add("/offline");
    } catch (_) {
      // No offline page this round. The fetch handler already answers a cache
      // miss with a 503 that says so, so the app degrades to that sentence
      // instead of failing to exist.
    }
    await self.skipWaiting();
  })());
});
self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    // Drop any older shell, so a renamed cache does not accumulate.
    for (const k of await caches.keys()) if (k !== SHELL) await caches.delete(k);
    await self.clients.claim();
  })());
});

// NAVIGATIONS ONLY. Every other request — the feed reads, /pending, the icons —
// goes straight to the network untouched, because a cached answer to any of them
// is a stale answer this app has no way to caveat.
self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;
  event.respondWith((async () => {
    try {
      return await fetch(event.request);
    } catch (_) {
      return (await caches.match("/offline")) ||
        new Response("Offline, and the offline page is missing too.", {
          status: 503, headers: { "content-type": "text/plain; charset=utf-8" },
        });
    }
  })());
});

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

    // TELL ANY OPEN PAGE TO REFRESH. Without this the notification says the
    // board changed and the board sitting in front of the reader still does
    // not — the page is server-rendered once and nothing polls, so an installed
    // app left open shows whatever it loaded, indefinitely.
    const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of open) c.postMessage({ type: "front-desk:refresh" });
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

  // ── KEEPING THE PAGE HONEST WHILE IT SITS OPEN ─────────────────────────────
  //
  // The board is rendered once, server-side, and nothing here polled. An
  // installed app left open therefore showed whatever it loaded — so a
  // notification could say the board changed while the board in front of the
  // reader still did not, which is worse than not notifying: it makes the page
  // look authoritative and stale at the same moment.
  //
  // Two triggers, because they cover different absences:
  //   1. The service worker messages us when a push arrives — the app is open
  //      and the board just moved.
  //   2. Coming back to a backgrounded app, if what is on screen is older than
  //      the edge TTL it was served under. A push may never have arrived (the
  //      device was off, or nobody is subscribed) and the page is still stale.
  //
  // Reload rather than patch the DOM: the page IS the render, so re-fetching it
  // is the whole update and there is no second code path to keep in agreement
  // with the server's.
  var loadedAt = Date.now();
  var STALE_MS = 60000; // matches the page's own cache-control: max-age=60

  function refresh(why) {
    if (document.visibilityState !== "visible") return;
    console.info("front-desk: reloading (" + why + ")");
    location.reload();
  }

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", function (e) {
      if (e.data && e.data.type === "front-desk:refresh") refresh("push");
    });
  }

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible" && Date.now() - loadedAt > STALE_MS) {
      refresh("returned to a stale page");
    }
  });

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

  // REGISTERED IS NOT ACTIVE, and that gap is the whole of #60.
  // navigator.serviceWorker.register() resolves as soon as the REGISTRATION
  // exists; its worker may still be 'installing'. pushManager.subscribe()
  // requires an ACTIVE worker, so subscribing straight off the registration
  // threw "Subscribing for push requires an active service worker" and NO NEW
  // DEVICE could ever turn notifications on. It went unnoticed because a device
  // that had registered on any earlier visit already had an active worker: the
  // bug is invisible to everyone who already has the thing it fails to wait for.
  //
  // NOT navigator.serviceWorker.ready: that never settles when install rejects,
  // and a promise that never settles is the dead button with no message. This
  // waits on the worker we were handed, and gives up out loud.
  var ACTIVATION_TIMEOUT_MS = 10000;
  function activated(reg) {
    return new Promise(function (resolve, reject) {
      if (reg.active) return resolve(reg);
      var sw = reg.installing || reg.waiting;
      if (!sw) return reject(new Error("the browser registered the service worker but produced no worker"));
      var done = false;
      function settle(fn, arg) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        sw.removeEventListener("statechange", onChange);
        fn(arg);
      }
      var timer = setTimeout(function () {
        settle(reject, new Error("the service worker did not finish installing in time"));
      }, ACTIVATION_TIMEOUT_MS);
      function onChange() {
        if (sw.state === "activated") settle(resolve, reg);
        else if (sw.state === "redundant") settle(reject, new Error("the service worker failed to install"));
      }
      sw.addEventListener("statechange", onChange);
      // The state can already have moved between the check above and the
      // listener going on; re-read rather than wait for an event that fired.
      onChange();
    });
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
    navigator.serviceWorker.register("/sw.js").then(activated).then(subscribeAndStore).then(function () {
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
      return navigator.serviceWorker.register("/sw.js").then(activated).then(subscribeAndStore).then(function () {
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

/**
 * A response for something a COOKIE gated.
 *
 * `json()`/`html()` above emit `public, max-age=<ttl>` on every 200 and set no
 * `Vary`, which is correct for a board every reader sees the same version of and
 * wrong for anything a session decides the contents of: a shared cache would
 * hand one reader's queue to the next. So gated content gets its own builder —
 * `no-store`, `Vary: cookie` — rather than a mutation of the shared one, which
 * would also have moved the public board's caching (a committed test pins
 * `public, max-age=0` on the question card, which is NOT gated: a question stays
 * readable at its own address).
 */
const priv = (body, status, type, extra = {}) =>
  new Response(body, {
    status,
    headers: {
      "content-type": type,
      "cache-control": "no-store",
      "vary": "cookie",
      "referrer-policy": "strict-origin-when-cross-origin",
      "x-content-type-options": "nosniff",
      ...extra,
    },
  });

const privJson = (body, status, extra = {}) =>
  priv(JSON.stringify(body, null, 2) + "\n", status, "application/json; charset=utf-8", extra);

const privHtml = (body, status, extra = {}) =>
  priv(body, status, "text/html; charset=utf-8", { "content-security-policy": CSP_APP, ...extra });

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

/** Longest question worth reading. Its own constant: /approval hardcodes 4096
 * and /subscribe names its own, so there is no shared limit to inherit — and a
 * prompt plus a choice set is a different budget from a push subscription. */
const MAX_QUESTION_BODY = 4096;

/** Longest login body worth reading — an attestationObject is ~1KB of base64url. */
const MAX_LOGIN_BODY = 8192;

/**
 * `/human`, `/human.json`, `/human/<id>`, `/human/<id>.json` — and nothing else.
 *
 * Every other route in this Worker is a pathname EQUALITY, which a question
 * address cannot be: the id is in the path. So this is the one match that has
 * to be a regex, and it is anchored at both ends and restricted to the minted
 * id charset so it can never swallow `/human` itself, `/human/<id>/answer`, or
 * a path added later.
 */
const RE_HUMAN = /^\/human(?:\/([A-Za-z0-9_-]{1,64}))?(\.json)?$/;
function matchHuman(pathname) {
  const m = RE_HUMAN.exec(pathname);
  return m ? { id: m[1] ?? null, json: Boolean(m[2]) } : null;
}

/** The answer route. Separate pattern, so `/human/<id>` cannot reach it. */
const RE_HUMAN_ANSWER = /^\/human\/([A-Za-z0-9_-]{1,64})\/answer$/;

/**
 * The login routes (desk#65). An EXPLICIT list, not `/login/*`: a pattern that
 * matched anything under /login would send an unknown path to the dispatcher and
 * make "which door is this" a question answered twice.
 */
const RE_LOGIN = /^\/login\/(register\/start|register\/finish|activate|start|finish|revoke|logout)$/;

/**
 * Ask a person something, and exit (#69).
 *
 * Same OIDC door as /approval and /notify — the caller is a pinned lane, not a
 * secret — and deliberately NOT the same rung. An approval names a ceremony a
 * keyholder completes; this names a question, and what comes back is
 * information. Nothing here is spendable as an authorization.
 *
 * WHY THIS DOES NOT SIMPLY `return handleNotify(...)` THE WAY /approval DOES.
 * The caller needs the id and the address a person will answer at, and those
 * are not in the fan-out census. And a push that could not leave does not
 * un-ask the question: the record is already durable by then, so a VAPID
 * misconfiguration is reported as a field rather than as this route's status,
 * which would tell the lane its question was refused when it was not.
 */
export async function handleQuestion(request, env) {
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
  if (body.length > MAX_QUESTION_BODY) return no(413, "question too large");
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return no(400, "body is not JSON");
  }
  const checked = validateQuestion(parsed);
  if (!checked.ok) return no(400, checked.error);

  // RECORD BEFORE SENDING, for the same reason /approval does: a push whose
  // /pending is still empty tells the reader the board changed.
  const rec = await putQuestion(env.SUBSCRIPTIONS, checked.value);

  const fan = await handleNotify(request, env);
  const census = await fan.json();
  return new Response(
    JSON.stringify(
      {
        id: rec.id,
        url: rec.url,
        deadline: rec.deadline,
        no_answer_policy: rec.no_answer_policy,
        // Reported, not conflated: the question is on file either way.
        notified: fan.status === 200 ? census : { error: census.error, status: fan.status },
      },
      null,
      2,
    ) + "\n",
    { status: 201, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } },
  );
}

/**
 * THE LOGIN DOOR (desk#65) — seven POSTs, one dispatcher.
 *
 * A DIFFERENT DOOR from /notify, /approval and /human's ask side. Those verify a
 * GitHub Actions OIDC token, which authenticates a WORKFLOW AT A REF and has no
 * claim shape in it for a person; this authenticates a person's passkey. Neither
 * opens the other, and there is no path here that consults `verifyNotifyCaller`.
 *
 * WHAT EACH ONE IS:
 *   register/start, register/finish  anyone may register; what they get is a
 *                                    PENDING credential that can do nothing.
 *   activate                         redeems a keeper grant; pending → live.
 *                                    The one door that grants any authority, and
 *                                    the keeper is what decides it.
 *   start, finish                    the login ceremony itself.
 *   revoke                           live → revoked. Behind a live session, so
 *                                    it needs no keeper and stays reachable in
 *                                    the incident where it is wanted.
 *   logout                           clears the cookie. Nothing to consult.
 *
 * Bodies are read only after the route is resolved and, for revoke, only after
 * the session is — the same ordering `handleAnswer` states: a door that is shut
 * should not be able to store anything a caller sent it.
 */
export async function handleLogin(request, env, which) {
  const no = (status, error, extra = {}) =>
    new Response(JSON.stringify({ error }) + "\n", {
      status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
    });
  const yes = (status, value, extra = {}) =>
    new Response(JSON.stringify(value, null, 2) + "\n", {
      status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
    });

  // LOGOUT FIRST, ABOVE THE STORE GUARD -- the comment below used to sit under
  // that guard and was therefore false (desk#65 review). Clearing a cookie needs
  // nothing, and a deployment with no credential store must still let a person
  // drop their own session.
  if (which === "logout") {
    // Best effort: invalidates every cookie for this credential by bumping its
    // epoch. If the store is absent or the write fails, the cookie is still
    // cleared -- see endSessions for why that failure direction is the right one.
    if (env.SUBSCRIPTIONS) {
      const who = await currentCredential(request, env);
      if (who.ok) await endSessions(env.SUBSCRIPTIONS, who.credential.credentialId);
    }
    return yes(200, { ok: true }, { "set-cookie": clearedCookie() });
  }

  if (!env.SUBSCRIPTIONS) return no(503, "no credential store is configured on this deployment");

  // THE SESSION FIRST for revoke, before the body is read at all: a door that is
  // shut should not be able to store anything a caller sent it, which is the
  // ordering `handleAnswer` states and the reason this check is not further down
  // beside the call. A revoked credential cannot revoke, because this re-reads.
  if (which === "revoke") {
    const may = await mayViewQueue(request, env);
    if (!may.ok) return no(may.status, may.reason, may.clear ? { "set-cookie": clearedCookie() } : {});
  }

  let body = {};
  if (which !== "start") {
    const text = await request.text();
    if (text.length > MAX_LOGIN_BODY) return no(413, "login body too large");
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        return no(400, "body is not JSON");
      }
    }
  }

  let out;
  if (which === "register/start") out = await registerStart(env.SUBSCRIPTIONS, body);
  else if (which === "register/finish") out = await registerFinish(env.SUBSCRIPTIONS, body);
  else if (which === "activate") out = await activate(env.SUBSCRIPTIONS, body);
  else if (which === "start") out = await loginStart(env.SUBSCRIPTIONS, body);
  else if (which === "finish") out = await loginFinish(env.SUBSCRIPTIONS, body, env);
  else if (which === "revoke") out = await revokeCredential(env.SUBSCRIPTIONS, body.credentialId);
  else return no(404, "not found");

  if (!out.ok) return no(out.status, out.reason);
  return yes(out.status, out.value, out.cookie ? { "set-cookie": out.cookie } : {});
}

/**
 * THE PENDING-APPROVALS QUEUE (desk#65's actual ask), behind the login.
 *
 * WHAT IT IS FOR: /pending names ONE thing, because a phone gets one thing. That
 * is right for a notification and useless for a person who wants to know what is
 * outstanding. This is the whole set, and `pendingApprovals()` already returns
 * it — keyed, per-entry TTL, paged, newest first. Nothing new is stored.
 *
 * WHAT IT DELIBERATELY DOES NOT HAVE:
 *   NO "approve all". Rows 5-6 of the infra#555 chain — display → intent — are
 *   the weakest links in the ceremony, and one button that means yes to a set a
 *   person did not read is an attack on exactly those two.
 *   NO challenge material. Entries carry title, body and url, which is what
 *   pendingApprovals projects; reaching past it to the raw record would be the
 *   only way to leak more, and nothing here does.
 *   NO TTL extension, and no writes at all. The ceremony clocks belong to the
 *   keeper.
 *
 * Approving is still done AT THE KEEPER, under the other credential: each entry
 * is a link to keeper.bounded.tools/a/<id> and nothing else. The url is re-read
 * through `ceremonyIdFrom` on the way out — validateApproval already pins the
 * host on the way in and is untouched, but a link rendered to a person is worth
 * checking twice, and a record that does not name a keeper ceremony is dropped
 * rather than linked.
 */
async function selectQueue(request, env) {
  const may = await mayViewQueue(request, env);
  if (!may.ok) return { status: may.status, clear: may.clear, value: { kind: "closed", error: may.reason } };
  const approvals = (await pendingApprovals(env.SUBSCRIPTIONS)).filter((a) => ceremonyIdFrom(a.url));
  // APPROVALS ONLY. Questions are behind the same gate at /human, under
  // `mayList`, and folding them in here would make this route a second read path
  // for them — the thing #69's "one judgement, two renderings" exists to
  // prevent. Two kinds, two routes, one gate.
  return { status: 200, value: { kind: "queue", approvals } };
}

/**
 * Record a person's answer — BEHIND DESK LOGIN (desk#65).
 *
 * The seam is `mayAnswer`, one named predicate in questions.js, and it is
 * consulted BEFORE the body is read: a door that is shut should not be able to
 * store anything a caller sent it, even by accident.
 *
 * 401 now, where it was 501. The old status was right for the old reason — 401
 * invites a caller to present a credential, and there was none to present on any
 * deployment — and it inverts the moment one exists. The status comes from the
 * predicate rather than from reading its sentence: 403 is a credential that is
 * no longer live, which is a different thing to tell a person than "sign in".
 */
export async function handleAnswer(request, env, id) {
  const no = (status, error, extra = {}) =>
    new Response(JSON.stringify({ error }) + "\n", {
      status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
    });

  if (!env.SUBSCRIPTIONS) return no(503, "no subscription store is configured on this deployment");

  const may = await mayAnswer(request, env);
  // The STATUS comes from the predicate, not from string-matching its reason:
  // 401 with no session (there IS a credential to present now, which is exactly
  // why the old 501 was right then and wrong here), 403 with a credential that
  // is no longer live, 503 on a deployment that cannot check either. A refusal
  // that names a dead session also clears it, so the browser stops sending one.
  if (!may.ok) return no(may.status, may.reason, may.clear ? { "set-cookie": clearedCookie() } : {});

  const body = await request.text();
  if (body.length > MAX_QUESTION_BODY) return no(413, "answer too large");
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return no(400, "body is not JSON");
  }
  const done = await answerQuestion(env.SUBSCRIPTIONS, id, parsed);
  if (!done.ok) return no(done.status, done.error);
  return json(done.value, 200, 0);
}

/**
 * THE ONE JUDGEMENT behind both /human renderings.
 *
 * A person and an agent must never be able to disagree about whether a question
 * was answered or what the answer was, so there is one selection here and the
 * fork is at the return — the same shape the board's `wantsJson` fork has had
 * since #7. There is no agent-only store and no second read path.
 */
async function selectHuman(request, env, id, now) {
  const kv = env.SUBSCRIPTIONS;
  if (!kv) return { status: 503, value: { error: "no question store is configured on this deployment" } };
  if (id) {
    const rec = await getQuestion(kv, id);
    // 404 rather than an empty card: "answered", "unanswered" and "there is no
    // such question" are three different sentences.
    if (!rec) return { status: 404, value: { error: "no such question" } };
    return { status: 200, value: viewOf(rec, now) };
  }
  // The COLLECTION, behind desk login (desk#65) — see `mayList`. NOT an empty
  // list: "you may not read this" and "there are none" are different facts, and
  // answering 200 with `questions: []` would state the second while the first is
  // what is true. Refused before the store is touched, so a caller who may not
  // read the corpus cannot make us page it. The status is the predicate's — 401
  // when nothing was presented, which is now a sentence with a remedy in it.
  const may = await mayList(request, env);
  if (!may.ok) return { status: may.status, clear: may.clear, private: true, value: { kind: "closed", error: may.reason } };
  // Gated, so it is served no-store and Vary: cookie — see `priv` above. The
  // single question above is NOT: it stays readable at its own address.
  return { status: 200, private: true, value: { kind: "questions", questions: await questionViews(kv, now) } };
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

    // Ask a person something and exit (#69). Same door as /notify, and the same
    // surface rule for the same reason: the three static hosts serve no question
    // and have no person attached to them.
    if (url.pathname === "/human" && request.method === "POST") {
      if (surfaceFor(url.hostname, env) !== "overview") {
        return new Response("not found\n", { status: 404, headers: { "cache-control": "no-store" } });
      }
      return await handleQuestion(request, env);
    }

    // Answer one (#69). A DIFFERENT door — see `mayAnswer` in questions.js —
    // and behind desk login (desk#65). The surface check comes first anyway, so
    // a wrong-host caller learns nothing about either.
    const answering = request.method === "POST" ? RE_HUMAN_ANSWER.exec(url.pathname) : null;
    if (answering) {
      if (surfaceFor(url.hostname, env) !== "overview") {
        return new Response("not found\n", { status: 404, headers: { "cache-control": "no-store" } });
      }
      return await handleAnswer(request, env, answering[1]);
    }

    // The login doors (desk#65). Above the method gate for the reason the block
    // above states, and matched as ONE route with ONE surface guard rather than
    // six copies of it: six copies is six chances to leave one off, and a login
    // answering on issues/claims/prs would be a passkey prompt on a host that
    // has no person attached to it.
    const login = request.method === "POST" ? RE_LOGIN.exec(url.pathname) : null;
    if (login) {
      if (surfaceFor(url.hostname, env) !== "overview") {
        return new Response("not found\n", { status: 404, headers: { "cache-control": "no-store" } });
      }
      return await handleLogin(request, env, login[1]);
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
      // THE CONVENTIONAL ROOT PATHS. iOS looks for these when the <link> does not
      // resolve, and until now they fell through to the catch-all and answered
      // 200 with text/html — a page served as a PNG. Same wrong-content-type 200
      // #766 named, in the two paths a phone reaches for by name rather than by
      // markup, which is why the guard added for /manifest.webmanifest missed it.
      if (url.pathname === "/apple-touch-icon.png" || url.pathname === "/apple-touch-icon-precomposed.png") {
        return new Response(iconBytes(ICON_PNGS[200]), {
          headers: {
            "content-type": "image/png",
            "cache-control": "public, max-age=31536000, immutable",
            "x-content-type-options": "nosniff",
          },
        });
      }
      const icon = url.pathname.match(/^\/icon-(200|460|1024)\.png$/);
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
      // What the service worker shows when the network is gone. Served here
      // rather than inlined in the worker so it is one page with one style,
      // and so this route is testable like any other.
      if (url.pathname === "/offline") {
        return new Response(renderOffline(), {
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "public, max-age=300",
            "content-security-policy": CSP_APP,
            "x-content-type-options": "nosniff",
          },
        });
      }
      if (url.pathname === "/pending") {
        return json(await pending(env.SUBSCRIPTIONS), 200, 0);
      }
      // A question, or all of them (#69) — ONE selection, two renderings.
      //
      // ttl 0, like /pending above and for a sharper reason: a card cached for
      // EDGE_TTL keeps saying "waiting for a person" for a minute after a person
      // answered, and a human and an agent reading the same question a second
      // apart would then disagree about it. That is the one thing this route
      // must never allow.
      const human = matchHuman(url.pathname);
      if (human) {
        const sel = await selectHuman(request, env, human.id, Date.now());
        if (sel.private) {
          // A cookie decided this body, so it is never handed to a shared cache.
          const extra = sel.clear ? { "set-cookie": clearedCookie() } : {};
          return human.json
            ? privJson(sel.value, sel.status, extra)
            : privHtml(renderHuman(sel.value), sel.status, extra);
        }
        return human.json
          ? json(sel.value, sel.status, 0)
          : html(renderHuman(sel.value), sel.status, 0);
      }
      // The queue (desk#65). Same shape as /human: one selection, two renderings.
      if (url.pathname === "/queue" || url.pathname === "/queue.json") {
        const sel = await selectQueue(request, env);
        const extra = sel.clear ? { "set-cookie": clearedCookie() } : {};
        return url.pathname === "/queue.json"
          ? privJson(sel.value, sel.status, extra)
          : privHtml(renderQueue(sel.value), sel.status, extra);
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
    //
    // The /human paths join the list (#69), and they are matched by shape rather
    // than by name because a question address carries an id. Without this a
    // question URL would have three impostor resolutions — issues, claims and
    // prs would each answer 200 with their own board for it, which is the
    // wrong-content-type 200 above and a phishing-shaped one besides.
    //
    // The login and queue paths join it (desk#65) for the same reason and one
    // sharper: a /login/start that fell through would answer 200 with a board on
    // a host that is not the relying party, which is a page inviting a passkey
    // at an origin the credential was never scoped to.
    if (
      matchHuman(url.pathname) ||
      /^\/queue(\.json)?$/.test(url.pathname) ||
      /^\/login(\/|$)/.test(url.pathname) ||
      /^\/(manifest\.webmanifest|sw\.js|notify\.js|offline|icon\.svg|icon-(200|460|1024)\.png|apple-touch-icon(-precomposed)?\.png)$/.test(url.pathname)
    ) {
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
      const [board, prsFeed, ciFeed] = await Promise.all([
        readFeed(env.FEED_URL, "FEED_URL"),
        readFeed(env.PRS_FEED_URL, "PRS_FEED_URL"),
        // Repo health (desk#81): the conformance snapshot the standard's own
        // repo publishes. Fails closed per section like the other two.
        readFeed(env.CI_FEED_URL, "CI_FEED_URL"),
      ]);
      // Both issue-side sections read the SAME feed — one origin read, and the
      // two pages can never disagree about which snapshot they are describing.
      const overview = selectOverview({
        issues: selected(board, (f) => select(f, limit)),
        claims: selected(board, selectClaims),
        prs: selected(prsFeed, selectPrs),
        ci: selected(ciFeed, selectCi),
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
