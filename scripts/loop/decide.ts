// decide.ts — authenticated approve/reject decisions for held changes.

import { resolve, dirname } from "node:path";
import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync, realpathSync,
} from "node:fs";
import { getBacklog } from "./backlog.ts";
import { log } from "./telemetry.ts";
import { recordLabel } from "./persona-feedback.ts";
import {
  releaseStages, runReleaseStages, validateReleaseConfig, type ReleaseResult, type ReleaseStage,
} from "./release-policy.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(process.cwd());
const STATE_DIR = resolve(process.env.HARNESS_STATE_DIR || resolve(ROOT, ".harness"));
const PENDING_DIR = resolve(STATE_DIR, "pending");
const REJECT_DIR = resolve(STATE_DIR, "reject");
const DECISION_LOCK_DIR = resolve(STATE_DIR, "decision-locks");
const DEPLOY_SCRIPT = resolve(HERE, "deploy-railway.ts");
const VERIFY_SCRIPT = resolve(HERE, "verify-deployment.ts");
const CARD_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const KINDS = new Set(["review", "deploy-retry", "rollback"]);
const COMMAND_TIMEOUT_MS = Number(process.env.HARNESS_COMMAND_TIMEOUT_MS || 120_000);
const DEPLOY_TIMEOUT_MS = Number(process.env.HARNESS_DEPLOY_TIMEOUT_MS || 180_000);

export function releaseRegressionScript(root = ROOT, platform = process.platform): string {
  return resolve(root, "scripts", "loop", platform === "win32" ? "health.ps1" : "health.sh");
}

export function requiresProductionRollback(
  released: Pick<ReleaseResult, "stage" | "phase">,
): boolean {
  return released.stage === "production"
    && ["verify", "regression", "evidence"].includes(String(released.phase || ""));
}

export function releaseDeployOptions(
  stage: ReleaseStage,
): { stage: string; environment: string } {
  return { stage: stage.name, environment: stage.environment };
}

/**
 * A held decision, as persisted under .harness/pending. The nonce is the
 * authorization secret a Telegram tap echoes back, so the shape is a contract
 * between the writer (holdCard) and every reader.
 */
export interface PendingMarker {
  version: number;
  card: string;
  kind: string;
  reason: string;
  nonce: string;
  branch?: string;
  baseBranch?: string;
  commit?: string;
  mainCommit?: string;
  digest?: string;
  at?: string;
  [key: string]: unknown;
}

/** Everything holdCard accepts; which fields are required depends on `kind`. */
export interface HoldOptions {
  kind?: string;
  branch?: string;
  baseBranch?: string;
  commit?: string;
  mainCommit?: string;
  digest?: string;
  nonce?: string;
}

/** What a decision returns to its caller (Telegram, MCP, the session CLI). */
export interface DecisionResult {
  card?: string;
  decision?: string | null;
  error?: string;
  rolledBack?: boolean;
  reopened?: boolean;
  [key: string]: unknown;
}

function assertCard(card: unknown): string {
  if (!CARD_RE.test(String(card || ""))) throw new Error("card must be a lowercase hyphenated slug (max 80 chars)");
  return String(card);
}

function markerPath(card: string): string {
  return resolve(PENDING_DIR, `${assertCard(card)}.json`);
}

function safeEqual(a: unknown, b: unknown): boolean {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length > 0 && left.length === right.length && timingSafeEqual(left, right);
}

function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  try {
    renameSync(tmp, path);
  } catch {
    rmSync(path, { force: true });
    renameSync(tmp, path);
  }
}

function readMarker(card: string): PendingMarker | null {
  try {
    const marker = JSON.parse(readFileSync(markerPath(card), "utf8"));
    if (marker.card !== card || !KINDS.has(marker.kind) || !marker.nonce) throw new Error("invalid marker schema");
    return marker;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw new Error(`invalid pending marker for ${card}: ${(error as Error)?.message || error}`);
  }
}

function acquireDecisionLock(card: string): () => void {
  mkdirSync(DECISION_LOCK_DIR, { recursive: true });
  const path = resolve(DECISION_LOCK_DIR, `${assertCard(card)}.lock`);
  let fd;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") throw new Error(`a decision for "${card}" is already in progress`);
    throw error;
  }
  writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }) + "\n");
  closeSync(fd);
  return () => rmSync(path, { force: true });
}

function authorize(marker: PendingMarker, { nonce, approvalToken }: { nonce?: string; approvalToken?: string } = {}): void {
  if (nonce && safeEqual(nonce, marker.nonce)) return;
  const expected = process.env.HARNESS_APPROVAL_TOKEN;
  if (approvalToken && expected && safeEqual(approvalToken, expected)) return;
  throw new Error("decision authorization failed");
}

interface CmdResult {
  code: number;
  stdout: string;
  error: Error | null;
}

function runCmd(bin: string, args: string[] = [], cwd = ROOT, timeout = COMMAND_TIMEOUT_MS): Promise<CmdResult> {
  return new Promise<CmdResult>((resolveResult) => {
    const child = spawn(bin, args, { cwd, shell: false, windowsHide: true });
    let stdout = "";
    let settled = false;
    const finish = (code: number, error: Error | null = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult({ code, stdout, error });
    };
    child.stdout?.on("data", (data) => { stdout += data.toString(); });
    child.stderr?.on("data", (data) => { stdout += data.toString(); });
    child.on("error", (error: NodeJS.ErrnoException) => finish(error?.code === "ENOENT" ? 127 : 1, error));
    child.on("close", (code) => finish(code ?? 1));
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(124, new Error(`${bin} timed out after ${timeout}ms`));
    }, timeout);
    timer.unref?.();
  });
}

function runDeploy(card: string, { stage = "production", environment }: { stage?: string; environment?: string } = {}) {
  return new Promise((resolveCode) => {
    const args = [DEPLOY_SCRIPT, card, "--stage", stage];
    if (environment) args.push("--environment", environment);
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      stdio: "inherit",
      windowsHide: true,
    });
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveCode(code);
    };
    child.on("error", (error: NodeJS.ErrnoException) => finish(error?.code === "ENOENT" ? 127 : 1));
    child.on("close", (code) => finish(code ?? 1));
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(124);
    }, DEPLOY_TIMEOUT_MS);
    timer.unref?.();
  });
}

function configuredReleaseStages() {
  const stages = releaseStages(process.env);
  const config = validateReleaseConfig(stages, process.env);
  if (process.env.RELEASE_PIPELINE === "staging-canary-production" && !config.ok) {
    throw new Error(`release configuration missing: ${config.missing.join(", ")}`);
  }
  return stages;
}

async function executeRelease(card: string, stages: ReleaseStage[]) {
  return runReleaseStages(stages, {
    deploy: async (stage) => {
      const code = await runDeploy(card, releaseDeployOptions(stage));
      return {
        ok: code === 0,
        owner: "railway",
        evidence: `command:deploy-railway.ts?stage=${stage.name}#exit=${code}`,
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
      const result = await runCmd(
        process.execPath,
        [VERIFY_SCRIPT, "--url", stage.healthUrl, "--stage", stage.name],
        ROOT,
        DEPLOY_TIMEOUT_MS,
      );
      return {
        ok: result.code === 0,
        owner: "verification",
        evidence: `command:verify-deployment.ts?stage=${stage.name}#exit=${result.code}`,
      };
    },
    regress: async (stage) => {
      const windows = process.platform === "win32";
      const script = releaseRegressionScript();
      const result = windows
        ? await runCmd("powershell", ["-ExecutionPolicy", "Bypass", "-File", script], ROOT, DEPLOY_TIMEOUT_MS)
        : await runCmd("bash", [script], ROOT, DEPLOY_TIMEOUT_MS);
      return {
        ok: result.code === 0,
        owner: "release",
        evidence: `command:${windows ? "health.ps1" : "health.sh"}?stage=${stage.name}#exit=${result.code}`,
        blockedReason: result.code === 0 ? null : `${stage.name} regression failed`,
      };
    },
    onCheck: async (check) => {
      await log("release.check", { card, actor: check.owner, detail: check });
    },
  });
}

async function checkedGit(args: string[], label: string) {
  const result = await runCmd("git", args);
  if (result.code !== 0) throw new Error(`${label} failed: ${result.stdout.trim().slice(-600) || `exit ${result.code}`}`);
  return result.stdout.trim();
}

async function setBacklogStatus(card: string, status: string) {
  const backlog = await getBacklog();
  if (backlog.get(card)) backlog.setStatus(card, status);
}

async function removeReviewBranch(marker: PendingMarker) {
  if (!marker.branch) return;
  await runCmd("git", ["push", "origin", "--delete", marker.branch]);
}

/** Record a held change. The returned nonce is only for the decision UI. */
export function holdCard(card: string, reason = "", options: HoldOptions = {}): PendingMarker {
  assertCard(card);
  const kind = options.kind || "review";
  if (!KINDS.has(kind)) throw new Error(`unsupported pending decision kind: ${kind}`);
  const marker = {
    version: 1,
    card,
    kind,
    reason: String(reason || ""),
    branch: options.branch || undefined,
    baseBranch: options.baseBranch || undefined,
    commit: options.commit || undefined,
    mainCommit: options.mainCommit || undefined,
    digest: options.digest || undefined,
    nonce: options.nonce || randomBytes(8).toString("hex"),
    at: new Date().toISOString(),
  };
  if (kind === "review" && (!marker.branch || !marker.baseBranch || !marker.commit || !marker.digest)) {
    throw new Error("review hold requires branch, baseBranch, commit, and digest");
  }
  if ((kind === "deploy-retry" || kind === "rollback") && !marker.mainCommit) {
    throw new Error(`${kind} hold requires mainCommit`);
  }
  atomicJson(markerPath(card), marker);
  return marker;
}

/** Public pending state. Authorization nonces are deliberately never exposed. */
export function pendingCards() {
  if (!existsSync(PENDING_DIR)) return [];
  return readdirSync(PENDING_DIR)
    .filter((file) => file.endsWith(".json") && CARD_RE.test(file.replace(/\.json$/, "")))
    .map((file) => {
      try {
        const { nonce: _nonce, ...publicMarker } = JSON.parse(readFileSync(resolve(PENDING_DIR, file), "utf8"));
        return publicMarker;
      } catch {
        return { card: file.replace(/\.json$/, ""), error: "invalid pending marker" };
      }
    })
    .sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")));
}

async function approveReview(marker: PendingMarker): Promise<DecisionResult> {
  const stages = configuredReleaseStages();
  const status = await checkedGit(["status", "--porcelain"], "git status");
  if (status) throw new Error("approval requires a clean working tree");
  const current = await checkedGit(["branch", "--show-current"], "resolve current branch");
  if (current !== marker.baseBranch) throw new Error(`approval must run on base branch ${marker.baseBranch}, not ${current || "detached HEAD"}`);
  // holdCard already refused a review marker missing these, but the reader
  // cannot see that guard from here.
  if (!marker.branch || !marker.commit || !marker.baseBranch) throw new Error("review marker is missing its branch/commit");

  await checkedGit(["fetch", "origin", marker.branch], "fetch review branch");
  const remoteCommit = await checkedGit(["rev-parse", "FETCH_HEAD"], "resolve review commit");
  if (!safeEqual(remoteCommit, marker.commit)) throw new Error("review branch changed after approval request");
  await checkedGit(["cherry-pick", marker.commit], "apply reviewed commit");
  const mainCommit = await checkedGit(["rev-parse", "HEAD"], "resolve approved commit");
  try {
    await checkedGit(["push", "origin", `HEAD:refs/heads/${marker.baseBranch}`], "push approved commit");
  } catch (error) {
    await runCmd("git", ["cherry-pick", "--abort"]);
    throw error;
  }

  const released = await executeRelease(marker.card, stages);
  if (!released.ok) {
    const productionStarted = requiresProductionRollback(released);
    holdCard(marker.card, `approved commit pushed; ${released.stage} ${released.phase} failed`, {
      kind: productionStarted ? "rollback" : "deploy-retry",
      mainCommit,
      digest: marker.digest,
      nonce: marker.nonce,
    });
    throw new Error(`${released.stage} ${released.phase} failed; approval remains pending`);
  }
  holdCard(marker.card, marker.reason, {
    kind: "rollback",
    mainCommit,
    digest: marker.digest,
    nonce: marker.nonce,
  });
  await removeReviewBranch(marker);
  await setBacklogStatus(marker.card, "done");
  await log("hypercare.enter", {
    card: marker.card,
    actor: "session",
    detail: { startedAt: new Date().toISOString(), releaseChecks: released.checks.map((item) => item.id) },
  });
  return { deployed: true, mainCommit };
}

async function approveRetry(marker: PendingMarker): Promise<DecisionResult> {
  const stages = configuredReleaseStages();
  const released = await executeRelease(marker.card, stages);
  if (!released.ok) {
    if (requiresProductionRollback(released)) {
      holdCard(marker.card, marker.reason, {
        kind: "rollback",
        mainCommit: marker.mainCommit,
        digest: marker.digest,
        nonce: marker.nonce,
      });
    }
    throw new Error(`release retry failed at ${released.stage} ${released.phase}`);
  }
  holdCard(marker.card, marker.reason, {
    kind: "rollback",
    mainCommit: marker.mainCommit,
    digest: marker.digest,
    nonce: marker.nonce,
  });
  await setBacklogStatus(marker.card, "done");
  await log("hypercare.enter", {
    card: marker.card,
    actor: "session",
    detail: { startedAt: new Date().toISOString(), releaseChecks: released.checks.map((item) => item.id) },
  });
  return { deployed: true, mainCommit: marker.mainCommit };
}

export async function approveCard(card: string, { actor = "session", nonce, approvalToken, force }: { actor?: string; nonce?: string; approvalToken?: string; force?: boolean } = {}): Promise<DecisionResult> {
  assertCard(card);
  const release = acquireDecisionLock(card);
  try {
    const marker = readMarker(card);
    if (!marker) return { card, decision: null, error: `no pending decision for "${card}"` };
    authorize(marker, { nonce, approvalToken });
    if (marker.kind === "rollback") {
      return { card, decision: null, error: "change is already deployed; only reject/rollback is available" };
    }

    try { recordLabel({ card, label: "approve", source: actor }); } catch {}
    const result = marker.kind === "review" ? await approveReview(marker) : await approveRetry(marker);
    await log("approve", { card, actor, detail: { card, kind: marker.kind, deployed: true } }).catch(() => {});
    return { card, decision: "approve", ...result };
  } catch (error) {
    const message = (error as Error)?.message || String(error);
    await log("error", { card, actor, detail: `approve failed: ${message}` }).catch(() => {});
    return { card, decision: null, error: message };
  } finally {
    release();
  }
}

async function writeRejectMarker(card: string, reason: string) {
  atomicJson(resolve(REJECT_DIR, `${card}.json`), { card, reason, at: new Date().toISOString() });
  await setBacklogStatus(card, "open");
}

async function rollbackMain(marker: PendingMarker): Promise<{ rolledBack: boolean }> {
  const status = await checkedGit(["status", "--porcelain"], "git status");
  if (status) throw new Error("rollback requires a clean working tree");
  if (!marker.mainCommit) throw new Error(`${marker.kind} marker is missing mainCommit`);
  const ancestor = await runCmd("git", ["merge-base", "--is-ancestor", marker.mainCommit, "HEAD"]);
  if (ancestor.code !== 0) throw new Error(`approved commit ${marker.mainCommit.slice(0, 12)} is not in the current branch`);
  await checkedGit(["revert", marker.mainCommit, "--no-edit"], "revert approved commit");
  await checkedGit(["push"], "push rollback");
  const deployCode = await runDeploy(marker.card, {
    stage: "production",
    environment: process.env.RAILWAY_PRODUCTION_ENVIRONMENT || "production",
  });
  if (deployCode !== 0) throw new Error(`rollback was pushed but redeploy failed with exit ${deployCode}`);
  return { rolledBack: true };
}

export async function rejectCard(card: string, { actor = "session", nonce, approvalToken, force }: { actor?: string; nonce?: string; approvalToken?: string; force?: boolean } = {}): Promise<DecisionResult> {
  assertCard(card);
  const release = acquireDecisionLock(card);
  try {
    const marker = readMarker(card);
    if (!marker) return { card, decision: null, error: `no pending decision for "${card}"` };
    authorize(marker, { nonce, approvalToken });
    try { recordLabel({ card, label: "reject", source: actor }); } catch {}

    let result = { rolledBack: false };
    if (marker.kind === "review") {
      await removeReviewBranch(marker);
    } else {
      result = await rollbackMain(marker);
    }
    await writeRejectMarker(card, marker.reason);
    rmSync(markerPath(card), { force: true });
    await log("reject", { card, actor, detail: { card, kind: marker.kind, ...result } }).catch(() => {});
    return { card, decision: "reject", reopened: true, ...result };
  } catch (error) {
    const message = (error as Error)?.message || String(error);
    await log("error", { card, actor, detail: `reject failed: ${message}` }).catch(() => {});
    return { card, decision: null, error: message };
  } finally {
    release();
  }
}

function cliToken(argv: string[]): string | undefined {
  const index = argv.indexOf("--token");
  return index >= 0 ? argv[index + 1] : process.env.HARNESS_APPROVAL_TOKEN;
}

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
  const argv = process.argv.slice(2);
  const [cmd, card] = argv.filter((arg, index) => !arg.startsWith("--") && argv[index - 1] !== "--token");
  if (cmd === "pending") {
    const rows = pendingCards();
    for (const pending of rows) console.log(`${pending.at || "?"}  ${pending.card}  ${pending.kind || "?"}  ${pending.reason || ""}`);
    if (!rows.length) console.log("(no changes waiting for a decision)");
  } else if ((cmd === "approve" || cmd === "reject") && card) {
    const fn = cmd === "approve" ? approveCard : rejectCard;
    const result = await fn(card, { actor: "cli", approvalToken: cliToken(argv) });
    console.log(result.error || `${cmd}d ${card}`);
    if (result.error) process.exitCode = 1;
  } else {
    console.error("usage: decide.ts pending | approve <card> --token <token> | reject <card> --token <token>");
    process.exitCode = 2;
  }
}
