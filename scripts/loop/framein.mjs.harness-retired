// framein.mjs — the cross-model continuity layer (the "Framein" verbs).
//
// The harness already swaps agent CLIs mid-task (the cooldown roster in
// ralph-loop.mjs), but a swap used to hand the next model only a bare WIP commit
// plus the one-line spec. The next lead re-derived intent, re-scanned the diff,
// and sometimes drifted from what the previous lead had agreed to build. This
// module closes that gap with four small, model-agnostic verbs — the same idea
// as framein.dev, implemented natively on top of this harness's git+SQLite state:
//
//   start    — freeze a per-card WORK CONTRACT (intent, acceptance, baseline sha,
//              path budget) the moment a card is claimed. It survives every model
//              handoff so no lead silently renegotiates the task.
//   risk     — score the working diff by the paths it touches (auth/, payments,
//              migrations, secrets, the data contract) → low|medium|high. Feeds
//              the persona deploy gate so "risk high: auth/ touched" forces a tap.
//   capsule  — package {contract, baseline→head diff, last health, risk, ledger}
//              into a handoff CAPSULE when the lead model changes, so the next
//              agent resumes with full context instead of scratch.
//   show     — print a card's contract + latest capsule + ledger.
//
// Everything is git-friendly JSON under .harness/framein/<card>.*.json (same
// convention as .harness/reject and .harness/shots). Every helper is best-effort:
// a missing git binary or unwritable dir degrades to null/empty, never throws into
// the loop. Disable risk-driven holds with FRAMEIN_RISK=off; the rest is inert
// unless ralph-loop calls it.

import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";

const ROOT = resolve(process.cwd());
const DIR = resolve(ROOT, ".harness", "framein");

function ensureDir() {
  try { mkdirSync(DIR, { recursive: true }); } catch {}
  return DIR;
}
const contractPath = (card) => resolve(DIR, `${card}.contract.json`);
const capsulePath = (card) => resolve(DIR, `${card}.capsule.json`);

// ISO timestamp helper — a plain Node script (not a workflow), so Date is fine.
const nowIso = () => new Date().toISOString();

function readJson(p) {
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}
function writeJson(p, obj) {
  ensureDir();
  writeFileSync(p, JSON.stringify(obj, null, 2) + "\n");
  return obj;
}

// --- git helpers (all best-effort, never throw) --------------------------------

function git(args) {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}
export function headSha() {
  return git(["rev-parse", "HEAD"]) || null;
}
// Files changed since `baseline` (committed diff) PLUS anything currently dirty or
// untracked in the working tree — the full surface the next lead inherits.
export function changedFiles(baseline) {
  const set = new Set();
  if (baseline) {
    for (const f of git(["diff", "--name-only", baseline, "HEAD"]).split("\n")) if (f) set.add(f);
  }
  // working-tree + staged + untracked, via porcelain (path is the 4th char on).
  // -uall lists individual untracked FILES instead of collapsing a new directory
  // to "src/" — otherwise a fresh src/auth/session.js would hide behind "src/" and
  // never trip the risk score.
  for (const line of git(["status", "--porcelain", "-uall"]).split("\n")) {
    const f = line.slice(3).trim();
    if (f) set.add(f.includes(" -> ") ? f.split(" -> ")[1] : f);
  }
  // Drop the harness's own bookkeeping (.harness/framein/*, locks, shots): it's not
  // part of the change under review and would only add noise to the risk reasons.
  return [...set].filter((f) => !f.startsWith(".harness/"));
}
function diffStat(baseline) {
  if (!baseline) return git(["diff", "--stat"]);
  return git(["diff", "--stat", baseline, "HEAD"]) || git(["diff", "--stat"]);
}

// --- risk scoring --------------------------------------------------------------

// Path/intent signals that raise the blast radius. `crit:true` means a single hit
// is enough to force "high" — these mirror the SENSITIVE list in persona-approve,
// but scored on the FILES the diff actually touches (framein's "risk high: x/").
export const RISK_PATTERNS = [
  { re: /(^|\/)(auth|login|session|oauth|permission|rbac|acl)([./_-]|$)/i, why: "auth/permissions", crit: true, w: 3 },
  { re: /(secret|credential|password|\.env(\.|$)|token|apikey|api[_-]?key|private[_-]?key)/i, why: "secrets/credentials", crit: true, w: 3 },
  { re: /(migrat|schema|alter[_-]?table)/i, why: "schema/migration", crit: true, w: 3 },
  { re: /(payment|billing|invoice|charge|stripe|subscription|pricing|checkout)/i, why: "billing/payments", crit: true, w: 3 },
  { re: /(data-contract|data_contract)/i, why: "data contract", crit: true, w: 3 },
  { re: /(deploy|railway|infra|terraform|dockerfile|\.github\/workflows|dns)/i, why: "deploy/infra", crit: false, w: 2 },
  { re: /(package(-lock)?\.json|pnpm-lock|yarn\.lock|go\.mod|requirements\.txt|cargo\.toml)/i, why: "dependency manifest", crit: false, w: 1 },
];

/**
 * Score a change by the paths it touches (and, secondarily, the spec text).
 * @param {string[]} files changed file paths
 * @param {string} [spec] the card intent (a fallback signal when no files yet)
 * @returns {{level:"low"|"medium"|"high", score:number, reasons:string[]}}
 */
export function riskScore(files = [], spec = "") {
  const reasons = new Set();
  let score = 0;
  let critical = false;
  const probe = (text, weightMul = 1) => {
    for (const { re, why, crit, w } of RISK_PATTERNS) {
      if (re.test(text)) {
        if (!reasons.has(why)) { reasons.add(why); score += w * weightMul; }
        if (crit) critical = true;
      }
    }
  };
  for (const f of files) probe(f);
  // Spec text is a weak signal (no file yet, e.g. at `start`): half weight.
  if (spec) probe(spec, 0.5);

  const level = critical || score >= 3 ? "high" : score >= 1 ? "medium" : "low";
  return { level, score: Math.round(score * 10) / 10, reasons: [...reasons] };
}

// One-line risk summary in framein's `ship` phrasing, e.g.
//   "risk high: auth/permissions, secrets/credentials"
export function riskLine(risk) {
  if (!risk) return "risk unknown";
  return risk.reasons.length ? `risk ${risk.level}: ${risk.reasons.join(", ")}` : `risk ${risk.level}`;
}

// --- work contract -------------------------------------------------------------

/**
 * Freeze a work contract for a card. Idempotent: re-calling keeps the original
 * baseline sha (so a requeued/handed-off card measures its diff from the same
 * point), and only refreshes the spec/acceptance if they were empty.
 */
export function startContract({ card, spec = "", acceptance = [] }) {
  const existing = readJson(contractPath(card));
  if (existing) {
    let dirty = false;
    if (!existing.spec && spec) { existing.spec = spec; dirty = true; }
    if ((!existing.acceptance || !existing.acceptance.length) && acceptance.length) { existing.acceptance = acceptance; dirty = true; }
    if (dirty) writeJson(contractPath(card), existing);
    return existing;
  }
  const contract = {
    card,
    spec,
    acceptance,                 // optional human-checkable criteria; lead may fill later
    baseline: headSha(),        // the commit the diff is measured from, fixed for life
    createdAt: nowIso(),
    ledger: [{ at: nowIso(), agent: "lead", event: "contract.start" }],
  };
  return writeJson(contractPath(card), contract);
}

export function loadContract(card) {
  return readJson(contractPath(card));
}

/** Append a handoff/iteration event to the contract ledger. Best-effort. */
export function appendLedger(card, { agent, event, detail }) {
  const c = readJson(contractPath(card));
  if (!c) return null;
  c.ledger = c.ledger || [];
  c.ledger.push({ at: nowIso(), agent, event, ...(detail ? { detail } : {}) });
  return writeJson(contractPath(card), c);
}

// --- handoff capsule -----------------------------------------------------------

/**
 * Build and persist a handoff capsule for switching the lead model. Captures the
 * contract, the baseline→head diff surface, the current risk, and the ledger so
 * the `to` agent resumes with everything the `from` agent knew.
 */
export function writeCapsule({ card, from = "?", to = "next", health = null }) {
  const contract = loadContract(card);
  const baseline = contract?.baseline ?? null;
  const files = changedFiles(baseline);
  const risk = riskScore(files, contract?.spec || "");
  const capsule = {
    card,
    from,
    to,
    at: nowIso(),
    spec: contract?.spec || "",
    acceptance: contract?.acceptance || [],
    baseline,
    head: headSha(),
    changedFiles: files,
    diffStat: diffStat(baseline),
    risk,
    health,                     // optional: "pass" | "fail" | last health tail
    ledger: contract?.ledger || [],
  };
  appendLedger(card, { agent: from, event: "capsule.write", detail: `→ ${to} (${riskLine(risk)})` });
  return writeJson(capsulePath(card), capsule);
}

export function loadCapsule(card) {
  return readJson(capsulePath(card));
}

/**
 * Render a capsule as a context block to PREPEND to the next agent's input, so a
 * fresh lead model picks up mid-task without losing the contract or the diff.
 */
export function capsuleMarkdown(capsule) {
  if (!capsule) return "";
  const lines = [
    "[FRAMEIN HANDOFF CAPSULE — you are taking over this task mid-flight; honor the contract below, do not renegotiate it]",
    `Card: ${capsule.card}    handoff: ${capsule.from} → ${capsule.to}    ${riskLine(capsule.risk)}`,
    `Intent (frozen contract): ${capsule.spec || "(see task)"}`,
  ];
  if (capsule.acceptance?.length) {
    lines.push("Acceptance criteria:");
    for (const a of capsule.acceptance) lines.push(`  - ${a}`);
  }
  lines.push(`Baseline commit: ${capsule.baseline || "(unknown)"}    current HEAD: ${capsule.head || "(unknown)"}`);
  if (capsule.changedFiles?.length) {
    lines.push(`Files touched so far (${capsule.changedFiles.length}): ${capsule.changedFiles.slice(0, 20).join(", ")}${capsule.changedFiles.length > 20 ? " …" : ""}`);
  }
  if (capsule.diffStat) lines.push("Diff stat:\n" + capsule.diffStat);
  if (capsule.health) lines.push(`Last health: ${capsule.health}`);
  if (capsule.ledger?.length) {
    lines.push("Ledger (who touched this, latest last):");
    for (const e of capsule.ledger.slice(-8)) lines.push(`  - ${e.at} ${e.agent} ${e.event}${e.detail ? " — " + e.detail : ""}`);
  }
  lines.push("[END CAPSULE]");
  return lines.join("\n");
}

// --- CLI -----------------------------------------------------------------------

function printUsage() {
  console.error(
    [
      "usage:",
      '  framein start   <card> "<spec>"      freeze a work contract (baseline + intent)',
      "  framein risk    <card>               score the working diff: low|medium|high",
      "  framein capsule <card> [toAgent]     write a handoff capsule, print it",
      "  framein show    <card>               print contract + latest capsule + ledger",
      "  framein ledger  <card>               print the ledger only",
    ].join("\n"),
  );
}

async function cli() {
  const [verb, card, ...rest] = process.argv.slice(2);
  if (!verb || !card) { printUsage(); process.exit(2); }

  switch (verb) {
    case "start": {
      const c = startContract({ card, spec: rest.join(" ").trim() });
      console.log(JSON.stringify(c, null, 2));
      return 0;
    }
    case "risk": {
      const contract = loadContract(card);
      const files = changedFiles(contract?.baseline ?? null);
      const risk = riskScore(files, contract?.spec || rest.join(" "));
      console.log(JSON.stringify({ ...risk, line: riskLine(risk), files }, null, 2));
      // exit code carries the level for scripting: 0 low, 10 medium, 20 high
      return risk.level === "high" ? 20 : risk.level === "medium" ? 10 : 0;
    }
    case "capsule": {
      const cap = writeCapsule({ card, from: rest[0] || "?", to: rest[1] || "next" });
      console.log(capsuleMarkdown(cap));
      return 0;
    }
    case "show": {
      console.log(JSON.stringify({ contract: loadContract(card), capsule: loadCapsule(card) }, null, 2));
      return 0;
    }
    case "ledger": {
      const c = loadContract(card);
      console.log(JSON.stringify(c?.ledger || [], null, 2));
      return 0;
    }
    default:
      printUsage();
      return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli().then((code) => process.exit(code || 0)).catch((e) => {
    console.error(e?.stack || String(e));
    process.exit(1);
  });
}
