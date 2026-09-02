// The question card, measured in a real browser (#69, on desk#61's rails).
//
// WHY IT NEEDS ITS OWN FILE. The board suite measures ONE fixture —
// test/board-live.json through renderOverview — and /human is a different page
// that fixture is not on. A card added to the repo without this would ship
// unmeasured while `npm run test:layout` kept passing, measuring a page the card
// does not appear on.
//
// AND THE RISK IS HIGHER HERE THAN ON THE BOARD. A board title comes from the
// projection and is compressed by src/title.js; a question's prompt is written
// by whatever lane called /human and routinely carries a run URL, a SHA or an
// id — exactly the unbreakable run that made Chromium widen the layout viewport
// and scale the whole page down. Nothing compresses it, so `overflow-wrap` is
// the only thing standing between a caller's paste and a zoomed-out page.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { renderHuman } from "../../src/render.js";
import { viewOf } from "../../src/questions.js";
import { launch, phone } from "./browser.mjs";

/** A real caller's paste: a run URL nothing will break for you. */
const TOKEN = "https://github.com/bounded-systems/desk/actions/runs/18446744073709551616";

const RECORD = {
  id: "aQ3zfMwXSsOyv2IeEVJymg",
  prompt: `Should this lane keep retrying ${TOKEN} or stop?`,
  choices: [TOKEN, "stop"],
  no_answer_policy: "default",
  no_answer_value: "stop",
  url: "https://desk.bounded.tools/human/aQ3zfMwXSsOyv2IeEVJymg",
  asked_at: "2026-09-01T09:00:00Z",
  deadline: "2026-09-08T09:00:00Z",
  answer: null,
};
const HTML = renderHuman(viewOf(RECORD, Date.parse("2026-09-02T09:00:00Z")));

let browser = null, skip = null;
before(async () => {
  ({ browser, skip = null } = await launch());
  if (skip) console.warn(`\n  ! layout suite SKIPPED: ${skip}\n`);
});
after(async () => { if (browser) await browser.close(); });

async function onPhone(width, fn, html = HTML) {
  const ctx = await browser.newContext(phone(width));
  const page = await ctx.newPage();
  await page.setContent(html, { waitUntil: "load" });
  try {
    return await fn(page);
  } finally {
    await ctx.close();
  }
}

test("the fixture still contains the thing being measured", () => {
  // ANTI-VACUITY, the way this suite would rot: a fixture that lost its long
  // run would keep the assertions below green while measuring nothing.
  const longest = Math.max(...HTML.replace(/<[^>]*>/g, " ").split(/\s+/).map((w) => w.length));
  assert.ok(longest >= 40, `the longest unbreakable run in the render is ${longest} characters`);
});

test("a caller's unbreakable paste does not widen the layout viewport", async (t) => {
  if (skip) return t.skip(skip);
  // Remove `overflow-wrap:anywhere` from `.q` and this goes red the same way the
  // board did at 493 — measured, this fixture reached 381 at 320px with the rule
  // on `.q__prompt` alone, because an unwrapped CHOICE widened it by itself.
  for (const width of [390, 320]) {
    const got = await onPhone(width, (p) =>
      p.evaluate(() => ({ inner: innerWidth, doc: document.documentElement.scrollWidth })));
    assert.equal(got.inner, width, `layout viewport widened to ${got.inner} at a ${width}px viewport`);
    assert.equal(got.doc, width, `the document is ${got.doc} wide in a ${width}px viewport`);
  }
});

test("the state a person reads is the state the page reports", async (t) => {
  if (skip) return t.skip(skip);
  // The parity test in node asserts the string; this asserts a reader can
  // actually SEE it — the element is rendered, non-empty and in the flow.
  const seen = await onPhone(390, (p) =>
    p.evaluate(() => {
      const el = document.querySelector(".q__state");
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { status: el.dataset.status, w: r.width, h: r.height, text: el.textContent.trim().length };
    }));
  assert.equal(seen.status, "open");
  assert.ok(seen.w > 200 && seen.h > 20, `the state block measured ${seen.w}x${seen.h}`);
  assert.ok(seen.text > 30, "the state block is a sentence, not a class name");
});
