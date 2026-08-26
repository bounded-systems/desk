# @bounded-systems/desk

The Front Desk, live. A standalone Cloudflare Worker that renders the org's
ranked board **at request time**.

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
be a different board wearing the same name. `src/select.js` is a faithful port
of the site's `trim-front-desk.mjs`, which holds the same line as
`front-desk.sh` — the three readers must agree about what "claimable" means, or
a session and the page it reads are looking at different boards.

Claimable is: `Status == "Todo"`, not claimed, `type == "Issue"`, and carrying a
numeric `Score`. Everything excluded is counted and printed, so the list is
never silently capped.

## Fail-closed

Every failure — feed unreachable, non-200, a snapshot with no parseable
`generated_at`, or a feed that does not identify itself as `front-desk-public` —
renders "the board could not be read" with a 5xx. Never an empty list: *"nothing
claimable"* and *"the board could not be read"* are different sentences, and
only one of them is ever true.

That last guard matters most. The **private** projection carries private repos'
issue titles. `front-desk-public.sh` produces the publishable copy under a
default-deny visibility filter, and this Worker re-checks the feed's own name
before rendering a single row, so a mistyped `FEED_URL` cannot put a private
title on a public page.

## Configuration

| var | meaning |
| --- | --- |
| `FEED_URL` | The **filtered** `front-desk-public` feed, published by [`front-desk-feed`](https://github.com/bounded-systems/front-desk-feed). |
| `DESK_LIMIT` | Rows rendered (default 25). |

The feed is cosign-signed, and this Worker does **not** verify that signature: a
keyless verification per request is not something an edge render can afford. It
gets TLS plus the pinned repo, and the signature stays available for anything
verifying out of band — CI, or a job that verifies once and republishes. That is
a real gap, named rather than papered over.

This is also **not the whole board**. The public feed carries public rows by
construction, so the page says it is showing the public feed rather than
implying it shows everything.

## Routes

| path | |
| --- | --- |
| `/` | the board, as HTML |
| `/board.json` | the same selection, as JSON |
| `/healthz` | liveness that does **not** touch the feed, so "is the Worker up" and "is the board readable" stay separately answerable |

## Open prerequisites

1. **The feed lane must run.** `front-desk-feed`'s `publish` workflow creates the
   `feed` branch on its first dispatch; until then `FEED_URL` 404s and this
   Worker fails closed with "the board could not be read" rather than an empty
   list.
2. **Broker deploy routes** — no stored Cloudflare credential exists anywhere in
   this org; a deploy mints a per-run token from the OIDC broker, whose
   `WORKERS_DEPLOY` entries pin an exact workflow ref. This repo needs its own
   entries before any deploy can authenticate.
3. **`desk.bounded.tools` DNS + Worker route** — manual `[settings]`.
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
