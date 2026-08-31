// A browser small enough to hold, for the two scripts this Worker GENERATES.
//
// The notify tests around it are all greps over the served text, and a grep
// cannot see #60: `pushManager.subscribe(` is present whether or not anything
// waited for an active worker. So this runs the real served script instead.
//
// THE STUB IS BORN IN THE STATE THAT BREAKS THE BUG. A registration handed back
// already-active passes the broken code, which is exactly why this shipped — so
// `bornInstalling` starts with active: null and an 'installing' worker, and
// subscribe() enforces the browser's own precondition with the browser's own
// message. What it asserts is that our code respects that precondition; it is
// not evidence about what a real browser does, which is what the live check in
// docs/ is for.
import vm from "node:vm";

class FakeWorker extends EventTarget {
  constructor(state) { super(); this._state = state; }
  get state() { return this._state; }
  set state(v) { this._state = v; this.dispatchEvent(new Event("statechange")); }
}

/** A registration as a FIRST-EVER register() returns one: no active worker yet. */
export function bornInstalling(log = []) {
  const sw = new FakeWorker("installing");
  const reg = {
    log, installing: sw, waiting: null, active: null,
    pushManager: {
      getSubscription: async () => null,
      subscribe: async () => {
        if (!reg.active) throw new Error("Subscribing for push requires an active service worker");
        log.push("subscribe");
        return { endpoint: "https://push.example/dev", keys: { p256dh: "B", auth: "a" } };
      },
    },
    /** What the browser does once install resolves. */
    activate() { reg.installing = null; reg.active = sw; sw.state = "activated"; },
    /** What it does when install rejects. */
    fail() { reg.installing = null; sw.state = "redundant"; },
  };
  return reg;
}

/**
 * The RACE the immediate state re-read guards, modelled.
 *
 * A real registration can move from `installing` to `activated` between the
 * `reg.active` check and the `statechange` listener going on. Nothing in a
 * synchronous stub can interleave there, so this makes `active` a getter that
 * reads null exactly once and completes activation as a side effect of that
 * read. From the caller's point of view that is the same window: the check said
 * "not active", and by the time the listener is attached the event it is waiting
 * for has already fired. Code that only ever waits for a future event hangs
 * here; code that re-reads the state resolves.
 */
export function activatesDuringTheCheck(log = []) {
  const reg = bornInstalling(log);
  const sw = reg.installing;
  let firstRead = true;
  Object.defineProperty(reg, "active", {
    get() {
      if (!firstRead) return sw;
      firstRead = false;
      // The browser finishes installing right here — after the check has read
      // null, and before any listener exists to hear the statechange.
      sw.state = "activated";
      return null;
    },
  });
  return reg;
}

/** Run the served /notify.js against a given registration and permission. */
export function runNotifyJs(source, { permission = "default", reg }) {
  const el = () => ({ hidden: true, textContent: "", disabled: false, _clicks: [],
    addEventListener(t, f) { if (t === "click") this._clicks.push(f); } });
  const box = el(), msg = el(), btn = el();
  const posted = [];
  const ctx = {
    console: { info() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, atob, Promise, Error, Date, JSON, Event,
    document: { getElementById: (id) => ({ notify: box, "notify-state": msg, "notify-btn": btn }[id]),
      addEventListener() {}, visibilityState: "visible" },
    location: { reload() {} },
    fetch: async (u) => { posted.push(u); return { ok: true, status: 200 }; },
    PushManager: function () {},
    Notification: { permission, requestPermission: async () => "granted" },
    navigator: {
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/120",
      platform: "Linux x86_64", maxTouchPoints: 0,
      serviceWorker: { addEventListener() {},
        register: async () => { reg.log.push("register"); return reg; } },
    },
  };
  ctx.window = ctx;
  ctx.window.matchMedia = () => ({ matches: false });
  vm.createContext(ctx);
  vm.runInContext(source, ctx);
  return { box, msg, btn, posted, click: () => btn._clicks[0]() };
}

/**
 * Fire the served /sw.js install handler, optionally with a cache that cannot
 * fetch.
 *
 * `added` RECORDS WHAT WAS CACHED rather than leaving the caller to grep the
 * source. A regex over the served script cannot tell `await c.add("/offline")`
 * from the same line sitting under a condition that is never true — the string
 * is present either way, so a "still precaches" assertion written that way is
 * green against a worker that caches nothing. This is the observation the
 * assertion needs.
 */
export function runInstall(source, { addFails = false } = {}) {
  let waited = null, skipWaiting = false;
  const added = [];
  const ctx = { console: { info() {}, warn() {}, error() {} }, Promise, Error, Response,
    caches: { open: async () => ({ add: async (u) => {
        if (addFails) throw new TypeError("Failed to fetch");
        added.push(u); } }),
      keys: async () => [], delete: async () => {}, match: async () => undefined },
    self: { addEventListener: (t, f) => { if (t === "install") f({ waitUntil: (p) => { waited = p; } }); },
      skipWaiting: async () => { skipWaiting = true; },
      clients: { claim: async () => {}, matchAll: async () => [], openWindow: async () => {} } } };
  vm.createContext(ctx);
  vm.runInContext(source, ctx);
  return { settled: () => waited, skipped: () => skipWaiting, added: () => added };
}

/** Let the pending microtask/timer chain drain. */
export const settle = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
