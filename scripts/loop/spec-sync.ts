// spec-sync.ts — turns spec.md's "## Today" bullets into backlog cards.
//
// backlog.ts's contract says "the human writes intent into spec.md; the Lead
// agent turns each line into a task row" — but nothing in the loop actually did
// that conversion, so bullets sat in spec.md forever unless someone ran
// `backlog.ts add` by hand. This module is the mechanical half of the lead's
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
//   node scripts/loop/spec-sync.ts          # sync once, print added cards
//   node scripts/loop/spec-sync.ts --dry    # parse and print, add nothing

import { resolve } from "node:path";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { getBacklog } from "./backlog.ts";

const ROOT = resolve(process.cwd());
const SPEC_PATH = resolve(ROOT, "spec.md");

/**
 * Extract Today-section bullets from spec.md source text.
 *
 * HTML comments are removed first. The shipped spec.md explains the format with
 * example bullets inside a `<!-- ... -->` block, and without this every freshly
 * scaffolded project queued those examples as real cards — an agent would go
 * build a "remember me" checkbox for a project with no login screen. A comment
 * left unterminated drops everything after it, because that is what it renders
 * as, and queuing work from a half-written note is the worse failure.
 */
export function parseTodayBullets(text: unknown): string[] {
  const lines = String(text)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!--[\s\S]*$/, "")
    .split(/\r?\n/);
  const bullets = [];
  let inToday = false;
  for (const line of lines) {
    if (/^##\s/.test(line)) { inToday = /^##\s+Today\b/i.test(line); continue; }
    if (!inToday) continue;
    const m = line.match(/^\s*[-*]\s+(.*\S)\s*$/);
    if (!m) continue;
    let item = m[1] ?? "";
    if (/^\[[xX]\]\s/.test(item)) continue; // checked off — human says done
    item = item.replace(/^\[\s?\]\s+/, "");
    if (item) bullets.push(item);
  }
  return bullets;
}

/** Stable card id: ascii slug of the bullet + 6-char content hash. */
export function cardIdFor(bullet: string): string {
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
/** The slice of backlog.ts this needs, so a caller can inject a double. */
interface BacklogLike {
  get(card: string): unknown;
  add(card: string, spec: string, source: string): Promise<unknown> | unknown;
}

export async function syncSpec(backlog?: BacklogLike) {
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
// `import.meta.url` is realpath-resolved by the loader, while `process.argv[1]` is
// the raw path the caller typed. On a symlinked path (macOS /tmp -> /private/tmp,
// /var -> /private/var, linked checkouts) the two differ and a naive comparison
// makes this CLI silently no-op with exit 0. Compare both through realpath.
const isMainModule = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isMainModule) {
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
