// persona-bootstrap.mjs — behavioral cloning from git history (free labels).
//
// The slow part of building a persona is waiting for you to tap ✅/❌ on live
// changes. But you have already made hundreds of accept/reject decisions — they
// are sitting in git history:
//
//   a commit that survived            -> you (implicitly) accepted it   -> "approve"
//   a commit that was `git revert`-ed -> you rejected it after the fact -> "reject"
//
// Mining those gives the calibrator and the synthesizer a labeled prior with ZERO
// new taps, collapsing cold-start. Mathematically it shrinks the posterior
// variance from the first run instead of after N escalations.
//
// Output goes into the same dataset as live taps (persona-feedback.jsonl), tagged
// source:"history" and keyed by commit hash so re-running is idempotent.

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { loadDataset, appendRow } from "./persona-feedback.mjs";

const ROOT = resolve(process.cwd());
const US = "\x1f"; // unit separator between fields
const RS = "\x1e"; // record separator between commits

/**
 * Parse `git log` output (records: hash US subject US body RS).
 * @param {string} raw
 * @returns {Array<{hash:string, subject:string, body:string}>}
 */
export function parseLog(raw) {
  return raw
    .split(RS)
    .map((rec) => rec.replace(/^\s+/, ""))
    .filter(Boolean)
    .map((rec) => {
      const [hash = "", subject = "", body = ""] = rec.split(US);
      return { hash: hash.trim(), subject: subject.trim(), body: body.trim() };
    })
    .filter((c) => c.hash);
}

/**
 * Collect every commit hash that some later commit reverts. Git's default revert
 * body is "This reverts commit <hash>." — we read it from every commit's body.
 * @param {Array<{body:string, subject:string}>} commits
 * @returns {Set<string>} reverted hash prefixes (7–40 hex chars)
 */
export function collectReverted(commits) {
  const reverted = new Set();
  const re = /This reverts commit ([0-9a-f]{7,40})/gi;
  for (const c of commits) {
    for (const m of `${c.subject}\n${c.body}`.matchAll(re)) reverted.add(m[1].toLowerCase());
  }
  return reverted;
}

/**
 * Label one commit, or null to skip it (bookkeeping commits carry no preference).
 * @param {{hash:string, subject:string}} commit
 * @param {Set<string>} revertedSet
 * @returns {"approve"|"reject"|null}
 */
export function commitLabel(commit, revertedSet) {
  const s = commit.subject;
  if (/^revert\b/i.test(s)) return null;          // the revert itself is bookkeeping
  if (/^(wip|merge|fixup!|squash!)\b/i.test(s)) return null;
  const full = commit.hash.toLowerCase();
  for (const h of revertedSet) if (full.startsWith(h)) return "reject";
  return "approve";
}

/**
 * Turn commits into dataset rows (pure — used by tests without touching disk).
 * @param {Array} commits
 * @returns {Array<object>}
 */
export function commitsToRows(commits) {
  const reverted = collectReverted(commits);
  const rows = [];
  for (const c of commits) {
    const label = commitLabel(c, reverted);
    if (!label) continue;
    rows.push({
      card: `history:${c.hash.slice(0, 12)}`,
      spec: c.subject,
      features: { sensitive: [] },
      predicted: null,
      label,
      source: "history",
    });
  }
  return rows;
}

/**
 * Mine the repo's history and append any new labeled rows. Idempotent.
 * @param {{limit?:number}} [opt]
 * @returns {{added:number, approve:number, reject:number}}
 */
export function bootstrap({ limit = 500 } = {}) {
  const res = spawnSync(
    "git",
    ["log", `-n${limit}`, "--no-merges", `--format=%H${US}%s${US}%b${RS}`],
    { cwd: ROOT, encoding: "utf8" },
  );
  if (res.status !== 0) {
    throw new Error(`git log failed: ${res.stderr || res.status}`);
  }
  const rows = commitsToRows(parseLog(res.stdout));

  const seen = new Set(loadDataset().map((r) => r.card));
  let added = 0, approve = 0, reject = 0;
  for (const row of rows) {
    if (seen.has(row.card)) continue;
    appendRow(row);
    seen.add(row.card);
    added++;
    if (row.label === "approve") approve++; else reject++;
  }
  return { added, approve, reject };
}

// CLI: `node scripts/loop/persona-bootstrap.mjs [limit]`
if (process.argv[1] && import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) {
  const limit = Number(process.argv[2]) || 500;
  const { added, approve, reject } = bootstrap({ limit });
  console.log(`persona-bootstrap: added ${added} rows from history (approve=${approve}, reject=${reject})`);
}
