// The four pages, and the one thing they all have to get right.
//
// FRESHNESS IS COMPUTED AT REQUEST TIME. This is the whole reason the desk is an
// app rather than a page. gen-desk.mjs deliberately refused to print "3 hours
// ago" because a static build cannot: the phrase would be a lie the moment the
// page was cached, so it could only state the stamp and let the reader judge.
// Here the age is computed against the reader's request, so the relative phrase
// is true when it is read — and the absolute stamp is printed beside it anyway,
// because the edge cache means "now" is only accurate to within EDGE_TTL.
//
// The staleness threshold matches front-desk.sh and gen-desk.mjs: the lane
// publishes hourly, so the number worth reacting to is not "this is old" but
// "the lane stopped and nobody noticed".
//
// ONE QUESTION PER PAGE. issues.bounded.tools no longer mentions claims at all —
// not a tile, not a held-back line — because a queue of what to pick up and a
// register of what is already taken are different questions, and the page that
// tried to answer both answered neither cleanly. This is the same move #480/#713
// made when PRs left the desk: the count does not vanish, it moves to the host
// that owns it, and a footer line says where.

import { LIGHT, DARK, vars } from "./palette.js";
import { scaleVars } from "./scale.js";
import { compress } from "./title.js";

// TWO BANDS, BECAUSE ONE THRESHOLD CANNOT SAY BOTH THINGS.
//
// The single 24h threshold was set against the lane's DECLARED cadence — "the
// lane publishes hourly, so the number worth reacting to is the lane stopping".
// Measured 2026-08-30, the declared cadence is not the real one. GitHub delivers
// scheduled workflows best-effort and drops slots under load, and every hourly
// cron in the org is shredded:
//
//   front-desk-projection   36 of ~106 slots over 106h   (~34%)
//   front-desk-sync         one per 3.36h                (~30%)
//   pr-projection           one per 6.05h                (~17%)
//   front-desk-feed publish gaps of 2h41m, 5h09m, 6h25m  and widening
//   repo-health-projection  DAILY — one per 24.48h       (~98%)
//
// So a 6h-old board is NORMAL, not broken — and on 2026-08-30 a 6h25m-old board
// rendered with no indication at all, because it sat far below 24h. That is the
// gap: "current" and "the lane stopped" are not the only two states, and the one
// in between is the one a reader actually meets.
//
// Tightening the single threshold would not fix it. At the measured cadence a 2h
// alarm would be on almost always, and an always-red banner is one nobody reads
// (#139) — the same reason claim-sweep's staleness rule and dispatch-liveness
// both refuse to alarm on their normal state.
//
// BEHIND is therefore informational and STOPPED is the alarm. The first says
// "this may have moved since"; the second says "nobody is publishing".
const BEHIND_AFTER_HOURS = 2;
const STALE_AFTER_HOURS = 24;

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** "44 minutes", "3 hours", "2 days" — the largest unit that is still honest. */
function humanAge(ms) {
  const min = Math.floor(ms / 60000);
  if (min < 1) return "less than a minute";
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"}`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} hour${h === 1 ? "" : "s"}`;
  return `${Math.floor(h / 24)} days`;
}

const hoursSince = (generatedAt, now) => (now - Date.parse(generatedAt)) / 36e5;
const isStale = (generatedAt, now) => hoursSince(generatedAt, now) > STALE_AFTER_HOURS;
const isBehind = (generatedAt, now) => hoursSince(generatedAt, now) > BEHIND_AFTER_HOURS;

function stamp(generatedAt, now, edgeTtlSeconds, what = "Board", extra = "") {
  const ageMs = now - Date.parse(generatedAt);
  const when = esc(generatedAt);
  if (isStale(generatedAt, now)) {
    return `<div class="stamp stamp--stale" data-freshness="stale">
        <strong>This snapshot is old.</strong> ${esc(what)} projected at <span class="mono">${when}</span>,
        ${esc(humanAge(ageMs))} ago — more than ${STALE_AFTER_HOURS} hours. The projection lane publishes
        hourly, so this means it stopped. Treat what follows as history, not as the board.${extra}
      </div>`;
  }
  if (isBehind(generatedAt, now)) {
    // A STATE WORD, because the band cannot be the only thing that says which
    // state this is. `stale` has always opened with one; `behind` opened with
    // the timestamp, and its distinguishing mark was an inset box-shadow —
    // which forced-colors does not paint. So a forced-colors reader met
    // "behind" and "fresh" as the same banner. The sentence says it now, and
    // data-freshness lets a test assert the band without matching the
    // stylesheet (the trap render.test.mjs's `banner()` helper exists for).
    return `<div class="stamp stamp--behind" data-freshness="behind">
        <strong>${esc(what)} is behind.</strong> Projected at <span class="mono">${when}</span>,
        <strong>${esc(humanAge(ageMs))} ago</strong>.
        The publishing lane is scheduled hourly, but GitHub runs scheduled workflows best-effort and
        drops slots under load — measured delivery is well under half, so gaps of several hours are
        normal rather than a fault. Work listed here may have been picked up since.${extra}
      </div>`;
  }
  // THE OLD SENTENCE HERE WAS FALSE AND IT MATTERED (#809). It read "cached at
  // the edge for up to Ns, so this age is accurate to within that window" — but
  // the age is the SNAPSHOT's age, and how far the snapshot trails the newest
  // one is set by the publishing lane, not by this cache. The feed also carries
  // its own 300s cache upstream. I used that sentence to decide a change should
  // be visible, and it was wrong by hours.
  //
  // What the edge TTL actually bounds is how stale the *rendered page* is
  // relative to the feed, which is the smaller and less interesting number. Say
  // that, rather than promising something this page cannot know.
  return `<div class="stamp" data-freshness="fresh">
        ${esc(what)} projected at <span class="mono">${when}</span>, ${esc(humanAge(ageMs))} ago.
        Read live per request and cached at the edge for up to ${edgeTtlSeconds}s; the age shown is
        the snapshot's own, and how far it trails the newest one depends on when the publishing lane
        last ran.${extra}
      </div>`;
}

const tile = (n, l) =>
  `<div class="tile"><div class="tile__n">${esc(n)}</div><div class="tile__l">${esc(l)}</div></div>`;

const shortRepo = (r) => String(r).replace(/^bounded-systems\//, "");

/** Text for assistive technology only — see `.visually-hidden` in STYLE. */
const vh = (s) => `<span class="visually-hidden">${esc(s)}</span>`;

/**
 * One list row: an optional left-hand marker, and ONE link carrying the title
 * and where it lives.
 *
 * THE WHOLE ROW BODY IS THE LINK, AND THAT IS THE POINT. It was a 16–21px line
 * box around the title text alone — measured, 60 of 60 links on the live page
 * were under the 24px WCAG 2.2 floor, and `elementFromPoint` at a row's
 * top-right corner returned the row rather than the anchor, so the right-hand
 * two-thirds of every row was dead space. A block link with a `--control-md`
 * floor makes the target the thing a reader is actually aiming at.
 *
 * THE ACCESSIBLE NAME NOW CARRIES THE REPO AND THE NUMBER. It used to be the
 * bare title, so in a links list `prx#434` and `prx#348` were indistinguishable
 * — and this page's two longest titles are near-identical dependabot bumps. The
 * `— ` and the noun are literal text inside the name rather than a hoped-for
 * boundary from `display:block`, because whether a screen reader inserts one is
 * not a property this page controls.
 *
 * The `·` is decoration and is hidden from assistive tech; the noun differs per
 * page ("issue", "pull request") and is passed in rather than guessed.
 *
 * `marker` is null on the claims page (#10) and the slot is then omitted
 * entirely rather than rendered empty. The slot means "the board's numeric
 * rank" on issues.bounded.tools, so filling it with anything else — as the
 * claims page did with `Status` — makes the two pages disagree about what the
 * same position means. The rail's WIDTH is reserved by the board (see
 * `.board--railed`), so a markerless row still lines up with its neighbours
 * without an empty element being emitted to do it.
 *
 * The marker stays OUTSIDE the anchor: it is not what you navigate to, and the
 * `<ol>` already announces position.
 */
const row = ({ marker, markerLabel = "", title, url, repo, number, noun, suffix = "" }) => {
  const c = compress(title);
  const routine = c.kind !== "plain";
  return `<li class="row${routine ? " row--routine" : ""}">${
    marker == null ? "" : `\n        <p class="row__score">${vh(markerLabel + " ")}${esc(marker)}</p>`
  }
        <a class="row__link" href="${esc(url)}">
          <span class="row__title">${
            routine
              ? `<span class="row__subject">${esc(c.subject)}</span> <span class="row__delta">${esc(c.delta)}</span>`
              : esc(title)
          }</span>
          <span class="row__where">${vh(" — ")}${esc(shortRepo(repo))}${
            number == null
              ? ""
              : `<span aria-hidden="true"> · </span>${vh(noun + " ")}${esc(number)}`
          }${suffix ? `<span aria-hidden="true"> · </span>${esc(suffix)}` : ""}</span>
        </a>
      </li>`;
};

/**
 * The rows, as a list.
 *
 * `<ol>` rather than `<ul>` on all four pages: the order carries information on
 * every one of them — ranked, most-recently-claimed, newest-first.
 *
 * `role="list"` beside it is not redundant decoration: `list-style:none` strips
 * the list role in Safari/VoiceOver, so without it the count a reader is told
 * ("list of 5 items") disappears on the browser this page is most often read in.
 * It is a workaround for a browser, not a spec requirement, and if the org would
 * rather not carry redundant ARIA the alternative is `list-style-type:"\200B"`.
 *
 * `railed` reserves the marker track WITHOUT emitting an element into it. That
 * is the difference from a spacer: the slot's meaning is still "the board's
 * numeric rank", a page with no rank still emits nothing, and the four pages
 * still line their titles up. Measured on the live overview, the title's left
 * edge was 90px in the issues and prs sections and 20px in claims — a 70px
 * discontinuity down a page whose whole job is to be scanned in one pass.
 */
const board = (rows, railed = false) =>
  `<ol class="board${railed ? " board--railed" : ""}" role="list">
        ${rows.join("\n        ")}
      </ol>`;

// THE COLOURS ARE NO LONGER TYPED HERE. Six of the light eight are brand tokens
// now (src/tokens.js, generated from @bounded-systems/brand); the other two and
// the whole dark scheme have nothing to pin to, and src/palette.js says which
// and why for each. Both schemes go through one writer so a role cannot be added
// to one block and forgotten in the other — the two lines used to be independent
// prose, and nothing checked that they declared the same set.
const STYLE = `
    :root { ${vars(LIGHT)} ${scaleVars()} }
    @media (prefers-color-scheme: dark) {
      :root { ${vars(DARK)} }
    }
    * { box-sizing: border-box; }
    body { margin:0; background:var(--bg); color:var(--fg);
      font:var(--text-body)/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
      /* Prevents iOS enlarging body text in landscape, which reflows the tile
         row into something the layout was not measured against. */
      -webkit-text-size-adjust:100%; }
    /* SAFE AREAS ARE NEW AS OF TODAY (#766). Until this page became an
       installable standalone app it was always inside browser chrome, which
       handles the notch and the home indicator for you. Installed, it is not:
       content runs under both. The insets are ADDED to the existing padding
       rather than replacing it, so nothing changes on the web. */
    .wrap { max-width:52rem; margin:0 auto;
      padding:var(--wrap-top) var(--wrap-side) var(--wrap-bottom);
      padding-left:calc(var(--wrap-side) + env(safe-area-inset-left));
      padding-right:calc(var(--wrap-side) + env(safe-area-inset-right));
      padding-top:calc(var(--wrap-top) + env(safe-area-inset-top));
      padding-bottom:calc(var(--wrap-bottom) + env(safe-area-inset-bottom)); }

    /* Text for assistive technology and nothing else. clip-path rather than
       clip: the latter is deprecated and a 1px box with overflow:hidden alone
       still gets read as an empty line by some screen readers. */
    .visually-hidden { position:absolute; width:1px; height:1px; margin:-1px; padding:0;
      overflow:hidden; clip-path:inset(50%); white-space:nowrap; border:0; }

    /* FOCUS WAS INVISIBLE, and this page is now keyboard- and switch-operable
       in a way it was not: links here suppress the UA underline in favour of a
       drawn one, which also suppresses the default focus ring's contrast on
       some browsers. One explicit rule for everything focusable. */
    :focus-visible { outline:2px solid var(--accent); outline-offset:2px; border-radius:var(--radius-focus); }
    h1 { font-size:var(--text-h2); margin:0 0 var(--space-1); letter-spacing:-.01em; }
    h2 { font-size:var(--text-lead); margin:0; letter-spacing:-.005em; }
    /* A REAL UNDERLINE, and a target with a floor. The border-bottom this
       replaces sat below the descenders, could not skip ink, and — once a
       heading wrapped — drew one rule per line box with gaps between them.
       What takes this link over the 24px WCAG 2.2 target floor is the
       inline-block and its padding, on the taller --text-lead step: measured,
       all three section headings were 21px and are now 36. The min-height is a
       FLOOR, not the cause — at today's type size it does not bind, and
       deleting it changes nothing measurable. It is here so a future smaller
       heading cannot quietly drop back under the floor. */
    h2 a { color:inherit; display:inline-block; padding-block:var(--space-1);
      min-height:var(--min-tap-target);
      text-decoration:underline; text-decoration-color:var(--line);
      text-decoration-thickness:1px; text-underline-offset:.18em;
      text-decoration-skip-ink:auto; }
    h2 a:hover { text-decoration-color:var(--accent); }
    .lede { color:var(--muted); margin:0 0 var(--space-7); }
    .mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:var(--mono-optical); }
    .muted { color:var(--muted); font-size:var(--text-meta); }
    .stamp { border:1px solid var(--line); background:var(--card); border-radius:var(--radius-sm);
      padding:var(--space-3) var(--space-4); margin-bottom:var(--space-6);
      font-size:var(--text-meta); color:var(--muted); }
    .stamp--stale { border-color:var(--warn); background:var(--warnbg); color:var(--warn); }
    /* Informational, not an alarm: a distinct left edge rather than the warn
       ground, so "behind" never reads as "broken" at a glance. */
    /* The thicker edge is drawn INSIDE the existing 1px border, not added to it:
       a plain border-left:3px would shift the text 2px relative to the fresh and
       stale bands, and three stamps that do not share a left edge read as three
       different components rather than one control in three states. */
    .stamp--behind { box-shadow:inset 3px 0 0 var(--accent); padding-left:calc(var(--space-4) + 3px); }
    /* minmax(0,1fr) as the floor, with auto-fit doing the wrapping: the PR page
       carries FOUR tiles since #29 added unknown, and at a 7.5rem minimum the
       fourth wrapped alone onto its own row on a phone — one number stranded
       under three, which reads as more important rather than merely later.
       A 2x2 at narrow widths keeps them a set. */
    .desk__tiles { display:grid; gap:var(--space-3); margin-bottom:var(--space-7);
      grid-template-columns:repeat(auto-fit,minmax(min(100%,7.5rem),1fr)); }
    @media (max-width:26rem) { .desk__tiles { grid-template-columns:repeat(2,1fr); } }
    .tile { border:1px solid var(--line); background:var(--card); border-radius:var(--radius-sm);
      padding:var(--space-3) var(--space-4); }
    .tile__n { font-size:var(--text-h3); font-weight:650; line-height:1.1; }
    .tile__l { color:var(--muted); font-size:var(--text-small); margin-top:var(--space-1); }

    /* ── THE BOARD ───────────────────────────────────────────────────────────
       GRID, NOT FLEX, for two reasons flex could not give: the marker must be a
       fixed track the title cannot push around, and a page with no marker needs
       the track GONE rather than empty. The named lines are declared on the base
       rule as well as the railed one so a lookup can never fall through to an
       implicit column. */
    .board { list-style:none; margin:0; padding:0; }
    .row { display:grid; grid-template-columns:[score] 0 [link] minmax(0,1fr);
      column-gap:0; align-items:start; border-top:1px solid var(--line); }
    .board--railed .row { grid-template-columns:[score] var(--rail-width) [link] minmax(0,1fr);
      column-gap:var(--space-3); }
    .row__score { grid-column:score; grid-row:1; margin:0; padding-top:var(--space-3);
      font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
      font-size:var(--text-small); color:var(--accent);
      text-align:right; font-variant-numeric:tabular-nums; }
    .row__link { grid-column:link; grid-row:1; display:block;
      min-height:var(--control-md); padding:var(--space-3) 0;
      color:inherit; text-decoration:none; }
    /* THE UNDERLINE IS ON THE TITLE, NOT A BORDER ON THE ROW. Once the anchor
       became a block, a border-bottom would have drawn one full-width rule under
       every row; and on a wrapping title the old border drew one disconnected
       segment per line. Kept AT REST rather than on hover only: the title is
       color:inherit, so with no underline the only thing marking a link would
       be colour — WCAG 1.4.1. */
    .row__title { display:block; overflow-wrap:anywhere;
      text-decoration:underline; text-decoration-color:var(--line);
      text-decoration-thickness:1px; text-underline-offset:.18em;
      text-decoration-skip-ink:auto; }
    .row__link:hover .row__title { text-decoration-color:var(--accent); }
    .row__where { display:block; margin:var(--space-1) 0 0; color:var(--muted);
      font-size:var(--text-small);
      font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }

    /* A question's text is CALLER-SUPPLIED and routinely carries an unbreakable
       token — a SHA, a run URL, an id. Left to wrap normally that sets the
       page's min-content width to the length of the token, and Chromium widens
       the layout viewport and scales the whole page down to fit it: the exact
       defect the layout suite was built for (#61). Same rule the board title
       already carries, for the same reason. */
    /* The rule is on the CARD, not on the prompt: the prompt, the choices, the
       answer and the declared default are ALL caller-supplied, and measured at
       320px a single unwrapped choice in .mono widened the layout viewport to
       381 on its own. Scoping it to one child is how that gets missed again. */
    .q { margin:0 0 var(--space-7); overflow-wrap:anywhere; }
    .q__prompt { margin:0 0 var(--space-3); }
    .q__value { margin:0 0 var(--space-3); }
    .q__value-t { font-weight:650; }

    /* Tier C — routine. DEMOTED, never hidden, never truncated: a dependabot row
       is still a row, its count is still in the section head, and its SHAs are
       what tell four otherwise identical rows apart. The underline comes off
       here because the link is the whole body of a list row rather than a link
       inside a paragraph, and --muted on --bg measures 5.39:1 light /
       7.08:1 dark, so the demoted text still clears AA on its own. */
    .row--routine .row__link { padding:var(--space-2) 0; }
    .row--routine .row__score { color:var(--muted); }
    .row--routine .row__title { font-size:var(--text-meta); line-height:1.35;
      text-decoration:none; color:var(--muted); }
    .row--routine .row__subject { color:var(--fg); }
    .row--routine .row__delta { font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
      font-size:var(--text-label); color:var(--muted); white-space:nowrap; }

    .sec { margin:0 0 var(--space-8); }
    .sec__head { display:flex; align-items:baseline; justify-content:space-between; gap:var(--space-4);
      padding-bottom:var(--space-2); border-bottom:2px solid var(--line); }
    .sec__n { margin:0; font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
      font-size:var(--text-small); color:var(--muted); flex:none; }
    .sec__more { margin:var(--space-2) 0 0; }
    footer { margin-top:var(--space-10); padding-top:var(--space-5); border-top:1px solid var(--line); }
    .notify { margin-top:var(--space-10); padding:var(--space-4) var(--space-5); border:1px solid var(--line);
              border-radius:var(--radius-sm); background:var(--card); }
    .notify h2 { margin:0 0 var(--space-1); }
    .notify p { margin:var(--space-1) 0; }
    /* min-height is control.md: the platform touch-target floor, which the
       design system already owns and documents (WCAG 2.2 SC 2.5.5 AAA). It was
       typed here as 44px beside a comment re-deriving that rationale, which is
       the same hand-transcription palette.js exists to stop. */
    .notify button { font:inherit; padding:var(--space-2) var(--space-4); min-height:var(--control-md);
                     border-radius:var(--radius-sm);
                     cursor:pointer; border:1px solid var(--accent);
                     background:var(--accent); color:var(--bg); }
    .notify button:disabled { opacity:.6; cursor:default; }

    /* ── FORCED COLOURS ──────────────────────────────────────────────────────
       box-shadow IS NOT PAINTED under forced-colors and every colour is
       replaced, so behind's inset edge vanished and the three freshness bands
       became identical but for a 3px indent. The stale band at least opened with
       a state word; the behind band had none at all, so for a
       forced-colors reader "behind" and "fresh" were the same banner — state
       carried by colour alone, WCAG 1.4.1. Border WIDTHS are not forced, so the
       bands are told apart by a property that survives.

       There is deliberately NO prefers-reduced-motion block: src/*.js declares
       no transition, animation or scroll-behavior, so one would be dead CSS that
       no test could tell from a correct one. The rule is that any future
       transition ships with its guard in the same commit, and render.test.mjs
       enforces that as a counter-test rather than as a media block asserting
       itself. */
    @media (forced-colors: active) {
      .stamp--behind { border-inline-start-width:4px; }
      .stamp--stale { border-width:3px; }
      :focus-visible { outline-color:Highlight; }
    }`;


/**
 * The app-shell head, desk only (#51).
 *
 * THE MANIFEST WAS NEVER LINKED. The Worker has served /manifest.webmanifest
 * since #766, and nothing referenced it — so no browser ever read it. That is
 * why iOS installed the app as a grey letter "D": with no manifest reachable it
 * had neither an icon nor a name to work from, and fell back to the first
 * character of the title. A file served but unlinked is a file that does not
 * exist, and the read-back probe that checked /manifest.webmanifest answered 200
 * could not see the difference.
 *
 * apple-touch-icon is separate and not redundant: iOS reads it for the Home
 * Screen and does not take manifest icons for that purpose.
 */
const APP_HEAD = `
  <link rel="manifest" href="/manifest.webmanifest">
  <link rel="apple-touch-icon" href="/icon-460.png">
  <link rel="icon" type="image/svg+xml" href="/icon.svg">`;

function page(title, description, body, headExtra = "") {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <!-- viewport-fit=cover is what MAKES the safe-area padding below do anything.
       env(safe-area-inset-*) resolves to 0 without it, so the insets #33 added
       have been inert since they were written: iOS letterboxed the page instead
       of letting it reach the edges, and the padding they compute was always
       plus-zero. The CSS was right and unreachable. -->
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}">
  <!-- Per scheme, because one value cannot be right in both: the bar above the
       page should match the PAGE, not the brand. The manifest's splash colour
       has no such option — one value serves both launches, which is why it is
       the brand green rather than either page background. -->
  <meta name="theme-color" media="(prefers-color-scheme: light)" content="${LIGHT.bg}">
  <meta name="theme-color" media="(prefers-color-scheme: dark)" content="${DARK.bg}">${headExtra}
  <style>${STYLE}</style>
</head>
<body>
  <main class="wrap">
${body}
  </main>
</body>
</html>
`;
}

/** The shared footer line: every page says where the other three are. */
function elsewhere(self) {
  const links = [
    ["desk", "https://desk.bounded.tools", "everything at a glance"],
    ["issues", "https://issues.bounded.tools", "what to pick up"],
    ["claims", "https://claims.bounded.tools", "what is already taken"],
    ["prs", "https://prs.bounded.tools", "what is awaiting a check"],
  ].filter(([k]) => k !== self);
  return `<p class="muted">Also: ${links
    .map(([k, href, what]) => `<a href="${href}">${esc(k)}.bounded.tools</a> — ${esc(what)}`)
    .join("; ")}.</p>`;
}

// ── issues.bounded.tools ─────────────────────────────────────────────────────

// No claims tile and no claims line (this change), and no PR tile (#480): each
// belongs to a host that answers for it. `heldBack` still names pull_requests
// DEFENSIVELY — it renders only when the count is nonzero, which after the feed
// change means an upstream regression, and a page that quietly hides that is how
// it goes unnoticed. `claimed` is deliberately NOT in that list: a nonzero count
// there is the normal state of a healthy board, so printing it would be noise
// rather than a signal, and it is the claims page's number now.
function issueTiles(d) {
  const w = d.withheld || {};
  return `<div class="desk__tiles">
        ${tile(d.items.length, "shown")}
        ${tile(w.todo_total ?? "?", "not started")}
      </div>`;
}

function issueRows(d) {
  if (!d.items.length) {
    return `<div class="stamp">
        <strong>Nothing claimable right now.</strong> Everything on the board is claimed,
        finished, or waiting on a check.
      </div>`;
  }
  // "prx &middot; 434", not "bounded-systems/prx#434": the org prefix is identical on
  // every row and pure noise in a list built to be scanned. The title already
  // links to the issue; this line only says where it lives.
  return board(
    d.items.map((i) =>
      row({
        marker: i.score.toFixed(2),
        markerLabel: "Board score",
        title: i.title,
        url: i.url,
        repo: i.repo,
        number: i.number,
        noun: "issue",
      }),
    ),
    true,
  );
}

function issuesHeldBack(d) {
  const w = d.withheld || {};
  // Never a silent cap: if the list is truncated, the page says by how much.
  const held = [
    w.pull_requests
      ? `${w.pull_requests} pull request(s), which are changes awaiting a check rather than work to pick up`
      : null,
    w.unscored ? `${w.unscored} unranked by the board` : null,
    w.beyond_limit ? `${w.beyond_limit} ranked below the ${d.limit} shown` : null,
  ].filter(Boolean);
  return held.length ? `<p class="muted">Held back: ${esc(held.join("; "))}.</p>` : "";
}

/** The claimable queue, ranked — issues.bounded.tools. */
export function renderIssues(d, now = Date.now(), edgeTtlSeconds = 60) {
  const description =
    "What is worth picking up next, ranked by the Front Desk board itself — the same projection a session reads before it claims work.";
  return page(
    "Issues — Bounded Systems",
    description,
    `    <h1>Issues</h1>
    <p class="lede">${esc(description)}</p>
      ${stamp(d.generated_at, now, edgeTtlSeconds)}
      ${issueTiles(d)}
      ${issueRows(d)}
      <footer>${issuesHeldBack(d)}<p class="muted">Work already spoken for is not listed here — it lives at <a href="https://claims.bounded.tools">claims.bounded.tools</a>.</p>${elsewhere("issues")}</footer>`,
  );
}

// ── claims.bounded.tools ─────────────────────────────────────────────────────

/** What is currently claimed — claims.bounded.tools. */
export function renderClaims(d, now = Date.now(), edgeTtlSeconds = 60) {
  const description =
    "What is already spoken for — every open board row carrying a claim, so a session can see what not to start.";
  const list = d.items.length
    ? board(
        d.items.map((i) =>
          row({ marker: null, title: i.title, url: i.url, repo: i.repo, number: i.number, noun: "issue" }),
        ),
      )
    : `<div class="stamp">
        <strong>Nothing is claimed right now.</strong> Every open row on the board is free to pick up.
      </div>`;
  const held = (d.withheld || {}).finished
    ? `<p class="muted"><strong>Finished, still labelled</strong> counts claims on work the board calls Done or
        GitHub calls closed. They are held out of the list — a finished claim is a record, not a reservation —
        but they are counted, because the claim doors write the <code>claimed</code> label and nothing removes it,
        so the number only grows until someone drains it.</p>`
    : "";
  return page(
    "Claims — Bounded Systems",
    description,
    `    <h1>Claims</h1>
    <p class="lede">${esc(description)}</p>
      ${stamp(d.generated_at, now, edgeTtlSeconds)}
      <div class="desk__tiles">
        ${tile(d.count, "claimed")}
        ${tile((d.withheld || {}).finished ?? 0, "finished, still labelled")}
      </div>
      ${list}
      <footer>${held}<p class="muted">This page says <em>that</em> a row is claimed, never <em>by whom</em>: the public feed
        does not carry assignees, on purpose — it publishes the board's ranking, not a roster of who is
        working on what. The claimant is named in the claim comment on the issue itself.</p>${elsewhere("claims")}</footer>`,
  );
}

// ── prs.bounded.tools ────────────────────────────────────────────────────────

/**
 * How each claim state reads on a row.
 *
 * `compliant` is deliberately BLANK. It is the normal case, and annotating it
 * would make the page a wall of ticks in which the two states worth acting on
 * do not stand out. A blank suffix here means "the gate verified a live claim".
 */
const CLAIM_SUFFIX = {
  compliant: "",
  non_compliant: "no live claim",
  not_measured: "not gated",
  pending: "checking",
  unknown: "unknown",
};

/** The open PRs, prs.bounded.tools (#480/#713): newest first, per repo. */
export function renderPrs(d, now = Date.now(), edgeTtlSeconds = 60) {
  const description =
    "Every open pull request in the org's public repos — changes awaiting a check, projected from the same board as the desk.";
  const c = d.compliance;
  // NO RANK SLOT HERE ANY MORE. It printed `#1088` while the where-line printed
  // `prx · 1088` — the same number twice on every row, one of them stripped of
  // the repo that gives it meaning. The where-line is the one that survives,
  // and dropping the marker costs no row height because the row is a grid whose
  // first track collapses when the board is not railed.
  const list = d.items.length
    ? board(
        d.items.map((i) =>
          row({
            marker: null,
            title: i.title,
            url: i.url,
            repo: i.repo,
            number: i.number,
            noun: "pull request",
            suffix: CLAIM_SUFFIX[i.claim] ?? CLAIM_SUFFIX.unknown,
          }),
        ),
      )
    : `<div class="stamp"><strong>No open pull requests.</strong> The backlog is drained.</div>`;

  // THE TILE THAT USED TO BE HERE COULD NOT BE NON-ZERO (#15). It counted the
  // `claimed` label ON THE PULL REQUEST, and the claim convention never writes
  // one there — both doors write onto an ISSUE. So the page reported "0 claimed"
  // as though it had measured something. These two count what that tile was
  // reaching for, and they are kept APART on purpose: `no live claim` is a PR to
  // fix, `not gated` is a repo that has not adopted the check yet, and adding
  // them together would make a rollout gap look like a compliance problem.
  //
  // `unknown` IS SHOWN, AND THAT IS THE SAME DEFECT ONE LEVEL DOWN (#809). The
  // two tiles above count only states the projection MEASURED, so a row it could
  // not measure fell out of the summary entirely — and on 2026-08-30 the page
  // read `6 open · 0 no live claim · 0 not gated` while all six were blocked on
  // exactly `no live claim`. The enrichment reads check-runs in each PR's OWN
  // repo, which the projection's repo-scoped token cannot reach, so every
  // cross-repo row degrades to `unknown` and both problem tiles are structurally
  // zero.
  //
  // Per-row honesty was intact — each said `unknown` — but the SUMMARY is what a
  // reader looks at first, and it said the queue was clean. Exactly the shape the
  // paragraph above describes, recurring because the fix counted the states it
  // knew about rather than every row.
  //
  // Shown even at zero, deliberately: `0 unknown` is positive evidence that the
  // rows WERE measured, and silence is indistinguishable from "not checked".
  return page(
    "PRs — Bounded Systems",
    description,
    `    <h1>PRs</h1>
    <p class="lede">${esc(description)}</p>
      ${stamp(d.generated_at, now, edgeTtlSeconds, "PRs")}
      <div class="desk__tiles">
        ${tile(d.count, "open")}
        ${tile(c.non_compliant, "no live claim")}
        ${tile(c.not_measured, "not gated")}
        ${tile(c.unknown, "unknown")}
      </div>
      ${list}
      <footer><p class="muted">Every PR should name an issue that carries a live claim, and
        <code>pr-claim</code> checks it on each pull request. <strong>No live claim</strong> means the
        gate ran and the PR named no open, claimed issue. <strong>Not gated</strong> is not a failure —
        the check has not been adopted in that repo yet. <strong>Unknown</strong> means this projection
        could not read the PR's checks at all — usually a PR in another repository, which the
        projection's own token cannot reach — so those rows are counted here rather than being
        left out of the summary. A green check says an open, claimed issue was
        named; it does not establish that the PR is the work of that claim.</p>
      ${elsewhere("prs")}</footer>`,
  );
}

// ── desk.bounded.tools ───────────────────────────────────────────────────────

// `markerLabel` and `noun` are what the rank slot and the where-line MEAN on
// each section, spelled out for assistive tech. They differ per section and the
// row cannot guess them: the same position holds a board score under Issues, a
// status under Claims and a PR number under PRs, which is precisely why the row
// takes them as arguments rather than inferring one.
const SECTION_COPY = {
  issues: { title: "Issues", label: "claimable", blurb: "what is worth picking up, ranked by the board",
    markerLabel: "Board score", noun: "issue" },
  claims: { title: "Claims", label: "claimed", blurb: "what is already spoken for",
    markerLabel: "Status", noun: "issue" },
  prs: { title: "PRs", label: "open", blurb: "changes awaiting a check",
    markerLabel: "Pull request", noun: "pull request" },
  ci: { title: "Repo health", label: "with findings",
    blurb: "which public repos run the standard CI, and whether it passes — measured daily by the standard's own repo",
    markerLabel: "Findings", noun: "repo" },
};

const EMPTY_COPY = {
  issues: "Nothing claimable right now.",
  claims: "Nothing is claimed right now.",
  prs: "No open pull requests.",
  ci: "Every public repo calls the standard CI, and every standard run is green.",
};

/**
 * The repo-health denominator, said out loud (desk#81). "42 with findings" on
 * its own hides the fact that matters most — how many repos call the standard
 * at all, and whether the ones that do are green — so the section carries the
 * lane's own totals and this turns them into one sentence. Gaps are named as
 * gaps: "could not be measured" is not "healthy", and the lane keeps them in a
 * separate field for exactly this reason.
 */
function ciSummary(s) {
  const t = s.totals;
  if (!t || !t.caller || !t.standard_run) return "";
  const rows = t.rows ?? "?";
  const gaps = t.gaps ? ` ${esc(t.gaps)} could not be measured.` : "";
  const selftest = s.standard ? ` The standard's own selftest is ${esc(s.standard)}.` : "";
  return `<p class="muted">${esc(t.caller.present)} of ${esc(rows)} public repos call the standard: ${esc(t.standard_run.green)} green, ${esc(t.standard_run.red)} red. ${esc(t.caller.absent)} do not call it.${gaps}${selftest}</p>`;
}

function overviewSection(s) {
  const copy = SECTION_COPY[s.key] || { title: s.key, label: "", blurb: "", markerLabel: "", noun: "item" };
  // A section with no host of its own links wherever its feed lives (repo
  // health links to the snapshot itself until a `ci.` host exists).
  const link = s.href || `https://${s.host}`;
  // The heading carries the id the <section> points at, so each section is a
  // NAMED landmark rather than three anonymous regions a reader has to count.
  const heading = `<div class="sec__head">
        <h2 id="${esc(s.key)}-h"><a href="${esc(link)}">${esc(copy.title)}</a></h2>
        <p class="sec__n">${s.ok ? `${esc(s.count)} ${esc(copy.label)}` : "unreadable"}</p>
      </div>`;

  // A section that could not be read keeps its slot and says why. The
  // alternative — printing 0, or dropping the section — is how a reader
  // concludes there is no work when what actually happened is that nobody could
  // tell. "Nothing" and "not known" are different sentences here too.
  if (!s.ok) {
    return `<section class="sec" id="${esc(s.key)}" aria-labelledby="${esc(s.key)}-h">
      ${heading}
      <div class="stamp stamp--stale">
        <strong>This section could not be read.</strong> It is not empty — the feed behind
        <a href="${esc(link)}">${esc(s.host)}</a> did not answer in a way this page can stand behind,
        so nothing is shown rather than a count that would be made up.
      </div>
      <p class="muted mono">${esc(s.reason)}</p>
    </section>`;
  }

  // RAILED ON ALL THREE, including the section whose rows carry no marker. The
  // public claims feed does not publish a status, so those rows render no marker
  // at all — and measured on the live page that put their titles at 20px while
  // the issues and prs titles sat at 90px, a 70px discontinuity down a page
  // built to be read in one pass. The board reserves the track; the row still
  // emits nothing into it.
  const body = s.items.length
    ? board(
        s.items.map((i) =>
          row({
            marker: i.note ?? null,
            markerLabel: copy.markerLabel,
            title: i.title,
            url: i.url,
            repo: i.repo,
            number: i.number,
            noun: copy.noun,
          }),
        ),
        true,
      )
    : `<div class="stamp"><strong>${esc(EMPTY_COPY[s.key] || "Nothing here.")}</strong></div>`;

  // Never a silent head: if the section shows fewer rows than it counted, it
  // says so and points at the host that shows the rest. An EMPTY section gets
  // neither line — "all of them, in full" reads as an offer when there is
  // nothing to offer, and the heading already links to the host.
  const more = !s.count
    ? ""
    : s.count > s.items.length
      ? `<p class="muted sec__more">Showing the first ${esc(s.items.length)} of ${esc(s.count)} — the rest are at <a href="${esc(link)}">${esc(s.host)}</a>.</p>`
      : `<p class="muted sec__more">All of them, in full, at <a href="${esc(link)}">${esc(s.host)}</a>.</p>`;

  return `<section class="sec" id="${esc(s.key)}" aria-labelledby="${esc(s.key)}-h">
      ${heading}
      <p class="muted">${esc(copy.blurb)}</p>
      ${s.key === "ci" ? ciSummary(s) : ""}
      ${body}
      ${more}
    </section>`;
}

/**
 * The front door — desk.bounded.tools.
 *
 * Three questions on one page, each answered by the host that owns it and
 * summarised here. The desk's own job is no longer to BE one of the lists; it is
 * to say how much of each there is and hand the reader to the right one.
 */
/**
 * The notification opt-in, on the overview page only (#766).
 *
 * WHY A BUTTON AND NOT AN AUTOMATIC PROMPT. `Notification.requestPermission()`
 * must be called from a user gesture — Safari ignores it otherwise, and a
 * permission dialog nobody asked for is the fastest way to get a permanent
 * "denied" that cannot be re-prompted. So the ask is deliberate and one click
 * away, never on load.
 *
 * WHY IT IS HIDDEN BY DEFAULT AND REVEALED BY SCRIPT. The control is useless
 * without JavaScript, a service worker, and an installed app, and a dead button
 * is worse than none — this page's whole posture is that it never shows
 * something it cannot vouch for. So the markup ships `hidden` and the script
 * un-hides it only once it has established that this browser can actually do
 * the thing. On the three static hosts, which carry no `script-src`, the block
 * is never rendered at all.
 *
 * WHY IT REPORTS iOS'S RULE RATHER THAN JUST FAILING. On iOS, Web Push works
 * only from a Home-Screen app. A visitor in Safari who taps and gets nothing
 * learns nothing; being told "add this to your Home Screen first" is the
 * difference between a broken button and an instruction.
 *
 * The subscription itself is NOT here. Storing one needs a VAPID key and an
 * identity to attach it to, which is the Face ID decision on #766. Permission
 * plus a registered worker is the half that stands alone and is testable now.
 */
function notifyOptIn() {
  return `<section class="notify" id="notify" hidden>
        <h2>Notifications</h2>
        <p class="muted" id="notify-state">Checking whether this browser can notify…</p>
        <p><button type="button" id="notify-btn" hidden>Enable notifications</button></p>
      </section>
      <script src="/notify.js"></script>`;
}

export function renderOverview(d, now = Date.now(), edgeTtlSeconds = 60) {
  const description =
    "The whole desk at a glance: what is open, what is claimed, and what is worth picking up next — each summarised from the feed its own host serves.";

  // A page that could not date ANY of its sections cannot state its own
  // freshness, and the one thing every page here must do is say how old it is.
  const head = d.generated_at
    ? stamp(
        d.generated_at,
        now,
        edgeTtlSeconds,
        "Oldest feed",
        ` This is the <strong>oldest</strong> of the feeds below — the only age true of all of them.`,
      )
    : `<div class="stamp stamp--stale"><strong>No section could be dated.</strong> Nothing below is
        vouched for by a stamp, which means no feed answered — not that there is nothing to show.</div>`;

  const incomplete = d.ok
    ? ""
    : `<div class="stamp stamp--stale"><strong>This overview is incomplete.</strong> At least one
        section could not be read, so this page is served with an error status rather than as a
        complete picture. The sections that did answer are shown below and are as good as ever; the
        one that did not says so in its own words.</div>`;

  return page(
    "Desk — Bounded Systems",
    description,
    `    <h1>Desk</h1>
    <p class="lede">${esc(description)}</p>
      ${head}
      ${incomplete}
      ${d.sections.map(overviewSection).join("\n")}
      ${notifyOptIn()}
      <footer><p class="muted">Each host answers exactly one question, reads the feed live on every
        request, and fails closed rather than showing an empty list it cannot vouch for.</p></footer>`,
    APP_HEAD,
  );
}

// ── /human: a question waiting on a person (#69) ─────────────────────────────
//
// FIVE STATES, FIVE SENTENCES. The house rule from `overviewSection` — where
// "unreadable", "empty" and "truncated" each get their own words rather than
// collapsing into a count — applies here with more at stake: "a person answered
// yes" and "nobody answered and the asker had declared yes in advance" are not
// the same fact, and a card that renders them the same way is output that reads
// as more than it established.
//
// THE STATE IS ALSO MACHINE-READABLE, via data-status. Not decoration: it is
// the same string /human.json reports, so a test can assert the two renderings
// agree rather than regexing prose that would match the explanation as happily
// as the state.
const QUESTION_STATE = {
  open: {
    stale: false,
    head: "Waiting for a person.",
    text: "Nobody has answered this yet.",
  },
  answered: {
    stale: false,
    head: "A person answered.",
    text: "This is what they said. It is reviewed information, not a decision anything may be spent as.",
  },
  "default-fired": {
    stale: true,
    head: "Nobody answered. The declared default fired.",
    text:
      "No person looked at this. The value below is the one the asker declared in advance for exactly " +
      "this case, and it is recorded as a default rather than as an answer.",
  },
  blocked: {
    stale: true,
    head: "Nobody answered, and the asker declared block.",
    text: "No value was substituted. Whatever was waiting on this is still waiting.",
  },
  escalated: {
    stale: true,
    head: "Nobody answered, and the asker declared escalate.",
    text: "No value was substituted. The asker declared that this goes to a person another way instead.",
  },
};

const NO_ANSWER_COPY = {
  default: (v) => `if nobody answers, the asker declared the value <strong>${esc(v)}</strong>`,
  block: () => "if nobody answers, the asker declared that nothing proceeds",
  escalate: () => "if nobody answers, the asker declared that it escalates",
};

/**
 * The one sentence this page must never stop saying.
 *
 * An answer here is information a person reviewed. desk#65 caps it there and
 * cannot cap it higher: a record whose relying party is the requester is
 * self-asserted about everything except that a person was present. Approving
 * stays at the keeper, on a different credential.
 */
const RUNG_LINE = `<p class="muted">An answer here is <strong>human-reviewed</strong> information —
        what a person said. It is not an approval and authorizes nothing; approvals are a different
        credential at the keeper.</p>`;

/**
 * Why there is still no button.
 *
 * Desk login exists now (desk#65) and the answer route is behind it, but nothing
 * on THIS page can drive it: `form-action` is 'none' on every surface, so a form
 * here would be inert, and no browser-side sign-in ships yet. The posture the
 * notification opt-in states outright holds — a dead control is worse than none,
 * because a page that offers something it cannot honour has told the reader
 * something untrue about itself.
 */
const ANSWERING_LINE = `<p class="muted">Answering needs a signed-in desk session (desk#65) and happens
        at <span class="mono">POST /human/&lt;id&gt;/answer</span>. This page reports the question and
        its state and offers no control it cannot honour.</p>`;

function questionCard(q, { heading = "h2" } = {}) {
  const st = QUESTION_STATE[q.status] || QUESTION_STATE.open;
  const value = q.answer ? q.answer.value : q.default_value;
  return `<section class="q" id="q-${esc(q.id)}">
        <${heading} class="q__prompt">${esc(q.prompt)}</${heading}>
        <div class="stamp${st.stale ? " stamp--stale" : ""} q__state" data-status="${esc(q.status)}">
          <strong>${esc(st.head)}</strong> ${esc(st.text)}
        </div>
        ${
          value == null
            ? ""
            : `<p class="q__value">${vh(q.answer ? "Answer: " : "Default: ")}<span class="q__value-t">${esc(value)}</span>
          <span class="muted"> — ${q.answer ? "given by a person" : "declared in advance, not given by anyone"}</span></p>`
        }
        ${
          q.choices
            ? `<p class="muted">Choices offered: ${q.choices.map((c) => `<span class="mono">${esc(c)}</span>`).join(", ")}</p>`
            : ""
        }
        <p class="muted">Asked <span class="mono">${esc(q.asked_at ?? "at an unrecorded time")}</span> ·
          answers close <span class="mono">${esc(q.deadline ?? "at an unrecorded time")}</span> ·
          ${NO_ANSWER_COPY[q.no_answer_policy] ? NO_ANSWER_COPY[q.no_answer_policy](q.no_answer_value) : "no policy on file"}.</p>
      </section>`;
}

/**
 * ONE renderer for /human, because there is one judgement behind it.
 *
 * It takes exactly what /human.json serves — a question view, the list, the
 * refusal or the error — so the two renderings cannot be computed from
 * different things. The worker selects once and forks only at the return.
 */
export function renderHuman(payload) {
  if (payload && payload.kind === "question") {
    return page(
      "Desk — a question for a person",
      "A question a lane put in front of a person, and what has happened to it since.",
      `    <h1>A question</h1>
      ${questionCard(payload)}
      ${RUNG_LINE}
      ${ANSWERING_LINE}
      <footer><p class="muted">Asked by a lane that then exited. Nobody is blocked on this page being
        open.</p></footer>`,
    );
  }

  // The listing. Reachable to a signed-in reader since desk#65 (`mayList`), and
  // rendered from the same card as a single question so a person and an agent
  // cannot be shown two different judgements about one question.
  if (payload && payload.kind === "questions") {
    const qs = payload.questions || [];
    return page(
      "Desk — questions for a person",
      "Every question a lane has put in front of a person, and what has happened to each.",
      `    <h1>Questions</h1>
    <p class="lede">What lanes have asked a person, newest first — and for each, whether a person
      answered, or nobody did and the asker's declared policy took over.</p>
      ${
        qs.length
          ? qs.map((q) => questionCard(q, { heading: "h2" })).join("\n")
          : `<div class="stamp"><strong>No questions have been asked.</strong> This is empty, not
        unreadable — nothing has called /human.</div>`
      }
      ${RUNG_LINE}
      ${ANSWERING_LINE}`,
    );
  }

  // The corpus is not public (desk#65) — its own page and its own sentence.
  // NOT the "could not be read" page below: a reader told a record is
  // unreadable when it is simply not theirs to read goes looking for a fault
  // that is not there, and NOT an empty list, which would say there are none.
  if (payload && payload.kind === "closed") {
    return page(
      "Desk — questions are not listed here",
      "Questions are readable one at a time, at their own addresses.",
      `    <h1>The questions are not listed here</h1>
      <div class="stamp stamp--stale">
        <strong>This is not an empty list.</strong> The corpus is behind desk login (desk#65), so
        every question ever asked is not something this page will hand out to a caller it cannot
        name. A question is readable at its own address — the one the person who was asked was
        given.
      </div>
      <p class="muted mono">${esc((payload && payload.error) || "unknown")}</p>
      ${RUNG_LINE}`,
    );
  }

  // Not a question and not a list: the read failed, and it says so rather than
  // rendering an empty page that reads as "there are none".
  return page(
    "Desk — question unavailable",
    "This question could not be read.",
    `    <h1>This question could not be read</h1>
      <div class="stamp stamp--stale">
        <strong>This is not an answered question, and not an unanswered one.</strong> The record
        behind this address could not be read, so nothing is shown about it rather than a state that
        would be made up.
      </div>
      <p class="muted mono">${esc((payload && payload.error) || "unknown")}</p>`,
  );
}

/**
 * THE PENDING-APPROVALS QUEUE (desk#65) — every outstanding one, behind the login.
 *
 * ONE LINK PER ENTRY AND NOTHING ELSE. There is no "approve all" and there are
 * no controls: rows 5-6 of the infra#555 chain are display → intent, and a
 * button that means yes to a set the reader did not open attacks precisely
 * those. Approving happens at the keeper, under the other credential, one
 * ceremony at a time — so what this page can offer is the address, and the
 * address is what it offers.
 *
 * The entries carry title, body and url, which is all `pendingApprovals()`
 * projects. No ceremony material reaches this function to be leaked.
 */
export function renderQueue(payload) {
  if (payload && payload.kind === "queue") {
    const rows = payload.approvals || [];
    return page(
      "Desk — what is waiting for a person",
      "Every approval whose ceremony window is still open.",
      `    <h1>Waiting for a person</h1>
    <p class="lede">Every approval whose window is still open, newest first. Each is approved at the
      keeper, with the keyholder passkey — this page shows what is outstanding and where to go.</p>
      ${
        rows.length
          ? rows.map((a) => `<section class="q">
        <h2 class="q__prompt">${esc(a.title ?? "An approval")}</h2>
        <p>${esc(a.body ?? "")}</p>
        <p class="muted">Raised <span class="mono">${esc(a.at ?? "at an unrecorded time")}</span> ·
          <a href="${esc(a.url)}">${esc(a.url)}</a></p>
      </section>`).join("\n")
          : `<div class="stamp"><strong>Nothing is waiting.</strong> This is empty, not unreadable —
        no approval ceremony is open. Windows are short, so an approval you were told about may
        already have closed.</div>`
      }
      <p class="muted">These are approvals, not questions: each is a <strong>human-authorized</strong>
        ceremony completed at the keeper under a different credential. Reading this page authorizes
        nothing, and there is no way to approve several at once — every ceremony is opened, read and
        answered on its own.</p>`,
    );
  }

  // Not signed in. Its own sentence, and NOT "nothing is waiting": a reader told
  // the queue is empty stops looking, which is the one thing a queue must never
  // say to someone who simply has not signed in.
  return page(
    "Desk — the queue is not open to this caller",
    "What is waiting for a person is readable to a person, once they have signed in.",
    `    <h1>The queue is not readable here</h1>
      <div class="stamp stamp--stale">
        <strong>This is not an empty queue.</strong> What is outstanding is readable to a signed-in
        person (desk#65). Nothing about any pending ceremony — not its title, not its address — is
        on this page.
      </div>
      <p class="muted mono">${esc((payload && payload.error) || "unknown")}</p>`,
  );
}

/**
 * The board could not be read. Rendered instead of an empty list, and served
 * with a 5xx — "nothing claimable" and "the board could not be read" are
 * different sentences, and a page that shows the first when the second is true
 * is how a reader picks the wrong work.
 */
export function renderUnavailable(reason) {
  return page(
    "Desk — board unavailable",
    "The Front Desk board could not be read.",
    `    <h1>The board could not be read</h1>
      <div class="stamp stamp--stale">
        <strong>This is not an empty board.</strong> The desk could not fetch or validate the
        Front Desk feed, so it is showing nothing rather than showing a ranking it cannot stand behind.
      </div>
      <p class="muted mono">${esc(reason)}</p>`,
  );
}

/**
 * What an installed app shows with no network (#51).
 *
 * It does NOT show a board. The service worker caches this page and nothing
 * else, because a cached board is a stale board an installed app would present
 * with no way to caveat it — the defect the live Worker exists to remove,
 * reintroduced offline. So this says what it does not know, which is what every
 * other failure on this board does.
 */
export function renderOffline() {
  return page(
    "Offline — Front Desk",
    "The board could not be read because this device is offline.",
    `    <h1>Desk</h1>
      <div class="stamp stamp--stale"><strong>You are offline.</strong> This board is read live on
        every request, so there is nothing to show you — no cached copy is kept, deliberately: a
        stale board with no way to say how stale is worse than an honest gap.</div>
      <p class="muted">It will load as soon as you have a connection. Nothing was lost.</p>`,
    APP_HEAD,
  );
}
