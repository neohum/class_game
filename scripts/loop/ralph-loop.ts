// ralph-loop.ts — the autonomous development loop driver.
//
// Named for the "Ralph-Loop" coordination pattern in this harness: instead of a
// heavyweight message queue, agents coordinate through a shared git repo, a
// SQLite backlog, and lock files under current_tasks/. This script is the
// always-on heartbeat that runs on the Linux server while the developer is
// offline. It does NOT itself reason about code — it orchestrates: pick a task,
// drive the Builder under a hard iteration cap and per-command timeout, gate on
// health.sh, hand to the Reviewer, and surface the result for mobile approval.
//
// One iteration of the loop:
//   1. git pull            — sync with the bare repo (other machines/agents)
//   2. claim a task        — SQLite txn + current_tasks/<card>.lock (race-safe)
//   3. honor rejections    — if .harness/reject/<card>.json exists, re-inject it
//   4. build iterations    — invoke the builder CLI, run health.sh, repeat to cap
//   5. review + report     — on green, mark for review; notify via Telegram
//   6. release / requeue   — drop the lock; failed tasks go back to 'open'
//
// Safety rails (all configurable via env):
//   LOOP_MAX_ITERS     hard cap on build iterations per task   (default 6)
//   LOOP_MAX_ATTEMPTS  failed claim→build→review attempts before a card is
//                      parked as 'failed' (terminal) instead of requeued (default 5)
//   LOOP_CMD_TIMEOUT   ms before a child command is killed     (default 600000)
//   LOOP_INTERVAL      ms to sleep when the backlog is empty    (default 30000)
//   LOOP_ONCE=1        run exactly one task then exit (for cron / testing)
//   LOOP_BUILDER       command to run one build iteration; receives the task
//                      spec on argv. default: node scripts/invoke-codex.ts
//   LOOP_DRY=1         skip git push + deploy notify (local dry run)
//
// Exit: runs forever unless LOOP_ONCE=1. SIGINT/SIGTERM finish the current
// iteration's cleanup (lock release) before exiting.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve, dirname, delimiter, relative } from "node:path";
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getBacklog, type Backlog, type TaskRow } from "./backlog.ts";
import { log } from "./telemetry.ts";
import { defineGraph, runGraph, loadCheckpoint, END, HALT } from "./graph.ts";
import { withSpan, currentSpan } from "./trace.ts";
import { claimTask, reclaimStaleClaims } from "./claim-task.ts";
import { runAssessment } from "./assess-shortcomings.ts";
import { startPainPointScout } from "./pain-point-scout.ts";
import { runPromptAssessment } from "./assess-prompts.ts";
import { syncSpec } from "./spec-sync.ts";
import { compilePlan } from "./plan-compile.ts";
import { compilePlanDocs, planConfig, planForCard, stepBrief } from "./plan-doc.ts";
import { planGateDecision } from "./plan-gate.ts";
import { evidenceRequired, openEvidence, verifyEvidence } from "./evidence.ts";
import { readyCards, blockedSummary, pickForWorker } from "./deps.ts";
import { runDesignAssessment } from "./assess-design.ts";
import { buildFeedback } from "./feedback-distill.ts";
import { budgetStatus, recordUsage, parseUsage } from "./budget.ts";
import { isBulkLane, bulkLane } from "./lanes.ts";
import { markUnattended, optOutRefusal, unattendedHostAllowed, GOVERNED_OPT_OUTS } from "./autonomy.ts";
import { gatherValidationContext } from "./validate-card.ts";
import { record as recordKnowledge } from "./knowledge.ts";
import { personaApprove, type PersonaVerdict } from "./persona-approve.ts";
import { holdCard, type PendingMarker } from "./decide.ts";
import {
  startContract, appendLedger, writeCapsule, loadCapsule, capsuleMarkdown,
  loadContract, riskScore, riskLine, type Risk,
} from "./framein.ts";
import {
  analyzeDiff, formatSloppinessPrompt, suggestRefactorCard,
} from "./sloppiness.ts";

import { bootstrap as bootstrapPersona } from "./persona-bootstrap.ts";
import { synthesize as synthesizePersona } from "./persona-synthesize.ts";
import { fit as fitCalibration, saveParams as saveCalibration, ece as calibrationEce } from "./persona-calibrate.ts";
import { labeledRows } from "./persona-feedback.ts";
import { sandboxCommand, sandboxSummary } from "./sandbox.ts";
import {
  enabled as worktreeEnabled, ensureWorktree, integrate as integrateWorktree,
  removeWorktree, baseBranch as worktreeBase,
} from "./worktree.ts";
import { parseStructured } from "./schema.ts";
import {
  independentAgents, trustDomainFor, type Card,
} from "./agent-policy.ts";
import {
  releaseStages, runReleaseStages, validateReleaseConfig,
} from "./release-policy.ts";

import {
  acceptanceCriteria, validateAcceptanceResults, classifyFailure, normalizeFailure,
} from "./quality-contract.ts";
import {
  setCooldown, inCooldown, remaining, activeCooldowns,
  parseResetTime, DEFAULT_WINDOWS,
} from "./cooldown.ts";

const HERE = dirname(fileURLToPath(import.meta.url));   // where the loop scripts live
// ROOT is the repo the loop operates on. The loop is always launched from the
// target repo root, and the sibling helpers (backlog/telemetry/claim) resolve
// their state from process.cwd() — so ROOT must agree with cwd, NOT with the
// script's install location. (These differ once create-agent-harness copies the
// scripts into a project and the loop runs there.)
const ROOT = resolve(process.cwd());
// Swarm workers (scripts/loop/swarm.ts) run in isolated checkouts but share ONE
// backlog/lock/state surface by pointing these env vars at the primary repo.
const LOCK_DIR = resolve(process.env.HARNESS_LOCK_DIR || resolve(ROOT, "current_tasks"));
const STATE_DIR = resolve(process.env.HARNESS_STATE_DIR || resolve(ROOT, ".harness"));
const REJECT_DIR = resolve(STATE_DIR, "reject");

const CFG = {
  maxIters: Number(process.env.LOOP_MAX_ITERS) || 6,
  // After this many failed claim→build→review attempts, a card is parked as
  // 'failed' (terminal) instead of being requeued forever. Prevents an unfixable
  // card (e.g. a monitor false-positive on a dead URL) from hot-looping the
  // builder + spamming Telegram. See Incident-012.
  maxAttempts: Number(process.env.LOOP_MAX_ATTEMPTS) || 5,
  cmdTimeout: Number(process.env.LOOP_CMD_TIMEOUT) || 600_000,
  interval: Number(process.env.LOOP_INTERVAL) || 30_000,
  once: process.env.LOOP_ONCE === "1",
  dry: process.env.LOOP_DRY === "1",
  // The session runner owns same-provider model handoff. Ralph owns provider
  // handoff so its independent-reviewer invariant always knows the true builder.
  builder: process.env.LOOP_BUILDER || `node ${resolve(HERE, "..", "agent-session.ts")} --agent codex --same-provider-only`,
};

let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => { stopping = true; console.log(`\n${sig} — finishing current iteration then exiting`); });
}

/**
 * The card pipeline's state bag, threaded through every graph node.
 *
 * `card` and `spec` come from the backlog row; everything else accumulates as
 * nodes run, which is why almost all of it is optional — a node reads what the
 * nodes before it happened to set. Extending Card keeps builderEligible and the
 * path allowlist reading the same object the loop carries.
 */
export interface LoopState extends Card {
  card: string;
  taskText?: string;
  builderInput?: string;
  workdir?: string;
  iter?: number;
  lastAgent?: string | null;
  feedback?: string;
  outcome?: string;
  shipped?: boolean;
  reviewApproved?: boolean;
  reviewDigest?: string;
  personaVerdict?: unknown;
  green?: boolean;
  /** consecutive red health gates from one lane — drives the quality rotation */
  redStreak?: { agent: string; count: number };
  /** architect/editor split: the change plan, and the agent that authored it */
  plan?: string;
  planner?: string | null;
  /** where the card came from (`plan-doc`, `spec`, `assess`, …) — decides the evidence gate */
  source?: string;
  /** slug of the approved plan document that declares this card, when one does */
  planDoc?: string | null;
  /** evidence/<stamp>-<card>/ — opened at prime, verified before ship */
  evidenceDir?: string;
  challengeBrief?: string;
  reviewReject?: boolean;
  runVerifyReject?: boolean;
  spec?: string;
  // Written by the graph runtime, read here — see GraphControl in graph.ts.
  __breakpoint?: { node: string; step: number };
  __maxStepsExceeded?: boolean;
}

/** What a spawned command reports back. `run` never rejects — a wedged child
 *  fails this iteration, it does not kill the loop. */
export interface RunResult {
  code: number;
  timedOut: boolean;
  stdout: string;
}

interface RunOptions {
  timeout?: number;
  capture?: boolean;
  tee?: boolean;
  sandbox?: boolean;
  envAllow?: string[];
  workspaceReadOnly?: boolean;
  cwd?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Run a command with a hard timeout. Resolves { code, timedOut, stdout }; never
// rejects — a stuck network call or wedged child must not kill the whole loop,
// it just fails this iteration (the "command execution timeout filter").
//
// bin + args are passed as an explicit array, NOT a joined string, so paths
// containing spaces (e.g. C:\Users\My Name\...) survive intact.
//   { capture: true } collects stdout INSTEAD of inheriting it.
//   { tee: true }     collects stdout AND still streams it to the console — used
//                     for agent CLIs so we can scan their output for rate-limit
//                     messages without hiding their progress.
function run(bin: string, args: string[] = [], opts: RunOptions = {}): Promise<RunResult> {
  // Observability: when we're inside a card's trace (a graph-node span is in
  // scope), every child command becomes a "tool" span — the builder CLI, the
  // health gate, git — so the dashboard waterfall shows what each node invoked,
  // for how long, and with what exit code. Outside a trace, run untraced.
  if (!currentSpan()) return runChild(bin, args, opts);
  return withSpan(`run:${bin}`, { kind: "tool", bin, arg0: String(args[0] ?? "").slice(0, 120) }, async (span) => {
    const res = await runChild(bin, args, opts);
    span.attrs.code = res.code;
    if (res.timedOut) span.attrs.timedOut = true;
    if (res.code !== 0) span.status = "error";
    return res;
  });
}

function runChild(bin: string, args: string[] = [], { timeout = CFG.cmdTimeout, capture = false, tee = false, sandbox = true, envAllow = [], workspaceReadOnly = false, cwd = ROOT }: RunOptions = {}): Promise<RunResult> {
  return new Promise<RunResult>((res) => {
    const piped = capture || tee;
    let child: import("node:child_process").ChildProcess;
    try {
      const stdio: import("node:child_process").StdioOptions = piped ? ["inherit", "pipe", "pipe"] : "inherit";
      // `cwd` doubles as the sandbox root, so in worktree mode the container
      // mounts the CARD's checkout as /workspace and the agent cannot even see
      // the main tree. Passing cwd without moving root would leave the mount at
      // ROOT and silently hand the agent the shared tree back.
      const launch = sandbox
        ? sandboxCommand(bin, args, { cwd, root: cwd, stdio, envAllow, workspaceReadOnly })
        : { bin, args, spawnOptions: { cwd, stdio, shell: process.platform === "win32", env: process.env } };
      child = spawn(launch.bin, launch.args, launch.spawnOptions);
    } catch (e) {
      res({ code: 126, timedOut: false, stdout: String((e as Error)?.message || e) });
      return;
    }
    let stdout = "";
    if (piped) {
      child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); if (tee) process.stdout.write(d); });
      child.stderr?.on("data", (d: Buffer) => { stdout += d.toString(); if (tee) process.stderr.write(d); });
    }
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeout);
    child.on("error", () => { clearTimeout(timer); res({ code: 127, timedOut, stdout }); });
    child.on("exit", (code) => { clearTimeout(timer); res({ code: code ?? 1, timedOut, stdout }); });
  });
}

// Detect a rate/subscription limit in an agent CLI's output and, if found,
// record a per-agent cooldown so the loop stops scheduling that agent until it
// resets. Returns true if a limit was recorded. `agent` is the cooldown key
// (claude|codex|gemini|antigravity) inferred from the builder command.
async function recordLimitIfAny(agent: string, output: string, card?: string) {
  // Matches the verified Claude CLI limit phrasings plus the generic signals
  // other agent CLIs emit (codex/gemini/antigravity). See cooldown.ts for the
  // reset-time formats parsed out of these same messages.
  // "hit your usage limit" (codex) does not say "reached", so match the noun
  // phrase itself rather than a specific verb — otherwise an exhausted provider
  // is never parked and the loop retries it instead of rotating to the next.
  if (!/usage limit|limit reached|rate[_ ]?limit|exceed your account|too many requests|quota|subscription|\b429\b/i.test(output || "")) return false;
  const windows = DEFAULT_WINDOWS as Record<string, number>;
  const until = parseResetTime(output) ?? (Date.now() + (windows[agent] ?? windows.claude!));
  setCooldown(agent, until, { reason: "limit detected in loop" });
  await log("error", { card, actor: agent, detail: `rate limit — cooldown until ${new Date(until).toISOString()}` });
  return true;
}

/**
 * Rotate away from a lane that keeps producing code the health gate rejects.
 *
 * The two cooldowns exist because the two failures are not the same failure. A
 * non-zero exit is an INFRASTRUCTURE signal — the box or the model server died —
 * and its sibling node is exactly the right place to go, which is what
 * coolDownLocalFailure below does. A red health gate after a clean exit is a
 * CONTENT signal, and a sibling running the same weights will reproduce it
 * verbatim if the two lanes share weights. So this cools the whole trust domain,
 * not one lane — see agent-policy.ts.
 *
 * It rotates only when there is somewhere to rotate TO. If every eligible
 * builder shares the failing domain, cooling them all would just stall the card
 * — iterating with the distilled feedback is then still the best move available,
 * and the iteration cap remains the bound.
 *
 * @returns true when the lane was rotated away from.
 */
async function rotateOnQualityFailure(agent: string, card: string, streak: number, state: LoopState) {
  const after = Math.max(2, Number(process.env.LOOP_QUALITY_ROTATE_AFTER) || 2);
  if (streak < after) return false;

  const domain = trustDomainFor(agent);
  const roster = [...new Set(builderRoster().map((cmd) => agentKeyFor(cmd)))]
    ;
  const peers = roster.filter((a) => trustDomainFor(a) === domain);
  const elsewhere = roster.filter((a) => trustDomainFor(a) !== domain && !inCooldown(a));
  if (!elsewhere.length) return false;

  const until = Date.now() + Math.max(1_000, Number(process.env.LOOP_QUALITY_ROTATE_COOLDOWN_MS) || 10 * 60_000);
  const reason = `${streak} consecutive failed health gates`;
  for (const peer of peers) setCooldown(peer, until, { reason: `quality rotation — ${reason}` });
  await log("guard", {
    card, actor: agent,
    detail: `quality rotation: ${reason} — cooling trust domain "${domain}" (${peers.join(", ")}) → ${elsewhere[0]}`,
  });
  return true;
}


// Which provider a command drives — the cooldown key, and what "the reviewer
// must differ from the builder" is decided on.
//
// Matched against the BASENAME of each token, never the whole command line: the
// line carries absolute paths, and a directory that merely contains a provider
// name used to decide the key. A builder at
// `/tmp/claude-501/…/stub-codex.mjs` read as "claude" purely because of its
// parent directory, so builder and reviewer looked like one provider and the
// card stalled on "no independent reviewer available". Only the executable and
// script names carry that signal.
const AGENT_PATTERNS: Array<[string, RegExp]> = [
  ["claude", /claude/],
  ["codex", /codex/],
  // \b for the short one: "legacy.mjs" must not read as agy.
  ["antigravity", /\bagy\b|antigravity/],
  ["gemini", /gemini/],
];

export function agentKeyFor(cmdline: unknown): string {
  for (const token of String(cmdline ?? "").split(/\s+/).filter(Boolean)) {
    const name = (token.split(/[\\/]/).pop() ?? "").toLowerCase().replace(/\.(mjs|cjs|js|ts|cmd|bat|exe|ps1|sh)$/, "");
    for (const [key, re] of AGENT_PATTERNS) if (re.test(name)) return key;
  }
  return "builder";
}

// The CLI binaries each roster agent drives (the invoke-* wrappers spawn these).
// A key with no installed binary is skipped by the scheduler so the loop doesn't
// burn an iteration spawning a wrapper that just ENOENTs. antigravity ships as
// either the new `agy` or the legacy `antigravity` command.
const AGENT_BINARIES = {
  claude: ["claude"],
  codex: ["codex"],
  gemini: ["gemini"],
  antigravity: ["agy", "antigravity"],
};
// Nominal role each backing CLI plays — used only to make the startup warning
// name what degrades ("gemini (explorer) not found").
const AGENT_ROLE = {
  claude: "lead/reviewer", codex: "builder", gemini: "explorer", antigravity: "AGY builder",
};

// Cross-platform PATH lookup with no dependency: is `base` resolvable as an
// executable on PATH? On Windows we try each PATHEXT extension (so `claude.exe`,
// `codex.cmd` resolve from the base name); on POSIX the bare name.
export function whichSync(base: string): boolean {
  const dirs = (process.env.PATH || "").split(delimiter).filter(Boolean);
  const exts = process.platform === "win32"
    ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").map((e) => e.trim()).filter(Boolean)
    : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      if (existsSync(resolve(dir, base + ext))) return true;
    }
  }
  return false;
}

// Which agent CLIs are actually installed. Cached: installation doesn't change
// mid-run, and PATH scanning shouldn't repeat on every build iteration.
let _installedAgents: Set<string> | null = null;
export function installedAgentSet(): Set<string> {
  if (_installedAgents) return _installedAgents;
  _installedAgents = new Set();
  for (const [key, bins] of Object.entries(AGENT_BINARIES)) {
    if (bins.some(whichSync)) _installedAgents.add(key);
  }
  return _installedAgents;
}

// True if this agent's CLI is present, OR the agent is a custom/unknown builder
// ("builder", from a LOOP_BUILDERS override) which we can't validate and so must
// not filter out.
function agentUsable(agent: string): boolean {
  return agent === "builder" || installedAgentSet().has(agent);
}

// The command lines an operator configured by hand: LOOP_BUILDER for the primary
// slot, LOOP_BUILDERS for the whole roster. The PATH filter must not second-guess
// these. agentKeyFor is a heuristic over the command NAME, so a wrapper called
// `my-codex-runner.sh` derives the key `codex` and gets dropped on a host with no
// `codex` on PATH — silently running a different agent than the operator asked
// for. agentUsable already exempts the unrecognized case ("builder"); the
// exemption belongs to "was this configured explicitly", not to "did the
// heuristic fail to name it".
export function explicitBuilderCommands(env = process.env) {
  const commands = new Set();
  if (env.LOOP_BUILDER) commands.add(env.LOOP_BUILDER.trim());
  for (const cmd of String(env.LOOP_BUILDERS || "").split(",")) {
    const trimmed = cmd.trim();
    if (trimmed) commands.add(trimmed);
  }
  return commands;
}

// Startup check: name the roster CLIs missing from PATH (and the roles they back)
// so a silent degrade-to-whatever becomes a loud, actionable warning. Advisory —
// the loop still runs on whatever IS installed.
async function warnMissingClis() {
  const rosterKeys = [...new Set(builderRoster().map(agentKeyFor))].filter((k) => k !== "builder");
  const installed = installedAgentSet();
  const missing = rosterKeys.filter((k) => !installed.has(k));
  if (missing.length) {
    const roles = AGENT_ROLE as Record<string, string>;
    const detail = missing.map((k) => `${k} (${roles[k] || "?"})`).join(", ");
    const remaining = [...installed].join(", ") || "NONE";
    console.warn(`[ralph-loop] backing CLI not on PATH: ${detail} — those agents are skipped; using: ${remaining}`);
    await log("iterate", { actor: "ralph", detail: `startup: missing CLIs ${detail}; installed: ${remaining}` }).catch(() => {});
  }
  if (!installed.size && !process.env.LOOP_BUILDERS) {
    console.warn("[ralph-loop] WARNING: no agent CLI found on PATH — builds will fail until one is installed (or set LOOP_BUILDERS).");
  }
}

// Builder roster in priority order. The loop drives the first one NOT in
// cooldown. Each entry is a full command line (same format as LOOP_BUILDER).
// Override the whole roster with LOOP_BUILDERS (comma-separated commands).
export function builderRoster(env = process.env) {
  if (env.LOOP_BUILDERS) {
    return env.LOOP_BUILDERS.split(",").map((c) => c.trim()).filter(Boolean);
  }
  const node = process.execPath;
  const session = resolve(HERE, "..", "agent-session.ts");
  //
  // spend cloud quota — but they lead the roster ONLY when the builder is the
  // default. An explicit LOOP_BUILDER is an operator's deliberate choice and
  // still goes first. Both nodes are listed for load distribution and failure
  return [
    env.LOOP_BUILDER || CFG.builder,                              // default: Codex session → model/provider handoff
    `${node} ${session} --agent agy --same-provider-only`,        // AGY model fallback
    `${node} ${resolve(HERE, "..", "invoke-gemini.ts")}`,        // gemini
    `${node} ${session} --agent claude --same-provider-only`,     // Claude last
  ];
}

// Pick the first roster command whose agent is available (installed + not in
// cooldown). Returns { cmd, agent } or null if every usable agent is cooling down.
// Uninstalled CLIs are filtered out FIRST so the loop doesn't waste an iteration
// on a wrapper that just ENOENTs — unless that would empty the roster (e.g. a
// detection miss, or nothing installed), in which case we fall back to the full
// roster and let the runtime ENOENT surface rather than bricking the loop.
// An explicitly configured command is exempt from that filter; see
// explicitBuilderCommands.
export function pickAvailableBuilder(card: LoopState | Card) {
  const roster = builderRoster();
  const explicit = explicitBuilderCommands();
  const eligible = roster;
  const usable = eligible.filter((cmd) => explicit.has(cmd) || agentUsable(agentKeyFor(cmd)));
  for (const cmd of (usable.length ? usable : eligible)) {
    const agent = agentKeyFor(cmd);
    if (!inCooldown(agent)) return { cmd, agent };
  }
  return null;
}

// The audit lane: test-correctness and security review are cross-verified by
// codex and antigravity, never by the lane that built it. Implementation sits on
// the local models, but judging whether a test actually proves anything — or
// whether a diff opens a hole — is where a stronger model earns its quota.
// Override with LOOP_AUDITORS (comma-separated agent keys).
export function auditAgents() {
  const override = String(process.env.LOOP_AUDITORS || "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return override.length ? override : ["codex", "antigravity"];
}

function commandForAgent(agent: string): string {
  const node = process.execPath;
  const session = resolve(HERE, "..", "agent-session.ts");
  if (agent === "antigravity") return `${node} ${session} --agent agy --same-provider-only`;
  if (agent === "gemini") return `${node} ${resolve(HERE, "..", "invoke-gemini.ts")}`;
  return `${node} ${session} --agent ${agent} --same-provider-only`;
}

// The auditors available to cross-verify a diff, excluding whoever built it (an
// author never audits their own work). Returns [{cmd, agent}], possibly empty.
export function pickAuditors(builderAgent: string) {
  return auditAgents()
    .filter((agent) => independentAgents(agent, builderAgent) && agentUsable(agent) && !inCooldown(agent))
    .map((agent) => ({ cmd: commandForAgent(agent), agent }));
}

// Does this change need the security/test audit lane? Anything the risk scorer
// flags as critical (auth, secrets, migrations, billing, the data contract), and
// anything that touches tests — a test that doesn't test is worse than none.
export function needsAudit(risk: Risk | null | undefined, files: string[] = [], spec = ""): boolean {
  if (risk && risk.level === "high") return true;
  const text = `${files.join(" ")} ${spec}`;
  return /(test|spec)[s._-]|__tests__|\.test\.|\.spec\.|(테스트|보안|취약점|검증)/i.test(text);
}

// Framein challenge: pick the first available roster agent whose provider DIFFERS
// from the builder's, so the challenge is genuinely cross-model. Prefers a
// dedicated auditor (codex/agy) so a local node is never the only second opinion
// on a security- or test-shaped diff. Returns { cmd, agent } or null.
function pickChallenger(builderAgent: string) {
  const [auditor] = pickAuditors(builderAgent);
  if (auditor) return auditor;
  for (const cmd of builderRoster()) {
    const agent = agentKeyFor(cmd);
    // A challenger must be a DIFFERENT, installed, non-cooling agent. If none
    // qualifies the challenge is simply skipped (best-effort) — see nodeChallenge.
    if (independentAgents(agent, builderAgent) && agentUsable(agent) && !inCooldown(agent)) return { cmd, agent };
  }
  return null;
}

/**
 * Everyone who authored this diff.
 *
 * With the architect/editor split the builder is no longer the only author: the
 * planner chose the files and the approach, the builder typed it. A reviewer
 * that shares a provider with EITHER is reviewing its own work, so independence
 * is checked against the whole author set, not just the last agent to run.
 */
export function authorsOf(state: { lastAgent?: string | null; planner?: string | null }): string[] {
  return [state.lastAgent, state.planner].filter((a): a is string => Boolean(a));
}

function independentOfAll(agent: string, authors: string[]): boolean {
  return authors.every((author) => independentAgents(agent, author));
}

// Pick the reviewer: it must be AVAILABLE and a DIFFERENT provider than every
// author, so no agent ever signs off its own work (rules.md: "a builder does
// not self-approve its own deploy"). Prefer the configured LOOP_REVIEWER when it
// is both distinct and not cooling down; otherwise fall back to any distinct,
// available challenger. Returns { cmd, agent } or null when the only reviewer
// available would be one of the authors.
export function pickReviewer(builderAgent: string, planner: string | null = null) {
  const authors = [builderAgent, planner].filter((a): a is string => Boolean(a));
  const primary = process.env.LOOP_REVIEWER || `${process.execPath} ${resolve(HERE, "..", "invoke-claude.ts")}`;
  const primaryAgent = agentKeyFor(primary);
  if (independentOfAll(primaryAgent, authors) && !inCooldown(primaryAgent)) return { cmd: primary, agent: primaryAgent };
  for (const cmd of builderRoster()) {
    const agent = agentKeyFor(cmd);
    if (independentOfAll(agent, authors) && agentUsable(agent) && !inCooldown(agent)) return { cmd, agent };
  }
  for (const agent of auditAgents()) {
    if (independentOfAll(agent, authors) && agentUsable(agent) && !inCooldown(agent)) {
      return { cmd: commandForAgent(agent), agent };
    }
  }
  return null;
}

/**
 * Pick a planner for the architect/editor split, or null to build directly.
 *
 * Aider measured this: a strong model reasoning about the change and a cheap one
 * applying it beats the cheap one doing both, at a fraction of the strong one
 * doing both. It is worth nothing when the builder is ALREADY the strong lane —
 * the same model would plan and type, paying twice for one opinion — so a
 * planner is only chosen when it is independent of the builder.
 *
 * The hard constraint is the review gate: planning adds an author, and an author
 * cannot review. A planner that would leave no independent reviewer is not
 * chosen at all, so the split can never starve the gate that makes the loop
 * trustworthy.
 *
 * LOOP_PLAN: auto (default) | on | off.
 *
 * "auto" plans when the PLANNER is the bulk lane — the architect pass then costs
 * no rationed quota, and Aider's result stands: the split scored higher than
 * either model alone because frontier models reason well and mangle diffs while
 * cheaper ones are precise about diffs and weaker at planning.
 *
 * When the planner would be a metered lane, "auto" declines. An earlier default
 * planned regardless and turned a 2-second end-to-end test into 88 seconds of
 * real quota; "on" is how an operator asks for that deliberately.
 */
export function pickPlanner(builderAgent: string, env: NodeJS.ProcessEnv = process.env) {
  const mode = String(env.LOOP_PLAN || "auto").toLowerCase();
  if (mode === "off") return null;
  // "antigravity", not "agy": that is the canonical roster key (agentKeyFor maps
  // both spellings to it), and a name the roster does not know is silently never
  // usable — which is exactly how "agy" here quietly never got picked.
  const preferred = String(env.LOOP_PLANNERS || `${bulkLane(env)},claude,codex`)
    .split(",").map((a) => a.trim().toLowerCase()).filter(Boolean);

  // An explicit command, like LOOP_BUILDER/LOOP_REVIEWER. Without one the split
  // could not be exercised without invoking a real CLI.
  if (env.LOOP_PLANNER) {
    const agent = agentKeyFor(env.LOOP_PLANNER);
    if (!independentAgents(agent, builderAgent) || !pickReviewer(builderAgent, agent)) return null;
    return { cmd: env.LOOP_PLANNER, agent };
  }

  for (const agent of preferred) {
    if (!independentAgents(agent, builderAgent)) continue;   // same lane: no second opinion
    if (!agentUsable(agent) || inCooldown(agent)) continue;
    // "auto" pays no rationed quota for reasoning; "on" accepts the bill.
    if (mode !== "on" && !isBulkLane(agent, env)) continue;
    // Would a reviewer still exist with this planner added to the authors?
    if (!pickReviewer(builderAgent, agent)) continue;
    return { cmd: commandForAgent(agent), agent };
  }
  return null;
}

// Soonest reset across all cooling-down agents, in ms from now (Infinity if none).
function soonestReset() {
  const active = activeCooldowns();
  let min = Infinity;
  for (const agent of Object.keys(active)) min = Math.min(min, remaining(agent));
  return min;
}

// WIP-save the working tree before yielding a limited task, so the next agent
// (or the same one after reset) resumes from real progress instead of scratch.
async function wipSave(card: string, cwd = ROOT) {
  await run("git", ["add", "-A"], { timeout: 60_000, sandbox: false, cwd });
  // commit is a no-op (non-zero) when there's nothing staged — that's fine.
  await run("git", ["commit", "-m", `wip:${card}`], { timeout: 60_000, sandbox: false, cwd });
  await log("commit", { card, actor: "ralph", detail: "WIP saved before cooldown yield" });
}

async function changedFilesIn(cwd: string, baseline?: string | null): Promise<{ ok: boolean; files: string[] }> {
  const files = new Set<string>();
  if (baseline) {
    const committed = await run("git", ["diff", "--name-only", baseline, "HEAD"], {
      capture: true, sandbox: false, cwd,
    });
    if (committed.code !== 0) return { ok: false, files: [] };
    for (const file of committed.stdout.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)) files.add(file);
  }

  const dirty = await run("git", ["status", "--porcelain", "-uall"], {
    capture: true, sandbox: false, cwd,
  });
  if (dirty.code !== 0) return { ok: false, files: [] };
  for (const line of dirty.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const path = line.slice(3).trim();
    if (path) files.add(path.includes(" -> ") ? (path.split(" -> ")[1] ?? path) : path);
  }
  return { ok: true, files: [...files].filter((file) => !file.startsWith(".harness/")) };
}

// A builder/reviewer command comes from env as a string (e.g. "node x.ts") and
// may legitimately need word-splitting. This is the ONLY place we split — and
// only the configured prefix, never an interpolated path argument.
function splitCmd(cmdline: string): { bin: string; args: string[] } {
  const parts = cmdline.split(" ").filter(Boolean);
  return { bin: parts[0] ?? "", args: parts.slice(1) };
}

// health.sh on POSIX, health.ps1 on Windows. Returns { ok, logs }.
async function health(cwd = ROOT) {
  // Run the health script that BELONGS to the tree under test. health.sh cd's to
  // its own ../.. , so the main checkout's copy would gate the main checkout no
  // matter which cwd it was handed — silently green-lighting a card whose work
  // is in a worktree. Under Docker it would break outright: the script path sits
  // outside the mounted root and never appears in the container.
  const script = (name: string) => resolve(cwd, "scripts", "loop", name);
  const res = process.platform === "win32"
    ? await run("powershell", ["-ExecutionPolicy", "Bypass", "-File", script("health.ps1")], { tee: true, cwd })
    : await run("bash", [script("health.sh")], { tee: true, cwd });
  return { ok: res.code === 0, logs: res.stdout };
}

async function strictHealthCheck(cwd = ROOT) {
  const prior = process.env.HEALTH_STRICT;
  process.env.HEALTH_STRICT = "1";
  try { return await health(cwd); }
  finally {
    if (prior === undefined) delete process.env.HEALTH_STRICT;
    else process.env.HEALTH_STRICT = prior;
  }
}

async function workingTreeDigest(cwd = ROOT) {
  const diff = await run("git", ["diff", "--binary", "HEAD"], { capture: true, sandbox: false, timeout: 60_000, cwd });
  const others = await run("git", ["ls-files", "--others", "--exclude-standard"], { capture: true, sandbox: false, timeout: 60_000, cwd });
  if (diff.code !== 0 || others.code !== 0) throw new Error("could not fingerprint working tree");
  const hash = createHash("sha256").update(diff.stdout);
  for (const rel of others.stdout.split(/\r?\n/).filter(Boolean).sort()) {
    const full = resolve(cwd, rel);
    if (!full.startsWith(cwd)) throw new Error(`unsafe untracked path: ${rel}`);
    hash.update(`\0${rel}\0`);
    try { hash.update(readFileSync(full)); } catch { hash.update("[unreadable]"); }
  }
  return hash.digest("hex");
}

function pendingReject(card: string): Record<string, unknown> | null {
  const p = resolve(REJECT_DIR, `${card}.json`);
  if (!existsSync(p)) return null;
  try {
    const data = JSON.parse(readFileSync(p, "utf8"));
    rmSync(p, { force: true }); // consume it
    return data;
  } catch {
    rmSync(p, { force: true });
    return { card };
  }
}

function releaseLock(card: string): void {
  rmSync(resolve(LOCK_DIR, `${card}.lock`), { force: true });
}

// --- The per-card pipeline as a declarative state graph ------------------------

/** The reviewer's structured verdict, as REVIEW_SCHEMA validates it. */
export interface ReviewVerdict {
  decision: string;
  rationale?: string;
  acceptance_results?: unknown;
  blocking_issues?: string[];
  persona_verdict?: { decision?: string; confidence?: number; blast_radius?: string; rationale?: string };
}

export const REVIEW_SCHEMA = {
  type: "object",
  required: ["decision", "rationale", "acceptance_results", "blocking_issues", "persona_verdict"],
  properties: {
    decision: { enum: ["approve", "revise"] },
    rationale: { type: "string", minLength: 1 },
    acceptance_results: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["id", "status", "evidence"],
        properties: {
          id: { type: "string", pattern: "^AC-[0-9]+$" },
          status: { enum: ["pass", "fail", "unverified"] },
          evidence: { type: "string" },
        },
        additionalProperties: false,
      },
    },
    blocking_issues: { type: "array", items: { type: "string" } },
    persona_verdict: {
      type: "object",
      required: ["decision", "confidence", "blast_radius", "rationale"],
      properties: {
        decision: { enum: ["approve", "escalate", "reject"] },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        blast_radius: { enum: ["low", "medium", "high"] },
        rationale: { type: "string", minLength: 1 },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};
//
// The card lifecycle is expressed as NODES + conditional EDGES over a
// JSON-serializable state, executed by the checkpointing runtime in graph.ts
// (LangGraph-style, dependency-free). Same behavior as the old hardcoded
// pipeline, plus: crash-resume at the exact node, `graph.ts history/rewind
// <card>` time-travel, and a hard step cap so build ⇄ health can never cycle
// forever.
//
//     prime ──▶ build ──▶ strictHealth ──▶ challenge ──▶ review ──▶ ship ──▶ END
//                │ ▲                                        │
//                └─┘ (health red / retry, up to maxIters)   └──▶ END (failed/cooldown)
//
// State (checkpointed after every node): { card, spec, taskText, builderInput,
//   feedback, iter, lastAgent, green, challengeBrief, outcome, shipped }
// Ctx (never persisted): { backlog, stopping }

// prime — freeze the framein contract, fold in a human rejection, a handoff
// capsule, and (opt-in) prior hub knowledge, producing the builder's base input.
async function nodePrime(state: LoopState) {
  const { card, spec } = state;

  // The plan gate comes FIRST — before the worktree, before recall, before a
  // single token is spent. A risky card with no approved plan document is not a
  // build that needs better feedback; it is a build that must not start.
  const planCfg = planConfig(ROOT);
  const planDoc = planForCard(card, ROOT, planCfg);
  const gate = planGateDecision({ card, spec: spec ?? "", plan: planDoc, cfg: planCfg });
  if (gate.refusal) await log("guard", { card, actor: "autonomy", detail: gate.refusal });
  if (!gate.allow) {
    await log("guard", { card, actor: "plan-gate", detail: gate.reason });
    // 'failed' rather than a retry: retrying changes nothing until a human (or
    // the lead) writes the plan, and the reason travels back as card feedback.
    return { outcome: "failed", feedback: `Plan gate blocked this card: ${gate.reason}` };
  }
  await log("iterate", { card, actor: "plan-gate", detail: gate.reason });

  // Per-card isolation (LOOP_WORKTREE=1): give this card its own branch +
  // checkout so a second claim — or a human editing the repo while the loop
  // runs — cannot absorb its uncommitted edits. Every later node works in
  // `workdir`; with the flag off it stays ROOT and nothing changes.
  //
  // An ensure failure FAILS the card on purpose. Falling back to the shared
  // tree would silently reintroduce the collision this exists to prevent.
  let workdir = ROOT;
  if (worktreeEnabled()) {
    const wt = ensureWorktree(card);
    if (!wt.ok) {
      await log("error", { card, actor: "ralph", detail: `worktree: ${wt.reason}` });
      return { outcome: "failed", feedback: `Per-card worktree could not be prepared: ${wt.reason}` };
    }
    workdir = wt.path;
    if (wt.reason) await log("iterate", { card, actor: "ralph", detail: `worktree: ${wt.reason}` });
    await log("iterate", { card, actor: "ralph", detail: `worktree: ${wt.created ? "created" : "reused"} ${wt.branch} at ${wt.path}` });
    // A base-sync conflict is left in the tree deliberately: the builder has
    // full git access there and resolves it inside its iterate→health loop,
    // which is the same conflict integrate would hit later anyway.
    if (wt.conflictFiles?.length) {
      await log("iterate", { card, actor: "ralph", detail: `worktree: base sync left ${wt.conflictFiles.length} conflicted file(s)` });
    }
  }

  // Framein: freeze the work contract (baseline sha + intent) so every model that
  // touches this card measures its diff from the same point and can't silently
  // renegotiate the task. Idempotent — a requeued card keeps its original baseline.
  try { startContract({ card, spec }); } catch (e) { console.error("framein: startContract failed (continuing):", (e as Error)?.message ?? e); }

  // A human rejection re-injects the prior context as a prefix to the spec. This
  // `taskText` is the immutable base — capsules are prepended onto a copy of it so
  // repeated handoffs never stack capsule-on-capsule into an ever-growing prompt.
  const reject = pendingReject(card);
  const requested = reject
    ? `[REVISION REQUESTED] previous attempt rejected at ${reject.at || "?"}. Fix and retry.\n\nTask: ${spec}`
    : spec;

  // The evidence lives where the BUILDER works — inside the per-card worktree when
  // one exists. Opening (and later verifying) it in ROOT instead would look for the
  // dossier in a tree the builder never touched, so every card would be held for a
  // missing file it did write. The path handed to the agent is relative for the
  // same reason: it has to resolve from whatever cwd the CLI runs in.
  let evidenceDir: string | undefined;
  if (evidenceRequired({ spec: spec ?? "", source: String(state.source ?? ""), cfg: planCfg })) {
    try {
      const opened = openEvidence(card, { intent: planDoc?.intent ?? "", cwd: workdir, cfg: planCfg });
      evidenceDir = relative(workdir, opened.dir).split(/[\\/]/).join("/");
      await log("iterate", { card, actor: "ralph", detail: `evidence: ${opened.created ? "opened" : "reusing"} ${opened.dir}` });
    } catch (e) {
      console.error("evidence: could not open the evidence directory (continuing):", (e as Error)?.message ?? e);
    }
  }
  // 계획서 우선. When an approved plan declares this card, the builder's job is one
  // STEP of a design a human already signed off — intent, non-goals, declared files,
  // acceptance — not a spec it is free to reinterpret. The brief sits directly above
  // the task text (closest position = most salient) and is part of taskText, so a
  // capsule handoff to another model carries it too.
  const context = [
    planDoc ? stepBrief(planDoc, card) : "",
    evidenceDir
      ? `[EVIDENCE REQUIRED] This card does not ship without verification on disk. Fill every section of `
        + `${evidenceDir}/README.md and write the real captured command output beside it `
        + `(node scripts/loop/evidence.ts record ${card} <name> < output). "It should work" is not evidence.`
      : "",
  ].filter(Boolean).join("\n\n");
  const taskText = context ? `${context}\n\nTask: ${requested}` : requested;
  let builderInput = taskText;

  // Framein: if a prior round handed this card off (cooldown yield or a model
  // swap), a capsule is on disk. Prepend it so the resuming agent picks up with
  // the full contract + diff surface instead of a bare spec. Best-effort.
  try {
    const cap = loadCapsule(card);
    if (cap) {
      builderInput = `${capsuleMarkdown(cap)}\n\n${taskText}`;
      await log("iterate", { card, actor: "ralph", detail: `framein: resumed from capsule (${cap.from} → ${cap.to}, ${riskLine(cap.risk)})` });
    }
  } catch (e) {
    console.error("framein: capsule resume failed (continuing):", (e as Error)?.message ?? e);
  }

  // Reuse instead of relearn: pull prior cross-project knowledge for this card
  // and prepend it so the builder reuses known solutions and sidesteps known
  // traps. ON by default now that recall returns distilled lessons (prompt
  // trails are filtered out — see knowledge.ts). Opt out with HUB_RECALL=0.
  // Best-effort — never blocks or fails the build.
  if (process.env.HUB_RECALL !== "0") {
    try {
      const ctx = await gatherValidationContext(spec);
      if (ctx.hits.length) {
        // Titles alone (`lesson: <card> — worked`) carry no signal; append a
        // one-line body snippet so the builder sees the actual lesson.
        const lines = ctx.hits.slice(0, 8).map((e) => {
          const snippet = String(e.body || "").replace(/\s+/g, " ").trim().slice(0, 160);
          return `- [${e.project || e.source || "?"}] ${e.title}${snippet ? ` — ${snippet}` : ""}`;
        }).join("\n");
        builderInput = `[PRIOR KNOWLEDGE — reuse, don't relearn; from the central hub across projects]\n${lines}\n\nTask: ${builderInput}`;
        await log("iterate", { card, actor: "ralph", detail: `recalled ${ctx.hits.length} prior entr(ies) via ${ctx.source}` });
      }
    } catch (err) {
      console.error("ralph-loop: recall failed (continuing):", (err as Error)?.message ?? err);
    }
  }

  return {
    taskText, builderInput, workdir, iter: 0, feedback: "", lastAgent: null, green: false,
    planDoc: planDoc?.slug ?? null, evidenceDir,
  };
}

// build — ONE builder iteration: pick an available agent, capsule a mid-task model
// swap, run the CLI, then verify with the health gate. The build ⇄ build self-edge
// (below) replays this node until green, cooldown, or the iteration cap.
async function nodeBuild(state: LoopState) {
  const { card, workdir = ROOT } = state;

  // Spend check BEFORE the lane is picked: a run that would cross the ceiling
  // must never start. This is the only brake that bounds how MUCH the loop
  // consumes — cooldown bounds only how often — so it is checked every
  // iteration, not once per card.
  const budget = await budgetStatus({ card });
  if (!budget.ok) {
    await wipSave(card, workdir);
    const detail = `budget ceiling reached — ${budget.exceeded.join("; ")}`;
    await log("guard", { card, actor: "ralph", detail });
    return { outcome: "budget", feedback: detail };
  }

  // Pick a builder that isn't cooling down. If all are limited, save progress
  // and yield — main() will sleep until the soonest reset, then retry.
  const choice = pickAvailableBuilder(state);
  if (!choice) {
    await wipSave(card, workdir);
    // Framein: capsule the WIP so whichever agent resumes after a reset (maybe a
    // different model) inherits the contract + diff instead of a bare spec.
    try { writeCapsule({ card, from: state.lastAgent || "?", to: "next", health: state.feedback ? "fail (see feedback)" : null }); } catch {}
    await log("iterate", { card, actor: "ralph", detail: "all agents in cooldown — yielding task (capsuled)" });
    return { outcome: "cooldown" };
  }
  const builder = splitCmd(choice.cmd);

  // Framein: a mid-task model swap (the cooldown roster moved to a different
  // CLI) is a handoff — capsule the state so the new lead inherits the frozen
  // contract + diff surface + ledger instead of resuming from a bare spec.
  let builderInput = state.builderInput;
  if (state.lastAgent && state.lastAgent !== choice.agent) {
    try {
      const cap = writeCapsule({ card, from: state.lastAgent, to: choice.agent, health: state.feedback ? "fail (see feedback)" : null });
      builderInput = `${capsuleMarkdown(cap)}\n\n${state.taskText}`;
      await log("iterate", { card, actor: "ralph", detail: `framein: handoff ${state.lastAgent} → ${choice.agent} (${riskLine(cap.risk)})` });
    } catch (e) {
      console.error("framein: handoff capsule failed (continuing):", (e as Error)?.message ?? e);
    }
  }
  // --- architect/editor split ------------------------------------------------
  // Plan once per card, not per iteration: the plan is the reasoning, and a red
  // health gate means the EDIT was wrong, not necessarily the approach. The
  // quality rotation clears it when a lane has failed repeatedly, so the next
  // lane re-plans rather than re-typing a plan that is not working.
  let plan = state.plan ?? "";
  let planner = state.planner ?? null;
  if (!plan) {
    const pick = pickPlanner(choice.agent);
    if (pick) {
      const planPrompt = [
        "You are the ARCHITECT. Do NOT edit files and do NOT output diffs.",
        "Produce a concrete change plan another agent will execute verbatim:",
        "  1. the files to touch, by path,",
        "  2. what changes in each, by function/section,",
        "  3. the order, and what proves each step worked.",
        "Be specific enough that a weaker model cannot misread it; say what NOT to touch.",
        "",
        `Task: ${state.taskText ?? state.spec ?? card}`,
      ].join("\n");
      const planner_ = splitCmd(pick.cmd);
      const startedPlan = Date.now();
      const out = await withSpan("plan", { traceId: card, kind: "llm" }, () =>
        run(planner_.bin, [...planner_.args, planPrompt], { tee: false, cwd: workdir }));
      await recordUsage({ card, agent: pick.agent, ms: Date.now() - startedPlan, ...(parseUsage(out.stdout) ?? {}) });
      if (out.code === 0 && String(out.stdout || "").trim()) {
        plan = String(out.stdout).trim().slice(-6000);
        planner = pick.agent;
        await log("iterate", { card, actor: pick.agent, detail: `plan authored for ${choice.agent} (architect/editor split)` });
      } else {
        // A failed plan is not a failed card: build directly rather than block.
        await log("error", { card, actor: pick.agent, detail: `planning failed (exit ${out.code}) — building without a plan` });
      }
    }
  }

  const i = (state.iter ?? 0) + 1;
  try { appendLedger(card, { agent: choice.agent, event: `iterate.${i}` }); } catch {}

  await log("iterate", { card, actor: choice.agent, detail: `iteration ${i}/${CFG.maxIters}` });

  const planBlock = plan
    ? `\n\n[PLAN] Follow this change plan authored by ${planner}. Execute it; do not redesign it.\n${plan}`
    : "";
  const currentInput = state.feedback
    ? `${builderInput}${planBlock}\n\n[FEEDBACK] The previous implementation attempt FAILED. Fix the following compilation/linter/test errors:\n${state.feedback}`
    : `${builderInput}${planBlock}`;
  const base = { builderInput: builderInput ?? "", lastAgent: choice.agent, plan, planner };

  const startedAt = Date.now();
  const { code, timedOut, stdout } = await run(builder.bin, [...builder.args, currentInput ?? ""], { tee: true, cwd: workdir });
  // Bill the invocation whatever its outcome — a crashed or timed-out run cost
  // real quota, and a ledger that only counts successes understates the spend
  // exactly when the loop is burning the most.
  await recordUsage({ card, agent: choice.agent, ms: Date.now() - startedAt, ...(parseUsage(stdout) ?? {}) });
  if (timedOut) {
    await log("error", { card, actor: choice.agent, detail: `iteration ${i} timed out after ${CFG.cmdTimeout}ms` });
    return { ...base, iter: i }; // a single timeout doesn't end the session — try again up to the cap
  }
  if (code !== 0) {
    // A non-zero exit might be a rate limit. If so, save WIP and let the next
    // pass pick a different (available) agent; otherwise just retry.
    const limited = await recordLimitIfAny(choice.agent, stdout, card);
    if (limited) { await wipSave(card, workdir); return { ...base, iter: state.iter }; } // don't burn an iteration on a limit
    // A local endpoint/model failure is not evidence that the card is
    // impossible; the cooldown makes the next iteration use another lane.
    const { text: exitFeedback, known } = buildFeedback(stdout);
    await log("error", {
      card, actor: choice.agent,
      detail: `iteration ${i} exited ${code}${known ? ` — ${known.id}` : ""}`,
    });
    return { ...base, iter: i, feedback: exitFeedback || `Builder exited with code ${code}` };
  }

  const contract = loadContract(card);
  const diff = await changedFilesIn(workdir, contract?.baseline);
  if (!diff.ok) {
    await log("guard", { card, actor: choice.agent, detail: "could not verify builder path budget" });
    return { ...base, iter: i, feedback: "Safety guard failed closed: unable to enumerate changed files." };
  }

  // Builder claims success — verify with the health gate before believing it.
  const check = await health(workdir);
  if (check.ok) {
    await log("health", { card, actor: "ralph", detail: `passed on iteration ${i}` });
    return { ...base, iter: i, green: true, redStreak: { agent: choice.agent, count: 0 } };
  }
  // Distill before the log becomes the next iteration's prompt: raw, this is the
  // whole run (installs, passing checks, progress) and the builder re-reads it
  // every iteration up to the cap. An environment failure code can name gets
  // that name attached, so the builder doesn't spend a round-trip deducing it.
  const { text: healthFeedback, known } = buildFeedback(check.logs);
  await log("health", {
    card, actor: "ralph",
    detail: `failed on iteration ${i}${known ? ` — ${known.id}` : ""}`,
  });
  // A lane that keeps handing back red code is a content failure, not a flaky
  // one. Count the streak per lane and rotate off it before the iteration cap is
  // spent proving the same weights wrong a third time.
  const streak = state.redStreak?.agent === choice.agent ? (state.redStreak.count ?? 0) + 1 : 1;
  const rotated = await rotateOnQualityFailure(choice.agent, card, streak, state);
  return {
    ...base,
    iter: i,
    feedback: healthFeedback,
    redStreak: { agent: choice.agent, count: rotated ? 0 : streak },
    // Rotating lanes means the previous approach kept producing red code. Drop
    // the plan with it so the new lane reasons afresh instead of re-typing one
    // that has already failed twice.
    ...(rotated ? { plan: "", planner: null } : {}),
  };
}

// giveUp — the iteration cap was exhausted without a green health gate.
async function nodeGiveUp(state: LoopState) {
  await log("error", { card: state.card, actor: "ralph", detail: `gave up after ${CFG.maxIters} iterations` });
  return { outcome: "failed" };
}

// strictHealth — iterations may run fast checks (skipping slow builds/tests), but
// before review we must enforce a complete validation.
async function nodeStrictHealth(state: LoopState) {
  const { card, workdir = ROOT } = state;
  const versionSync = await run("node", [resolve(workdir, "scripts", "loop", "version-sync.ts"), "bump"], {
    tee: true,
    cwd: workdir,
  });
  if (versionSync.code !== 0) {
    await log("error", { card, actor: "ralph", detail: "harness version sync failed before review" });
    return { outcome: "failed" };
  }
  await log("health", { card, actor: "ralph", detail: "running strict full health check before review" });
  const strictCheck = await strictHealthCheck(workdir);

  if (!strictCheck.ok) {
    await log("error", { card, actor: "ralph", detail: "strict full health check failed before review" });
    return { outcome: "failed" };
  }
  return {};
}

function getHarnessMode(cwd = ROOT): string {
  if (process.env.HARNESS_MODE) return process.env.HARNESS_MODE;
  try {
    const stampPath = resolve(cwd, ".harness-version.json");
    if (existsSync(stampPath)) {
      return JSON.parse(readFileSync(stampPath, "utf8")).mode || "autonomous";
    }
  } catch {}
  try {
    const stampPath = resolve(ROOT, ".harness-version.json");
    if (existsSync(stampPath)) {
      return JSON.parse(readFileSync(stampPath, "utf8")).mode || "autonomous";
    }
  } catch {}
  return "autonomous";
}

// runVerify — 'verify' mode gate: boots the dev server or runs custom execution, then double-checks everything.
async function nodeRunVerify(state: LoopState) {
  const { card, workdir = ROOT } = state;
  const mode = getHarnessMode(workdir);
  if (mode !== "verify") {
    return { runVerifyReject: false };
  }

  await log("health", { card, actor: "ralph", detail: "starting execution and recheck phase (verify mode)" });

  // 1. Execution phase
  const scriptPath = resolve(workdir, "scripts", "loop", process.platform === "win32" ? "verify-run.ps1" : "verify-run.sh");
  let runOk = false;
  let runLogs = "";

  if (existsSync(scriptPath)) {
    await log("health", { card, actor: "ralph", detail: `running custom execution script: ${scriptPath}` });
    const res = process.platform === "win32"
      ? await run("powershell", ["-ExecutionPolicy", "Bypass", "-File", scriptPath], { tee: true, cwd: workdir })
      : await run("bash", [scriptPath], { tee: true, cwd: workdir });
    runOk = res.code === 0;
    runLogs = res.stdout;
  } else {
    let verifyCmd = "";
    try {
      const pkg = JSON.parse(readFileSync(resolve(workdir, "package.json"), "utf8"));
      if (pkg.scripts?.["verify-run"]) {
        verifyCmd = "verify-run";
      } else if (pkg.scripts?.["verify"]) {
        verifyCmd = "verify";
      }
    } catch {}

    if (verifyCmd) {
      const pm = existsSync(resolve(workdir, "pnpm-lock.yaml")) ? "pnpm" : (existsSync(resolve(workdir, "yarn.lock")) ? "yarn" : (existsSync(resolve(workdir, "bun.lockb")) ? "bun" : "npm"));
      await log("health", { card, actor: "ralph", detail: `running execution command: ${pm} run ${verifyCmd}` });
      const res = await run(pm, ["run", verifyCmd], { tee: true, cwd: workdir });
      runOk = res.code === 0;
      runLogs = res.stdout;
    } else {
      let hasStartOrDev = false;
      let startScript = "start";
      try {
        const pkg = JSON.parse(readFileSync(resolve(workdir, "package.json"), "utf8"));
        if (pkg.scripts?.["dev"] || pkg.scripts?.["start"]) {
          hasStartOrDev = true;
          if (pkg.scripts?.["dev"]) startScript = "dev";
        }
      } catch {}

      if (hasStartOrDev) {
        const pm = existsSync(resolve(workdir, "pnpm-lock.yaml")) ? "pnpm" : (existsSync(resolve(workdir, "yarn.lock")) ? "yarn" : (existsSync(resolve(workdir, "bun.lockb")) ? "bun" : "npm"));
        const port = process.env.SCREENSHOT_URL || "http://localhost:3000";
        await log("health", { card, actor: "ralph", detail: `spawning dev server via: ${pm} run ${startScript}` });
        
        const server = spawn(pm, ["run", startScript], { cwd: workdir, shell: process.platform === "win32" });
        
        const checkUp = async (url: string, maxWaitMs = 15000): Promise<boolean> => {
          const start = Date.now();
          while (Date.now() - start < maxWaitMs) {
            try {
              const res = await fetch(url, { method: "GET" });
              if (res.ok || res.status < 500) return true;
            } catch {}
            await new Promise(r => setTimeout(r, 1000));
          }
          return false;
        };

        const up = await checkUp(port);
        runOk = up;
        
        server.kill("SIGTERM");
        if (process.platform === "win32") {
          try { spawnSync("taskkill", ["/pid", String(server.pid), "/f", "/t"]); } catch {}
        }
        
        if (up) {
          await log("health", { card, actor: "ralph", detail: `dev server booted successfully at ${port}` });
          runLogs = "dev server booted successfully";
        } else {
          await log("error", { card, actor: "ralph", detail: `dev server failed to boot at ${port}` });
          runLogs = "dev server timed out or failed to boot";
        }
      } else {
        await log("health", { card, actor: "ralph", detail: "no dev/start scripts found in package.json; skipping background execution check" });
        runOk = true;
        runLogs = "No dev/start script to execute.";
      }
    }
  }

  if (!runOk) {
    await log("error", { card, actor: "ralph", detail: "execution phase failed" });
    return { runVerifyReject: true, feedback: `[EXECUTION FAILURE]\n${runLogs.slice(-2000)}` };
  }

  // 2. Recheck/Doublecheck phase
  const choice = pickReviewer(state.lastAgent ?? "", state.planner ?? null);
  const checkerAgent = choice ? choice.agent : (state.lastAgent || "claude");
  const checkerCmd = choice ? splitCmd(choice.cmd) : splitCmd(process.env.LOOP_BUILDER || `node ${resolve(HERE, "..", "agent-session.ts")} --agent claude`);

  await log("health", { card, actor: checkerAgent, detail: "running doublecheck (recheck) of execution logs and changes" });

  const doublecheckPrompt = [
    `Doublecheck/recheck the working-tree changes and the execution logs for task "${card}".`,
    `frozen intent / contract: ${state.spec}`,
    `Execution logs:\n${runLogs.slice(-3000)}`,
    "As an independent quality checker, verify that the solution is actually fully correct, handles all edge cases, and there are no logical bugs or UI flaws from running/executing it.",
    "Return ONLY one JSON object with this exact shape:",
    '{"verdict":"PASS|REVISE","rationale":"short description of the audit","blocking_issues":["specific issue in the execution or code"]}',
  ].join("\n\n");

  const { code: rc, stdout: rout } = await run(checkerCmd.bin, [
    ...checkerCmd.args,
    doublecheckPrompt,
  ], { tee: true, workspaceReadOnly: true, cwd: workdir });

  if (rc !== 0) {
    await log("error", { card, actor: checkerAgent, detail: `doublecheck agent exited with code ${rc}` });
    return { runVerifyReject: true, feedback: `[DOUBLECHECK AGENT EXITED ${rc}]` };
  }

  const parsed = parseStructured<{ verdict: string; rationale: string; blocking_issues?: string[] }>(rout, {
    type: "object",
    required: ["verdict", "rationale"],
    properties: {
      verdict: { enum: ["PASS", "REVISE"] },
      rationale: { type: "string", minLength: 1 },
      blocking_issues: { type: "array", items: { type: "string" } },
    },
  });

  if (!parsed.ok) {
    await log("error", { card, actor: checkerAgent, detail: "doublecheck agent returned invalid output schema" });
    return { runVerifyReject: true, feedback: "[DOUBLECHECK SCHEMA INVALID] Check logs and retry." };
  }

  // `ok` does not narrow `value` (Parsed is not a discriminated union), so read it
  // the way every other call site here does — optionally, and treat an absent
  // verdict as "not PASS" rather than trusting a null through the gate.
  if (parsed.value?.verdict !== "PASS") {
    const issues = parsed.value?.blocking_issues?.join("\n") || parsed.value?.rationale;
    await log("iterate", { card, actor: checkerAgent, detail: "doublecheck requested revision on execution results" });
    return { runVerifyReject: true, feedback: `[DOUBLECHECK REVISION REQUESTED]\n${issues}` };
  }

  await log("health", { card, actor: "ralph", detail: "execution and doublecheck phase passed successfully" });
  return { runVerifyReject: false };
}

// verdict parsing — the challenger's brief opens with "verdict PASS/CONCERN/BLOCK".
// We read the FIRST non-empty line only, so a "one concrete fix: don't block on X"
// suggestion further down can't be misread as a BLOCK verdict.
export function challengeVerdict(brief: unknown): string {
  const first = String(brief || "").split("\n").map((l: string) => l.trim()).find(Boolean) || "";
  if (/\bBLOCK\b/i.test(first)) return "BLOCK";
  if (/\bCONCERN\b/i.test(first)) return "CONCERN";
  if (/\bPASS\b/i.test(first)) return "PASS";
  return "UNKNOWN";
}

/**
 * Should a normal card get the cross-model challenge on top of its review?
 *
 * It was opt-in for one reason: the reviewer is already independent and
 * adversarial, so a second opinion meant paying twice for the same judgment.
 * That argument is about the bill, and it stops applying when the challenger is
 * the lane whose quota is not being rationed — a free second opinion on a diff
 * about to be committed is worth taking.
 *
 * So: always on for a high-risk diff, on by default when an independent BULK
 * challenger is available, opt-in otherwise. FRAMEIN_CHALLENGE=0 turns it off
 * even then, because an operator may still not want the latency.
 */
export function shouldRunChallenge(
  value = process.env.FRAMEIN_CHALLENGE,
  highRisk = false,
  bulkChallengerAvailable = false,
) {
  if (highRisk) return true;
  if (value === "0") return false;
  return value === "1" || bulkChallengerAvailable;
}

/** Convert unavailable safety metadata into the same high-risk floor used at ship. */
export function failClosedRisk(error: unknown): Risk {
  return {
    level: "high",
    score: 99,
    reasons: [`risk evaluation failed: ${(error as Error)?.message || error}`],
  };
}

/** High-risk work may proceed only after a valid independent challenge verdict. */
export function challengeGateDecision({
  highRisk = false,
  available = true,
  exitCode = 0,
  verdict = "UNKNOWN",
} = {}) {
  if (!highRisk) return "continue";
  if (!available || exitCode !== 0) return "fail";
  return verdict === "PASS" || verdict === "CONCERN" ? "continue" : "fail";
}

/** Resolve the mandatory high-risk outcome of a parallel auditor set. */
/** One auditor's report, or why it could not produce one. */
export interface AuditReport {
  verdict?: string;
  unavailable?: boolean;
  limited?: boolean;
  agent?: string;
  exitCode?: number;
}

export function challengeAuditDecision(results: AuditReport[] = [], highRisk = false): string {
  if (!highRisk) return "continue";
  const reports = results.filter((result) => result && !result.unavailable);
  if (reports.some((result) => result.verdict === "BLOCK")) return "fail";
  if (reports.some((result) => !["PASS", "CONCERN"].includes(result.verdict ?? ""))) return "fail";

  // This lane promises two independent opinions. One valid report must never
  // hide a missing or failed peer; rate limits yield for retry, while ordinary
  // unavailability closes the card. A single rate-limited result also yields,
  // because the other auditor may already have been removed by the cooldown
  // filter before this function received the execution results.
  const unavailable = results.filter((result) => result?.unavailable);
  if (results.length < 2) {
    return results.length && results.every((result) => result?.unavailable && result.limited)
      ? "cooldown"
      : "fail";
  }
  if (unavailable.length) {
    return unavailable.every((result) => result.limited) ? "cooldown" : "fail";
  }
  return reports.length >= 2 && reports.every((result) => ["PASS", "CONCERN"].includes(result.verdict ?? ""))
    ? "continue"
    : "fail";
}

/** Prevent a mandatory dual-audit lane from falling through to one challenger. */
export function auditCoverageDecision({
  auditRequired = false,
  highRisk = false,
  auditorCount = 0,
  independentCount = 0,
  coolingCount = 0,
} = {}) {
  if (!auditRequired || !highRisk) return "continue";
  if (auditorCount > 0) return "run";
  return independentCount > 0 && coolingCount === independentCount ? "cooldown" : "fail";
}

// challenge — a DIFFERENT provider than the builder adversarially challenges the
// diff against the frozen contract and returns a short decision brief. This is the
// "second pair of eyes from another model" that catches single-model blind spots,
// independent of the reviewer (which drives a CLI and trusts its exit code).
//
// Two modes:
//   • Opt-in (FRAMEIN_CHALLENGE=1): runs on EVERY card, advisory — the brief is
//     prepended to the reviewer's prompt but never blocks.
//   • High-risk (risk.level === "high", ALWAYS on, not gated by the opt-in): a
//     BLOCK verdict stops the card before it is ever committed/pushed. This is a
//     fail-safe ADDITION — the persona deploy gate still holds high-risk for a
//     human tap; this catches a bad high-blast diff one step earlier, so a
//     contract-drifting auth/migration change isn't pushed to origin at all.
//     Can't be disabled by env: high risk gets a second model regardless.
async function nodeChallenge(state: LoopState) {
  const { card, spec, workdir = ROOT } = state;

  // Score the diff the same way ship does, so "high risk" means the same thing at
  // both gates. Missing safety metadata fails closed and therefore also requires
  // a successful independent challenge.
  let risk: Risk | null = null;
  let changed: string[] = [];
  // FRAMEIN_RISK=off is a human's convenience while refactoring. An unattended
  // run may not use it: the spec-text sensitive check that would remain can be
  // fooled by innocuous wording, and the file paths cannot.
  const riskOptOut = process.env.FRAMEIN_RISK === "off"
    ? optOutRefusal(GOVERNED_OPT_OUTS.risk) : null;
  if (riskOptOut) await log("guard", { card, actor: "ralph", detail: riskOptOut });
  if (process.env.FRAMEIN_RISK !== "off" || riskOptOut) {
    try {
      const contract = loadContract(card);
      const diff = await changedFilesIn(workdir, contract?.baseline);
      if (!diff.ok) throw new Error("could not enumerate changed files");
      changed = diff.files;
      risk = riskScore(changed, spec);
    } catch (e) {
      risk = failClosedRisk(e);
      await log("error", { card, actor: "framein", detail: riskLine(risk) });
    }
  }
  const highRisk = risk?.level === "high";
  // Is the free second opinion actually on the table? Only if the bulk lane is
  // installed, idle, and independent of whoever built this diff — an author
  // cannot challenge its own work however much quota it has.
  const freeChallenger = pickChallenger(state.lastAgent ?? "");
  const bulkChallengerAvailable = Boolean(freeChallenger && isBulkLane(freeChallenger.agent));
  const runChallenge = shouldRunChallenge(process.env.FRAMEIN_CHALLENGE, highRisk, bulkChallengerAvailable);
  if (!runChallenge) return { challengeBrief: "" };

  // Security- and test-shaped diffs get BOTH auditors (codex + agy) in parallel
  // rather than one challenger. Two independent models disagreeing is the signal;
  // a single opinion on "is this test meaningful" or "does this open a hole" is
  // the blind spot this lane exists to close.
  let challengeBrief = "";
  if (!changed.length) {
    try {
      const diff = await changedFilesIn(workdir, loadContract(card)?.baseline);
      if (diff.ok) changed = diff.files;
    } catch { /* unscored */ }
  }
  const auditRequired = needsAudit(risk, changed, spec);
  const auditCandidates = auditRequired
    ? auditAgents().filter((agent) => independentAgents(agent, state.lastAgent ?? ""))
    : [];
  const auditors = auditRequired ? pickAuditors(state.lastAgent ?? "") : [];
  const auditCoverage = auditCoverageDecision({
    auditRequired,
    highRisk,
    auditorCount: auditors.length,
    independentCount: auditCandidates.length,
    coolingCount: auditCandidates.filter((agent) => agentUsable(agent) && inCooldown(agent)).length,
  });
  if (auditCoverage === "cooldown") {
    await wipSave(card, workdir);
    await log("iterate", { card, actor: "ralph", detail: "framein: every mandatory high-risk auditor is cooling down — yielding" });
    return { outcome: "cooldown", feedback: "Mandatory high-risk audit is temporarily unavailable." };
  }
  if (auditCoverage === "fail") {
    await log("error", { card, actor: "ralph", detail: "framein: no independent auditor available for mandatory high-risk dual audit — not shipping" });
    return { outcome: "failed", feedback: "No independent auditor is available for this high-risk change." };
  }
  if (auditors.length) {
    // One auditor is a degraded audit, not a skipped one — say so rather than
    // letting a single opinion look like a full cross-verification.
    if (auditors.length < 2) {
      await log("iterate", { card, actor: "ralph", detail: `framein: only ${auditors[0]?.agent} available to audit (cross-verification degraded)` });
    }
    const contract = (() => { try { return loadContract(card); } catch { return null; } })();
    const prompt =
      `[CROSS-VERIFY] You are an INDEPENDENT auditor from a different model than the builder. ` +
      `Audit the staged changes for task "${card}" against this frozen contract: ${contract?.spec || spec}. ` +
      `Focus on TEST CORRECTNESS (do the tests actually prove the claim, or do they pass vacuously?) and ` +
      `SECURITY (injection, authz bypass, secret exposure, unsafe deserialization, path traversal, unvalidated input). ` +
      `Reply with a 3-line DECISION BRIEF: (1) verdict PASS/CONCERN/BLOCK, (2) the single biggest risk, (3) one concrete fix if any.`;

    const results = await Promise.all(auditors.map(async (auditor) => {
      const ab = splitCmd(auditor.cmd);
      const { code, stdout } = await run(ab.bin, [...ab.args, prompt], { tee: true, workspaceReadOnly: true, cwd: workdir });
      if (code !== 0) {
        const limited = await recordLimitIfAny(auditor.agent, stdout, card);
        await log("error", { card, actor: auditor.agent, detail: `framein: audit exited ${code}${highRisk ? " (mandatory opinion unavailable)" : " (advisory — continuing)"}` });
        return { agent: auditor.agent, unavailable: true, limited };
      }
      const brief = (stdout || "").trim().slice(-1200);
      const verdict = challengeVerdict(brief);
      await appendLedger(card, { agent: auditor.agent, event: "challenge", detail: `audit ${verdict} — ${brief.split("\n")[0]?.slice(0, 120)}` });
      await log("iterate", { card, actor: auditor.agent, detail: `framein: security/test audit → ${verdict}` });
      return { agent: auditor.agent, brief, verdict };
    }));

    const reports = results.filter((result) => result && !result.unavailable);
    const opinions = reports.filter((result) => ["PASS", "CONCERN", "BLOCK"].includes(result.verdict ?? ""));
    if (reports.length) {
      challengeBrief = reports.map((o) => `[${o.agent}] ${o.brief}`).join("\n\n").slice(-2400);
    }
    const auditDecision = challengeAuditDecision(results, highRisk);
    if (auditDecision === "cooldown") {
      await wipSave(card, workdir);
      await log("iterate", { card, actor: "ralph", detail: "framein: every mandatory high-risk auditor is cooling down — yielding" });
      return { outcome: "cooldown", feedback: "Mandatory high-risk audit is temporarily unavailable." };
    }
    if (auditDecision === "fail") {
      const blocker = opinions.find((o) => o.verdict === "BLOCK");
      if (highRisk && blocker) {
        await log("error", { card, actor: blocker.agent, detail: `framein: high-risk change BLOCKED by security/test audit (${riskLine(risk)}) — not shipping` });
        return { outcome: "failed", feedback: `Cross-model security/test audit BLOCKED this high-risk change:\n${challengeBrief}` };
      }
      await log("error", { card, actor: "ralph", detail: "framein: no valid mandatory high-risk audit verdict — not shipping" });
      return { outcome: "failed", feedback: "No valid independent audit verdict is available for this high-risk change." };
    }
    return { challengeBrief };
  }

  const challenger = pickChallenger(state.lastAgent ?? "");
  if (challenger) {
    const contract = (() => { try { return loadContract(card); } catch { return null; } })();
    const cb = splitCmd(challenger.cmd);
    const { code: cc, stdout: cout } = await run(cb.bin, [
      ...cb.args,
      `[FRAMEIN CHALLENGE] You are an INDEPENDENT reviewer from a different model than the builder. ` +
      `Adversarially challenge the staged changes for task "${card}" against this frozen contract: ${contract?.spec || spec}. ` +
      `Look for: contract drift (built something other than agreed), missed edge cases, risky blast radius, and data-contract violations. ` +
      `Reply with a 3-line DECISION BRIEF: (1) verdict PASS/CONCERN/BLOCK, (2) the single biggest risk, (3) one concrete fix if any.`,
    ], { tee: true, workspaceReadOnly: true, cwd: workdir });
    if (cc === 0) {
      challengeBrief = (cout || "").trim().slice(-1200);
      const verdict = challengeVerdict(challengeBrief);
      await appendLedger(card, { agent: challenger.agent, event: "challenge", detail: `${verdict} — ${challengeBrief.split("\n")[0]?.slice(0, 120)}` });
      await log("iterate", { card, actor: challenger.agent, detail: `framein: cross-model challenge → ${verdict}` });
      // Enforce ONLY on high risk: a BLOCK there stops the card before ship. On a
      // non-high card the brief stays advisory (prepended to the reviewer prompt).
      if (challengeGateDecision({ highRisk, verdict }) === "fail") {
        await log("error", { card, actor: challenger.agent, detail: `framein: high-risk change did not pass mandatory cross-model challenge (${verdict}; ${riskLine(risk)}) — not shipping` });
        return { outcome: "failed", feedback: `Mandatory cross-model challenge failed for this high-risk change (${verdict}):\n${challengeBrief}` };
      }
    } else {
      const limited = await recordLimitIfAny(challenger.agent, cout, card);
      if (challengeGateDecision({ highRisk, exitCode: cc }) === "fail") {
        if (limited) {
          await wipSave(card, workdir);
          await log("iterate", { card, actor: challenger.agent, detail: "framein: mandatory high-risk challenger is cooling down — yielding" });
          return { outcome: "cooldown", feedback: "Mandatory high-risk challenge is temporarily unavailable." };
        }
        await log("error", { card, actor: challenger.agent, detail: `framein: mandatory high-risk challenge exited ${cc} — not shipping` });
        return { outcome: "failed", feedback: `Mandatory high-risk challenge exited ${cc}.` };
      }
      await log("error", { card, actor: challenger.agent, detail: `framein: challenge exited ${cc} (advisory — continuing)` });
    }
  } else {
    if (challengeGateDecision({ highRisk, available: false }) === "fail") {
      await log("error", { card, actor: "ralph", detail: "framein: no distinct challenger available for mandatory high-risk challenge — not shipping" });
      return { outcome: "failed", feedback: "No independent challenger is available for this high-risk change." };
    }
    await log("iterate", { card, actor: "ralph", detail: "framein: no distinct challenger available (optional challenge skipped)" });
  }
  return { challengeBrief };
}

// review — reviewer sign-off. The reviewer agent re-checks the diff against intent
// + conventions + data contract. It must be a DIFFERENT provider than the builder
// (never self-review), and its verdict is PARSED — a clean exit that returned a
// fix list is a rejection, not a pass.
async function nodeReview(state: LoopState, ctx: any) {
  const { card, spec, challengeBrief, workdir = ROOT } = state;
  ctx.backlog.setStatus(card, "review");

  // The planner is an author too — it chose the files and the approach — so the
  // reviewer must differ from BOTH. Reviewing the output of your own plan is the
  // same false consensus as reviewing your own diff.
  const choice = pickReviewer(state.lastAgent ?? "", state.planner ?? null);
  if (!choice) {
    // Every distinct provider is an author here (or is cooling down). Do NOT let
    // an author review its own work — save WIP and yield so the card is retried
    // once an independent reviewer frees up.
    await wipSave(card, workdir);
    await log("iterate", {
      card, actor: "ralph",
      detail: `no independent reviewer available (distinct from ${authorsOf(state).join(" + ") || "the builder"}) — yielding`,
    });
    return { outcome: "cooldown" };
  }
  const reviewerAgent = choice.agent;
  const reviewer = splitCmd(choice.cmd);
  if (reviewerAgent !== agentKeyFor(process.env.LOOP_REVIEWER || "claude")) {
    await log("iterate", { card, actor: reviewerAgent, detail: `reviewer fallback → independent provider (builder was '${state.lastAgent}')` });
  }
  const beforeDigest = await workingTreeDigest(workdir);
  const criteria = acceptanceCriteria(spec);
  const criteriaText = criteria.map((c) => `- ${c.id}: ${c.statement}`).join("\n");
  let sloppinessText = "";
  try {
    const contract = loadContract(card);
    const slopReport = analyzeDiff(workdir, contract?.baseline);
    if (slopReport.filesAnalyzed > 0) {
      sloppinessText = formatSloppinessPrompt(slopReport);
    }
  } catch {}
  const reviewPrompt = [
    `Review the working-tree changes for task "${card}" against AGENTS.md, CLAUDE.md, the frozen intent, and the data contract.`,
    "You are READ-ONLY. Do not edit files or run commands that mutate the repository.",
    challengeBrief ? `Independent challenge brief:\n${challengeBrief}` : "",
    sloppinessText ? sloppinessText : "",
    `Verify every frozen acceptance criterion independently:\n${criteriaText}`,
    "In the same pass, act as the owner described in .claude/persona.md and give a deploy recommendation. This recommendation never overrides a failed code review; it is consumed only after approval.",
    "Return ONLY one JSON object with this exact shape:",
    '{"decision":"approve|revise","rationale":"short reason","acceptance_results":[{"id":"AC-1","status":"pass|fail|unverified","evidence":"observed command/output or file evidence"}],"blocking_issues":["specific issue"],"persona_verdict":{"decision":"approve|escalate|reject","confidence":0.9,"blast_radius":"low|medium|high","rationale":"one sentence as the owner"}}',
    "Include every acceptance ID exactly once. Approve only when every status is pass and every item has concrete evidence.",
  ].filter(Boolean).join("\n\n");

  const { code: rc, stdout: rout } = await run(reviewer.bin, [
    ...reviewer.args,
    reviewPrompt,
  ], { tee: true, workspaceReadOnly: true, cwd: workdir });
  if (rc !== 0) {
    if (await recordLimitIfAny(reviewerAgent, rout, card)) { await wipSave(card, workdir); return { outcome: "cooldown" }; }
    await log("error", { card, actor: reviewerAgent, detail: `reviewer exited ${rc}` });
    return { outcome: "failed" };
  }

  const parsed = parseStructured<ReviewVerdict>(rout, REVIEW_SCHEMA);
  if (!parsed.ok) {
    await log("error", { card, actor: reviewerAgent, detail: `review output invalid: ${parsed.errors.join("; ")}` });
    return { outcome: "failed", feedback: "Reviewer did not return a valid structured verdict." };
  }
  const coverageErrors = validateAcceptanceResults(criteria, parsed.value?.acceptance_results);
  if (coverageErrors.length) {
    await log("error", { card, actor: reviewerAgent, detail: `acceptance evidence invalid: ${coverageErrors.join("; ")}` });
    return { reviewReject: true, feedback: `[ACCEPTANCE EVIDENCE]\n${coverageErrors.join("\n")}` };
  }
  const afterReviewDigest = await workingTreeDigest(workdir);
  if (afterReviewDigest !== beforeDigest) {
    await log("error", { card, actor: reviewerAgent, detail: "read-only reviewer changed the working tree" });
    return { outcome: "failed", feedback: "Security boundary violation: reviewer changed the working tree." };
  }
  if (parsed.value?.decision !== "approve") {
    const feedback = parsed.value?.blocking_issues?.join("\n") || parsed.value?.rationale;
    await log("iterate", { card, actor: reviewerAgent, detail: "reviewer requested revision" });
    return { reviewReject: true, feedback: `[REVIEWER FEEDBACK]\n${feedback}` };
  }

  // Verify once more after sign-off. A green check that mutates tracked output is
  // rejected because the reviewer did not inspect that final diff.
  const finalCheck = await strictHealthCheck(workdir);
  if (!finalCheck.ok) return { outcome: "failed", feedback: buildFeedback(finalCheck.logs).text };
  const finalDigest = await workingTreeDigest(workdir);
  if (finalDigest !== beforeDigest) {
    return { outcome: "failed", feedback: "Post-review health changed the working tree; review the generated diff explicitly." };
  }
  return {
    reviewReject: false,
    reviewApproved: true,
    reviewDigest: finalDigest,
    personaVerdict: parsed.value.persona_verdict,
  };
}

// ship — commit + push, score the diff's path risk, run the persona deploy gate,
// then auto-deploy or hold for the owner's Telegram tap.
async function nodeShip(state: LoopState) {
  const { card, spec, workdir = ROOT } = state;
  let shipped = false;
  if (!CFG.dry) {
    if (!state.reviewApproved || !state.reviewDigest) throw new Error("ship refused: no structured review approval");

    // No evidence file means the verification did not happen. The reviewer's
    // structured approval is a model's word about what it observed; this is the
    // observation itself, on disk, re-readable next month. A card in scope for
    // evidence and carrying none is held for the owner rather than committed —
    // failing it would throw away a green, reviewed diff over a missing file.
    const planCfg = planConfig(ROOT);
    if (evidenceRequired({ spec: spec ?? "", source: String(state.source ?? ""), cfg: planCfg })) {
      // `workdir`, not ROOT: the builder wrote the dossier in its own worktree, and
      // it reaches the base branch with the rest of the diff at integrate time.
      const verdict = verifyEvidence(card, { cwd: workdir, cfg: planCfg });
      if (!verdict.ok) {
        const reason = `evidence gate: ${verdict.reason}`;
        const staged = await stageForApproval(card, state.reviewDigest, workdir);
        const pending = holdCard(card, reason, { kind: "review", ...staged });
        await log("guard", { card, actor: "evidence", detail: reason });
        await notifyMobile(card, "approval", reason, pending.nonce);
        return { outcome: "approval", shipped: false };
      }
      await log("approve", { card, actor: "evidence", detail: verdict.reason });
    }

    // Risk is evaluated before any commit or push. An unavailable risk scorer is
    // itself high risk: safety metadata must fail closed, never silently vanish.
    let risk;
    try {
      const contract = loadContract(card);
      const diff = await changedFilesIn(workdir, contract?.baseline);
      if (!diff.ok) throw new Error("could not enumerate reviewed files");
      if (!diff.files.length) throw new Error("reviewed task produced no changed files");
      risk = riskScore(diff.files, spec);
      await log("approve", { card, actor: "framein", detail: riskLine(risk) });
    } catch (e) {
      risk = failClosedRisk(e);
      await log("error", { card, actor: "framein", detail: riskLine(risk) });
    }

    // Code sloppiness & erosion telemetry (non-blocking, soft metric)
    try {
      const contract = loadContract(card);
      const slopReport = analyzeDiff(workdir, contract?.baseline);
      if (slopReport.filesAnalyzed > 0) {
        await log("health", { card, actor: "sloppiness", detail: slopReport.summary });
        const refactorSuggestion = suggestRefactorCard(card, slopReport);
        if (refactorSuggestion) {
          await log("iterate", { card, actor: "sloppiness", detail: `advisory follow-up: ${refactorSuggestion}` });
        }
      }
    } catch {}


    const verdict = await personaApprove({ card, spec: spec ?? "", risk, reviewerVerdict: state.personaVerdict as PersonaVerdict | null });
    if (risk) verdict.reason = `${verdict.reason} · ${riskLine(risk)}`;
    await log("approve", { card, actor: "persona", detail: verdict });

    if (verdict.decision === "approve") {
      const stages = releaseStages(process.env);
      if (process.env.RELEASE_PIPELINE === "staging-canary-production") {
        const config = validateReleaseConfig(stages, process.env);
        if (!config.ok) {
          const reason = `release configuration missing: ${config.missing.join(", ")}`;
          const staged = await stageForApproval(card, state.reviewDigest, workdir);
          const pending = holdCard(card, reason, { kind: "review", ...staged });
          await log("guard", { card, actor: "release", detail: reason });
          await notifyMobile(card, "approval", reason, pending.nonce);
          return { outcome: "approval", shipped: false };
        }
      }

      const committed = await commitAndPush(card, state.reviewDigest, workdir);
      // The branch is merged into the base and pushed, so this checkout is spent
      // — retire it HERE, not after the deploy. A failed deploy returns early,
      // and its retry replays from `mainCommit` (decide.ts approveRetry), never
      // from this tree, so cleanup further down would simply never run and every
      // failed deploy would leak a full checkout onto a long-lived loop server.
      //
      // The held branch below is the opposite case and keeps its checkout: a
      // rejection requeues the card and the builder resumes on loop/<card>.
      await retireWorktree(card, workdir);
      try {
        await log("deploy", { card, actor: "persona", detail: `auto-deploy approved: ${verdict.reason}` });
        // Held in a box, not a `let`: the marker is created inside the deploy
        // callback, and control-flow analysis cannot see a closure's assignment
        // — it would narrow the variable to null at the read below.
        const release: { rollback: PendingMarker | null } = { rollback: null };
        const released = await runReleaseStages(stages, {
          deploy: async (stage) => {
            await log("deploy", { card, actor: "railway", detail: `promoting ${stage.name} (${stage.environment})` });
            const deployed = await run(process.execPath, [
              resolve(HERE, "deploy-railway.ts"), card,
              "--stage", stage.name, "--environment", stage.environment,
            ], { timeout: 180_000, sandbox: false });
            if (deployed.code === 0 && stage.name === "production") {
              // Production has started. Create rollback authority before probing
              // health so a failed verification never leaves an untracked release.
              release.rollback = holdCard(card, verdict.reason, {
                kind: "rollback", mainCommit: committed.commit, digest: state.reviewDigest,
              });
            }
            return {
              ok: deployed.code === 0,
              owner: "railway",
              evidence: `command:deploy-railway.ts?stage=${stage.name}#exit=${deployed.code}`,
            };
          },
          verify: async (stage) => {
            if (!stage.healthUrl) {
              return {
                ok: true,
                owner: "verification",
                evidence: `config:${stage.name}:health-check-intentionally-skipped`,
              };
            }
            const verified = await run(process.execPath, [
              resolve(HERE, "verify-deployment.ts"),
              "--url", stage.healthUrl, "--stage", stage.name,
            ], {
              timeout: 180_000,
              envAllow: ["FACTORY_HEALTH_ATTEMPTS", "FACTORY_HEALTH_INTERVAL_MS"],
            });
            return {
              ok: verified.code === 0,
              owner: "verification",
              evidence: `command:verify-deployment.ts?stage=${stage.name}#exit=${verified.code}`,
            };
          },
          regress: async (stage) => {
            const regression = await strictHealthCheck(ROOT);
            return {
              ok: regression.ok,
              owner: "ralph",
              evidence: `${state.evidenceDir || "evidence"}/README.md#${stage.name}-regression`,
              blockedReason: regression.ok ? null : `${stage.name} regression failed`,
            };
          },
          onCheck: async (check) => {
            await log("release.check", { card, actor: check.owner, detail: check });
          },
        });
        if (!released.ok) {
          if (!release.rollback) {
            holdCard(card, `${released.stage} ${released.phase} failed`, {
              kind: "deploy-retry", mainCommit: committed.commit, digest: state.reviewDigest,
            });
          }
          throw new Error(`${released.stage} ${released.phase} failed`);
        }
        shipped = true;
        await log("deploy", { card, actor: "ralph", detail: `release succeeded: ${(released.stages ?? []).join(" → ")}` });
        await log("hypercare.enter", {
          card,
          actor: "ralph",
          detail: { startedAt: new Date().toISOString(), releaseChecks: released.checks.map((item) => item.id) },
        });
        await notifyMobile(card, "deployed", verdict.reason, release.rollback?.nonce || "");
      } catch (e) {
        const message = (e as Error)?.message ?? String(e);
        await log("error", { card, actor: "ralph", detail: `auto-deploy failed: ${message}` });
        writeFailureBundle(card, spec, { ...state, feedback: message, workdir }, e);
        return { outcome: "approval", shipped: false };
      }
    } else {
      // A held change is pushed only to a review branch. The protected/default
      // branch and production remain untouched until a nonce-authorized decision.
      const staged = await stageForApproval(card, state.reviewDigest, workdir);
      const pending = holdCard(card, verdict.reason, { kind: "review", ...staged });
      await log("iterate", { card, actor: "persona", detail: `deploy withheld (${verdict.decision}): ${verdict.reason}` });
      await notifyMobile(card, "approval", verdict.reason, pending.nonce);
      return { outcome: "approval", shipped: false };
    }
  }
  await log("commit", {
    card, actor: "reviewer",
    detail: CFG.dry ? "dry-run (no push)" : shipped ? "committed + pushed & deployed" : "committed + pushed; deploy held for owner approval",
  });
  return { outcome: "done", shipped };
}

const TASK_GRAPH = defineGraph({
  name: "ralph-task",
  start: "prime",
  nodes: {
    prime: nodePrime,
    build: nodeBuild,
    giveUp: nodeGiveUp,
    strictHealth: nodeStrictHealth,
    challenge: nodeChallenge,
    runVerify: nodeRunVerify,
    review: nodeReview,
    ship: nodeShip,
  },
  edges: {
    // An outcome set at prime is a refusal, not a result: the plan gate blocked
    // the card, or the per-card worktree could not be prepared. Both must END.
    // Falling through to build would hand the builder a state with no `workdir`,
    // which defaults to ROOT — i.e. it would edit the shared checkout, the exact
    // collision the worktree exists to prevent, and it would build a risky card
    // the gate just refused.
    prime: (s, ctx) => (ctx.stopping() ? HALT : s.outcome ? END : "build"),
    build: (s, ctx) => {
      if (s.outcome === "cooldown" || s.outcome === "budget") return END;
      if (s.green) return "strictHealth";
      if ((s.iter ?? 0) >= CFG.maxIters) return "giveUp";
      // A graceful stop keeps the checkpoint so the next claim resumes mid-build.
      if (ctx.stopping()) return HALT;
      return "build";
    },
    giveUp: () => END,
    strictHealth: (s) => (s.outcome ? END : "challenge"),
    // A high-risk BLOCK verdict sets outcome=failed here — end before review/ship
    // so the change is never committed or pushed. Otherwise proceed to runVerify.
    challenge: (s) => (s.outcome ? END : "runVerify"),
    runVerify: (s) => {
      if (s.outcome) return END;
      if (s.runVerifyReject) {
        if ((s.iter ?? 0) >= CFG.maxIters) return "giveUp";
        return "build"; // Return to builder with execution feedback
      }
      return "review";
    },
    review: (s) => {
      if (s.outcome) return END;
      if (s.reviewReject) {
        if ((s.iter ?? 0) >= CFG.maxIters) return "giveUp";
        return "build"; // Dynamic Peer Review loop: return to builder with feedback
      }
      return "ship";
    },
    ship: () => END,
  },
});

function safeJson(path: string): any {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function writeFailureBundle(card: string, spec: string | undefined, state: Partial<LoopState> = {}, error: unknown = null) {
  try {
    const feedback = String((error as Error)?.stack || state.feedback || error || "unknown failure");
    const classification = classifyFailure(feedback);
    const signature = createHash("sha256").update(`${classification}\n${normalizeFailure(feedback)}`).digest("hex");
    const root = resolve(STATE_DIR, "failures", card);
    const previous = safeJson(resolve(root, "last.json"));
    const repeats = previous?.signature === signature ? Number(previous.repeats || 1) + 1 : 1;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dir = resolve(root, stamp);
    mkdirSync(dir, { recursive: true });

    const gitDiff = spawnSync("git", ["diff", "--binary", "HEAD"], {
      cwd: state.workdir || ROOT, encoding: "utf8", windowsHide: true, maxBuffer: 10 * 1024 * 1024,
    });
    const contract = (() => { try { return loadContract(card); } catch { return null; } })();
    const summary = {
      card, classification, signature, repeats, createdAt: new Date().toISOString(),
      feedback: feedback.slice(0, 20_000),
    };
    writeFileSync(resolve(dir, "contract.json"), JSON.stringify({
      card, spec, acceptance: acceptanceCriteria(spec), frozen: contract,
    }, null, 2) + "\n");
    writeFileSync(resolve(dir, "environment.json"), JSON.stringify({
      platform: process.platform, arch: process.arch, node: process.version,
      cwd: state.workdir || ROOT,
    }, null, 2) + "\n");
    writeFileSync(resolve(dir, "commands.json"), JSON.stringify({
      lastAgent: state.lastAgent || null,
      iterations: state.iter || 0,
      healthFeedback: state.feedback || "",
    }, null, 2) + "\n");
    writeFileSync(resolve(dir, "checkpoint.json"), JSON.stringify(state, null, 2) + "\n");
    writeFileSync(resolve(dir, "git-diff.patch"), gitDiff.status === 0 ? gitDiff.stdout : `git diff failed: ${gitDiff.stderr || gitDiff.status}\n`);
    writeFileSync(resolve(dir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
    writeFileSync(resolve(root, "last.json"), JSON.stringify(summary, null, 2) + "\n");
    return summary;
  } catch (bundleError) {
    console.error("failure bundle: could not persist diagnostics:", (bundleError as Error)?.message || bundleError);
    return null;
  }
}

function repeatedFailureCount(card: string): number {
  return Number(safeJson(resolve(STATE_DIR, "failures", card, "last.json"))?.repeats || 0);
}

// Drive one task end-to-end. Returns "done" | "approval" | "failed" | "cooldown".
// "cooldown" means every builder agent is rate-limited: the task is WIP-saved
// and requeued so it resumes automatically once an agent resets.
async function runTask(backlog: Backlog, task: TaskRow) {
  const { card, spec } = task;
  process.env.LOOP_CARD = card;
  await log("iterate", { card, actor: "ralph", detail: "task start" });

  // A leftover checkpoint means a prior run died (or was stopped) mid-card —
  // runGraph resumes at that node instead of restarting the card from scratch.
  const prior = loadCheckpoint(card);
  if (prior && prior.graph === TASK_GRAPH.name) {
    await log("iterate", { card, actor: "ralph", detail: `graph: resuming at '${prior.node}' (step ${prior.step})` });
  }

  // The whole card runs under one root span (traceId = card), so the node/tool
  // spans of this attempt read as a single nested timeline in the dashboard.
  const state = await withSpan(`card:${card}`, { traceId: card, kind: "internal", spec: spec.slice(0, 200) }, () =>
    runGraph(TASK_GRAPH, {
      card, spec, taskText: spec, builderInput: spec,
      source: String(task.source ?? ""),
      feedback: "", iter: 0, lastAgent: null, green: false,
      challengeBrief: "", outcome: undefined, shipped: false,
    }, {
      key: card,
      ctx: { backlog, stopping: () => stopping },
      // Room for maxIters builds plus limit retries and the tail nodes. The cap is
      // a safety net against a wedged cycle, not a tuning knob.
      maxSteps: CFG.maxIters * 4 + 16,
    }));

  if (state.__maxStepsExceeded) {
    await log("error", { card, actor: "ralph", detail: "graph: max step cap exceeded — failing the card" });
  }
  // A breakpoint pause is a deliberate human hold, not a failure: park the card
  // so the loop doesn't auto-resume it; the dashboard's ▶ resume (or
  // `backlog.ts status <card> open`) releases it.
  if (state.__breakpoint) {
    await log("iterate", { card, actor: "ralph", detail: `graph: paused at breakpoint '${state.__breakpoint.node}' — resume from the dashboard` });
    return "paused";
  }
  const outcome = state.outcome ?? "failed";
  if (outcome === "failed") {
    const bundle = writeFailureBundle(card, spec, state);
    if (bundle) await log("error", {
      card, actor: "ralph",
      detail: `failure classified=${bundle.classification} signature=${bundle.signature.slice(0, 12)} repeats=${bundle.repeats}`,
    });
  }

  // Distill, don't just archive: the invoke-* wrappers push raw prompt trails
  // (tagged `prompt`, excluded from recall); THIS is the entry recall serves —
  // one line of "what worked / what trapped" per finished card, tagged `lesson`.
  // Cooldown/paused cards aren't finished, so they teach nothing yet.
  if (outcome === "done" || outcome === "failed") {
    try {
      const specLine = spec.replace(/\s+/g, " ").trim().slice(0, 200);
      const trap = (state.feedback || "").trim().slice(0, 400);
      await recordKnowledge(
        outcome === "done"
          ? {
              title: `lesson: ${card} — worked`,
              tags: "lesson,auto,worked",
              source: "loop",
              card,
              body: `Spec: ${specLine}\nWorked: built by ${state.lastAgent ?? "?"} in ${state.iter} iteration(s), reviewer-approved; ${state.shipped ? "auto-deployed" : "deploy held for owner"}.`,
            }
          : {
              title: `lesson: ${card} — trapped`,
              tags: "lesson,auto,trapped",
              source: "loop",
              card,
              body: `Spec: ${specLine}\nTrapped: not green after ${state.iter} iteration(s) (last agent: ${state.lastAgent ?? "?"}).${trap ? `\nLast failure:\n${trap}` : ""}`,
            },
      );
    } catch (e) {
      console.error("knowledge: lesson record failed (continuing):", (e as Error)?.message ?? e);
    }
  }
  return outcome;
}

// Drop a card's worktree once its work no longer lives there. No-op when
// per-card isolation is off, and never fatal: the work is already integrated,
// so a stale checkout is untidy, not lost.
async function retireWorktree(card: string, workdir: string) {
  if (workdir === ROOT) return;
  const gone = removeWorktree(card);
  await log(gone.ok ? "commit" : "error", {
    card, actor: "ralph",
    detail: gone.ok ? "worktree: retired after integrate" : `worktree: ${gone.reason}`,
  });
}

async function commitAndPush(card: string, digest: string | undefined, cwd = ROOT) {
  await run("git", ["add", "-A"], { timeout: 60_000, sandbox: false, cwd });
  const commit = await run("git", ["commit", "--allow-empty", "-m", `loop:${card}`, "-m", `review-digest:${digest}`], { timeout: 60_000, sandbox: false, capture: true, cwd });
  if (commit.code !== 0) throw new Error(`git commit failed: ${commit.stdout.slice(-500)}`);

  // Worktree mode: the commit landed on loop/<card>, not on the base branch.
  // Merge it into the base IN THE MAIN TREE — integrate() refuses if that tree
  // is not on the base branch, and aborts a conflicting merge rather than
  // leaving it half-applied. The main tree never switches branches, which is
  // what makes two cards safe to run at once.
  if (cwd !== ROOT) {
    const merged = integrateWorktree(card);
    if (!merged.ok) {
      const detail = merged.conflictFiles?.length
        ? `${merged.reason}: ${merged.conflictFiles.join(", ")}`
        : merged.reason;
      throw new Error(`worktree integrate failed: ${detail}`);
    }
    if (merged.reason) await log("error", { card, actor: "ralph", detail: `worktree: ${merged.reason}` });
    const head = await run("git", ["rev-parse", "HEAD"], { capture: true, sandbox: false });
    if (head.code !== 0) throw new Error("could not resolve merged HEAD");
    return { commit: head.stdout.trim(), digest, branch: merged.branch, pushed: merged.pushed };
  }
  // Swarm workers can race on push. On rejection, rebase onto the remote and try
  // once more; a second failure just leaves the commit local (the next loop tick
  // pulls/pushes again), so it degrades to eventual consistency, not data loss.
  const first = await run("git", ["push"], { timeout: 120_000, sandbox: false });
  let pushed = first;
  if (first.code !== 0) {
    const rebased = await run("git", ["pull", "--rebase"], { timeout: 120_000, sandbox: false, capture: true });
    if (rebased.code !== 0) throw new Error(`git rebase failed: ${rebased.stdout.slice(-500)}`);
    pushed = await run("git", ["push"], { timeout: 120_000, sandbox: false, capture: true });
  }
  if (pushed.code !== 0) throw new Error(`git push failed: ${pushed.stdout.slice(-500)}`);
  const head = await run("git", ["rev-parse", "HEAD"], { capture: true, sandbox: false });
  if (head.code !== 0) throw new Error("could not resolve committed HEAD");
  return { commit: head.stdout.trim(), digest };
}

async function stageForApproval(card: string, digest: string | undefined, cwd = ROOT) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(card)) throw new Error(`unsafe card id: ${card}`);
  const branch = `harness-review/${card}-${(digest ?? "").slice(0, 12)}`;

  // Worktree mode: the card already has its own branch and checkout, so the
  // review branch is pushed straight from there. The main tree is not touched
  // at all — no `switch -c` … `switch back` dance to race with a second card.
  // The worktree deliberately survives: the human has not decided yet, and
  // approval (decide.ts) works off the pushed branch, not this checkout.
  if (cwd !== ROOT) {
    const base = worktreeBase();
    if (!base) throw new Error("approval staging requires a named base branch (main tree is detached)");
    const add = await run("git", ["add", "-A"], { capture: true, sandbox: false, cwd });
    if (add.code !== 0) throw new Error(`git add failed: ${add.stdout.slice(-500)}`);
    const commit = await run("git", ["commit", "--allow-empty", "-m", `review:${card}`, "-m", `review-digest:${digest}`], { capture: true, sandbox: false, cwd });
    if (commit.code !== 0) throw new Error(`review commit failed: ${commit.stdout.slice(-500)}`);
    const sha = await run("git", ["rev-parse", "HEAD"], { capture: true, sandbox: false, cwd });
    if (sha.code !== 0) throw new Error("could not resolve review commit");
    const push = await run("git", ["push", "origin", `HEAD:refs/heads/${branch}`], { timeout: 120_000, capture: true, sandbox: false, cwd });
    if (push.code !== 0) throw new Error(`review branch push failed: ${push.stdout.slice(-500)}`);
    return { branch, baseBranch: base, commit: sha.stdout.trim(), digest };
  }

  const current = await run("git", ["branch", "--show-current"], { capture: true, sandbox: false });
  if (current.code !== 0 || !current.stdout.trim()) throw new Error("approval staging requires a named git branch");
  const baseBranch = current.stdout.trim();
  const switched = await run("git", ["switch", "-c", branch], { capture: true, sandbox: false });
  if (switched.code !== 0) throw new Error(`could not create review branch ${branch}: ${switched.stdout.slice(-500)}`);
  try {
    const add = await run("git", ["add", "-A"], { capture: true, sandbox: false });
    if (add.code !== 0) throw new Error(`git add failed: ${add.stdout.slice(-500)}`);
    const commit = await run("git", ["commit", "--allow-empty", "-m", `review:${card}`, "-m", `review-digest:${digest}`], { capture: true, sandbox: false });
    if (commit.code !== 0) throw new Error(`review commit failed: ${commit.stdout.slice(-500)}`);
    const sha = await run("git", ["rev-parse", "HEAD"], { capture: true, sandbox: false });
    const push = await run("git", ["push", "origin", `HEAD:refs/heads/${branch}`], { timeout: 120_000, capture: true, sandbox: false });
    if (push.code !== 0) throw new Error(`review branch push failed: ${push.stdout.slice(-500)}`);
    return { branch, baseBranch, commit: sha.stdout.trim(), digest };
  } finally {
    const back = await run("git", ["switch", baseBranch], { capture: true, sandbox: false });
    if (back.code !== 0) throw new Error(`could not restore branch ${baseBranch}: ${back.stdout.slice(-500)}`);
  }
}

// Minimal one-shot Telegram notifier for loop-level escalations (e.g. a card
// parked as terminally 'failed'). Swallows every error so a notification failure
// never breaks the loop, and no-ops without TELEGRAM_BOT_TOKEN/CHAT_ID.
async function sendTelegram(text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return false;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
        signal: ctrl.signal,
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean };
      return !!data.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

// Best-effort: capture a screenshot, push it to Wasabi, send the Telegram card.
// Each step is optional — if creds/deps are absent the step fails and we just log
// it; the commit still happened. `mode` is "deployed" (informational, with a
// rollback button) or "approval" (the persona held the deploy — show an ✅ button
// so the human can release it). `reason` is the persona's one-line rationale.
async function notifyMobile(card: string, mode = "deployed", reason = "", nonce = "") {
  const shot = resolve(ROOT, ".harness", "shots", `${card}.png`);
  mkdirSync(dirname(shot), { recursive: true });
  const cap = await run(process.execPath, [
    resolve(HERE, "capture-screenshot.ts"),
    process.env.SCREENSHOT_URL || "http://localhost:3000",
    shot,
  ]);
  let url = "";
  if (cap.code === 0) {
    // Call upload() in-process: it returns the URL directly (no stdout scraping)
    // and keeps its own optional-dependency guard, so a missing AWS SDK still
    // degrades gracefully here.
    try {
      const uploaded = await run(process.execPath, [
        resolve(HERE, "upload-wasabi.ts"), shot, `screenshots/prod-preview/${card}.png`,
      ], { capture: true, envAllow: ["WASABI_ACCESS_KEY_ID", "WASABI_SECRET_ACCESS_KEY", "WASABI_BUCKET", "WASABI_REGION", "WASABI_ENDPOINT"] });
      if (uploaded.code === 0) url = uploaded.stdout.trim().split(/\r?\n/).at(-1) || "";
      else await log("error", { card, actor: "wasabi", detail: `upload skipped: exit ${uploaded.code}` });
    } catch (e) {
      await log("error", { card, actor: "wasabi", detail: `upload skipped: ${(e as Error)?.message}` });
    }
  }
  await run(process.execPath, [
    resolve(HERE, "notify-telegram.ts"),
    card, "success", "health gate passed", url, mode, reason, nonce,
  ], { envAllow: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"] });
  await run(process.execPath, [
    resolve(HERE, "notify-resend.ts"),
    `[Harness] ${card} ${mode}`,
    `card=${card} status=success mode=${mode} evidence=${url || "n/a"} reason=${reason || "n/a"}`,
  ], { envAllow: ["RESEND_API_KEY", "FACTORY_EMAIL_FROM", "FACTORY_EMAIL_TO"] });
}

// Improve the persona during downtime: refit the confidence calibration from the
// growing label set, then (if enough disagreements have accrued) let the persona
// rewrite its own learned-rules block from the cases it got wrong. Cheap parts
// (calibration) run every idle transition; the agent-backed synthesis is gated by
// a disagreement threshold so it doesn't spend a model call for nothing.
async function learnPersona() {
  try {
    const rows = labeledRows({ requirePrediction: true });
    const params = fitCalibration(rows);
    saveCalibration(params);
    await log("iterate", { actor: "persona", detail: `calibration refit n=${params.n} fitted=${params.fitted} ece=${calibrationEce(rows, params).toFixed(3)}` });
  } catch (e) {
    await log("error", { actor: "persona", detail: `calibration refit failed: ${(e as Error)?.message}` });
  }
  try {
    const r = await synthesizePersona({ minDisagreements: Number(process.env.PERSONA_SYNTH_MIN) || 3 });
    if (r.updated) await log("iterate", { actor: "persona", detail: `persona.md updated from ${r.falseApprove}+${r.overCautious} disagreements` });
  } catch (e) {
    await log("error", { actor: "persona", detail: `synthesis failed: ${(e as Error)?.message}` });
  }
}

async function main() {
  mkdirSync(LOCK_DIR, { recursive: true });
  const backlog = await getBacklog();
  const planResult = await compilePlan({ backlog });
  if (planResult.added.length || planResult.rejected.length) {
    console.log(`[guard] plan-compile added=${planResult.added.length} rejected=${planResult.rejected.length}`);
  }
  // Plan documents are the other, richer source: one approved design compiles into
  // its whole ordered chain of cards at once, which is what lets a feature be
  // queued in a single act instead of card by card.
  try {
    const docs = await compilePlanDocs({ cwd: ROOT, backlog });
    if (docs.added.length || docs.rejected.length) {
      console.log(`[guard] plan-doc docs=${docs.docs} added=${docs.added.length} rejected=${docs.rejected.length} draft=${docs.skipped.length}`);
    }
    for (const bad of docs.rejected) {
      await log("guard", { actor: "plan-doc", detail: `${bad.plan} rejected: ${bad.errors.join("; ")}` });
    }
  } catch (e) {
    console.error("plan-doc: compile failed (continuing):", (e as Error)?.message ?? e);
  }
  const recovered = reclaimStaleClaims(backlog);
  if (recovered.length) {
    await log("guard", { actor: "ralph", detail: `reclaimed stale claims: ${recovered.join(", ")}` });
  }

  // One-time behavioral cloning: seed the persona's label set from git history so
  // it starts with a prior instead of cold. Idempotent — re-runs add only new
  // commits. Skip with PERSONA_BOOTSTRAP=off.
  if (process.env.PERSONA_BOOTSTRAP !== "off") {
    try {
      const b = bootstrapPersona({ limit: Number(process.env.PERSONA_BOOTSTRAP_LIMIT) || 500 });
      if (b.added) console.log(`ralph-loop: persona bootstrap added ${b.added} history labels (approve=${b.approve}, reject=${b.reject})`);
    } catch (e) {
      console.warn(`ralph-loop: persona bootstrap skipped: ${(e as Error)?.message}`);
    }
  }
  const sandbox = sandboxSummary();
  console.log(`ralph-loop: backend=${backlog.kind} sandbox=${sandbox.mode}:${sandbox.target} maxIters=${CFG.maxIters} cmdTimeout=${CFG.cmdTimeout}ms once=${CFG.once} dry=${CFG.dry}`);
  const startupCooldowns = Object.entries(activeCooldowns())
    .map(([a, e]) => `${a}@${new Date(e.until).toISOString()}`).join(", ");
  if (startupCooldowns) console.log(`ralph-loop: agents in cooldown at startup: ${startupCooldowns}`);
  // Surface missing backing CLIs up front so a silent degrade-to-whatever-is-
  // installed becomes a loud, named warning instead of wasted build iterations.
  await warnMissingClis();

  let idle = false; // true while the backlog has been empty — gate the idle log
  let lastDependencyWait = ""; // last logged "none ready" chain — gate that log too
  do {
    if (stopping) break;
    // 1. sync
    if (!CFG.dry) await run("git", ["pull", "--ff-only"], { timeout: 120_000, sandbox: false });

    // 2. spec.md → cards. The human's Today bullets are the highest-authority
    // source of work, so drain them every tick — before self-assessment gets a
    // chance to invent tasks. Idempotent (card id = slug+hash, add is
    // INSERT OR IGNORE), so an unchanged spec.md costs one file read.
    try {
      const s = await syncSpec(backlog);
      if (s.added.length) {
        console.log(`ralph-loop: spec.md sync added ${s.added.length} card(s): ${s.added.join(", ")}`);
        await log("iterate", { actor: "lead", detail: `spec.md sync added: ${s.added.join(", ")}` });
      }
    } catch (err) {
      console.error("ralph-loop: spec.md sync failed:", (err as Error)?.message);
    }

    // 3. find an open task
    let open = backlog.list("open");
    if (open.length === 0) {
      if (CFG.once) { console.log("backlog empty — nothing to do"); break; }

      // The human's own prompts are the highest-signal source of work — triage
      // them into cards (via sub-agent) BEFORE inventing shortcomings ourselves.
      if (!process.env.SKIP_PROMPT_CARDS) {
        try {
          const p = await runPromptAssessment(backlog);
          if (p.added.length > 0) {
            console.log(`ralph-loop: prompt triage added ${p.added.length} card(s). Continuing loop.`);
            continue;
          }
        } catch (err) {
          console.error("ralph-loop: prompt triage failed:", (err as Error)?.message);
        }
      }

      // Autonomous shortcomings assessment
      if (!process.env.SKIP_ASSESSMENT) {
        try {
          const assessment = await runAssessment(backlog);
          if (!assessment.skipped) {
            const detail = assessment as { found?: number; added?: number };
            console.log(`ralph-loop: shortcomings assessment completed (found=${detail.found || 0}, added=${detail.added || 0})`);
          }
          open = backlog.list("open");
          if (open.length > 0) {
            console.log(`ralph-loop: self-assessment added ${open.length} new tasks. Continuing loop.`);
            continue;
          }
        } catch (err) {
          console.error("ralph-loop: self-assessment failed:", (err as Error)?.message);
        }
      }

      // Opt-in (DESIGN_EVOLVE): when still idle, queue one design-evolution round so
      // the self-learning designer grows during downtime. No-op unless enabled; wrapped
      // so a design hiccup can never wedge the core loop.
      try {
        const d = await runDesignAssessment(backlog);
        if (d.queued) {
          open = backlog.list("open");
          if (open.length > 0) {
            console.log(`ralph-loop: queued design round ${d.card}. Continuing loop.`);
            continue;
          }
        }
      } catch (err) {
        console.error("ralph-loop: design-evolution assessment failed:", (err as Error)?.message);
      }

      // Log only on the transition into idle, not every 30s tick — otherwise an
      // idle server appends ~2,880 no-op rows/day to current.md forever. The same
      // transition is the right moment to learn the persona from the day's taps.
      if (!idle) {
        const scout = startPainPointScout();
        if (scout.started) {
          console.log(`ralph-loop: background pain-point scout started for ${scout.type} (pid ${scout.pid}).`);
        }
        await learnPersona();
        await log("iterate", { actor: "ralph", detail: "backlog empty — idle" });
        idle = true;
      }
      await sleep(CFG.interval);
      continue;
    }
    idle = false;

    // `open` is non-empty here (the idle branch above returns) — but "open" is not
    // "runnable". A card whose `Dependencies:` are still building must not be
    // claimed: FIFO would start step 2 of a plan on top of a step 1 that does not
    // exist yet. readyCards() reads the whole backlog (a dependency's state is
    // what decides readiness) and returns the cards that may actually run now.
    const ready = readyCards(backlog.list());
    if (!ready.length) {
      // Every open card is waiting on another. Not idle (there IS work) and not a
      // failure — so report the chain and wait, rather than hot-spinning on a
      // head-of-queue that cannot be claimed. Only the trail is deduped: a 30s
      // tick that appends the same row forever buries everything else in
      // current.md, which is the mistake the idle branch above already learned.
      const waiting = blockedSummary(backlog.list());
      const signature = waiting.join("; ") || "dependencies unresolved";
      console.log(`ralph-loop: ${open.length} open card(s), none ready — ${signature}`);
      if (signature !== lastDependencyWait) {
        lastDependencyWait = signature;
        await log("iterate", { actor: "ralph", detail: `dependency wait: ${waiting.slice(0, 5).join("; ")}` });
      }
      if (CFG.once) break;
      await sleep(CFG.interval);
      continue;
    }
    const task = pickForWorker(ready)!;
    const claimed = claimTask(backlog, task.card);
    if (!claimed.ok) {
      // Lost the race (another agent grabbed it) or the row is wedged in a
      // non-open state. Back off so we never hot-spin, and honor LOOP_ONCE so a
      // single-shot run can't hang forever on an unclaimable head-of-queue.
      await log("iterate", { card: task.card, actor: "ralph", detail: `claim failed: ${claimed.reason}` });
      if (CFG.once) { console.log(`could not claim ${task.card} — exiting (LOOP_ONCE)`); break; }
      await sleep(Math.min(CFG.interval, 5_000));
      continue;
    }

    let outcome = "failed";
    try {
      const row = backlog.get(task.card);
      if (row) outcome = await runTask(backlog, row);
    } catch (e) {
      await log("error", { card: task.card, actor: "ralph", detail: String((e as Error)?.stack || e) });
      writeFailureBundle(task.card, task.spec, {}, e);
    } finally {
      if (outcome === "done") {
        backlog.setStatus(task.card, "done");
      } else if (outcome === "approval") {
        // The reviewed change is either isolated on a remote review branch or
        // waiting for an explicitly authorized deploy retry. Do not feed it
        // back to the builder while the human decision is outstanding.
        backlog.setStatus(task.card, "review");
      } else if (outcome === "paused") {
        // Held at a breakpoint: keep it out of the open queue until a human
        // resumes it (dashboard ▶ or `backlog.ts status <card> open`).
        backlog.setStatus(task.card, "paused");
      } else if (outcome === "budget") {
        // Not the card's fault, so it must not burn an attempt: requeue it and
        // let the loop stop below. Anything else — parking it 'failed', or
        // retrying — would either lose the card or keep spending past the
        // ceiling that just fired.
        backlog.setStatus(task.card, "open");
      } else if (outcome === "cooldown") {
        // Not a failure — every agent is rate-limited. Requeue without holding it
        // against the attempt cap; main() sleeps until the soonest reset, then
        // this card is retried. (attempts still ticks on the next claim, which is
        // an acceptable slow drift toward the cap for a chronically-limited card.)
        backlog.setStatus(task.card, "open");
      } else {
        // Failed this round. Requeue ('open') unless we've hit the attempt cap —
        // then park it as 'failed' (terminal) so an unfixable card can't hot-loop
        // the builder + spam Telegram forever, and escalate to the human exactly
        // once (the row is never claimed again, so this fires a single time). See
        // Incident-012.
        const attempts = backlog.get(task.card)?.attempts ?? 0;
        const repeats = repeatedFailureCount(task.card);
        if (attempts >= CFG.maxAttempts || repeats >= 2) {
          backlog.setStatus(task.card, "failed");
          const reason = repeats >= 2
            ? `same failure signature repeated ${repeats} times`
            : `gave up after ${attempts} attempts`;
          await log("error", { card: task.card, actor: "ralph", detail: `${reason} → 'failed' (terminal, no more requeue)` });
          await sendTelegram(`🛑 auto-fix abandoned: ${task.card}\n${reason} → parked as 'failed'. Reproduction bundle: .harness/failures/${task.card}/`);
        } else {
          backlog.setStatus(task.card, "open"); // requeue for another attempt
        }
      }
      releaseLock(task.card);
    }

    // The spend ceiling fired. Unlike a cooldown there is nothing to wait for —
    // sleeping would only resume the same overspend when the window rolls — so
    // the loop stops and hands the decision back to the human who set the cap.
    if (outcome === "budget") {
      const status = await budgetStatus();
      console.error(`ralph-loop: STOPPING — ${status.exceeded.join("; ") || "budget ceiling reached"}`);
      await log("guard", { actor: "ralph", detail: `loop stopped: ${status.exceeded.join("; ")}` });
      await sendTelegram(`🛑 예산 상한 도달 — 루프를 정지했습니다\n${status.exceeded.join("\n")}\n\n상한을 올리거나 해제한 뒤 다시 시작하세요.`);
      break;
    }

    // Every agent is rate-limited: there's nothing to do until one resets, so
    // sleep until the soonest reset (capped at the normal interval as a floor,
    // and at 1h as a ceiling so a bad parse can't wedge the loop for a day).
    if (outcome === "cooldown") {
      if (CFG.once) { console.log("all agents in cooldown — exiting (LOOP_ONCE)"); break; }
      const wait = Math.max(CFG.interval, Math.min(soonestReset() + 1_000, 60 * 60 * 1000));
      const active = Object.entries(activeCooldowns())
        .map(([a, e]) => `${a}@${new Date(e.until).toISOString()}`).join(", ");
      console.log(`ralph-loop: all agents cooling down [${active}] — sleeping ${Math.round(wait / 1000)}s`);
      await log("iterate", { actor: "ralph", detail: `cooldown sleep ${Math.round(wait / 1000)}s; active: ${active}` });
      await sleep(wait);
    }

    if (CFG.once) break;
  } while (!stopping);

  console.log("ralph-loop: stopped");
}

// argv[1] is undefined under `node -e` / when imported (e.g. a test importing
// challengeVerdict) — guard so importing this module never crashes on CLI detection.
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
  // Declared here, at the entry point, rather than inferred later: this process
  // and everything it spawns is the 24/7 factory, and no safety opt-out inherited
  // from a shell profile applies to it. See autonomy.ts.
  markUnattended();
  // Running unsandboxed is allowed with an explicit acknowledgement, but it must
  // never be quiet: weeks of unsandboxed operation should be readable from the
  // trail, not reconstructed from someone's shell history.
  if (!sandboxSummary().isolated && unattendedHostAllowed()) {
    console.warn("ralph-loop: WARNING — unattended run executing on the HOST, outside the sandbox");
    await log("guard", { actor: "ralph", detail: "unattended run executing on the host (HARNESS_UNATTENDED_ALLOW_HOST=1)" });
  }
  main().catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
}
