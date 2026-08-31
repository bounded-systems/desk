// Compressing a routine title, and refusing to touch a human one.
//
// FIVE OF FIFTEEN ROWS ON THE OVERVIEW ARE `chore(deps)` AND THEY TAKE 43% OF
// THE VERTICAL SPACE. Measured against the live board on 2026-08-30: a
// dependabot row averages 175px against 116px for a row that is actual work, and
// the longest is 167 characters in a 195px box. The page's whole job is to rank
// what to pick up next, and the machine-authored rows were winning the layout.
//
// WHY COMPRESS RATHER THAN CLAMP, TRUNCATE, OR FILTER.
//
//   - A two-line clamp cuts the DISCRIMINATOR. Four bump rows in one feed differ
//     only in the path and the two SHAs, and the destination SHA is the last
//     token: the clamp removes precisely the part that says which row this is.
//     Truncation that removes the discriminator is deletion with extra steps.
//   - Filtering would falsify the section count. The page says "Showing the
//     first 5 of 6"; a hidden row makes that sentence false, and never showing a
//     silent cap is this page's entire posture.
//
// Compression keeps every token and shortens each: `chore(deps): bump X from A
// to B` becomes `X  A → B`, 167 characters down to 35 on the worst live row.
//
// THIS IS PRESENTATION, NOT DATA. src/render.js is the only consumer. select.js
// never calls it, so /board.json keeps serving the real title verbatim — a
// reader who wants the untransformed string can still get it, and the transform
// cannot leak into the feed.
//
// THE HONEST FRAMING: this is a display heuristic over machine output, not a
// contract. `chore(deps):` is a repo `commit-message` convention that dependabot
// owns, not a guarantee. If it changes, every row falls back to `kind: "plain"`
// and renders exactly as it does today — the right failure direction, but a
// silent one. `compress` is therefore total and never throws: anything it does
// not recognise comes back byte-identical.

const SHA = /^[0-9a-f]{7,40}$/;

/**
 * Shorten a git object name and NOTHING else.
 *
 * Deliberately not "truncate anything long": a semver is short enough already
 * and slicing `1.2.3` would mangle it. Only a string that is entirely lowercase
 * hex of commit-ish length is treated as a SHA.
 *
 * Seven characters because that is what git itself abbreviates to and what the
 * PR body will show. Collisions are possible in principle; the href is untouched
 * either way, so the cost is cosmetic.
 */
const short = (s) => (SHA.test(s) ? s.slice(0, 7) : s);

/**
 * What was bumped, said as briefly as it can still be said.
 *
 * `owner/repo` STAYS WHOLE — `actions/checkout` is a name, and its basename
 * alone (`checkout`) is a different and less useful thing. Anything deeper is a
 * LOCATION (`bounded-systems/.github/.github/workflows/_pr-claim.yml`) and
 * collapses to its basename, because the path is repeated on every such row and
 * the file is what distinguishes them.
 */
export function subject(s) {
  if (/^[^/]+\/[^/]+$/.test(s)) return s;
  const i = s.lastIndexOf("/");
  return i === -1 ? s : s.slice(i + 1);
}

/**
 * `{ kind, subject, delta }`. `kind: "plain"` means "this is human-written work
 * — render it exactly as given", and `subject` is then the input, byte for byte.
 */
export function compress(title) {
  let m = /^chore\(deps(?:-dev)?\): bump (\S+) from (\S+) to (\S+)$/.exec(title);
  if (m) return { kind: "bump", subject: subject(m[1]), delta: `${short(m[2])} → ${short(m[3])}` };
  m = /^chore\(deps(?:-dev)?\): bump the (\S+) group with (\d+) updates?$/.exec(title);
  if (m) return { kind: "group", subject: `${m[1]} group`, delta: `${m[2]} updates` };
  return { kind: "plain", subject: title, delta: null };
}
