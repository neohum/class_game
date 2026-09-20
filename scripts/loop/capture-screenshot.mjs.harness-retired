// capture-screenshot.mjs — full-page screenshot of the running app for mobile review.
//
// The autonomous loop builds a feature, boots the dev server, then calls this to
// produce one canonical PNG the human reviews on their phone. We standardize on
// headless Chromium at a fixed viewport (1280x800, deviceScaleFactor 2) so the
// render is identical regardless of the developer's OS, fonts, or DPI — the agent
// and the human are always looking at the same pixels.
//
// Playwright is an OPTIONAL dependency: it is imported dynamically so this file
// passes `node --check` and the scaffolder installs cleanly even when playwright
// is absent. Install it only on machines that actually capture screenshots.
//
// Required env (all have defaults):
//   SCREENSHOT_URL  target app URL                    (default http://localhost:3000)
//   SCREENSHOT_OUT  output PNG path                    (default .harness/shots/<timestamp>.png)

import { resolve, dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { log } from "./telemetry.mjs";

const DEFAULT_URL = process.env.SCREENSHOT_URL || "http://localhost:3000";

function defaultOut() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return resolve(process.cwd(), ".harness", "shots", `${stamp}.png`);
}

/**
 * Capture a full-page screenshot with headless Chromium.
 * @param {{url?:string, out?:string}} [opts]
 * @returns {Promise<string>} the absolute output path written
 */
export async function capture({ url, out } = {}) {
  const target = url || DEFAULT_URL;
  const outPath = resolve(out || process.env.SCREENSHOT_OUT || defaultOut());

  let playwright;
  try {
    playwright = await import("playwright");
  } catch {
    console.error(
      "playwright not installed — run: npm i -D playwright && npx playwright install chromium",
    );
    process.exit(127);
  }

  mkdirSync(dirname(outPath), { recursive: true });

  const browser = await playwright.chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    await page.goto(target, { waitUntil: "networkidle" });
    await page.screenshot({ path: outPath, fullPage: true });
  } finally {
    await browser.close();
  }

  try {
    await log("iterate", { actor: "screenshot", detail: { url: target, out: outPath } });
  } catch { /* telemetry must never break the capture */ }

  return outPath;
}

// CLI: `node scripts/loop/capture-screenshot.mjs [url] [outPath]`
if (import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) {
  const [url, outPath] = process.argv.slice(2);
  capture({ url, out: outPath })
    .then((p) => console.log(`✓ screenshot written: ${p}`))
    .catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
}
