// assess-shortcomings.ts — audits the codebase for improvements and adds them to the backlog.
//
// When the backlog runs dry, the loop can run this assessment step. A shared
// cadence + O_EXCL lease limits every swarm to one audit per interval. The audit
// uses the Gemini-first explorer lane, inspects the workspace, tests and
// persona, then adds its JSON findings directly to the backlog.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve, dirname } from "node:path";
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync,
  rmSync, writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { getBacklog } from "./backlog.ts";
import { log } from "./telemetry.ts";
import { parseStructured, retryPrompt, validate, formatErrors } from "./schema.ts";
import { laneArgs } from "./lanes.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(process.cwd());
const STATE_DIR = resolve(process.env.HARNESS_STATE_DIR || resolve(ROOT, ".harness"));
const STATE_FILE = "shortcomings-assessment.json";
const LOCK_FILE = "shortcomings-assessment.lock";

/** Cadence bookkeeping for the shared idle audit. */
interface AssessmentState {
  lastAttempt?: string;
  lastOutcome?: string;
  lastFinishedAt?: string;
  [key: string]: unknown;
}

interface AgentRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** One card the auditor proposed. */
interface ProposedCard {
  card: string;
  spec: string;
}

interface BacklogLike {
  list(): Array<{ card: string }>;
  add(card: string, spec: string, source: string): Promise<unknown> | unknown;
}

function readJson(path: string, fallback: Record<string, unknown> = {}): Record<string, any> {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}

function positiveHours(value: unknown, fallback: number): number {
  const hours = Number(value);
  return Number.isFinite(hours) && hours > 0 ? hours * 3_600_000 : fallback * 3_600_000;
}

/** Decide whether the shared idle audit is due without touching the filesystem. */
export function assessmentDue(state: AssessmentState = {}, {
  now = Date.now(),
  intervalMs = positiveHours(process.env.ASSESSMENT_INTERVAL_HOURS, 24),
  retryMs = positiveHours(process.env.ASSESSMENT_RETRY_HOURS, 1),
} = {}) {
  const last = Date.parse(state.lastAttempt || "");
  if (!Number.isFinite(last)) return true;
  const wait = state.lastOutcome === "success" ? intervalMs : retryMs;
  return now - last >= wait;
}

/**
 * Claim the one shared assessment slot used by every swarm worker. O_EXCL keeps
 * simultaneous idle workers from each launching their own explorer audit.
 *
 * The lease is deliberately fail-closed: wall-clock age alone never proves an
 * auditor stopped, so an old lock is not stolen automatically. The owner removes
 * its own token in `finally`; after a process/host crash an operator may remove
 * the orphaned lock once they have verified that no audit is still running.
 */
/**
 * A held lease, or the reason it was not granted.
 *
 * Discriminated on a literal so `if (!lease.acquired) return` actually narrows.
 * With `acquired: boolean` the compiler keeps both arms alive and every later
 * use of statePath/release reads as possibly-undefined.
 */
export type AssessmentLease =
  | { acquired: false; reason: string }
  | { acquired: true; statePath: string; release(): void };

export function acquireAssessmentLease({
  stateDir = STATE_DIR,
  now = Date.now(),
  intervalMs = positiveHours(process.env.ASSESSMENT_INTERVAL_HOURS, 24),
  retryMs = positiveHours(process.env.ASSESSMENT_RETRY_HOURS, 1),
} = {}) {
  const dir = resolve(stateDir);
  const statePath = resolve(dir, STATE_FILE);
  const lockPath = resolve(dir, LOCK_FILE);
  mkdirSync(dir, { recursive: true });

  if (!assessmentDue(readJson(statePath), { now, intervalMs, retryMs })) {
    return { acquired: false as const, reason: "cooldown" };
  }
  if (existsSync(lockPath)) return { acquired: false as const, reason: "running" };

  const owner = randomUUID();
  try {
    const fd = openSync(lockPath, "wx");
    writeFileSync(fd, JSON.stringify({ owner, acquiredAt: new Date(now).toISOString() }) + "\n");
    closeSync(fd);
  } catch {
    return { acquired: false as const, reason: "running" };
  }

  const releaseOwnedLock = () => {
    if (readJson(lockPath).owner === owner) rmSync(lockPath, { force: true });
  };

  const latest = readJson(statePath);
  if (!assessmentDue(latest, { now, intervalMs, retryMs })) {
    releaseOwnedLock();
    return { acquired: false as const, reason: "cooldown" };
  }
  writeFileSync(statePath, JSON.stringify({
    ...latest,
    lastAttempt: new Date(now).toISOString(),
    lastOutcome: "running",
  }, null, 2) + "\n");

  let released = false;
  return {
    acquired: true as const,
    statePath,
    release() {
      if (released) return;
      released = true;
      releaseOwnedLock();
    },
  };
}

function finishAssessment(lease: { statePath: string; release(): void }, outcome: string, detail: Record<string, unknown> = {}) {
  const state = readJson(lease.statePath);
  writeFileSync(lease.statePath, JSON.stringify({
    ...state,
    ...detail,
    lastFinishedAt: new Date().toISOString(),
    lastOutcome: outcome,
  }, null, 2) + "\n");
}

// Structured-output contract for the assessment: an array of task cards. Parsed
// and schema-validated (schema.ts) with one format-feedback retry; a partially
// valid array is salvaged item-by-item instead of thrown away.
export const CARDS_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    required: ["card", "spec"],
    properties: {
      card: { type: "string", pattern: "^[a-z0-9][a-z0-9-]*$" },
      spec: { type: "string", minLength: 8 },
    },
  },
};

// Drive the Gemini-first exploration lane once; agent-session retains provider
// and same-provider model failover when that lane reaches a usage limit.
function invokeAgent(prompt: string): Promise<AgentRun> {
  const sessionScript = resolve(HERE, "..", "agent-session.ts");
  const child = spawn(process.execPath, [sessionScript, ...laneArgs("assessment"), prompt], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => { stdout += d.toString(); });
  child.stderr.on("data", (d) => { stderr += d.toString(); });
  return new Promise((res) => child.on("exit", (code) => res({ code, stdout, stderr })));
}

/**
 * Runs the shortcomings self-assessment and adds generated tasks to the backlog.
 * @param {object} backlog backlog backend
 */
async function runAssessmentOnce(backlog: BacklogLike) {
  try {
    await log("iterate", { actor: "ralph", detail: "starting autonomous shortcomings assessment" });
  } catch {}
  console.log("[Assess] Spawning agent to inspect workspace for shortcomings...");

  const assessmentPrompt = [
    "You are a Senior QA/Developer Auditor assessing this workspace, working as a STRUCTURED DEVIL'S ADVOCATE.",
    "Examine the codebase files, folder structure, test runner setup, and logs to identify shortcomings.",
    "Specifically look for: bugs, missing tests, UI/UX gaps (referencing DESIGN.md), incomplete features, todo comments, and violations of the developer's values in .claude/persona.md.",
    "",
    "Resist confirmation bias: an audit that only confirms the project is healthy is a failed audit.",
    "Argue against the current direction, not just for more of it. Prioritize:",
    "  - security exposure before any user touches it (auth, secrets, data in API responses, injection, vulnerable deps),",
    "  - missing tests for logic that already shipped (each fixed bug should leave behind a regression test),",
    "  - scope creep already in the codebase (features built that no evidence justified),",
    "  - structural/architectural debt that will compound as usage grows.",
    "Before proposing a fix, consider whether a similar problem was already solved elsewhere; if the central hub is",
    "reachable you may consult prior knowledge with: node scripts/loop/knowledge.ts recall \"<topic>\".",
    "",
    "Output your findings ONLY as a raw JSON array of task cards.",
    "Each object in the array MUST have:",
    "  - 'card': a URL-friendly lowercase unique slug (using hyphens only, e.g., 'add-error-boundary')",
    "  - 'spec': a clear, actionable instruction for a builder to implement, INCLUDING the acceptance criterion (what evidence proves it is fixed).",
    "",
    "Do NOT wrap the output in markdown code blocks like ```json. Do NOT include any conversation or text outside the JSON array.",
    "If no shortcomings or gaps are found, return an empty array: []",
    "",
    "Format example: [{\"card\": \"add-unit-test-login\", \"spec\": \"Add unit tests for user authentication states in tests/auth.test.js; accept when the failing trailing-space email case is covered and green\"}]",
  ].join("\n");

  const first = await invokeAgent(assessmentPrompt);
  if (first.code !== 0) {
    console.error(`[Assess] Agent assessment exited with code ${first.code}`);
    console.error(first.stderr);
    try {
      await log("error", { actor: "ralph", detail: `shortcomings assessment failed with code ${first.code}` });
    } catch {}
    return { ok: false, reason: `agent exited ${first.code}` };
  }

  // Structured output: extract + schema-validate, with one format-feedback retry.
  let parsed = parseStructured<ProposedCard[]>(first.stdout, CARDS_SCHEMA);
  if (!parsed.ok) {
    console.error(`[Assess] Output failed schema validation (${formatErrors(parsed.errors)}) — asking the agent to correct its format...`);
    const second = await invokeAgent(retryPrompt(assessmentPrompt, parsed.errors, first.stdout));
    if (second.code === 0) parsed = parseStructured(second.stdout, CARDS_SCHEMA);
  }

  let tasks: ProposedCard[];
  if (parsed.ok) {
    tasks = parsed.value ?? [];
  } else if (Array.isArray(parsed.value)) {
    // The array parsed but some items are malformed — salvage the valid ones.
    tasks = parsed.value.filter((t: ProposedCard) => validate(t, CARDS_SCHEMA.items).length === 0);
    console.error(`[Assess] Salvaged ${tasks.length} schema-valid card(s) from a partially invalid array.`);
  } else {
    console.error("[Assess] Failed to obtain a schema-valid task array after retry. Raw output was:");
    console.log(first.stdout);
    try {
      await log("error", { actor: "ralph", detail: "failed to parse shortcomings assessment output (after schema retry)" });
    } catch {}
    return { ok: false, reason: "schema validation failed" };
  }

  console.log(`[Assess] Agent found ${tasks.length} potential improvements/tasks.`);

  let addedCount = 0;
  const allTasks = backlog.list();
  const existingCards = new Set(allTasks.map((t: { card: string }) => t.card));

  for (const t of tasks) {
    if (!t.card || !t.spec) continue;
    if (existingCards.has(t.card)) {
      console.log(`[Assess] Task ${t.card} already exists. Skipping.`);
      continue;
    }
    await backlog.add(t.card, t.spec, "assess");
    try {
      await log("iterate", { card: t.card, actor: "ralph", detail: `automatically added shortcoming task: ${t.spec}` });
    } catch {}
    console.log(`[Assess] Added new task: ${t.card}`);
    addedCount++;
  }

  console.log(`[Assess] Added ${addedCount} new tasks to the backlog.`);
  return { ok: true, added: addedCount, found: tasks.length };
}

export async function runAssessment(backlog: BacklogLike, options: Record<string, unknown> = {}) {
  const lease = acquireAssessmentLease(options);
  if (!lease.acquired) return { skipped: true, reason: lease.reason };

  try {
    const result = await runAssessmentOnce(backlog);
    finishAssessment(lease, result.ok ? "success" : "failed", {
      added: result.added || 0,
      found: result.found || 0,
      reason: result.reason || null,
    });
    return { skipped: false, ...result };
  } catch (error) {
    finishAssessment(lease, "failed", { reason: (error as Error)?.message || String(error) });
    throw error;
  } finally {
    lease.release();
  }
}

// CLI entry point
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
  const b = await getBacklog();
  runAssessment(b).catch(console.error);
}
