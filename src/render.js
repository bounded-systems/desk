// Render the claimable head of the board as a page.
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

function stamp(generatedAt, now, edgeTtlSeconds) {
  const ageMs = now - Date.parse(generatedAt);
  const stale = ageMs / 36e5 > STALE_AFTER_HOURS;
  const when = esc(generatedAt);
  if (stale) {
    return `<div class="stamp stamp--stale">
        <strong>This snapshot is old.</strong> The board was projected at <span class="mono">${when}</span>,
        ${esc(humanAge(ageMs))} ago — more than ${STALE_AFTER_HOURS} hours. The projection lane publishes
        hourly, so this means it stopped. Treat the ranking below as history, not as the board.
      </div>`;
  }
  return `<div class="stamp">
        Board projected at <span class="mono">${when}</span>, ${esc(humanAge(ageMs))} ago.
        Read live on each request and cached at the edge for up to ${edgeTtlSeconds}s, so this age is
        accurate to within that window.
      </div>`;
}

const tile = (n, l) =>
  `<div class="tile"><div class="tile__n">${esc(n)}</div><div class="tile__l">${esc(l)}</div></div>`;

// No PR tile (#480): a PR is not claimable work and the desk feed no longer
// carries PR rows at all — they have their own page, linked from the footer.
// heldBack below still names pull_requests DEFENSIVELY: it renders only when
// the count is nonzero, which after the feed change means an upstream
// regression, and a page that quietly hides that is how it goes unnoticed.
function tiles(d) {
  const w = d.withheld || {};
  return `<div class="desk__tiles">
        ${tile(d.items.length, "shown")}
        ${tile(w.todo_total ?? "?", "not started")}
        ${tile(w.claimed ?? 0, "already claimed")}
      </div>`;
}

function rows(d) {
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
    .map(
      (i) => `<div class="row">
        <div class="row__score">${esc(i.score.toFixed(2))}</div>
        <div class="row__body">
          <p class="row__title"><a href="${esc(i.url)}">${esc(i.title)}</a></p>
          <p class="row__where">${esc(String(i.repo).replace(/^bounded-systems\//, ""))} &middot; ${esc(i.number)}</p>
        </div>
      </div>`,
    )
    .join("\n      ");
}

function heldBack(d) {
  const w = d.withheld || {};
  // Never a silent cap: if the list is truncated, the page says by how much.
  const held = [
    w.claimed ? `${w.claimed} already claimed` : null,
    w.pull_requests
      ? `${w.pull_requests} pull request(s), which are changes awaiting a check rather than work to pick up`
      : null,
    w.unscored ? `${w.unscored} unranked by the board` : null,
    w.beyond_limit ? `${w.beyond_limit} ranked below the ${d.limit} shown` : null,
  ].filter(Boolean);
  return held.length ? `<p class="muted">Held back: ${esc(held.join("; "))}.</p>` : "";
}

const STYLE = `
    :root { --bg:#fbfaf8; --fg:#16201c; --muted:#5c6b64; --line:#e2e0da; --card:#fff; --accent:#0C5A42; --warn:#8a4b12; --warnbg:#fdf3e7; }
    @media (prefers-color-scheme: dark) {
      :root { --bg:#0e1512; --fg:#e8ece9; --muted:#93a49c; --line:#243029; --card:#141c18; --accent:#4fbf95; --warn:#f0b26b; --warnbg:#2a1e10; }
    }
    * { box-sizing: border-box; }
    body { margin:0; background:var(--bg); color:var(--fg);
      font:16px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
    .wrap { max-width:52rem; margin:0 auto; padding:2.5rem 1.25rem 4rem; }
    h1 { font-size:1.6rem; margin:0 0 .35rem; letter-spacing:-.01em; }
    .lede { color:var(--muted); margin:0 0 1.75rem; }
    .mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.92em; }
    .muted { color:var(--muted); font-size:.9rem; }
    .stamp { border:1px solid var(--line); background:var(--card); border-radius:.6rem;
      padding:.8rem 1rem; margin-bottom:1.5rem; font-size:.92rem; color:var(--muted); }
    .stamp--stale { border-color:var(--warn); background:var(--warnbg); color:var(--warn); }
    .desk__tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(7.5rem,1fr));
      gap:.75rem; margin-bottom:1.75rem; }
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
    footer { margin-top:2.5rem; padding-top:1.25rem; border-top:1px solid var(--line); }`;

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

/** The board, ranked. */
export function renderBoard(d, now = Date.now(), edgeTtlSeconds = 60) {
  const description =
    "What is worth picking up next, ranked by the Front Desk board itself — the same projection a session reads before it claims work.";
  return page(
    "Desk — Bounded Systems",
    description,
    `    <h1>Desk</h1>
    <p class="lede">${esc(description)}</p>
      ${stamp(d.generated_at, now, edgeTtlSeconds)}
      ${tiles(d)}
      ${rows(d)}
      <footer>${heldBack(d)}<p class="muted">Open pull requests live at <a href="https://prs.bounded.tools">prs.bounded.tools</a> — changes awaiting a check, not work to pick up.</p></footer>`,
  );
}

/** The open PRs, prs.bounded.tools (#480/#713): newest first, per repo. */
export function renderPrs(d, now = Date.now(), edgeTtlSeconds = 60) {
  const description =
    "Every open pull request in the org's public repos — changes awaiting a check, projected from the same board as the desk.";
  const list = d.items.length
    ? d.items
        .map(
          (i) => `<div class="row">
        <div class="row__score">#${esc(i.number)}</div>
        <div class="row__body">
          <p class="row__title"><a href="${esc(i.url)}">${esc(i.title)}</a></p>
          <p class="row__where">${esc(String(i.repo).replace(/^bounded-systems\//, ""))}${i.claimed ? " &middot; claimed" : ""}</p>
        </div>
      </div>`,
        )
        .join("\n      ")
    : `<div class="stamp"><strong>No open pull requests.</strong> The backlog is drained.</div>`;
  return page(
    "PRs — Bounded Systems",
    description,
    `    <h1>PRs</h1>
    <p class="lede">${esc(description)}</p>
      ${stamp(d.generated_at, now, edgeTtlSeconds)}
      <div class="desk__tiles">
        ${tile(d.count, "open")}
        ${tile(d.claimed, "claimed")}
      </div>
      ${list}
      <footer><p class="muted">The claimable queue lives at <a href="https://desk.bounded.tools">desk.bounded.tools</a>.</p></footer>`,
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
