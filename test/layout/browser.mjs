// A real browser, or an honest skip.
//
// THESE TESTS CANNOT BE MOVED INTO `npm test` AND MUST NOT BE FAKED IN ONE.
// What they measure — the layout viewport a phone chooses, a min-content
// contribution, the height of a rendered line box, what forced-colors paints —
// are outcomes of layout and the cascade. A DOM library has neither: a
// "target size" assertion written against linkedom reads the CSS this repo
// authored and agrees with it, which is the trap one level down.
//
// So: a real Chromium, behind `npm run test:layout`, skipping LOUDLY when the
// browser is not on this machine. A silent skip is `.github`#789's failure — a
// rule absent in 89 of 91 repos with a clean summary printed every run.
import { existsSync, readdirSync } from "node:fs";

/** Where a Chromium is, in preference order. */
function findChromium(chromium) {
  const named = process.env.CHROMIUM_PATH;
  if (named && existsSync(named)) return named;
  try {
    const p = chromium.executablePath();
    if (p && existsSync(p)) return p;
  } catch {
    /* no browser registered with this playwright install */
  }
  // The image this repo's sessions run in ships one outside playwright's own
  // registry. Last, so a properly installed browser always wins.
  const shared = "/opt/pw-browsers";
  if (existsSync(shared)) {
    for (const d of readdirSync(shared)) {
      const p = `${shared}/${d}/chrome-linux/chrome`;
      if (existsSync(p)) return p;
    }
  }
  return null;
}

/**
 * `{ browser }` or `{ skip: "why" }`. Never throws — a missing browser is a
 * reason to say so, not a failure of the thing under test.
 */
export async function launch() {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    return { skip: "playwright is not installed — `npm i` then `npx playwright install chromium`" };
  }
  const executablePath = findChromium(chromium);
  if (!executablePath) return { skip: "no Chromium on this machine — `npx playwright install chromium`" };
  const browser = await chromium.launch({
    executablePath,
    // --no-sandbox because these run as root in a container; the TLS cap is what
    // stops the egress proxy closing a 1.3 handshake and returning
    // ERR_CONNECTION_RESET on anything that does reach the network.
    args: ["--no-sandbox", "--ssl-version-max=tls1.2"],
    ...(process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY } } : {}),
  });
  return { browser, executablePath };
}

/**
 * A PHONE, not a narrow desktop window.
 *
 * `isMobile` IS THE WHOLE TEST. Chromium only applies the layout-viewport
 * widening heuristic — the thing that makes an unbreakable 40-character SHA
 * scale the entire page down — under mobile emulation. Without it, a desktop
 * Chromium at a 390px viewport reports innerWidth 390 on the DEFECTIVE page and
 * every assertion below passes vacuously against the bug it was written for.
 * That happened on the first run of this suite, which is why `coarsePointer`
 * below is asserted before anything else.
 */
export const phone = (width = 390) => ({
  viewport: { width, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
});

/** True only if the context really is emulating a touch device. */
export const coarsePointer = (page) =>
  page.evaluate(() => matchMedia("(pointer: coarse)").matches && matchMedia("(hover: none)").matches);
