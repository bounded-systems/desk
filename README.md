# @bounded-systems/desk

The Front Desk, live. A standalone Cloudflare Worker that renders the org's
board **at request time**, across four hosts.

## One question per host

| host | answers | selector |
| --- | --- | --- |
| [`issues.bounded.tools`](https://issues.bounded.tools) | what is worth picking up, ranked by the board | `select` |
| [`claims.bounded.tools`](https://claims.bounded.tools) | what is already spoken for | `selectClaims` |
| [`prs.bounded.tools`](https://prs.bounded.tools) | what is open and awaiting a check | `selectPrs` |
| [`desk.bounded.tools`](https://desk.bounded.tools) | all three at a glance — the front door | `selectOverview` |

The front door also carries a fourth section, **Repo health** (#81): which public repos run
the org's standard CI and whether it passes, read from the snapshot `bounded-systems/.github`
publishes daily (`selectCi`). It has no host of its own yet, so it links to the snapshot.

One Worker, selected by hostname, because the selection rules **are** the
product: four Workers would be four deploys, four broker entries, and four
chances for "claimable" to come to mean four different things.

The split is #7. `desk` used to *be* the issue queue, with claim facts mixed in —
an "already claimed" tile and a held-back line. A queue of what to pick up and a
register of what is taken are different questions, and the page trying to answer
both answered neither cleanly. So the queue moved to `issues`, claims got
`claims`, and `desk` took the job its name implies. The claimed count did not
vanish; it moved to the host that owns it, and the queue carries a pointer —
exactly the move #480/#713 made when PRs left the desk.

**`claims` says *that* a row is claimed, never *by whom*.** The public filter
deliberately drops `assignees` — it publishes the board's ranking, not a roster
of who is working on what — so the page says so rather than letting a reader
assume the names were cut for space. The claimant is named in the claim comment
on the issue itself.

## Why this is an app and not a page

`bounded.tools/desk` was a static page: `gen-desk.mjs` spliced a generated
region into `desk.html` from a committed `data/front-desk.json`. That design has
one unavoidable property — a static build can only ever state the age it had
when it was built. The site's generator was careful about this and refused to
print "3 hours ago", because the phrase would be a lie the moment the page was
cached. It could only print the stamp.

The deeper mismatch was cadence. The projection lane publishes **hourly**; the
site deploys behind `npm run check` (30-plus gates), a hermetic nix build,
Sigstore keyless signing, a GHCR OCI artifact, cosign verification and an
approval gate. That pipeline is right for a site whose claims are load-bearing
and wrong for a ranking that changes every hour — so in practice the data was
re-piped by hand, and on 2026-08-25 the live page was serving a 5-day-old
snapshot behind its own "this snapshot is old" banner while the lane was running
perfectly well.

Reading the feed per request makes the staleness banner mean what it says: it
now fires when the **lane** stops, not when a deploy hasn't happened.

## What it does not do

**It does not rank.** `Score` comes from the board and is carried through
untouched; the app only sorts on it and truncates. A ranking computed here would
be a different board wearing the same name. `select()` in `src/select.js` is a faithful port
of the site's `trim-front-desk.mjs`, which holds the same line as
`front-desk.sh` — the three readers must agree about what "claimable" means, or
a session and the page it reads are looking at different boards.

Claimable is: `Status == "Todo"`, not claimed, `type == "Issue"`, and carrying a
numeric `Score`. Everything excluded is counted and printed, so the list is
never silently capped.

## Fail-closed

Every failure — feed unreachable, non-200, a snapshot with no parseable
`generated_at`, or a feed that does not identify itself as the one that host
renders — renders "the board could not be read" with a 5xx. Never an empty list:
*"nothing claimable"* and *"the board could not be read"* are different
sentences, and only one of them is ever true.

The overview is the one page that can be **partly** unreadable, and it fails
closed per section: the sections that answered are rendered in full, the one that
did not keeps its slot and says why in its own words, and the page is still
served with a 5xx. Dropping the section, or printing `0`, are the two ways to
turn "nobody could tell" into "there is nothing" — which is the same mistake at
section scale.

That last guard matters most. The **private** projection carries private repos'
issue titles. `front-desk-public.sh` produces the publishable copy under a
default-deny visibility filter, and this Worker re-checks the feed's own name
before rendering a single row, so a mistyped `FEED_URL` cannot put a private
title on a public page.

## Configuration

| var | meaning |
| --- | --- |
| `FEED_URL` | The **filtered** `front-desk-public` feed, published by [`front-desk-feed`](https://github.com/bounded-systems/front-desk-feed). Serves both the issue queue and the claims page — a claim is a fact the board already carries about a row, so splitting the hosts splits the question, not the source of truth. |
| `PRS_FEED_URL` | The `front-desk-prs-public` feed, published by the same run. |
| `DESK_LIMIT` | Rows the issue queue renders (default 25). |
| `ISSUES_HOST`, `CLAIMS_HOST`, `PRS_HOST` | Override a hostname, for a preview or a rename. |

The feed is cosign-signed, and this Worker does **not** verify that signature: a
keyless verification per request is not something an edge render can afford. It
gets TLS plus the pinned repo, and the signature stays available for anything
verifying out of band — CI, or a job that verifies once and republishes. That is
a real gap, named rather than papered over.

This is also **not the whole board**. The public feed carries public rows by
construction, so the page says it is showing the public feed rather than
implying it shows everything.

## Paths

Every host serves the same three paths, over its own selection.

| path | |
| --- | --- |
| `/` | the page, as HTML |
| `/board.json` | the same selection, as JSON |
| `/healthz` | liveness that does **not** touch the feed, so "is the Worker up" and "is the board readable" stay separately answerable |

Any hostname that is not one of the three named ones — a `workers.dev` preview
above all — gets the overview. It is the safe default: it links to everything, so
a reader who landed on an unnamed host is never stuck on a page that looks like
the whole answer.

## Open prerequisites

1. **The feed lane must run.** `front-desk-feed`'s `publish` workflow creates the
   `feed` branch on its first dispatch; until then `FEED_URL` 404s and this
   Worker fails closed with "the board could not be read" rather than an empty
   list.
2. **Broker deploy routes** — no stored Cloudflare credential exists anywhere in
   this org; a deploy mints a per-run token from the OIDC broker, whose
   `WORKERS_DEPLOY` entries pin an exact workflow ref. This repo needs its own
   entries before any deploy can authenticate.
3. **First custom-domain attach for `issues.` and `claims.`** — created by the
   next deploy, not by a console step. That run is a *first* attach, which
   preflights `GET /zones/{id}/workers/routes`; the broker entry's `domains`
   group is what makes it authenticate, and it already carries it.
4. Retire `desk.html`, `gen-desk.mjs`, `trim-front-desk.mjs` and
   `data/front-desk.json` from `bounded-systems/site`
   ([site#242](https://github.com/bounded-systems/site/pull/242), held open until
   this serves the page).

Tracked in [bounded-systems/site#241](https://github.com/bounded-systems/site/issues/241).

## Develop

```sh
npm test          # node --test, no network
npx wrangler dev  # needs FEED_URL
```
