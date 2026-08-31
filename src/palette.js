// The desk palette: which colours come from the design system, and which do not.
//
// desk carried SIXTEEN hex literals — eight light, eight dark — and exactly one,
// the brand green #0C5A42, was character-for-character a brand token. The rest
// were typed. This file is the audit: every value below either names the
// @bounded-systems/brand token it comes from, or says why no token fits.
//
// THE HEADLINE FINDING IS THE DARK COLUMN. brand 2.0.0's semantic tier
// (`color.*`) is a LIGHT SCHEME ONLY — one page ground, one ink, one hairline,
// no `prefers-color-scheme` anywhere in tokens.css. The only dark-aware values
// the package ships are `grade.*-on-dark` / `-on-dark-bg`, derived for the
// graded-claim badge family and nothing else. So desk's entire dark theme —
// half its palette, and the half a phone in a dark room actually renders — has
// nothing to pin to. That is a gap in the design system, not a gap in this file,
// and it is worth an issue against brand rather than a mapping invented here.
//
// WHY THE NEAR MISSES ARE NOT ALL THE SAME KIND OF THING. Nearest-neighbour in
// colour space is not evidence of provenance, and the dark column is where that
// bites (measurements are CIEDE2000 against every colour brand publishes):
//
//   desk               nearest brand token              ΔE00   same role?
//   light --muted  #5c6b64   color.ink-soft   #5C6B63   0.50   yes  → drift
//   light --fg     #16201c   color.ink        #16221C   1.72   yes  → drift
//   dark  --line   #243029   grade.aspirational-on-dark-bg    0.32   NO
//   dark  --accent #4fbf95   grade.enforced   #3FB984   3.47   NO
//
// The first two are one hex digit and one hex digit: a value transcribed by hand
// and mistyped. Take the brand value.
//
// The last two are the trap. `grade.aspirational-on-dark-bg` is the closest
// match in this entire exercise — ΔE 0.32, visually the same colour — and it is
// a status-badge SURFACE, derived by brand's build step from the aspirational
// swatch. desk's `--line` is a hairline. Pinning one to the other because the
// numbers agree would mean desk's dark rules move the next time brand retunes
// how it derives badge grounds, for no reason anyone could reconstruct.
//
// `grade.enforced` is the same mistake with a better disguise. It is three
// channels off by 16/6/17 — not the shape a mistyped digit makes — and it means
// "proven/enforced in running code", a claim grade. desk's dark `--accent` is
// the brand green lightened to survive a dark ground; it paints links, the focus
// ring, the rank column and the notify button. Nearby greens, unrelated roles.
// The next-nearest, `color.on-forest-line` #58B196 (ΔE 5.31), is at least a
// brand green — but it is specified for NON-TEXT contrast on the forest panel
// (3.19:1), and desk uses its accent for text. Neither fits; leave it unpinned
// and say so.

import { FOREST, CARD, INK, INK_SOFT, AMBER, AMBER_TINT } from "./tokens.js";

/**
 * Values with no brand token, kept here rather than inline so "what is not
 * pinned" has one answer. Each is a finding; none is a preference.
 */
export const UNPINNED = {
  // The page ground. Nearest token is `color.paper` #EDEAE1 (ΔE 4.69), brand's
  // own app background — but desk's cards, tiles and stamps are `color.card`
  // (#FFFFFF) sitting ON this, and paper is warm enough that the surfaces would
  // still read while the whole page shifted beige. That is a redesign, and this
  // change is not one. Nearest by pure ΔE is white itself (1.44), which would
  // collapse ground and surface into the same colour and erase every card edge.
  // brand has no near-white page ground; this is the second gap.
  bgLight: "#fbfaf8",

  // The hairline. `color.line` #888374 is ΔE 26 away and, more to the point, a
  // different component: brand specifies it for functional non-text contrast
  // (3.63:1 on this ground), where desk's is decorative at 1.27:1. Adopting the
  // token would be both a visible redesign and — separately — an argument worth
  // having, because a 1.27:1 divider carries no information to anyone who cannot
  // see it. Raise that on its own; do not smuggle it in as provenance.
  lineLight: "#e2e0da",

  // The dark theme, entire. No `color.*` token has a dark counterpart; see the
  // header. Listed individually so a future brand release that adds a dark tier
  // has an obvious checklist.
  bgDark: "#0e1512",
  fgDark: "#e8ece9",
  mutedDark: "#93a49c",
  lineDark: "#243029",
  cardDark: "#141c18",
  accentDark: "#4fbf95",
  warnDark: "#f0b26b",
  warnbgDark: "#2a1e10",
};

/**
 * Light scheme. Six of eight now come from the design system.
 *
 * Two values MOVED rather than merely gaining a name, and they are the reviewable
 * part of this change:
 *
 *   --warn    #8a4b12 → color.amber      #8C5818  (ΔE 5.38)
 *   --warnbg  #fdf3e7 → color.amber-tint #F3E8D6  (ΔE 3.41)
 *
 * Bigger than transcription drift, but there is exactly one amber in the system
 * and this is exactly its role — the caution pair. brand specifies amber-600 as
 * text-AA and CVD-safe (≥4.5:1 under deuteranopia/protanopia/tritanopia) ON the
 * amber wash, which is a property desk's hand-picked pair was never checked for.
 * Measured, the stale stamp's text-on-ground goes 6.19:1 → 4.92:1: still AA, and
 * now AA under colour-vision deficiency too, which it was not before.
 *
 * A NEARER TOKEN EXISTS FOR --warnbg AND IS THE WRONG ONE. `grade.partial-bg`
 * #F7EEE0 is ΔE 1.62 from the current value, less than half the distance to
 * amber-tint. It is also the surface for "partially enforced", a claim grade.
 * The stale stamp is a staleness warning. Picking the closer number would be the
 * whole failure this file exists to prevent.
 */
export const LIGHT = {
  bg: UNPINNED.bgLight,
  fg: INK,
  muted: INK_SOFT,
  line: UNPINNED.lineLight,
  card: CARD,
  accent: FOREST,
  warn: AMBER,
  warnbg: AMBER_TINT,
};

/** Dark scheme. Nothing to pin — see UNPINNED and the header. */
export const DARK = {
  bg: UNPINNED.bgDark,
  fg: UNPINNED.fgDark,
  muted: UNPINNED.mutedDark,
  line: UNPINNED.lineDark,
  card: UNPINNED.cardDark,
  accent: UNPINNED.accentDark,
  warn: UNPINNED.warnDark,
  warnbg: UNPINNED.warnbgDark,
};

/** `:root { --bg:…; … }` — one writer for both schemes, so they cannot diverge. */
export const vars = (scheme) =>
  Object.entries(scheme)
    .map(([k, v]) => `--${k}:${v};`)
    .join(" ");
