// The icon is the design system's, not a redrawing of it (#51).
//
// An earlier version of this reconstructed the glyph from bounded.tools' 32×32
// favicon and lost two things 32px cannot carry: the GAP in the bottom of the
// door, and the rounded SQUARE inside it (which reads as a vertical bar at that
// size). A published brand package existed the whole time. These tests pin the
// bytes to it so a bump that changes the mark cannot land silently.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { AVATAR_SVG, AVATAR_460, AVATAR_1024, iconBytes } from "../src/icons.js";
import { ASSETS, MANIFEST, sha256, vendored } from "../scripts/make-icons.mjs";

test("the committed bytes match their recorded hashes — no install needed", async () => {
  // This is the half that runs EVERYWHERE. The package comparison below can only
  // run where the devDependency is installed, and CI does not install, so on its
  // own it would be a check that silently skips (`.github`#789's failure).
  const record = JSON.parse(await readFile(MANIFEST, "utf8"));
  assert.equal(record.package, "@bounded-systems/brand");
  assert.match(record.version, /^\d+\.\d+\.\d+/);
  assert.equal(Object.keys(record.files).length, ASSETS.length, "every vendored file is recorded");
  for (const [, to] of ASSETS) {
    assert.equal(sha256(await readFile(to)), record.files[to], `${to} does not match its recorded hash`);
  }
});

test("what is committed is byte-identical to @bounded-systems/brand", async (t) => {
  let pkg;
  try {
    pkg = await vendored();
  } catch {
    // The package is a devDependency; in an install-less environment there is
    // nothing to compare against and skipping is honest. CI installs, so CI
    // checks. Skipping silently is the failure this comment exists to prevent
    // being mistaken for a pass.
    return t.skip("@bounded-systems/brand is not installed");
  }
  for (const [, to] of ASSETS) {
    const committed = await readFile(to);
    assert.ok(committed.equals(pkg[to]), `${to} has drifted from the brand package`);
  }
});

test("the door has a gap in its bottom edge", () => {
  // The path runs from x=57.5 around to x=42.5 and stops — it does not close.
  // Reconstructing it as a closed rounded rect is the specific mistake this
  // replaces.
  assert.match(AVATAR_SVG, /M57\.5 81/);
  assert.match(AVATAR_SVG, /L42\.5 81/);
  assert.ok(!/\bZ\b/.test(AVATAR_SVG), "the path must not be closed");
});

test("the thing inside the door is a rounded square", () => {
  assert.match(AVATAR_SVG, /<rect x="44" y="51" width="12" height="12" rx="2\.6"/);
});

test("the plate is the brand green, and opaque to the edge", () => {
  assert.match(AVATAR_SVG, /<rect width="1024" height="1024" fill="#0C5A42"/);
  // Same value as the app's theme_color — a mismatch shows as a flash of the
  // wrong colour on launch.
  assert.match(AVATAR_SVG, /#0C5A42/);
});

test("the PNGs really are the sizes they are served as", () => {
  for (const [b64, want] of [[AVATAR_460, 460], [AVATAR_1024, 1024]]) {
    const b = iconBytes(b64);
    assert.ok(b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47, "is a PNG");
    // Width lives at byte 16, big-endian — read the pixels, not the filename.
    const w = (b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19];
    const h = (b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23];
    assert.equal(w, want);
    assert.equal(h, want, "square");
  }
});
