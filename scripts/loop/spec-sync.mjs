// spec-sync.mjs — turns spec.md's "## Today" bullets into backlog cards.
//
// backlog.mjs's contract says "the human writes intent into spec.md; the Lead
// agent turns each line into a task row" — but nothing in the loop actually did
// that conversion, so bullets sat in spec.md forever unless someone ran
// `backlog.mjs add` by hand. This module is the mechanical half of the lead's
// job: parse the Today section, derive a stable card id per bullet, and add it.
//
// Idempotence comes from the card id, not from bookkeeping: the id is a slug of
// the bullet plus a short content hash, and backlog add() is INSERT OR IGNORE on
// the unique card column. Re-syncing an unchanged spec.md is a no-op even after
// the card is done; editing a bullet's text yields a new id (a new card), which
// is the desired behavior — a changed intent is new work.
//
// Bullets: `- text` or `* text`; `- [ ] text` counts, `- [x] text` is skipped
// (checked off by the human = not work). Lines outside "## Today" are ignored.
//
// CLI:
//   node scripts/loop/spec-sync.mjs          # sync once, print added cards
//   node scripts/loop/spec-sync.mjs --dry    # parse and print, add nothing

import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { getBacklog } from "./backlog.mjs";

const ROOT = resolve(process.cwd());
const SPEC_PATH = resolve(ROOT, "spec.md");

/** Extract Today-section bullets from spec.md source text. */
export function parseTodayBullets(text) {
  const lines = text.split(/\r?\n/);
  const bullets = [];
  let inToday = false;
  for (const line of lines) {
    if (/^##\s/.test(line)) { inToday = /^##\s+Today\b/i.test(line); continue; }
    if (!inToday) continue;
    const m = line.match(/^\s*[-*]\s+(.*\S)\s*$/);
    if (!m) continue;
    let item = m[1];
    if (/^\[[xX]\]\s/.test(item)) continue; // checked off — human says done
    item = item.replace(/^\[\s?\]\s+/, "");
    if (item) bullets.push(item);
  }
  return bullets;
}

/** Stable card id: ascii slug of the bullet + 6-char content hash. */
export function cardIdFor(bullet) {
  const slug = bullet
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-").filter(Boolean).slice(0, 5).join("-")
    .slice(0, 40);
  const hash = createHash("sha1").update(bullet).digest("hex").slice(0, 6);
  return `${slug || "spec"}-${hash}`;
}

/**
 * Sync spec.md bullets into the backlog. Returns { bullets, added } where
 * `added` lists only card ids newly inserted this call.
 */
export async function syncSpec(backlog) {
  if (!existsSync(SPEC_PATH)) return { bullets: [], added: [] };
  const bullets = parseTodayBullets(readFileSync(SPEC_PATH, "utf8"));
  const b = backlog ?? (await getBacklog());
  const added = [];
  for (const bullet of bullets) {
    const card = cardIdFor(bullet);
    if (b.get(card)) continue;
    b.add(card, bullet, "spec");
    added.push(card);
  }
  return { bullets, added };
}

// CLI
if (import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) {
  const dry = process.argv.includes("--dry");
  if (dry) {
    const text = existsSync(SPEC_PATH) ? readFileSync(SPEC_PATH, "utf8") : "";
    for (const bullet of parseTodayBullets(text)) console.log(`${cardIdFor(bullet)}  ${bullet}`);
  } else {
    const r = await syncSpec();
    for (const card of r.added) console.log(`added ${card}`);
    console.log(`spec-sync: ${r.bullets.length} bullet(s), ${r.added.length} new card(s)`);
  }
}
