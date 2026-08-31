// The compression, checked against the FEED rather than against itself.
//
// The trap this repo keeps hitting is a check that can only see its own
// scaffolding — a stub born in the state that makes it pass, a scan that reads
// only the source containing the values it asserts. A transform test is
// unusually exposed to it: the obvious shape is "give compress() the input I
// invented and assert the output I invented", which proves the function does
// what I typed twice.
//
// So the corpus here is `test/board-live.json`: a real capture of the live
// projection, titles and SHAs untouched, with its provenance in `_source`. The
// two properties asserted over it — identity on human titles, injectivity over
// the whole set — are ones I did not choose the answers to. Ten of its fifteen
// rows exercise the first; both go red the moment either regex over-matches.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { compress, subject } from "../src/title.js";

const corpus = JSON.parse(await readFile(new URL("./board-live.json", import.meta.url), "utf8"));
const rows = corpus.sections.flatMap((s) => s.items);

test("the recorded corpus is still worth testing against", () => {
  // ANTI-VACUITY, and it is not ceremony: every assertion below is a `for` over
  // this array, so a fixture that quietly lost its rows would make all of them
  // pass while measuring nothing. Pin both halves — the machine rows the
  // transform is FOR, and the human rows it must not touch.
  assert.ok(rows.length >= 15, `only ${rows.length} rows recorded`);
  const dep = rows.filter((r) => /^chore\(deps/.test(r.title));
  assert.ok(dep.length >= 5, `only ${dep.length} dependabot rows — nothing to compress`);
  assert.ok(rows.length - dep.length >= 10, "no human-written rows left to protect");
  // And at least one unbreakable run long enough to widen a phone's layout
  // viewport. This is what makes the layout suite's innerWidth test meaningful;
  // a corpus that lost its 40-character SHAs would make that test pass for the
  // wrong reason.
  assert.ok(
    rows.some((r) => r.title.split(/\s+/).some((w) => w.length >= 40)),
    "no unbreakable run of 40+ characters left in the corpus",
  );
});

test("a human-written title comes back byte for byte", () => {
  // THE LOAD-BEARING SAFETY PROPERTY. The transform is a display heuristic over
  // machine output; the one thing it must never do is rewrite work a person
  // wrote. `kind` and `subject` are both asserted because a regex that
  // over-matched would typically get one of them right by accident.
  let checked = 0;
  for (const r of rows) {
    if (/^chore\(deps/.test(r.title)) continue;
    const c = compress(r.title);
    assert.equal(c.kind, "plain", `rewrote a human title: ${r.title}`);
    assert.equal(c.subject, r.title);
    assert.equal(c.delta, null);
    checked++;
  }
  assert.ok(checked >= 10, `only ${checked} human titles checked`);
});

test("every row still renders as a distinct string", () => {
  // INJECTIVITY over the real corpus: as many rendered strings as there are
  // rows. Compression that collapsed two rows into the same line would be
  // deletion wearing a shorter title — and the four bump rows differ only in a
  // path and two SHAs, which is exactly where a basename or a 7-hex prefix could
  // collide. This covers the recorded feed, not the future; the href is
  // untouched either way, so a future collision is cosmetic.
  const rendered = new Set();
  for (const r of rows) {
    const c = compress(r.title);
    rendered.add(c.delta === null ? c.subject : `${c.subject}  ${c.delta}`);
  }
  assert.equal(rendered.size, new Set(rows.map((r) => r.url)).size);
});

test("compression is real, and measured on the worst row", () => {
  // The claim in src/title.js is 167 characters down to 36. If a future feed
  // stops matching the pattern this goes red rather than silently rendering the
  // long form — which is the failure direction title.js names as its own risk.
  const worst = rows
    .filter((r) => /^chore\(deps/.test(r.title))
    .map((r) => {
      const c = compress(r.title);
      assert.notEqual(c.kind, "plain", `stopped recognising: ${r.title}`);
      return { before: r.title.length, after: `${c.subject}  ${c.delta}`.length };
    })
    .sort((a, b) => b.before - a.before)[0];
  assert.ok(worst.before > 160, `the longest routine title is only ${worst.before} chars`);
  assert.ok(worst.after < 40, `compressed to ${worst.after} chars, expected under 40`);
});

test("a SHA is shortened and a version is not", () => {
  // `short()` exists to shorten ONE thing. The version case is the reason it
  // tests for hex rather than for length: slicing `1.20.3` to seven characters
  // would produce `1.20.3` by luck and `1.20.31` -> `1.20.31` by accident, and
  // some other day a wrong number.
  assert.equal(
    compress("chore(deps): bump actions/checkout from 11bd71901bbe5b1630ceea73d27597364c9af683 to 08c6903cd8c0fde910a37f88322edcfb5dd907a8").delta,
    "11bd719 → 08c6903",
  );
  assert.equal(compress("chore(deps): bump undici from 6.19.8 to 7.0.0").delta, "6.19.8 → 7.0.0");
  assert.equal(compress("chore(deps-dev): bump wrangler from 4.1.0 to 4.2.0").kind, "bump");
});

test("owner/repo stays whole; a path collapses to its basename", () => {
  // `actions/checkout` is a NAME and its basename is a different, less useful
  // thing. Anything deeper is a location, repeated on every such row.
  assert.equal(subject("actions/checkout"), "actions/checkout");
  assert.equal(subject("undici"), "undici");
  assert.equal(
    subject("bounded-systems/.github/.github/workflows/_pr-claim.yml"),
    "_pr-claim.yml",
  );
});

test("anything unrecognised is returned untouched", () => {
  // Totality, stated as a test: the transform must never throw and must never
  // invent. These are the shapes a producer change would most plausibly take.
  for (const s of [
    "",
    "chore(deps): bump",
    "chore(deps): update actions/checkout to v5",
    "build(deps): bump actions/checkout from a to b",
    "chore(deps): bump the github-actions group across 3 directories with 3 updates",
  ]) {
    const c = compress(s);
    assert.equal(c.kind, "plain", `over-matched: ${JSON.stringify(s)}`);
    assert.equal(c.subject, s);
  }
});
