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
    return `<div class="stamp stamp--stale">
        <strong>This snapshot is old.</strong> ${esc(what)} projected at <span class="mono">${when}</span>,
        ${esc(humanAge(ageMs))} ago — more than ${STALE_AFTER_HOURS} hours. The projection lane publishes
        hourly, so this means it stopped. Treat what follows as history, not as the board.${extra}
      </div>`;
  }
  if (isBehind(generatedAt, now)) {
    return `<div class="stamp stamp--behind">
        ${esc(what)} projected at <span class="mono">${when}</span>, <strong>${esc(humanAge(ageMs))} ago</strong>.
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
  return `<div class="stamp">
        ${esc(what)} projected at <span class="mono">${when}</span>, ${esc(humanAge(ageMs))} ago.
        Read live per request and cached at the edge for up to ${edgeTtlSeconds}s; the age shown is
        the snapshot's own, and how far it trails the newest one depends on when the publishing lane
        last ran.${extra}
      </div>`;
}

const tile = (n, l) =>
  `<div class="tile"><div class="tile__n">${esc(n)}</div><div class="tile__l">${esc(l)}</div></div>`;

const shortRepo = (r) => String(r).replace(/^bounded-systems\//, "");

/**
 * One list row: an optional left-hand marker, the linked title, and where it
 * lives.
 *
 * `marker` is null on the claims page (#10) and the slot is then omitted
 * entirely rather than rendered empty. The slot means "the board's numeric
 * rank" on issues.bounded.tools, so filling it with anything else — as the
 * claims page did with `Status` — makes the two pages disagree about what the
 * same position means.
 */
const row = (marker, title, url, where) =>
  `<div class="row">
        ${marker == null ? "" : `<div class="row__score">${esc(marker)}</div>`}
        <div class="row__body">
          <p class="row__title"><a href="${esc(url)}">${esc(title)}</a></p>
          <p class="row__where">${esc(where)}</p>
        </div>
      </div>`;

const STYLE = `
    :root { --bg:#fbfaf8; --fg:#16201c; --muted:#5c6b64; --line:#e2e0da; --card:#fff; --accent:#0C5A42; --warn:#8a4b12; --warnbg:#fdf3e7; }
    @media (prefers-color-scheme: dark) {
      :root { --bg:#0e1512; --fg:#e8ece9; --muted:#93a49c; --line:#243029; --card:#141c18; --accent:#4fbf95; --warn:#f0b26b; --warnbg:#2a1e10; }
    }
    * { box-sizing: border-box; }
    body { margin:0; background:var(--bg); color:var(--fg);
      font:16px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
      /* Prevents iOS enlarging body text in landscape, which reflows the tile
         row into something the layout was not measured against. */
      -webkit-text-size-adjust:100%; }
    /* SAFE AREAS ARE NEW AS OF TODAY (#766). Until this page became an
       installable standalone app it was always inside browser chrome, which
       handles the notch and the home indicator for you. Installed, it is not:
       content runs under both. The insets are ADDED to the existing padding
       rather than replacing it, so nothing changes on the web. */
    .wrap { max-width:52rem; margin:0 auto;
      padding:2.5rem 1.25rem 4rem;
      padding-left:calc(1.25rem + env(safe-area-inset-left));
      padding-right:calc(1.25rem + env(safe-area-inset-right));
      padding-top:calc(2.5rem + env(safe-area-inset-top));
      padding-bottom:calc(4rem + env(safe-area-inset-bottom)); }

    /* FOCUS WAS INVISIBLE, and this page is now keyboard- and switch-operable
       in a way it was not: links here suppress the UA underline in favour of a
       border-bottom, which also suppresses the default focus ring's contrast on
       some browsers. One explicit rule for everything focusable. */
    :focus-visible { outline:2px solid var(--accent); outline-offset:2px; border-radius:.2rem; }
    h1 { font-size:1.6rem; margin:0 0 .35rem; letter-spacing:-.01em; }
    h2 { font-size:1.05rem; margin:0; letter-spacing:-.005em; }
    h2 a { color:inherit; text-decoration:none; border-bottom:1px solid var(--line); }
    h2 a:hover { border-bottom-color:var(--accent); }
    .lede { color:var(--muted); margin:0 0 1.75rem; }
    .mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.92em; }
    .muted { color:var(--muted); font-size:.9rem; }
    .stamp { border:1px solid var(--line); background:var(--card); border-radius:.6rem;
      padding:.8rem 1rem; margin-bottom:1.5rem; font-size:.92rem; color:var(--muted); }
    .stamp--stale { border-color:var(--warn); background:var(--warnbg); color:var(--warn); }
    /* Informational, not an alarm: a distinct left edge rather than the warn
       ground, so "behind" never reads as "broken" at a glance. */
    /* The thicker edge is drawn INSIDE the existing 1px border, not added to it:
       a plain border-left:3px would shift the text 2px relative to the fresh and
       stale bands, and three stamps that do not share a left edge read as three
       different components rather than one control in three states. */
    .stamp--behind { box-shadow:inset 3px 0 0 var(--accent); padding-left:calc(1rem + 3px); }
    /* minmax(0,1fr) as the floor, with auto-fit doing the wrapping: the PR page
       carries FOUR tiles since #29 added unknown, and at a 7.5rem minimum the
       fourth wrapped alone onto its own row on a phone — one number stranded
       under three, which reads as more important rather than merely later.
       A 2x2 at narrow widths keeps them a set. */
    .desk__tiles { display:grid; gap:.75rem; margin-bottom:1.75rem;
      grid-template-columns:repeat(auto-fit,minmax(min(100%,7.5rem),1fr)); }
    @media (max-width:26rem) { .desk__tiles { grid-template-columns:repeat(2,1fr); } }
    .tile { border:1px solid var(--line); background:var(--card); border-radius:.6rem; padding:.8rem 1rem; }
    .tile__n { font-size:1.5rem; font-weight:650; line-height:1.1; }
    .tile__l { color:var(--muted); font-size:.82rem; margin-top:.15rem; }
    .row { display:flex; gap:1rem; align-items:baseline; padding:.7rem 0; border-top:1px solid var(--line); }
    .row__score { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.86rem;
      color:var(--accent); min-width:3.4rem; text-align:right; flex:none; }
    .row__body { min-width:0; }
    .row__title { margin:0; }
    .row__title a { color:inherit; text-decoration:none; border-bottom:1px solid var(--line); }
    .row__title a:hover { border-bottom-color:var(--accent); }
    .row__where { margin:.15rem 0 0; color:var(--muted); font-size:.82rem;
      font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
    .sec { margin:0 0 2rem; }
    .sec__head { display:flex; align-items:baseline; justify-content:space-between; gap:1rem;
      padding-bottom:.4rem; border-bottom:2px solid var(--line); }
    .sec__n { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.86rem; color:var(--muted); flex:none; }
    .sec__more { margin:.6rem 0 0; }
    footer { margin-top:2.5rem; padding-top:1.25rem; border-top:1px solid var(--line); }
    .notify { margin-top:2.5rem; padding:1rem 1.25rem; border:1px solid var(--line);
              border-radius:.6rem; background:var(--card); }
    .notify h2 { margin:0 0 .35rem; }
    .notify p { margin:.35rem 0; }
    /* min-height 44px: the platform touch-target floor, and this is the only
       thing on the whole site anyone taps — on the device it was pinned to. */
    .notify button { font:inherit; padding:.6rem 1.1rem; min-height:44px; border-radius:.5rem;
                     cursor:pointer; border:1px solid var(--accent);
                     background:var(--accent); color:var(--bg); }
    .notify button:disabled { opacity:.6; cursor:default; }`;

function page(title, description, body) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}">
  <meta name="theme-color" content="#0C5A42">
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
  return d.items
    .map((i) => row(i.score.toFixed(2), i.title, i.url, `${shortRepo(i.repo)} · ${i.number}`))
    .join("\n      ");
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
    ? d.items
        .map((i) => row(null, i.title, i.url, `${shortRepo(i.repo)} · ${i.number}`))
        .join("\n      ")
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
  non_compliant: " · no live claim",
  not_measured: " · not gated",
  pending: " · checking",
  unknown: " · unknown",
};

/** The open PRs, prs.bounded.tools (#480/#713): newest first, per repo. */
export function renderPrs(d, now = Date.now(), edgeTtlSeconds = 60) {
  const description =
    "Every open pull request in the org's public repos — changes awaiting a check, projected from the same board as the desk.";
  const c = d.compliance;
  const list = d.items.length
    ? d.items
        .map((i) =>
          row(
            `#${i.number}`,
            i.title,
            i.url,
            `${shortRepo(i.repo)}${CLAIM_SUFFIX[i.claim] ?? CLAIM_SUFFIX.unknown}`,
          ),
        )
        .join("\n      ")
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

const SECTION_COPY = {
  issues: { title: "Issues", label: "claimable", blurb: "what is worth picking up, ranked by the board" },
  claims: { title: "Claims", label: "claimed", blurb: "what is already spoken for" },
  prs: { title: "PRs", label: "open", blurb: "changes awaiting a check" },
};

const EMPTY_COPY = {
  issues: "Nothing claimable right now.",
  claims: "Nothing is claimed right now.",
  prs: "No open pull requests.",
};

function overviewSection(s) {
  const copy = SECTION_COPY[s.key] || { title: s.key, label: "", blurb: "" };
  const heading = `<div class="sec__head">
        <h2><a href="https://${esc(s.host)}">${esc(copy.title)}</a></h2>
        <span class="sec__n">${s.ok ? `${esc(s.count)} ${esc(copy.label)}` : "unreadable"}</span>
      </div>`;

  // A section that could not be read keeps its slot and says why. The
  // alternative — printing 0, or dropping the section — is how a reader
  // concludes there is no work when what actually happened is that nobody could
  // tell. "Nothing" and "not known" are different sentences here too.
  if (!s.ok) {
    return `<section class="sec">
      ${heading}
      <div class="stamp stamp--stale">
        <strong>This section could not be read.</strong> It is not empty — the feed behind
        <a href="https://${esc(s.host)}">${esc(s.host)}</a> did not answer in a way this page can stand behind,
        so nothing is shown rather than a count that would be made up.
      </div>
      <p class="muted mono">${esc(s.reason)}</p>
    </section>`;
  }

  const body = s.items.length
    ? s.items
        .map((i) => row(i.note, i.title, i.url, `${shortRepo(i.repo)} · ${i.number}`))
        .join("\n      ")
    : `<div class="stamp"><strong>${esc(EMPTY_COPY[s.key] || "Nothing here.")}</strong></div>`;

  // Never a silent head: if the section shows fewer rows than it counted, it
  // says so and points at the host that shows the rest. An EMPTY section gets
  // neither line — "all of them, in full" reads as an offer when there is
  // nothing to offer, and the heading already links to the host.
  const more = !s.count
    ? ""
    : s.count > s.items.length
      ? `<p class="muted sec__more">Showing the first ${esc(s.items.length)} of ${esc(s.count)} — the rest are at <a href="https://${esc(s.host)}">${esc(s.host)}</a>.</p>`
      : `<p class="muted sec__more">All of them, in full, at <a href="https://${esc(s.host)}">${esc(s.host)}</a>.</p>`;

  return `<section class="sec">
      ${heading}
      <p class="muted">${esc(copy.blurb)}</p>
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
