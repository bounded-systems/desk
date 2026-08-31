import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";
import { activatesDuringTheCheck, bornInstalling, runNotifyJs, runInstall, settle } from "./browser-stub.mjs";

const ENV = { FEED_URL:"https://feed.example/board.json", PRS_FEED_URL:"https://feed.example/prs.json",
  DESK_LIMIT:"25", VAPID_PUBLIC_KEY:"BExampleTestPublicKeyValue" };
const notifyJs = () => worker.fetch(new Request("https://desk.bounded.tools/notify.js"), ENV).then((r) => r.text());
const swJs = () => worker.fetch(new Request("https://desk.bounded.tools/sw.js"), ENV).then((r) => r.text());

test("a FIRST-EVER device waits for the worker to activate before subscribing (#60)", async () => {
  // register() resolves as soon as the REGISTRATION exists. Its worker is still
  // 'installing', and subscribe() needs an ACTIVE one. Subscribing straight off
  // the registration is why no new device could turn notifications on.
  const reg = bornInstalling();
  const ui = runNotifyJs(await notifyJs(), { permission: "default", reg });
  ui.click();
  await settle();

  assert.deepEqual(reg.log, ["register"], "must not subscribe while the worker is installing");
  assert.ok(!/Could not enable/.test(ui.msg.textContent), `errored while installing: ${ui.msg.textContent}`);

  reg.activate();                       // install finishes; the worker goes active
  await settle();

  assert.deepEqual(reg.log, ["register", "subscribe"], "subscribes once active");
  assert.equal(ui.msg.textContent, "Notifications are on for this device.");
  assert.ok(ui.posted.includes("/subscribe"), "hands the subscription to the origin");
});

test("an already-permitted device also waits, rather than subscribing off the registration", async () => {
  const reg = bornInstalling();
  const ui = runNotifyJs(await notifyJs(), { permission: "granted", reg });
  await settle();
  assert.deepEqual(reg.log, ["register"]);
  reg.activate();
  await settle();
  assert.deepEqual(reg.log, ["register", "subscribe"]);
  assert.equal(ui.msg.textContent, "Notifications are enabled for this device.");
});

test("a worker that never activates ends in a sentence, not a dead button", async () => {
  // The failure mode the wait itself could introduce: waiting forever. Every
  // branch of this script ends in something the reader can act on, and a
  // promise that never settles is the one way to break that silently.
  const reg = bornInstalling();
  const ui = runNotifyJs(await notifyJs(), { permission: "default", reg });
  ui.click();
  await settle();
  reg.fail();                            // install rejected; worker goes redundant
  await settle();

  assert.match(ui.msg.textContent, /Could not enable notifications: .+/);
  assert.equal(ui.btn.disabled, false, "the button is offered again, not left dead");
});

test("a device that already has an active worker still subscribes", async () => {
  // The case that MASKED #60 in the field: everyone who had visited before
  // already had an active worker, so the missing wait was invisible to them.
  const reg = bornInstalling();
  reg.activate();
  const ui = runNotifyJs(await notifyJs(), { permission: "granted", reg });
  await settle();
  assert.deepEqual(reg.log, ["register", "subscribe"]);
  assert.equal(ui.msg.textContent, "Notifications are enabled for this device.");
});

test("an unfetchable /offline does not stop the worker activating (#60)", async () => {
  // install awaited a single caches.add(). One failed fetch rejected install,
  // the worker never activated, and the enable button hung with no message.
  // The offline page is a nicety; activating is the contract.
  const run = runInstall(await swJs(), { addFails: true });
  await assert.doesNotReject(run.settled(), "a failed offline precache must not reject install");
  assert.equal(run.skipped(), true, "the worker still takes over");
});

test("a healthy install still precaches the offline page", async () => {
  // The other direction: the try/catch must not quietly turn the cache off.
  //
  // ASSERTED ON WHAT THE CACHE RECEIVED, not on a regex over the served script.
  // `/\.add\("\/offline"\)/` matches whether or not that line ever runs — put it
  // behind a condition that is never true and the grep still passes while the
  // worker precaches nothing. The stub records the URLs it was handed, so this
  // is an observation of the run rather than a reading of the source.
  const run = runInstall(await swJs(), { addFails: false });
  await run.settled();
  assert.equal(run.skipped(), true);
  assert.deepEqual(run.added(), ["/offline"], "install cached nothing");
});

test("a worker that never activates at all still ends in a sentence", async () => {
  // THE FAILURE THE WAIT ITSELF INTRODUCES, and the one the redundant-worker
  // test above cannot reach: a worker that neither activates nor goes redundant
  // just sits in `installing`. Without the timeout the promise never settles,
  // and a promise that never settles is precisely the dead button with no
  // message that #60 was about — worse than the error it replaced.
  //
  // The constant is shrunk in the SERVED TEXT so the code path is the real one;
  // the substitution is asserted, so a rename or a removed timeout goes red here
  // rather than hanging the runner for ten seconds and then passing.
  const src = await notifyJs();
  assert.match(src, /ACTIVATION_TIMEOUT_MS = \d+/, "no activation timeout is declared");
  const fast = src.replace(/ACTIVATION_TIMEOUT_MS = \d+/, "ACTIVATION_TIMEOUT_MS = 40");
  const reg = bornInstalling();
  const ui = runNotifyJs(fast, { permission: "default", reg });
  ui.click();
  // Never activate, never fail. Bounded so a regression fails as a wrong value
  // rather than as a hung suite.
  const deadline = Date.now() + 2000;
  while (!ui.msg.textContent.startsWith("Could not") && Date.now() < deadline) await settle(4);

  assert.match(ui.msg.textContent, /Could not enable notifications: .+/, "the wait never gave up");
  assert.equal(ui.btn.disabled, false, "the button is offered again, not left dead");
  assert.deepEqual(reg.log, ["register"], "subscribed anyway after giving up");
});

test("a worker that activates during the check is not waited on forever", async () => {
  // THE RACE, AND THE ONE-LINE SAFEGUARD THAT CLOSES IT. `reg.active` is read,
  // says no, and the worker activates before the `statechange` listener is
  // attached — so the event the wait is listening for has already fired and will
  // never fire again. Attaching the listener and stopping there hangs until the
  // ten-second timeout and then reports a failure that did not happen; re-reading
  // the state immediately after attaching resolves. Delete the trailing
  // `onChange()` call in `activated` and this goes red.
  const reg = activatesDuringTheCheck();
  const ui = runNotifyJs(await notifyJs(), { permission: "granted", reg });
  await settle();
  assert.deepEqual(reg.log, ["register", "subscribe"], "the wait missed an activation it was already past");
  assert.equal(ui.msg.textContent, "Notifications are enabled for this device.");
});

test("a registration that never produces a worker is reported, not awaited", async () => {
  // The other way `activated` can be handed nothing to wait on: no `active`, no
  // `installing`, no `waiting`. Rejecting is what keeps this off the hang path.
  const reg = bornInstalling();
  reg.installing = null;
  reg.waiting = null;
  reg.active = null;
  const ui = runNotifyJs(await notifyJs(), { permission: "granted", reg });
  await settle();
  assert.match(ui.msg.textContent, /not subscribed: .+/);
  assert.deepEqual(reg.log, ["register"]);
});

test("a worker already past installing, sitting in waiting, is still awaited", async () => {
  // `reg.installing` is null once install resolves; the worker moves to
  // `waiting`. Reading only `installing` would reject a perfectly healthy
  // registration with "produced no worker".
  const reg = bornInstalling();
  reg.waiting = reg.installing;
  reg.installing = null;
  const ui = runNotifyJs(await notifyJs(), { permission: "granted", reg });
  await settle();
  assert.deepEqual(reg.log, ["register"], "subscribed before the worker was active");
  reg.active = reg.waiting;
  reg.waiting.state = "activated";
  await settle();
  assert.deepEqual(reg.log, ["register", "subscribe"]);
  assert.equal(ui.msg.textContent, "Notifications are enabled for this device.");
});
