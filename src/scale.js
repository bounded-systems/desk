// The desk scale: which dimensions come from the design system, and which do not.
//
// THIS IS palette.js's ARGUMENT, ONE AXIS OVER, AND THE FAILURE WAS ALREADY
// HERE. palette.js exists because desk typed sixteen hex literals and exactly
// one of them was character-for-character a brand token. The dimension axis had
// the identical shape and nothing checked it:
//
//   desk                          brand token          verdict
//   .notify button min-height:44px   control.md 44px      EXACT, typed by hand
//   h2 a / row link  (no floor)      control.min-tap-target 24px  MISSING
//   .tile__l  font-size:.82rem       size.text-small .8125rem  13.12px vs 13
//   .row__score font-size:.86rem     size.text-small .8125rem  13.76px vs 13
//   .stamp    font-size:.92rem       size.text-meta  .875rem   14.72px vs 14
//   .muted    font-size:.9rem        size.text-meta  .875rem   14.4px  vs 14
//   h2        font-size:1.05rem      size.text-lead  1.125rem  16.8px  vs 18
//   h1        font-size:1.6rem       size.text-h2    1.625rem  25.6px  vs 26
//   .tile__n  font-size:1.5rem       size.text-h3    1.5rem    EXACT, typed
//   .stamp/.tile/.notify radius:.6rem  radius.radius-sm 8px    9.6px vs 8
//   .notify button radius:.5rem      radius.radius-sm 8px      EXACT, typed
//
// Two of those were the token, transcribed — the same "right until someone reads
// it back and believes it" that palette.js documents for #0C5A42. The rest are
// near misses that a five-step scale has exactly one answer for. `.82rem` and
// `.86rem` are the tell: two different sizes for the same role, chosen a month
// apart by eye, where the design system has one step.
//
// WHAT MOVES, AND BY HOW MUCH. Six font sizes move by 0.12–0.80px, the page
// heading by 0.4px, `h2` up by 1.2px, and three radii down by 1.6px. Nothing
// here is a bug fix; it is a re-tune, and it is deliberately its own change so a
// bisect can tell "the board reads differently" from "the type moved onto the
// scale".
//
// WHY NOT VENDOR tokens/tokens.css. make-tokens.mjs's argument holds and is
// stronger here, not weaker: desk inlines its stylesheet into every page
// response, so 11.8KB of `@property` blocks and legacy `--bnd-*` aliases would
// ride every cold hit to carry about a dozen values.

import {
  TEXT_LABEL, TEXT_SMALL, TEXT_META, TEXT_BODY, TEXT_LEAD, TEXT_H3, TEXT_H2,
  RADIUS_SM, CONTROL_MD, MIN_TAP_TARGET,
  SPACE_1, SPACE_2, SPACE_3, SPACE_4, SPACE_5, SPACE_6, SPACE_7, SPACE_8, SPACE_10,
} from "./tokens.js";

/**
 * Values with no brand token, kept here rather than inline so "what is not
 * pinned" has one answer on this axis too. Each is a finding; none is a
 * preference.
 */
export const UNPINNED = {
  // The focus ring's corner. No token maps to a 3.2px radius — `radius-sm` is
  // 8px, which on a 2px outline offset 2px from a one-line link reads as a
  // lozenge rather than a ring. palette.js already established that a value
  // with nothing to pin to is stated rather than forced onto the nearest step.
  radiusFocus: ".2rem",

  // The monospace optical correction. `.mono` is an INLINE span inside whatever
  // it sits in — the stamp at --text-meta, the footer at --text-meta, a lede at
  // --text-body — and 92% of the parent is what keeps a monospace timestamp from
  // out-sizing the sentence around it. No token can express "of my parent": the
  // whole `size.*` tier is absolute rem steps, on purpose. Pinning this to a
  // step would fix the timestamp at one size in three different contexts.
  monoOptical: ".92em",

  // The rank rail. A grid TRACK, not a text or control dimension: it is set by
  // the widest score this board prints ("17.30") in the mono face, and the
  // spacing ramp has nothing to say about it. Named here so it is one value
  // rather than one per page, and so the next person knows it was measured
  // rather than guessed.
  railWidth: "3.4rem",

  // The page gutter, deliberately still in rem. brand's spacing ramp is px by
  // design ("a coherent 4px-based ramp"), which is right for gaps INSIDE a
  // component and wrong for the reading gutter: at 200% text a px gutter stays
  // 20px while every line inside it doubles. 2.5/1.25/4rem are space-10/5/16 at
  // a 16px root, so the ramp is what they were picked from — they simply have to
  // keep scaling. This is an argument with brand's own tier boundary and it is
  // worth raising there rather than resolving silently here.
  wrapTop: "2.5rem",
  wrapSide: "1.25rem",
  wrapBottom: "4rem",
};

/**
 * desk's CSS custom properties for size, radius, control and space.
 *
 * Named after DESK'S ROLE on the left and the brand token on the right, the same
 * way palette.js reads `muted: INK_SOFT` — so the mapping is visible at the
 * point of use rather than hidden in a table.
 */
export const SCALE = {
  "text-label": TEXT_LABEL,
  "text-small": TEXT_SMALL,
  "text-meta": TEXT_META,
  "text-body": TEXT_BODY,
  "text-lead": TEXT_LEAD,
  "text-h3": TEXT_H3,
  "text-h2": TEXT_H2,
  "radius-sm": RADIUS_SM,
  "control-md": CONTROL_MD,
  "min-tap-target": MIN_TAP_TARGET,
  "space-1": SPACE_1,
  "space-2": SPACE_2,
  "space-3": SPACE_3,
  "space-4": SPACE_4,
  "space-5": SPACE_5,
  "space-6": SPACE_6,
  "space-7": SPACE_7,
  "space-8": SPACE_8,
  "space-10": SPACE_10,
  // The stated gaps, carried as variables too — so the STYLESHEET types no
  // dimension at all and this file stays the only place to look. A literal in
  // the stylesheet is a value nobody has to justify; a literal here is one
  // sitting under the paragraph that justifies it.
  "radius-focus": UNPINNED.radiusFocus,
  "mono-optical": UNPINNED.monoOptical,
  "rail-width": UNPINNED.railWidth,
  "wrap-top": UNPINNED.wrapTop,
  "wrap-side": UNPINNED.wrapSide,
  "wrap-bottom": UNPINNED.wrapBottom,
};

/** `--text-small:0.8125rem; …` — one writer, the same shape as palette's `vars`. */
export const scaleVars = () =>
  Object.entries(SCALE)
    .map(([k, v]) => `--${k}:${v};`)
    .join(" ");
