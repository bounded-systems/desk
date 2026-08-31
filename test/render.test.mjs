import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderIssues, renderClaims, renderPrs, renderOverview, renderUnavailable,
} from "../src/render.js";
import { selectPrs } from "../src/select.js";
import { readFile } from "node:fs/promises";

const board = (o = {}) => ({
  generated_at: "2026-08-25T12:00:00Z", limit: 25,
  withheld: { todo_total: 10, claimed: 2, pull_requests: 3, unscored: 0, beyond_limit: 4 },
  items: [{ repo: "bounded-systems/prx", number: 434, title: "Cut it", url: "https://e/1", score: 17.3, labels: [] }],
  ...o,
});
const AT = Date.parse("2026-08-25T15:00:00Z"); // 3h after the stamp

// The point of the app: a static build could only print the stamp, because a
// relative age would be false the moment the page was cached.
test("states the age relative to the request, not to a build", () => {
  const html = renderIssues(board(), AT, 60);
  assert.match(html, /3 hours ago/);
  assert.match(html, /2026-08-25T12:00:00Z/);
  assert.doesNotMatch(html, /snapshot is old/);
});

test("says it is stale past the threshold, and how old", () => {
  const html = renderIssues(board(), Date.parse("2026-08-27T12:00:00Z"), 60);
  assert.match(html, /snapshot is old/);
  assert.match(html, /2 days ago/);
  // Was `/stamp--stale/`, which matched the STYLESHEET and passed regardless.
  assert.equal(banner(html), "stamp--stale");
});

// ── Freshness, in three bands (#809) ────────────────────────────────────────
//
// AT is 3h after the stamp, which USED to render the plain stamp because the
// only threshold was 24h. It now renders `behind`, and that change is the point:
// a 6h25m-old board rendered as completely normal on 2026-08-30, because
// "current" and "the lane stopped" were the only two states and the one a reader
// actually meets sits between them.
const FRESH = Date.parse("2026-08-25T12:30:00Z"); // 30m after the stamp

// MATCH THE RENDERED DIV, NOT THE CLASS NAME. Both modifier classes are defined
// in the stylesheet on every page, so a bare /stamp--stale/ matches the CSS and
// passes whether or not the banner rendered. The pre-existing stale test did
// exactly that; it is corrected below. Same failure as asserting /3/ for a tile
// count — the string is present for an unrelated reason.
const banner = (html) => {
  const m = /<div class="stamp([^"]*)"/.exec(html);
  return m ? m[1].trim() : null;   // "" fresh, "stamp--behind", "stamp--stale"
};

// The VISIBLE text of the first row's where-line, tags stripped.
//
// The where-line is markup now, not a pre-joined string: the `·` is wrapped in
// `aria-hidden` and the noun ("issue", "pull request") is a visually-hidden span,
// so a bare /prx · 434/ can no longer match what the page actually renders.
// Anchored on `</span></a>` because the where-line is the anchor's last child
// and it contains nested spans of its own. The leading `— ` is deliberate and
// is asserted: it is a literal boundary in the ACCESSIBLE NAME, not something
// this page can leave to a screen reader to insert.
const whereText = (html) => {
  const m = /<span class="row__where">([\s\S]*?)<\/span>\s*<\/a>/.exec(html);
  return m ? m[1].replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim() : null;
};

test("fresh: names the cache window without overclaiming what it bounds", () => {
  const html = renderIssues(board(), FRESH, 60);
  assert.match(html, /up to 60s/);
  assert.equal(banner(html), "");
  // The removed claim: the edge TTL never bounded how far the SNAPSHOT trails
  // the newest one — the publishing lane does. Saying otherwise is what made a
  // hours-stale board look like a cache artefact.
  assert.doesNotMatch(html, /accurate to within that window/);
});

test("behind: hours old is reported, and reported as normal rather than broken", () => {
  const html = renderIssues(board(), AT, 60);
  assert.equal(banner(html), "stamp--behind");
  assert.match(html, /3 hours ago/);
  // Informational wording. At the measured cadence this band is on often, and an
  // always-red banner is one nobody reads (#139) — so it must not say "broken".
  assert.match(html, /best-effort/);
  assert.match(html, /may have been picked up since/);
});

test("stopped: past a day is still the alarm, and says the lane stopped", () => {
  const html = renderIssues(board(), Date.parse("2026-08-27T12:00:00Z"), 60);
  assert.equal(banner(html), "stamp--stale");
  assert.match(html, /This snapshot is old/);
});

test("the bands do not overlap — exactly one applies at any age", () => {
  // A page carrying two freshness verdicts at once is worse than either.
  for (const [at, want] of [[FRESH, ""], [AT, "stamp--behind"], [Date.parse("2026-08-27T12:00:00Z"), "stamp--stale"]]) {
    assert.equal(banner(renderIssues(board(), at, 60)), want, `wrong band at ${new Date(at).toISOString()}`);
  }
});

test("reports everything held back", () => {
  const html = renderIssues(board(), AT, 60);
  assert.match(html, /3 pull request\(s\)/);
  assert.match(html, /4 ranked below the 25 shown/);
});

test("an empty queue says so plainly", () => {
  const html = renderIssues(board({ items: [], withheld: { todo_total: 0 } }), AT, 60);
  assert.match(html, /Nothing claimable right now/);
});

// An unreadable board must never render as an empty one.
test("the unavailable page is not the empty-board page", () => {
  const html = renderUnavailable("feed responded 500");
  assert.match(html, /could not be read/);
  assert.match(html, /not an empty board/);
  assert.doesNotMatch(html, /Nothing claimable right now/);
  assert.match(html, /feed responded 500/);
});

test("escapes feed-supplied text", () => {
  const html = renderIssues(board({
    items: [{ repo: "r", number: 1, title: '<script>x</script>', url: 'https://e/"1', score: 1, labels: [] }],
  }), AT, 60);
  assert.doesNotMatch(html, /<script>x<\/script>/);
  assert.match(html, /&lt;script&gt;/);
});

// ── the issue queue references neither PRs nor claims (#480/#713, #7) ────────

test("the queue renders no PR tile — PRs live on their own page", () => {
  const html = renderIssues(board({ withheld: { todo_total: 10, claimed: 2, pull_requests: 0, unscored: 0, beyond_limit: 0 } }), AT, 60);
  assert.doesNotMatch(html, /PRs \(not claimable\)/);
  assert.match(html, /href="https:\/\/prs\.bounded\.tools"/);
});

test("a nonzero pull_requests count still surfaces in held-back — a regression must not hide", () => {
  assert.match(renderIssues(board(), AT, 60), /3 pull request\(s\)/);
});

// THE SPLIT (#7). The queue answers "what should I pick up" and nothing else:
// the claimed count is not a tile, not a held-back line, not a number anywhere
// on the page. What survives is a POINTER, the same shape #480 left for PRs.
test("the queue never prints the claimed count — that number is the claims page's", () => {
  const html = renderIssues(board(), AT, 60);
  assert.doesNotMatch(html, /already claimed/);
  assert.doesNotMatch(html, /2 claimed/);
  assert.match(html, /href="https:\/\/claims\.bounded\.tools"/);
  assert.match(html, /Issues — Bounded Systems/);
});

// A stale-lane board still shows a claimed count of 2 in its data; the page
// must not surface it under any state.
test("not even a stale queue leaks the claimed count", () => {
  const html = renderIssues(board(), Date.parse("2026-08-27T12:00:00Z"), 60);
  assert.doesNotMatch(html, /already claimed/);
});

// ── claims.bounded.tools (#7) ────────────────────────────────────────────────

const claims = (o = {}) => ({
  generated_at: "2026-08-25T12:00:00Z", count: 2, in_progress: 1,
  withheld: { finished: 3 },
  items: [
    { repo: "bounded-systems/prx", number: 434, title: "Cut it", url: "https://e/1", status: "In Progress", labels: [] },
    { repo: "bounded-systems/site", number: 9, title: "a <fix>", url: "https://e/2", status: "Todo", labels: [] },
  ],
  ...o,
});

test("the claims page renders rows without a marker, and the age", () => {
  const html = renderClaims(claims(), AT, 60);
  assert.match(html, /Claims — Bounded Systems/);
  // Repo, separator and number, in that order — and the accessible name now
  // carries the noun too, so a links list can tell prx#434 from prx#9.
  assert.equal(whereText(html), "— prx · issue 434");
  assert.match(html, /<span class="visually-hidden">issue <\/span>434/);
  assert.match(html, /3 hours ago/);
  assert.match(html, /a &lt;fix&gt;/);   // escaping holds
});

// #10. The fixture items still CARRY `status`, so this fails if the renderer
// starts reading it again — a weaker test would just drop the field and pass
// for the wrong reason.
test("the claims page never renders the board's Status", () => {
  const html = renderClaims(claims(), AT, 60);
  assert.doesNotMatch(html, /In Progress/);
  assert.doesNotMatch(html, /Todo/);
});

// The slot means "the board's numeric rank" on issues.bounded.tools. Claims rows
// must omit it entirely rather than render it empty, or the two pages disagree
// about what the same position means.
test("the claims page emits no rank slot at all", () => {
  // The class is defined in the shared stylesheet either way, so this must
  // match the ROW MARKUP, not the CSS — a /row__score/ regex passes on the
  // <style> block and proves nothing.
  assert.doesNotMatch(renderClaims(claims(), AT, 60), /<p class="row__score">/);
  // ...while the issue queue, which does have a rank, still emits one.
  assert.match(renderIssues(board(), AT, 60), /<p class="row__score">/);
});

// The public feed drops assignees on purpose. A page that just omitted the name
// would read as "we didn't have room"; this one says the feed cannot answer it.
test("the claims page says it cannot name the claimant, and where the name is", () => {
  const html = renderClaims(claims(), AT, 60);
  assert.match(html, /never <em>by whom<\/em>/);
  assert.match(html, /does not carry assignees/);
  assert.match(html, /claim comment on the issue/);
});

test("finished claims are held back, and counted on a tile", () => {
  const html = renderClaims(claims(), AT, 60);
  // The count is a TILE now, not a footnote: nothing removes the `claimed`
  // label, so this number only grows until someone drains it.
  assert.match(html, /finished, still labelled/);
  assert.match(html, /<div class="tile__n">3<\/div>/);
  assert.match(html, /nothing removes it/);
  assert.doesNotMatch(
    renderClaims(claims({ withheld: { finished: 0 } }), AT, 60),
    /nothing removes it/,
  );
});

test("nothing claimed says the board is free, not that it is unreadable", () => {
  const html = renderClaims(claims({ count: 0, items: [], withheld: { finished: 0 } }), AT, 60);
  assert.match(html, /Nothing is claimed right now/);
  assert.doesNotMatch(html, /could not be read/);
});

// ── prs.bounded.tools ────────────────────────────────────────────────────────

const compliance = (o = {}) =>
  ({ compliant: 0, non_compliant: 0, not_measured: 0, pending: 0, unknown: 0, ...o });

const prs = (o = {}) => ({
  generated_at: "2026-08-25T12:00:00Z", count: 2,
  compliance: compliance({ non_compliant: 1, compliant: 1 }),
  items: [
    { repo: "bounded-systems/prx", number: 1001, title: "bump the bun-major group", url: "https://e/1", labels: [], claim: "non_compliant" },
    { repo: "bounded-systems/site", number: 9, title: "a <fix>", url: "https://e/2", labels: [], claim: "compliant" },
  ],
  ...o,
});

test("the PR page renders rows, the claim state, and the age", () => {
  const html = renderPrs(prs(), AT, 60);
  assert.match(html, /PRs — Bounded Systems/);
  assert.match(html, /bump the bun-major group/);
  // The rank slot is GONE on this page: it printed `#1001` while the where-line
  // printed `prx · 1001`, the same number twice, one of them without the repo
  // that gives it meaning. The where-line is the one that survives.
  assert.equal(whereText(html), "— prx · pull request 1001 · no live claim");
  assert.doesNotMatch(html, /class="row__score"/);
  assert.match(html, /no live claim/);
  assert.match(html, /3 hours ago/);
  assert.match(html, /a &lt;fix&gt;/);
  assert.match(html, /href="https:\/\/desk\.bounded\.tools"/);
});

// THE STATES MUST NOT BE ADDED TOGETHER (#15). `no live claim` is a PR to fix;
// `not gated` is a repo that has not adopted the check. One tile holding their
// sum would make a rollout gap read as a compliance problem, and would go DOWN
// as repos adopt the gate — the wrong direction for both numbers.
test("no-live-claim and not-gated are separate tiles, never summed", () => {
  const html = renderPrs(
    prs({ compliance: compliance({ non_compliant: 3, not_measured: 5 }) }), AT, 60);
  assert.match(html, /3<\/div><div class="tile__l">no live claim/);
  assert.match(html, /5<\/div><div class="tile__l">not gated/);
  assert.doesNotMatch(html, /8<\/div>/, "the two states were summed into one tile");
});

// A compliant row carries NO suffix — the normal case must not shout, or the
// two states worth acting on stop standing out.
test("a compliant row is not annotated", () => {
  const html = renderPrs(
    prs({ items: [{ repo: "bounded-systems/prx", number: 1, title: "ok", url: "https://e/1", labels: [], claim: "compliant" }] }),
    AT, 60);
  // Was `doesNotMatch(/· /)`, which is no longer specific enough: every row's
  // where-line separates the repo from the number with one. The claim about a
  // compliant row is that NOTHING follows the number.
  assert.equal(whereText(html), "— prx · pull request 1");
});

// The Worker and the feed deploy independently, so an unrecognised or absent
// state must render, not throw or print `undefined`.
test("an unrecognised claim state renders as unknown", () => {
  const html = renderPrs(
    prs({ items: [{ repo: "bounded-systems/prx", number: 1, title: "x", url: "https://e/1", labels: [], claim: "from-a-newer-producer" }] }),
    AT, 60);
  assert.equal(whereText(html), "— prx · pull request 1 · unknown");
  assert.doesNotMatch(html, /undefined/);
});

test("the page explains that `not gated` is not a failure", () => {
  const html = renderPrs(prs(), AT, 60);
  assert.match(html, /not a failure/);
});

test("an empty PR list says the backlog is drained, not nothing", () => {
  const html = renderPrs(prs({ count: 0, compliance: compliance(), items: [] }), AT, 60);
  assert.match(html, /No open pull requests/);
});

// ── desk.bounded.tools — the overview (#7) ───────────────────────────────────

const section = (key, host, o = {}) => ({
  key, host, ok: true, count: 2, shown: 1, generated_at: "2026-08-25T12:00:00Z",
  items: [{ repo: "bounded-systems/prx", number: 434, title: `${key} row`, url: "https://e/1", note: "n" }],
  ...o,
});
const overview = (o = {}) => ({
  ok: true, generated_at: "2026-08-25T12:00:00Z", head: 5,
  sections: [
    section("issues", "issues.bounded.tools"),
    section("claims", "claims.bounded.tools"),
    section("prs", "prs.bounded.tools"),
  ],
  ...o,
});

test("the overview shows all three, each linked to the host that owns it", () => {
  const html = renderOverview(overview(), AT, 60);
  assert.match(html, /Desk — Bounded Systems/);
  for (const [h, row] of [
    ["issues.bounded.tools", "issues row"],
    ["claims.bounded.tools", "claims row"],
    ["prs.bounded.tools", "prs row"],
  ]) {
    // Literal substring checks, not regexes built from data: hand-escaping a
    // string into a pattern is a thing to get wrong (CodeQL caught exactly that
    // here — the `.` was escaped and the backslash was not), and every one of
    // these assertions only ever wanted an exact match anyway.
    assert.ok(html.includes(`href="https://${h}"`), h);
    assert.ok(html.includes(row), row);
  }
});

// Quoting the newest would let a live feed vouch for one that stopped.
test("the overview says its age is the oldest of the feeds shown", () => {
  // The subject is named in EVERY band, which is the point — the three feeds
  // have three ages and only the stalest is true of all of them. At AT this is
  // the `behind` band, which now opens with its own state word, so the subject
  // is asserted rather than one band's sentence shape.
  for (const at of [FRESH, AT, Date.parse("2026-08-27T12:00:00Z")]) {
    const html = renderOverview(overview(), at, 60);
    assert.match(html, /Oldest feed/, "the stamp stopped naming what it dates");
    assert.match(html, /<strong>oldest<\/strong>/);
  }
  assert.match(renderOverview(overview(), AT, 60), /3 hours ago/);
});

// Never a silent head: showing 1 of 2 has to say so.
test("a truncated section names the count and points at its host", () => {
  const html = renderOverview(overview(), AT, 60);
  assert.match(html, /Showing the first 1 of 2/);
});

test("a section showing everything says so instead of implying more", () => {
  const html = renderOverview(overview({
    sections: [section("issues", "issues.bounded.tools", { count: 1 })],
  }), AT, 60);
  assert.match(html, /All of them, in full/);
  assert.doesNotMatch(html, /Showing the first/);
});

// The overview is the one page that can be PARTLY unreadable. A failed section
// must not read as an empty one, and must not quietly vanish.
test("an unreadable section keeps its slot, says why, and is not shown as empty", () => {
  const html = renderOverview(overview({
    ok: false,
    sections: [
      section("issues", "issues.bounded.tools"),
      section("claims", "claims.bounded.tools"),
      { key: "prs", host: "prs.bounded.tools", ok: false, reason: "feed responded 500", count: null, items: [] },
    ],
  }), AT, 60);
  assert.match(html, /This section could not be read/);
  assert.match(html, /feed responded 500/);
  assert.match(html, /unreadable/);
  assert.doesNotMatch(html, /No open pull requests/);   // never the empty sentence
  assert.match(html, /This overview is incomplete/);
  assert.match(html, /issues row/);                     // the readable ones still render
});

test("an empty-but-readable section says the right empty sentence", () => {
  const html = renderOverview(overview({
    sections: [section("prs", "prs.bounded.tools", { count: 0, items: [] })],
  }), AT, 60);
  assert.match(html, /No open pull requests/);
  assert.doesNotMatch(html, /could not be read/);
});

test("an overview that could date nothing says that, rather than showing no stamp", () => {
  const html = renderOverview(overview({ ok: false, generated_at: null, sections: [] }), AT, 60);
  assert.match(html, /No section could be dated/);
  assert.match(html, /not that there is nothing to show/);
});

test("the overview escapes feed-supplied text", () => {
  const html = renderOverview(overview({
    sections: [section("issues", "issues.bounded.tools", {
      items: [{ repo: "r", number: 1, title: "<script>x</script>", url: 'https://e/"1', note: "n" }],
    })],
  }), AT, 60);
  assert.doesNotMatch(html, /<script>x<\/script>/);
  assert.match(html, /&lt;script&gt;/);
});

// ── every page says where the other three are ────────────────────────────────

test("each page links the other hosts and never links itself", () => {
  for (const [html, self] of [
    [renderIssues(board(), AT, 60), "issues"],
    [renderClaims(claims(), AT, 60), "claims"],
    [renderPrs(prs(), AT, 60), "prs"],
  ]) {
    for (const other of ["desk", "issues", "claims", "prs"].filter((h) => h !== self)) {
      assert.ok(html.includes(`href="https://${other}.bounded.tools"`), `${self} → ${other}`);
    }
    // Scope the negative to the cross-link footer line — the rest of the page
    // may legitimately link its own host — then check it literally.
    const also = html.match(/Also:.*?<\/p>/s)?.[0];
    assert.ok(also, `${self} renders no cross-link footer`);
    assert.ok(
      !also.includes(`href="https://${self}.bounded.tools"`),
      `${self} must not link itself in the footer`,
    );
  }
});

test("an empty section offers no 'all of them' line — there is nothing to offer", () => {
  const html = renderOverview(overview({
    sections: [section("prs", "prs.bounded.tools", { count: 0, items: [] })],
  }), AT, 60);
  assert.doesNotMatch(html, /All of them, in full/);
  assert.doesNotMatch(html, /Showing the first/);
  assert.match(html, /No open pull requests/);
});

// ── `unknown` must reach the summary (#809) ──────────────────────────────────
//
// The two problem tiles count only states the projection MEASURED, so a row it
// could not measure fell out of the summary entirely. On 2026-08-30 the live
// page read `6 open · 0 no live claim · 0 not gated` while all six PRs were
// blocked on exactly `no live claim` — the enrichment reads check-runs in each
// PR's own repo, which the projection's repo-scoped token cannot reach, so every
// cross-repo row degrades to `unknown` and both problem tiles are structurally
// zero.
//
// Per-row honesty was intact; the SUMMARY is what lied, and it is what a reader
// looks at first.
// Reads a tile's number by its LABEL, from the exact markup `tile()` emits.
// The first version of these tests asserted `/3/.test(out)` — which matches any
// "3" anywhere on the page, including a PR number — and so passed against the
// unfixed renderer. A test that passes before the fix is not evidence.
const tileFor = (out, label) => {
  const re = new RegExp(
    `<div class="tile"><div class="tile__n">(\\d+)</div><div class="tile__l">${label}</div></div>`,
  );
  const m = re.exec(out);
  return m ? Number(m[1]) : null;
};

test("an all-unknown PR board does not render as a clean one", () => {
  const feed = {
    // The feed NAME is validated by selectPrs — a guard that caught this very
    // fixture. Only the PR feed may render on this page.
    feed: "front-desk-prs-public",
    generated_at: new Date().toISOString(),
    items: [1, 2, 3].map((n) => ({
      repo: "bounded-systems/prx", number: n, title: `t${n}`, url: `https://e/${n}`,
      labels: [], claim_check: { state: "unknown", conclusion: null, url: null },
    })),
  };
  const out = renderPrs(selectPrs(feed), Date.now(), 60);

  // The failure this replaces: `3 open · 0 no live claim · 0 not gated`, with
  // nothing saying the rows were never measured.
  assert.equal(tileFor(out, "unknown"), 3, "the unmeasured rows must be counted in the summary");
  assert.equal(tileFor(out, "open"), 3);
  // And not folded into a problem tile — `unknown` and `no live claim` are
  // different answers and only one of them is a PR to fix.
  assert.equal(tileFor(out, "no live claim"), 0);
  assert.equal(tileFor(out, "not gated"), 0);
});

test("`0 unknown` is shown too — silence and 'not checked' look identical", () => {
  const feed = {
    feed: "front-desk-prs-public",
    generated_at: new Date().toISOString(),
    items: [{
      repo: "bounded-systems/prx", number: 1, title: "t", url: "https://e/1",
      labels: [], claim_check: { state: "compliant", conclusion: "success", url: "https://e/c" },
    }],
  };
  const out = renderPrs(selectPrs(feed), Date.now(), 60);
  // Rendered AT ZERO on purpose: `0 unknown` is positive evidence the rows were
  // measured, and an absent tile is indistinguishable from "not checked".
  assert.equal(tileFor(out, "unknown"), 0);
});

// ── Presentation invariants (the design pass) ───────────────────────────────
//
// CSS is not usually worth asserting. These four are, because each is a
// correctness property rather than taste, and three of them exist only because
// of what changed today.

test("the stylesheet is not broken by its own comments", () => {
  // A backtick inside a CSS comment TERMINATES the template literal the
  // stylesheet lives in, and the file then fails to parse — which is how this
  // pass first broke every test in the suite. Prose that names a CSS property
  // is exactly where that is tempting.
  const css = renderIssues(board(), AT, 60).match(/<style>([\s\S]*?)<\/style>/)[1];
  assert.ok(css.length > 200, "stylesheet rendered");
  assert.ok(!css.includes("`"), "a backtick in the stylesheet would have ended the template");
});

test("safe-area insets are respected — the app is standalone now", () => {
  // New requirement as of today: installed to the Home Screen, this page is no
  // longer inside browser chrome, so the notch and home indicator are its
  // problem. Added to the existing padding, so nothing changes on the web.
  const css = renderIssues(board(), AT, 60).match(/<style>([\s\S]*?)<\/style>/)[1];
  for (const side of ["top", "bottom", "left", "right"]) {
    assert.ok(css.includes(`env(safe-area-inset-${side})`), `missing safe-area-inset-${side}`);
  }
});

test("focus is visible", () => {
  // Links here replace the UA underline with a border-bottom, which on some
  // browsers also costs the default focus ring its contrast. The page is
  // keyboard- and switch-operable and had no explicit focus style at all.
  const css = renderIssues(board(), AT, 60).match(/<style>([\s\S]*?)<\/style>/)[1];
  assert.match(css, /:focus-visible\s*\{[^}]*outline:/);
});

test("the behind band does not shift its text relative to the other two", () => {
  // Drawn inside the border with an inset shadow rather than a thicker
  // border-left: three stamps that do not share a left edge read as three
  // components, not one control in three states.
  const css = renderIssues(board(), AT, 60).match(/<style>([\s\S]*?)<\/style>/)[1];
  assert.match(css, /\.stamp--behind\s*\{[^}]*box-shadow:\s*inset/);
  assert.ok(!/\.stamp--behind\s*\{[^}]*border-left:\s*3px/.test(css));
});

// ── desk#61: the board, checked against the REAL render ─────────────────────
//
// `test/board-live.json` is a capture of the live projection — real titles, real
// SHAs, its provenance in `_source`. These assertions run over
// `renderOverview(fixture)`, which is the same function the Worker calls, so
// what they measure is the artifact rather than a shape written to satisfy them.

const live = JSON.parse(
  await readFile(new URL("./board-live.json", import.meta.url), "utf8"),
);
const LIVE_AT = Date.parse(live.generated_at) + 3.6e6;
const liveHtml = () => renderOverview(live, LIVE_AT, 60);

test("no forty-character hex survives the render, outside the href", () => {
  const html = liveHtml();
  // GUARD THE GUARD FIRST. An empty render, or a render with no routine rows in
  // it, would pass this vacuously — and vacuous is exactly how the fixture would
  // fail if it were ever swapped for something convenient.
  assert.ok(html.length > 5000, "the render is too small to be the page");
  assert.match(html, /class="row row--routine"/);
  const body = html.replace(/href="[^"]*"/g, "");
  const long = [...body.matchAll(/[0-9a-f]{40}/g)].map((m) => m[0]);
  assert.deepEqual(long, [], "a full SHA is still being printed as text");
});

// THE CONSTRAINT THE PAGE MAY NOT BREAK, MADE MECHANICAL. Compression exists so
// that no row has to be hidden; a change that started filtering rows would make
// "Showing the first 5 of 6" false, which is the one thing this page has always
// refused to do. Delete a row from the map in overviewSection and this goes red.
test("every row the section counted is still rendered", () => {
  const html = liveHtml();
  for (const s of live.sections) {
    const sec = new RegExp(`<section class="sec" id="${s.key}"[\\s\\S]*?</section>`).exec(html);
    assert.ok(sec, `no ${s.key} section rendered`);
    const shown = [...sec[0].matchAll(/<li class="row/g)].length;
    assert.equal(shown, s.items.length, `${s.key}: ${shown} rows for ${s.items.length} items`);
    assert.equal(shown, Math.min(live.head, s.count), `${s.key}: not the head the feed asked for`);
    const more = /Showing the first (\d+) of (\d+)/.exec(sec[0]);
    if (more) assert.equal(Number(more[1]), shown, `${s.key}: the count sentence is now false`);
  }
});

test("decorative separators are hidden from assistive technology", () => {
  // The `·` between the repo and the number is decoration. A links list read
  // aloud should say "prx issue 434", not "prx dot issue 434" — and the
  // separator that survives is the one before a claim state, which is also
  // hidden and also carries no meaning of its own.
  const html = liveHtml();
  const dots = [...html.matchAll(/·/g)];
  assert.ok(dots.length >= 10, `only ${dots.length} separators — nothing to check`);
  for (const m of dots) {
    const before = html.slice(Math.max(0, m.index - 40), m.index);
    assert.match(before, /aria-hidden="true">\s*$/, `a · escaped aria-hidden near: ${before.slice(-60)}`);
  }
});

test("the accessible name of a row carries the repo and the number", () => {
  // It used to be the bare title. In a links list that made prx#434 and prx#348
  // indistinguishable, and this page's longest two titles are near-identical
  // dependabot bumps.
  const html = liveHtml();
  assert.match(html, /<span class="visually-hidden"> — <\/span>prx/);
  assert.match(html, /<span class="visually-hidden">issue <\/span>434/);
  assert.match(html, /<span class="visually-hidden">pull request <\/span>1088/);
  // And the rank slot says what it is, which differs per section.
  assert.match(html, /<span class="visually-hidden">Board score <\/span>17\.30/);
});

test("the rows are a list, and each section is a named landmark", () => {
  const html = liveHtml();
  // role="list" beside <ol> is a Safari/VoiceOver workaround: list-style:none
  // strips the list role there, and with it the "list of 5 items" a reader is
  // told. Asserted on the markup, since no stylesheet regex could see it.
  assert.match(html, /<ol class="board board--railed" role="list">/);
  assert.doesNotMatch(html, /<div class="row"/, "a row is a list item now");
  for (const s of live.sections) {
    assert.match(html, new RegExp(`<section class="sec" id="${s.key}" aria-labelledby="${s.key}-h">`));
    assert.match(html, new RegExp(`<h2 id="${s.key}-h">`));
  }
});

test("all three sections reserve the rank rail, including the one with no ranks", () => {
  // Measured on the live page: the title's left edge was 90px under Issues and
  // PRs and 20px under Claims, because the public claims feed publishes no
  // status and those rows render no marker. The board reserves the track; the
  // row still emits nothing into it, so the slot's meaning is unchanged.
  const html = liveHtml();
  const claims = /<section class="sec" id="claims"[\s\S]*?<\/section>/.exec(html)[0];
  assert.match(claims, /<ol class="board board--railed"/);
  assert.doesNotMatch(claims, /class="row__score"/, "a claims row invented a marker");
  assert.equal([...html.matchAll(/class="board board--railed"/g)].length, 3);
});

// ── Freshness, told apart without colour ────────────────────────────────────

test("each freshness band names itself in words and in an attribute", () => {
  // box-shadow is not painted under forced-colors and every colour is replaced,
  // so `behind`'s inset edge vanished and the three bands became identical but
  // for a 3px indent — with `behind` carrying no state word at all. The
  // attribute exists so a test can assert the BAND without matching the
  // stylesheet, which is the trap `banner()` above was written for.
  const want = [
    [FRESH, "fresh"],
    [AT, "behind"],
    [Date.parse("2026-08-27T12:00:00Z"), "stale"],
  ];
  const opening = new Set();
  for (const [at, band] of want) {
    const html = renderIssues(board(), at, 60);
    const m = /<div class="stamp[^"]*" data-freshness="([a-z]+)">\s*(?:<strong>([^<]*)<\/strong>)?/.exec(html);
    assert.ok(m, `no dated stamp rendered at ${band}`);
    assert.equal(m[1], band);
    if (band !== "fresh") {
      assert.ok(m[2], `the ${band} band opens with no state word`);
      opening.add(m[2]);
    }
  }
  // Distinct sentences, not the same one twice: "behind" and "stopped" are
  // different claims and a reader who cannot see the band has only these.
  assert.equal(opening.size, 2, `the two alarming bands open with: ${[...opening].join(" / ")}`);
});

test("forced-colors tells the bands apart by something that is not a colour", () => {
  const css = /<style>([\s\S]*?)<\/style>/.exec(renderIssues(board(), AT, 60))[1];
  const fc = /@media \(forced-colors: active\) \{([\s\S]*?)\n    \}/.exec(css);
  assert.ok(fc, "no forced-colors block");
  // Widths, not colours: colours and shadows are all replaced by the UA.
  assert.match(fc[1], /\.stamp--behind\s*\{[^}]*border-inline-start-width:\s*4px/);
  assert.match(fc[1], /\.stamp--stale\s*\{[^}]*border-width:\s*3px/);
  assert.doesNotMatch(fc[1], /box-shadow/, "box-shadow is not painted under forced-colors");
});

// A COUNTER-TEST, NOT A MEDIA BLOCK ASSERTING ITSELF. src/*.js declares no
// transition, animation or scroll-behavior today, so shipping a
// prefers-reduced-motion block would be dead CSS that no test could tell from a
// correct one — the exact self-scaffolding shape this repo keeps hitting. What
// is enforceable is the RULE: any future motion ships with its guard in the same
// commit. Currently 0 === 0; red on the first unguarded declaration.
test("no motion ships without a reduced-motion guard", async () => {
  const files = ["src/render.js", "src/worker.js"];
  let declared = 0, guarded = 0;
  for (const f of files) {
    const css = (await readFile(f, "utf8")).replace(/\/\*[\s\S]*?\*\//g, "");
    declared += [...css.matchAll(/(?:^|[;{\s])(transition|animation|scroll-behavior)\s*:/g)].length;
    for (const m of css.matchAll(/@media \(prefers-reduced-motion[^)]*\)\s*\{([\s\S]*?)\n\s{0,6}\}/g)) {
      guarded += [...m[1].matchAll(/(?:^|[;{\s])(transition|animation|scroll-behavior)\s*:/g)].length;
    }
  }
  assert.equal(declared, guarded, `${declared} motion declarations, ${guarded} inside a reduced-motion guard`);
});
