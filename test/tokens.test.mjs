// The colours are the design system's, and stay that way.
//
// TWO TIERS, for the reason icons.test.mjs records. CI does not install, so a
// check that can only compare against `node_modules` silently skips there — the
// failure `.github`#789 documents, where a rule was absent in 89 of 91 repos and
// every run still printed a clean summary. So the half that catches the thing
// which actually regresses — someone typing a hex back into a page — runs
// EVERYWHERE, off the committed files alone, and the package comparison is the
// extra the installed environment can afford.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as tokens from "../src/tokens.js";
import { LIGHT, DARK, UNPINNED, vars } from "../src/palette.js";
import { SCALE, UNPINNED as SCALE_UNPINNED } from "../src/scale.js";
import { PINS, DIMENSIONS, resolvePins, resolveDimensions } from "../scripts/make-tokens.mjs";

/**
 * Comments only. A hex inside prose is fine and there is a lot of prose here —
 * worker.js explains the splash colour by naming the page background it used to
 * be. What must not survive is a hex in CODE.
 *
 * The trailing-comment rule refuses to fire after a colon so that a `https://`
 * in a string is not mistaken for one; a `//` comment that begins immediately
 * after a colon is the one thing this cannot see, and would fail open. Given
 * what it guards — a colour, never a URL — that is the right way round.
 */
const stripComments = (s) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n")
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");

const HEX = /#[0-9a-fA-F]{3}\b|#[0-9a-fA-F]{6}\b/g;

/** CSS comments only — the stylesheet explains its own values at length. */
const stripCss = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "");

test("no page types a colour — every hex comes from palette.js", async () => {
  // The state before this change: sixteen literals across these two files, of
  // which exactly one (#0C5A42) was character-for-character a brand token and
  // two more were a brand token with a digit wrong. Nothing could tell the
  // difference, which is why this assertion is the load-bearing one.
  for (const f of ["src/render.js", "src/worker.js"]) {
    const code = stripComments(await readFile(f, "utf8"));
    assert.deepEqual([...code.matchAll(HEX)].map((m) => m[0]), [], `${f} still types a colour`);
  }
});

test("the palette accounts for every colour, pinned or not", () => {
  const used = new Set([...Object.values(LIGHT), ...Object.values(DARK)]);
  const pinned = new Set(Object.keys(PINS).map((n) => tokens[n]));
  const unpinned = new Set(Object.values(UNPINNED));
  for (const v of used) {
    assert.ok(pinned.has(v) || unpinned.has(v), `${v} is neither a brand token nor a stated gap`);
  }
  // Nothing declared and then unused: an entry in UNPINNED that no scheme reads
  // is a gap that was closed without the note being removed, and a stale note
  // about a missing token is worse than none — it argues against a pin that may
  // by then exist.
  for (const v of unpinned) assert.ok(used.has(v), `${v} is listed as a gap but nothing uses it`);
  assert.equal(used.size, 16, "eight roles per scheme, all distinct");
});

test("the two schemes declare the same roles", () => {
  // The reason both go through `vars`. Adding `--warn` to light and forgetting
  // dark leaves the dark theme inheriting a light-scheme colour with no error
  // anywhere — it renders, it is just wrong, and only on the device.
  assert.deepEqual(Object.keys(LIGHT), Object.keys(DARK));
  for (const scheme of [LIGHT, DARK]) {
    assert.match(vars(scheme), /^(--[a-z]+:#[0-9a-fA-F]{3,6}; )*--[a-z]+:#[0-9a-fA-F]{3,6};$/);
  }
});

test("the generated module says which token each value came from", () => {
  assert.deepEqual(Object.keys(tokens.TOKEN_PATHS), Object.keys(PINS));
  for (const [name, path] of Object.entries(PINS)) {
    assert.equal(tokens.TOKEN_PATHS[name], path);
    assert.match(tokens[name], /^#[0-9A-F]{6}$/, `${name} is a full uppercase hex, as the package writes them`);
    // The SEMANTIC tier, never a primitive: tokens.json is explicit that
    // primitives are the raw palette the roles alias, so consuming one directly
    // opts out of the indirection the design system exists to provide.
    assert.match(path, /^color\./, `${path} must be a semantic role`);
  }
  assert.match(tokens.BRAND_VERSION, /^\d+\.\d+\.\d+/);
});

test("what is committed still matches @bounded-systems/brand", async (t) => {
  let pins;
  try {
    pins = await resolvePins();
  } catch {
    // devDependency-only; in an install-less environment there is nothing to
    // compare against and skipping is honest. The test above ran regardless.
    return t.skip("@bounded-systems/brand is not installed");
  }
  for (const [name, { path, value }] of Object.entries(pins)) {
    assert.equal(tokens[name], value, `${name} (${path}) has drifted — run \`npm run tokens\``);
  }
});

test("the stated gaps really are gaps", async (t) => {
  // The claim in palette.js is "no token fits". This checks the falsifiable half
  // of it: that none of them is an EXACT brand colour someone missed. It cannot
  // check the judgement calls — that `grade.enforced` is the wrong home for a
  // dark accent at ΔE 3.47, or that `grade.aspirational-on-dark-bg` being ΔE
  // 0.32 from a hairline is a coincidence rather than a mapping. Those are
  // arguments, and they are written down where they can be disagreed with.
  let json, css;
  try {
    const { pkgRoot } = await import("../scripts/make-tokens.mjs");
    json = JSON.parse(await readFile(pkgRoot() + "tokens/tokens.json", "utf8"));
    css = await readFile(pkgRoot() + "tokens/tokens.css", "utf8");
  } catch {
    return t.skip("@bounded-systems/brand is not installed");
  }
  const brand = new Set();
  for (const tier of ["primitive", "color", "grade"]) {
    for (const v of Object.values(json[tier])) {
      if (v?.$type === "color" && /^#/.test(v.$value)) brand.add(v.$value.toUpperCase());
    }
  }
  // AND THE STYLESHEET, because tokens.json is not all of what brand publishes.
  // The `grade` tier in tokens.json carries three swatches; tokens.css carries
  // those three plus twelve values a build step DERIVES from them — the
  // `-bg`/`-fg`/`-on-dark`/`-on-dark-bg` families. Scanning only the JSON leaves
  // this check blind to twelve real brand colours, and blind in exactly the
  // wrong direction: the `-on-dark*` family is the only dark-aware thing the
  // package ships, so it is where a token for one of desk's eight dark gaps
  // would first appear. This test would have gone on reporting "the stated gaps
  // really are gaps" while the gap it is loudest about — dark `--line` against
  // `grade.aspirational-on-dark-bg`, ΔE 0.32 — had quietly become a real match.
  for (const m of css.matchAll(/#[0-9a-fA-F]{6}\b/g)) brand.add(m[0].toUpperCase());
  // A set that stopped being populated would make every assertion below pass
  // vacuously, which is the failure `docs/agentic-code-hygiene.md` rule 3 names:
  // a gate's own claim about itself is not evidence. Pin the floor to the JSON
  // tiers alone so a brand restructure that empties either source is red here
  // rather than silently permissive.
  assert.ok(brand.size > 19, `only ${brand.size} brand colours found — the scan has narrowed`);
  for (const [role, value] of Object.entries(UNPINNED)) {
    assert.ok(!brand.has(value.toUpperCase()), `${role} ${value} is a brand colour after all — pin it`);
  }
});

// ── The dimensions, on the same two tiers (desk#61) ─────────────────────────
//
// Colour was never the only axis desk typed by hand. `min-height:44px` on the
// notify button IS `control.md`, transcribed, beside a comment re-deriving the
// WCAG rationale the token already documents — the identical failure this file
// exists to catch, one axis over, and nothing was watching it. Same shape as
// above: the half that catches the regression (a literal creeping back into a
// page) runs everywhere; the package comparison is the extra an installed
// environment can afford.

/** The stylesheet the Worker actually serves, extracted from the real render. */
const style = async () => {
  const { renderIssues } = await import("../src/render.js");
  const html = renderIssues(
    { generated_at: "2026-08-25T12:00:00Z", limit: 25, withheld: {}, items: [] },
    Date.parse("2026-08-25T12:30:00Z"),
    60,
  );
  return /<style>([\s\S]*?)<\/style>/.exec(html)[1];
};

test("no page types a dimension — every size, radius and control floor is a var", async () => {
  const css = stripCss(await style());
  // PIN THE FLOOR FIRST, the way "the stated gaps really are gaps" does. A
  // renamed constant or a changed extraction would otherwise hand every
  // assertion below an empty string and print a clean result.
  assert.ok(css.length > 2000, `only ${css.length} bytes of CSS extracted — the scan has narrowed`);
  for (const prop of ["font-size", "border-radius", "min-height", "min-width"]) {
    for (const m of css.matchAll(new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*([^;}]+)`, "g"))) {
      assert.match(
        m[1].trim(),
        /var\(--/,
        `${prop}: ${m[1].trim()} is typed rather than taken from src/scale.js`,
      );
    }
  }
  // The body font shorthand carries the base size too, and a shorthand hides
  // from the loop above.
  assert.match(css, /font:\s*var\(--text-body\)/);
});

test("the scale accounts for every dimension, pinned or not", () => {
  const pinned = new Set(Object.keys(DIMENSIONS).map((n) => tokens[n]));
  const gaps = new Set(Object.values(SCALE_UNPINNED));
  for (const [role, v] of Object.entries(SCALE)) {
    assert.ok(pinned.has(v) || gaps.has(v), `--${role}: ${v} is neither a brand token nor a stated gap`);
  }
  // Both directions, for the reason the palette's version records: a stated gap
  // nothing uses is a note arguing against a pin that may by now exist, and a
  // PIN nothing uses is the same staleness from the other side — a value the
  // repo claims to consume from the design system and does not.
  for (const v of gaps) {
    assert.ok(Object.values(SCALE).includes(v), `${v} is listed as a gap but nothing uses it`);
  }
  for (const name of Object.keys(DIMENSIONS)) {
    assert.ok(
      Object.values(SCALE).includes(tokens[name]),
      `${name} (${DIMENSIONS[name]}) is pinned but nothing consumes it`,
    );
  }
});

test("every custom property the stylesheet reads is one the stylesheet defines", async () => {
  // The failure this caught while it was being written: `--space-10` was used in
  // two rules and defined nowhere, so `margin-top` silently computed to nothing.
  // An undefined custom property is not an error anywhere — not in the browser,
  // not in a build, not in any other test here — it is just a declaration that
  // quietly does not apply.
  const css = await style();
  const defined = new Set([
    ...Object.keys(LIGHT).map((k) => `--${k}`),
    ...Object.keys(SCALE).map((k) => `--${k}`),
  ]);
  const used = new Set([...css.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]));
  assert.ok(used.size > 20, `only ${used.size} custom properties read — the scan has narrowed`);
  for (const u of used) assert.ok(defined.has(u), `${u} is read by the stylesheet and defined nowhere`);
  for (const d of defined) assert.ok(used.has(d), `${d} is defined and never read`);
});

test("the generated module says which token each dimension came from", () => {
  assert.deepEqual(Object.keys(tokens.DIMENSION_PATHS), Object.keys(DIMENSIONS));
  for (const [name, path] of Object.entries(DIMENSIONS)) {
    assert.equal(tokens.DIMENSION_PATHS[name], path);
    assert.match(tokens[name], /^[\d.]+(rem|px)$/, `${name} is not a plain dimension`);
    // The semantic tiers, never `primitive.font-size-13`: primitives are the raw
    // ramp the roles alias, and consuming one directly opts out of exactly the
    // indirection the design system provides.
    assert.match(path, /^(size|radius|space|control)\./, `${path} must be a semantic role`);
  }
});

test("the committed dimensions still match @bounded-systems/brand", async (t) => {
  let dims;
  try {
    dims = await resolveDimensions();
  } catch {
    return t.skip("@bounded-systems/brand is not installed");
  }
  for (const [name, { path, value }] of Object.entries(dims)) {
    assert.equal(tokens[name], value, `${name} (${path}) has drifted — run \`npm run tokens\``);
  }
});

test("the stated dimension gaps really are gaps", async (t) => {
  // The falsifiable half of scale.js's claim: that none of them is a brand
  // dimension someone missed. It cannot check the judgement calls — that a 3.2px
  // focus radius has no home on an 8/12/18 ramp, or that a rem gutter is right
  // where brand's ramp is px. Those are arguments, written where they can be
  // disagreed with.
  let json;
  try {
    const { pkgRoot } = await import("../scripts/make-tokens.mjs");
    json = JSON.parse(await readFile(pkgRoot() + "tokens/tokens.json", "utf8"));
  } catch {
    return t.skip("@bounded-systems/brand is not installed");
  }
  const brand = new Set();
  for (const tier of ["primitive", "size", "radius", "space", "control"]) {
    for (const v of Object.values(json[tier] || {})) {
      if (v?.$type === "dimension") brand.add(String(v.$value));
    }
  }
  assert.ok(brand.size > 25, `only ${brand.size} brand dimensions found — the scan has narrowed`);
  for (const [role, value] of Object.entries(SCALE_UNPINNED)) {
    assert.ok(!brand.has(value), `${role} ${value} is a brand dimension after all — pin it`);
  }
});
