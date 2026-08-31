// The board, measured in a real browser at a real phone size (desk#61).
//
// WHY THESE EXIST AT ALL. desk.bounded.tools rendered ZOOMED OUT on a phone and
// nothing in `npm test` could see it. The meta viewport was correct, no element
// overflowed, and every regex over the served HTML passed. What actually
// happened is that an unbreakable 40-character dependabot SHA has a min-content
// width of 477px, so Chromium WIDENED the layout viewport to fit it and then
// scaled the whole page down: at a 390px viewport the page reported
// `innerWidth: 493` and every text run rendered about 21% smaller than designed.
// That is a layout outcome. It has no textual signature, so only a browser can
// see it.
//
// Run with `npm run test:layout`. Deliberately not in `npm test`: it needs a
// browser binary, and a suite that silently no-ops where CI cannot install one
// is worse than one that is not run at all.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { renderOverview } from "../../src/render.js";
import { compress } from "../../src/title.js";
import { launch, phone, coarsePointer } from "./browser.mjs";

const live = JSON.parse(await readFile(new URL("../board-live.json", import.meta.url), "utf8"));
const HTML = renderOverview(live, Date.parse(live.generated_at) + 3.6e6, 60);

let browser = null, skip = null, executablePath = null;
before(async () => {
  ({ browser, skip = null, executablePath = null } = await launch());
  if (skip) console.warn(`\n  ! layout suite SKIPPED: ${skip}\n`);
});
after(async () => { if (browser) await browser.close(); });

/** Open the real render on a real phone, with the emulation asserted first. */
async function onPhone(width, fn, opts = {}) {
  const { html = HTML, ...ctxOpts } = opts;
  const ctx = await browser.newContext({ ...phone(width), ...ctxOpts });
  const page = await ctx.newPage();
  await page.setContent(html, { waitUntil: "load" });
  try {
    return await fn(page);
  } finally {
    await ctx.close();
  }
}

test("the fixture is still the live board, long titles and all", () => {
  // ANTI-VACUITY, and the specific way this suite could rot: every assertion
  // below is about what an UNBREAKABLE RUN does to the layout viewport. A
  // fixture that quietly lost its 40-character SHAs would make the innerWidth
  // test pass while measuring nothing at all.
  const rows = live.sections.flatMap((s) => s.items);
  const longest = Math.max(...rows.flatMap((r) => r.title.split(/\s+/).map((w) => w.length)));
  assert.ok(longest >= 40, `the longest unbreakable run is ${longest} characters`);
  assert.ok(HTML.length > 5000, "the render is too small to be the page");
  assert.match(live._source, /desk\.bounded\.tools/, "the fixture lost its provenance");
});

test("the context really is emulating a phone", async (t) => {
  if (skip) return t.skip(skip);
  // THE TRAP, ONE LEVEL DOWN, AND IT CAUGHT ME. Chromium applies the
  // layout-viewport widening heuristic only under mobile emulation. Written
  // without `isMobile: true`, the innerWidth test below reported 390 against the
  // BROKEN page and passed — a check that could only see its own scaffolding,
  // in the suite written to escape exactly that. So the emulation is asserted
  // before anything measured on top of it.
  assert.equal(await onPhone(390, coarsePointer), true);
});

test("the layout viewport is the viewport, at 390 and at 320", async (t) => {
  if (skip) return t.skip(skip);
  // RED BEFORE THIS CHANGE: 493 at both widths. Viewport-INDEPENDENT, and that
  // is not an accident — the widening target is the min-content width of the
  // longest unbreakable run (477px), not some fraction of the viewport, so the
  // same equality is the right assertion at every size.
  for (const width of [390, 320]) {
    const got = await onPhone(width, (p) =>
      p.evaluate(() => ({ inner: innerWidth, doc: document.documentElement.scrollWidth })));
    assert.equal(got.inner, width, `layout viewport widened to ${got.inner} at a ${width}px viewport`);
    assert.equal(got.doc, width, `the document is ${got.doc} wide in a ${width}px viewport`);
  }
});

test("the wrap rule holds the viewport on its own, with compression fallen back", async (t) => {
  if (skip) return t.skip(skip);
  // THE TEST ABOVE CANNOT SEE THE FIX IT WAS WRITTEN FOR, and that is why this
  // one exists. Measured, at a 390px viewport, all four cells:
  //
  //                     wrap ON   wrap OFF
  //   compress ON         390       390
  //   compress OFF        390       489
  //
  // Compression shortens every SHA to seven characters, so the longest
  // unbreakable run left in a rendered `.row__title` is 21 — there is nothing in
  // the DOM for the widening heuristic to widen FOR, and the assertion above is
  // green whether or not `overflow-wrap:anywhere` is in the stylesheet at all.
  // The fixture guard in the first test pins the FIXTURE's long runs, not the
  // rendered page's, so it does not catch this either.
  //
  // src/title.js states its own risk plainly: `chore(deps):` is a dependabot
  // convention, not a contract, and if it changes every row falls back to
  // `kind: "plain"` and the raw forty-character SHAs come back. The wrap rule is
  // the only thing standing between that day and the zoomed-out page. So this
  // renders the SAME live rows with their titles pushed off the compression path
  // — the documented fallback, not an invented input — and asserts the viewport
  // holds anyway. Remove `overflow-wrap:anywhere` and this goes red at 489.
  const fallback = {
    ...live,
    sections: live.sections.map((s) => ({
      ...s,
      items: s.items.map((i) => ({ ...i, title: i.title.replace(/^chore\(deps(?:-dev)?\): /, "Revert ") })),
    })),
  };
  const titles = fallback.sections.flatMap((s) => s.items).map((i) => i.title);
  // The fallback is real: nothing here is recognised, and the SHAs survived.
  for (const t2 of titles) assert.equal(compress(t2).kind, "plain", `still compressed: ${t2}`);
  assert.ok(
    titles.some((t2) => t2.split(/\s+/).some((w) => w.length >= 40)),
    "the fallback corpus lost its forty-character runs",
  );

  const html = renderOverview(fallback, Date.parse(live.generated_at) + 3.6e6, 60);
  for (const width of [390, 320]) {
    const got = await onPhone(width, (p) =>
      p.evaluate(() => {
        const runs = [...document.querySelectorAll(".row__title")]
          .flatMap((e) => e.textContent.split(/\s+/))
          .map((w) => w.length);
        return { inner: innerWidth, doc: document.documentElement.scrollWidth, longest: Math.max(...runs) };
      }), { html });
    // Guard the guard: the run has to reach the DOM, or the equality below is
    // the same vacuous pass this test was written to replace.
    assert.ok(got.longest >= 40, `the rendered titles' longest run is only ${got.longest}`);
    assert.equal(got.inner, width, `an uncompressed SHA widened the layout viewport to ${got.inner}`);
    assert.equal(got.doc, width, `the document is ${got.doc} wide in a ${width}px viewport`);
  }
});

test("a row title contributes no more than a touch target to min-content", async (t) => {
  if (skip) return t.skip(skip);
  // THE TEST THAT TELLS `anywhere` FROM `break-word`, and the reason the
  // property matters rather than the outcome. Measured here:
  //
  //   no rule                 387.1px
  //   overflow-wrap:break-word 387.1px   ← changes min-content by NOTHING
  //   overflow-wrap:anywhere    10.2px
  //
  // `break-word` measures identical to `anywhere` on today's page only because
  // `.row__body`/`.row__link` already sit in a `minmax(0,1fr)` track that caps
  // the flex/grid item. Swap the property and the test above still passes; this
  // one goes red. A guarantee about the ELEMENT, not about one layout it
  // currently happens to sit in.
  const min = await onPhone(390, (p) =>
    p.evaluate(() => {
      const probe = document.createElement("span");
      probe.className = "row__title";
      probe.style.width = "min-content";
      probe.style.display = "block";
      probe.textContent = "d5da3d12bdb0e04b09a63d6a58b266a2e48ca508";
      document.body.append(probe);
      const w = probe.getBoundingClientRect().width;
      probe.remove();
      return w;
    }));
  assert.ok(min <= 24, `a 40-character SHA contributes ${min.toFixed(1)}px of min-content`);
});

test("every link that is not prose clears the touch-target floor", async (t) => {
  if (skip) return t.skip(skip);
  // RED BEFORE THIS CHANGE: 57 of 57 link line-boxes under 24px, max 21, min 16
  // — and `elementFromPoint` at a row's top-right corner returned the ROW, so
  // the right-hand side of every row was dead space.
  //
  // MEASURED PER LINE BOX (`getClientRects`), NOT ON THE UNION RECT, and the
  // difference is the whole point. `getBoundingClientRect` on a link that wraps
  // across four lines returns the union of those lines — about 80px tall — so a
  // page whose every individual line box is 16–21px reports "tall enough" and
  // the assertion passes against exactly the defect it was written for.
  // Measured on the committed render: 57 of 57 line boxes under the floor, but
  // only 3 of 18 union rects. A line box is what a thumb can actually hit.
  //
  // Prose links are excluded because SC 2.5.8 exempts a link inline in a
  // sentence: the sentence is the target's context and enlarging it would break
  // the line. Every link this page expects a thumb on is a row or a heading.
  const out = await onPhone(390, (p) =>
    p.evaluate(() => {
      const prose = (a) => !!a.closest("p.muted, p.lede, .stamp, footer");
      const small = [], rows = [];
      for (const a of document.querySelectorAll("a")) {
        if (prose(a)) continue;
        for (const r of a.getClientRects()) {
          if (r.height < 24 || r.width < 24) {
            small.push(`${a.className || a.tagName} ${Math.round(r.width)}x${Math.round(r.height)}`);
          }
        }
        if (a.classList.contains("row__link")) rows.push(Math.round(a.getBoundingClientRect().height));
      }
      const first = document.querySelector(".row").getBoundingClientRect();
      const corner = document.elementFromPoint(first.right - 6, first.top + 8);
      return { small, rows, corner: corner && corner.tagName + "." + corner.className };
    }));
  assert.deepEqual(out.small, [], "a non-prose link is under the 24px WCAG 2.2 floor");
  assert.ok(out.rows.length >= 10, `only ${out.rows.length} row links measured`);
  assert.ok(Math.min(...out.rows) >= 44, `the shortest row link is ${Math.min(...out.rows)}px`);
  // The whole row body IS the link now, so the far corner of a row hits it.
  assert.match(out.corner, /^A\./, `the top-right of a row is still dead space: ${out.corner}`);
});

test("routine rows stop dominating the page", async (t) => {
  if (skip) return t.skip(skip);
  // The second-order finding, and the reason the wrap rule could not ship
  // alone: it reclaims the width and the longest dependabot title spends it on a
  // SEVENTH line of hex. Measured on the live page — baseline 43.1% of row
  // space, wrap-rule-only 45.8%.
  //
  // A RATIO, not a pixel count, because the pixels depend on the day's feed. The
  // structural claim is that a machine-authored row is smaller than a row of
  // work, which was false before this change (175px vs 116px).
  const m = await onPhone(390, (p) =>
    p.evaluate(() => {
      const rows = [...document.querySelectorAll(".row")];
      const h = (r) => r.getBoundingClientRect().height;
      const dep = rows.filter((r) => r.classList.contains("row--routine"));
      const act = rows.filter((r) => !r.classList.contains("row--routine"));
      const sum = (a) => a.reduce((t, r) => t + h(r), 0);
      return { n: rows.length, depN: dep.length, actN: act.length,
        depAvg: sum(dep) / dep.length, actAvg: sum(act) / act.length,
        depPct: (sum(dep) / sum(rows)) * 100 };
    }));
  assert.ok(m.depN >= 5 && m.actN >= 10, `${m.depN} routine / ${m.actN} actionable — nothing to compare`);
  assert.ok(m.depAvg < m.actAvg, `a routine row is ${m.depAvg.toFixed(0)}px against ${m.actAvg.toFixed(0)}px of work`);
  assert.ok(m.depPct < 30, `routine rows still take ${m.depPct.toFixed(1)}% of the board`);
});

test("the rows are a real list, and each section is a named landmark", async (t) => {
  if (skip) return t.skip(skip);
  // Structure asserted against a PARSED document rather than against the string
  // that produced it. Deliberately here rather than under a DOM library in
  // `npm test`: a real browser is strictly stronger, and it costs no second
  // parser whose disagreements with a browser nobody would ever see.
  const bad = await onPhone(390, (p) =>
    p.evaluate(() => {
      const bad = [];
      const rows = [...document.querySelectorAll(".row")];
      if (rows.length < 15) bad.push(`only ${rows.length} rows`);
      for (const r of rows) {
        if (r.tagName !== "LI") bad.push(`a .row is a ${r.tagName}`);
        const parent = r.parentElement;
        if (!parent || parent.tagName !== "OL" || !parent.classList.contains("board")) {
          bad.push("a row is not inside ol.board");
        }
        if (parent && parent.getAttribute("role") !== "list") bad.push("ol.board has no role=list");
        const links = r.querySelectorAll("a");
        if (links.length !== 1) bad.push(`a row holds ${links.length} links`);
      }
      const ids = new Set();
      for (const el of document.querySelectorAll("[id]")) {
        if (ids.has(el.id)) bad.push(`duplicate id ${el.id}`);
        ids.add(el.id);
      }
      const secs = [...document.querySelectorAll("section.sec")];
      if (secs.length !== 3) bad.push(`${secs.length} sections`);
      for (const s of secs) {
        const ref = s.getAttribute("aria-labelledby");
        if (!ref) bad.push(`section ${s.id} has no aria-labelledby`);
        else if (!document.getElementById(ref)) bad.push(`aria-labelledby=${ref} resolves to nothing`);
      }
      for (const el of document.querySelectorAll("*")) {
        if (el.children.length === 0 && el.textContent.includes("·") && el.getAttribute("aria-hidden") !== "true") {
          bad.push(`a · outside aria-hidden in .${el.className}`);
        }
      }
      return bad;
    }));
  assert.deepEqual(bad, []);
});

test("a row announces its repo and number, not just its title", async (t) => {
  if (skip) return t.skip(skip);
  // Computed from the rendered tree, so a visually-hidden span that stopped
  // being hidden — or stopped being read — shows up here rather than in a regex
  // over the source that wrote it.
  const names = await onPhone(390, (p) =>
    p.evaluate(() =>
      [...document.querySelectorAll(".row__link")].map((a) =>
        a.textContent.replace(/\s+/g, " ").trim())));
  assert.ok(names.length >= 15);
  // Every accessible name is distinct: in a links list, two dependabot bumps
  // that differ only in a path used to be the same string.
  assert.equal(new Set(names).size, names.length, "two rows announce the same name");
  for (const n of names) assert.match(n, / — \S+ · (issue|pull request) \d+/, `bare name: ${n}`);
});

test("the three freshness bands differ by something other than colour", async (t) => {
  if (skip) return t.skip(skip);
  // RED BEFORE THIS CHANGE. box-shadow is not painted under forced-colors and
  // every colour is replaced, so `behind`'s inset edge vanished and the three
  // bands measured identical background, colour, border colour, border width and
  // box-shadow — state carried by colour alone, WCAG 1.4.1.
  const ctx = await browser.newContext({ ...phone(390), forcedColors: "active" });
  const page = await ctx.newPage();
  const probe = `<!doctype html><html><head><style>${
    /<style>([\s\S]*?)<\/style>/.exec(HTML)[1]
  }</style></head><body><main class="wrap">
    <div class="stamp" data-freshness="fresh"><strong>A.</strong> x</div>
    <div class="stamp stamp--behind" data-freshness="behind"><strong>B.</strong> x</div>
    <div class="stamp stamp--stale" data-freshness="stale"><strong>C.</strong> x</div>
  </main></body></html>`;
  await page.setContent(probe, { waitUntil: "load" });
  const seen = await page.evaluate(() =>
    [...document.querySelectorAll(".stamp")].map((el) => {
      const s = getComputedStyle(el);
      return [el.dataset.freshness, [
        s.borderTopWidth, s.borderInlineStartWidth, s.borderBottomWidth,
        s.outlineWidth, s.textDecorationLine,
      ].join("|")];
    }));
  await ctx.close();
  assert.equal(seen.length, 3);
  assert.equal(
    new Set(seen.map(([, sig]) => sig)).size, 3,
    `two bands are told apart only by colour: ${JSON.stringify(seen)}`,
  );
});
