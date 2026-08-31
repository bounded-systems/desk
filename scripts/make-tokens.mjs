/**
 * Pin desk's colours to @bounded-systems/brand, the same way the icon is pinned.
 *
 * WHY THIS EXISTS. desk carried sixteen hex literals in `src/render.js` and
 * `src/worker.js` and exactly ONE of them — the brand green #0C5A42 — was
 * character-for-character a brand token. Two more were the right colour typed
 * slightly wrong (`#5c6b64` for `color.ink-soft` #5C6B63, `#16201c` for
 * `color.ink` #16221C), which is what hand-transcription looks like: a value
 * that is right until the day someone reads it back and believes it. The point
 * of this file is that nobody transcribes anything again.
 *
 * WHY A GENERATED MODULE RATHER THAN VENDORING tokens.css. The obvious move is
 * to copy `tokens/tokens.css` in beside the avatar and inline it. Three reasons
 * not to:
 *
 *   1. desk inlines its stylesheet into EVERY page response — it is a Worker
 *      with no static-asset stage — so tokens.css's 11.8KB of `@property`
 *      declarations, type recipes and font stacks would ride on every cold hit
 *      to carry six colours.
 *   2. Most of that file is the LEGACY `--bnd-*` alias block, which brand 2.0.0
 *      marks "transition only; migrate consumers off these, then drop". Pinning
 *      to bytes that the package says are on their way out is pinning to the
 *      wrong thing.
 *   3. It would not remove a single literal from the dark block, because the
 *      brand's `color.*` tier is a LIGHT SCHEME ONLY (see `src/palette.js`).
 *      Vendoring the whole sheet buys the page weight of a full design system
 *      and still leaves half of desk's palette unpinned.
 *
 * So: read the tokens, emit only the values desk actually uses, and name each
 * one after the token it came from so the provenance survives in the file that
 * is committed.
 *
 * WHY NO HASH MANIFEST, unlike `make-icons.mjs`. That script needs
 * `brand/vendored.json` because PNG bytes are opaque — a check with no
 * devDependency installed has nothing to compare against, and a check that
 * silently skips is `.github`#789's failure. Colours are not opaque: the token
 * path and the value are both right there in the generated source, so the
 * install-less half of `tokens.test.mjs` can read the committed file itself and
 * assert the thing that actually regresses — a raw hex creeping back into
 * `render.js`. The with-package half then compares values to the package, the
 * same two-tier shape, without a third file to keep in sync.
 *
 * `npm run tokens` after a brand bump.
 */
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/**
 * Resolved LAZILY, for the reason `make-icons.mjs` records: at module scope this
 * threw on import wherever the devDependency was absent, which took the whole
 * test file down as one failure instead of letting its drift check skip.
 */
export function pkgRoot() {
  return require.resolve("@bounded-systems/brand/package.json").replace(/package\.json$/, "");
}

/**
 * Every brand colour desk uses, as `EXPORT_NAME → token path`.
 *
 * NAMED AFTER THE TOKEN, not after desk's CSS variable, and that is the whole
 * discipline. `--muted` is a role this page invented; `color.ink-soft` is a role
 * the design system owns and answers for (its description pins it as the one
 * canonical muted grey, and its contrast is measured there, not here). Naming
 * the export after the token means the mapping is visible at the point of use in
 * `palette.js` — `muted: INK_SOFT` — rather than hidden in a table.
 *
 * The semantic tier (`color.*`), never `primitive.*`: primitives are the raw
 * palette the semantics alias, and tokens.json says so explicitly — "change a
 * primitive → every role that aliases it updates". Consuming a primitive
 * directly opts out of exactly that.
 */
export const PINS = {
  FOREST: "color.forest",
  CARD: "color.card",
  INK: "color.ink",
  INK_SOFT: "color.ink-soft",
  AMBER: "color.amber",
  AMBER_TINT: "color.amber-tint",
};

/** Resolve `{primitive.x}` aliases; the semantic tier is entirely aliases. */
function deref(tokens, value) {
  const m = /^\{(.+)\}$/.exec(value);
  if (!m) return value;
  const node = m[1].split(".").reduce((o, k) => o?.[k], tokens);
  if (!node) throw new Error(`unresolvable alias ${value}`);
  return deref(tokens, node.$value);
}

/** `{ EXPORT_NAME: { path, value } }`, read from the installed package. */
export async function resolvePins() {
  const tokens = JSON.parse(await readFile(pkgRoot() + "tokens/tokens.json", "utf8"));
  const out = {};
  for (const [name, path] of Object.entries(PINS)) {
    const node = path.split(".").reduce((o, k) => o?.[k], tokens);
    if (!node) throw new Error(`no such token: ${path}`);
    if (node.$type !== "color") throw new Error(`${path} is not a color`);
    out[name] = { path, value: deref(tokens, node.$value) };
  }
  return out;
}

export const OUT = "src/tokens.js";

if (import.meta.url === `file://${process.argv[1]}`) {
  const version = JSON.parse(await readFile(pkgRoot() + "package.json", "utf8")).version;
  const pins = await resolvePins();
  const lines = Object.entries(pins)
    .map(([name, { path, value }]) => `export const ${name} = "${value}"; // ${path}`)
    .join("\n");
  const src = `// The brand colours desk uses, embedded.
//
// GENERATED by scripts/make-tokens.mjs from @bounded-systems/brand ${version} —
// do not edit. Run \`npm run tokens\` after a brand bump; tokens.test.mjs fails
// if what is committed stops matching the package, so a bump that retunes a
// colour cannot land silently.
//
// Named after the TOKEN, not after desk's CSS variable: \`--muted\` is a role
// this page invented, \`color.ink-soft\` is a role the design system owns and
// measures. src/palette.js is where the two are tied together, and it is the one
// place to look for what is pinned and what is not.

/** The brand version these values were read from. */
export const BRAND_VERSION = "${version}";

${lines}

/** Token path per export, so a drift check can name what it compared. */
export const TOKEN_PATHS = ${JSON.stringify(
    Object.fromEntries(Object.entries(pins).map(([n, { path }]) => [n, path])),
    null,
    2,
  )};
`;
  await writeFile(OUT, src);
  console.log(`  ${OUT} (brand ${version}, ${Object.keys(pins).length} colours)`);
}
