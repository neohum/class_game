// ralph-loop.mjs — the autonomous development loop driver.
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
//                      spec on argv. default: node scripts/invoke-codex.mjs
//   LOOP_DRY=1         skip git push + deploy notify (local dry run)
//
// Exit: runs forever unless LOOP_ONCE=1. SIGINT/SIGTERM finish the current
// iteration's cleanup (lock release) before exiting.

import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { getBacklog } from "./backlog.mjs";
import { log } from "./telemetry.mjs";
import { claimTask } from "./claim-task.mjs";
import { runAssessment } from "./assess-shortcomings.mjs";
import { runDesignAssessment } from "./assess-design.mjs";
import { gatherValidationContext } from "./validate-card.mjs";
import { personaApprove } from "./persona-approve.mjs";
import {
  startContract, appendLedger, writeCapsule, loadCapsule, capsuleMarkdown,
  changedFiles, loadContract, riskScore, riskLine,
} from "./framein.mjs";
import { bootstrap as bootstrapPersona } from "./persona-bootstrap.mjs";
import { synthesize as synthesizePersona } from "./persona-synthesize.mjs";
import { fit as fitCalibration, saveParams as saveCalibration, ece as calibrationEce } from "./persona-calibrate.mjs";
import { labeledRows } from "./persona-feedback.mjs";
import {
  setCooldown, inCooldown, remaining, activeCooldowns,
  parseResetTime, DEFAULT_WINDOWS,
} from "./cooldown.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));   // where the loop scripts live
// ROOT is the repo the loop operates on. The loop is always launched from the
// target repo root, and the sibling helpers (backlog/telemetry/claim) resolve
// their state from process.cwd() — so ROOT must agree with cwd, NOT with the
// script's install location. (These differ once create-agent-harness copies the
// scripts into a project and the loop runs there.)
const ROOT = resolve(process.cwd());
const LOCK_DIR = resolve(ROOT, "current_tasks");
const REJECT_DIR = resolve(ROOT, ".harness", "reject");

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
  builder: process.env.LOOP_BUILDER || `node ${resolve(HERE, "..", "invoke-codex.mjs")}`,
};

let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => { stopping = true; console.log(`\n${sig} — finishing current iteration then exiting`); });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
function run(bin, args = [], { timeout = CFG.cmdTimeout, capture = false, tee = false } = {}) {
  return new Promise((res) => {
    const piped = capture || tee;
    const child = spawn(bin, args, {
      cwd: ROOT,
      stdio: piped ? ["inherit", "pipe", "pipe"] : "inherit",
      shell: process.platform === "win32",
    });
    let stdout = "";
    if (piped) {
      child.stdout?.on("data", (d) => { stdout += d.toString(); if (tee) process.stdout.write(d); });
      child.stderr?.on("data", (d) => { stdout += d.toString(); if (tee) process.stderr.write(d); });
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
async function recordLimitIfAny(agent, output, card) {
  // Matches the verified Claude CLI limit phrasings plus the generic signals
  // other agent CLIs emit (codex/gemini/antigravity). See cooldown.mjs for the
  // reset-time formats parsed out of these same messages.
  if (!/usage limit reached|limit reached|rate[_ ]?limit|exceed your account|too many requests|quota|subscription|\b429\b/i.test(output || "")) return false;
  const until = parseResetTime(output) ?? (Date.now() + (DEFAULT_WINDOWS[agent] ?? DEFAULT_WINDOWS.claude));
  setCooldown(agent, until, { reason: "limit detected in loop" });
  await log("error", { card, actor: agent, detail: `rate limit — cooldown until ${new Date(until).toISOString()}` });
  return true;
}

// Infer the cooldown key for a builder command string (which CLI it drives).
function agentKeyFor(cmdline) {
  const s = cmdline.toLowerCase();
  if (s.includes("invoke-claude") || /\bclaude\b/.test(s)) return "claude";
  if (s.includes("invoke-codex") || /\bcodex\b/.test(s)) return "codex";
  if (s.includes("invoke-antigravity") || /\bantigravity\b/.test(s)) return "antigravity";
  if (s.includes("invoke-gemini") || /\bgemini\b/.test(s)) return "gemini";
  return "builder";
}

// Builder roster in priority order. The loop drives the first one NOT in
// cooldown. Each entry is a full command line (same format as LOOP_BUILDER).
// Override the whole roster with LOOP_BUILDERS (comma-separated commands).
function builderRoster() {
  if (process.env.LOOP_BUILDERS) {
    return process.env.LOOP_BUILDERS.split(",").map((c) => c.trim()).filter(Boolean);
  }
  const node = process.execPath;
  return [
    CFG.builder,                                                  // default: codex (typist)
    `${node} ${resolve(HERE, "..", "invoke-claude.mjs")}`,        // claude (architect)
    `${node} ${resolve(HERE, "..", "invoke-antigravity.mjs")}`,   // antigravity
    `${node} ${resolve(HERE, "..", "invoke-gemini.mjs")}`,        // gemini
  ];
}

// Pick the first roster command whose agent is available (not in cooldown).
// Returns { cmd, agent } or null if every agent is cooling down.
function pickAvailableBuilder() {
  for (const cmd of builderRoster()) {
    const agent = agentKeyFor(cmd);
    if (!inCooldown(agent)) return { cmd, agent };
  }
  return null;
}

// Framein challenge: pick the first available roster agent whose provider DIFFERS
// from the builder's, so the challenge is genuinely cross-model. Returns
// { cmd, agent } or null when no distinct, non-cooling agent exists.
function pickChallenger(builderAgent) {
  for (const cmd of builderRoster()) {
    const agent = agentKeyFor(cmd);
    if (agent !== builderAgent && !inCooldown(agent)) return { cmd, agent };
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
async function wipSave(card) {
  await run("git", ["add", "-A"], { timeout: 60_000 });
  // commit is a no-op (non-zero) when there's nothing staged — that's fine.
  await run("git", ["commit", "-m", `wip:${card}`], { timeout: 60_000 });
  await log("commit", { card, actor: "ralph", detail: "WIP saved before cooldown yield" });
}

// A builder/reviewer command comes from env as a string (e.g. "node x.mjs") and
// may legitimately need word-splitting. This is the ONLY place we split — and
// only the configured prefix, never an interpolated path argument.
function splitCmd(cmdline) {
  const parts = cmdline.split(" ").filter(Boolean);
  return { bin: parts[0], args: parts.slice(1) };
}

// health.sh on POSIX, health.ps1 on Windows. Returns { ok, logs }.
async function health() {
  const res = process.platform === "win32"
    ? await run("powershell", ["-ExecutionPolicy", "Bypass", "-File", resolve(HERE, "health.ps1")], { tee: true })
    : await run("bash", [resolve(HERE, "health.sh")], { tee: true });
  return { ok: res.code === 0, logs: res.stdout };
}

function pendingReject(card) {
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

function releaseLock(card) {
  rmSync(resolve(LOCK_DIR, `${card}.lock`), { force: true });
}

// Drive one task end-to-end. Returns "done" | "failed" | "cooldown".
// "cooldown" means every builder agent is rate-limited: the task is WIP-saved
// and requeued so it resumes automatically once an agent resets.
async function runTask(backlog, task) {
  const { card, spec } = task;
  process.env.LOOP_CARD = card;
  await log("iterate", { card, actor: "ralph", detail: "task start" });

  // Framein: freeze the work contract (baseline sha + intent) so every model that
  // touches this card measures its diff from the same point and can't silently
  // renegotiate the task. Idempotent — a requeued card keeps its original baseline.
  try { startContract({ card, spec }); } catch (e) { console.error("framein: startContract failed (continuing):", e?.message ?? e); }

  // A human rejection re-injects the prior context as a prefix to the spec. This
  // `taskText` is the immutable base — capsules are prepended onto a copy of it so
  // repeated handoffs never stack capsule-on-capsule into an ever-growing prompt.
  const reject = pendingReject(card);
  const taskText = reject
    ? `[REVISION REQUESTED] previous attempt rejected at ${reject.at || "?"}. Fix and retry.\n\nTask: ${spec}`
    : spec;
  let builderInput = taskText;

  // Framein: if a prior round handed this card off (cooldown yield or a model
  // swap), a capsule is on disk. Prepend it so the resuming agent picks up with
  // the full contract + diff surface instead of a bare spec. Best-effort.
  let lastAgent = null;
  try {
    const cap = loadCapsule(card);
    if (cap) {
      builderInput = `${capsuleMarkdown(cap)}\n\n${taskText}`;
      await log("iterate", { card, actor: "ralph", detail: `framein: resumed from capsule (${cap.from} → ${cap.to}, ${riskLine(cap.risk)})` });
    }
  } catch (e) {
    console.error("framein: capsule resume failed (continuing):", e?.message ?? e);
  }

  // Reuse instead of relearn: when HUB_RECALL is set, pull prior cross-project
  // knowledge for this card and prepend it so the builder reuses known solutions
  // and sidesteps known traps. Best-effort — never blocks or fails the build.
  if (process.env.HUB_RECALL) {
    try {
      const ctx = await gatherValidationContext(spec);
      if (ctx.hits.length) {
        const lines = ctx.hits.slice(0, 8).map((e) => `- [${e.project || e.source || "?"}] ${e.title}`).join("\n");
        builderInput = `[PRIOR KNOWLEDGE — reuse, don't relearn; from the central hub across projects]\n${lines}\n\nTask: ${builderInput}`;
        await log("iterate", { card, actor: "ralph", detail: `recalled ${ctx.hits.length} prior entr(ies) via ${ctx.source}` });
      }
    } catch (err) {
      console.error("ralph-loop: recall failed (continuing):", err?.message ?? err);
    }
  }

  let green = false;
  let feedback = "";
  for (let i = 1; i <= CFG.maxIters && !stopping; i++) {
    // Pick a builder that isn't cooling down. If all are limited, save progress
    // and yield — main() will sleep until the soonest reset, then retry.
    const choice = pickAvailableBuilder();
    if (!choice) {
      await wipSave(card);
      // Framein: capsule the WIP so whichever agent resumes after a reset (maybe a
      // different model) inherits the contract + diff instead of a bare spec.
      try { writeCapsule({ card, from: lastAgent || "?", to: "next", health: feedback ? "fail (see feedback)" : null }); } catch {}
      await log("iterate", { card, actor: "ralph", detail: "all agents in cooldown — yielding task (capsuled)" });
      return "cooldown";
    }
    const builder = splitCmd(choice.cmd);

    // Framein: a mid-task model swap (the cooldown roster moved to a different
    // CLI) is a handoff — capsule the state so the new lead inherits the frozen
    // contract + diff surface + ledger instead of resuming from a bare spec.
    if (lastAgent && lastAgent !== choice.agent) {
      try {
        const cap = writeCapsule({ card, from: lastAgent, to: choice.agent, health: feedback ? "fail (see feedback)" : null });
        builderInput = `${capsuleMarkdown(cap)}\n\n${taskText}`;
        await log("iterate", { card, actor: "ralph", detail: `framein: handoff ${lastAgent} → ${choice.agent} (${riskLine(cap.risk)})` });
      } catch (e) {
        console.error("framein: handoff capsule failed (continuing):", e?.message ?? e);
      }
    }
    lastAgent = choice.agent;
    try { appendLedger(card, { agent: choice.agent, event: `iterate.${i}` }); } catch {}

    await log("iterate", { card, actor: choice.agent, detail: `iteration ${i}/${CFG.maxIters}` });

    const currentInput = feedback
      ? `${builderInput}\n\n[FEEDBACK] The previous implementation attempt FAILED. Fix the following compilation/linter/test errors:\n${feedback}`
      : builderInput;

    const { code, timedOut, stdout } = await run(builder.bin, [...builder.args, currentInput], { tee: true });
    if (timedOut) {
      await log("error", { card, actor: choice.agent, detail: `iteration ${i} timed out after ${CFG.cmdTimeout}ms` });
      continue; // a single timeout doesn't end the session — try again up to the cap
    }
    if (code !== 0) {
      // A non-zero exit might be a rate limit. If so, save WIP and let the next
      // iteration pick a different (available) agent; otherwise just retry.
      const limited = await recordLimitIfAny(choice.agent, stdout, card);
      if (limited) { await wipSave(card); i--; continue; } // don't burn an iteration on a limit
      await log("error", { card, actor: choice.agent, detail: `iteration ${i} exited ${code}` });
      feedback = stdout || `Builder exited with code ${code}`;
      continue;
    }
    // Builder claims success — verify with the health gate before believing it.
    const check = await health();
    if (check.ok) {
      await log("health", { card, actor: "ralph", detail: `passed on iteration ${i}` });
      green = true;
      break;
    }
    await log("health", { card, actor: "ralph", detail: `failed on iteration ${i}` });
    feedback = check.logs;
  }

  if (!green) {
    await log("error", { card, actor: "ralph", detail: `gave up after ${CFG.maxIters} iterations` });
    return "failed";
  }

  // --- Strict Full Health Check before Review ---
  // Iterations may run fast checks (skipping slow builds/tests), but before review
  // we must enforce a complete validation.
  await log("health", { card, actor: "ralph", detail: "running strict full health check before review" });

  const origGoTest = process.env.HEALTH_GO_TEST;
  const origWebBuild = process.env.HEALTH_WEB_BUILD;
  const origWailsFe = process.env.HEALTH_WAILS_FE;
  const origWebLint = process.env.HEALTH_WEB_LINT;

  process.env.HEALTH_GO_TEST = "false";
  process.env.HEALTH_WEB_BUILD = "false";
  process.env.HEALTH_WAILS_FE = "false";
  process.env.HEALTH_WEB_LINT = "false";

  const strictCheck = await health();

  if (origGoTest !== undefined) process.env.HEALTH_GO_TEST = origGoTest; else delete process.env.HEALTH_GO_TEST;
  if (origWebBuild !== undefined) process.env.HEALTH_WEB_BUILD = origWebBuild; else delete process.env.HEALTH_WEB_BUILD;
  if (origWailsFe !== undefined) process.env.HEALTH_WAILS_FE = origWailsFe; else delete process.env.HEALTH_WAILS_FE;
  if (origWebLint !== undefined) process.env.HEALTH_WEB_LINT = origWebLint; else delete process.env.HEALTH_WEB_LINT;

  if (!strictCheck.ok) {
    await log("error", { card, actor: "ralph", detail: "strict full health check failed before review" });
    return "failed";
  }
  // ----------------------------------------------

  // Framein challenge (opt-in FRAMEIN_CHALLENGE=1): before the reviewer signs off,
  // have a DIFFERENT provider than the builder adversarially challenge the diff
  // against the frozen contract and produce a short decision brief. Independent of
  // the reviewer (which is the actual gate) — this is the "second pair of eyes from
  // another model" that catches single-model blind spots. Advisory: its brief is
  // prepended to the reviewer's prompt; it never blocks on its own.
  let challengeBrief = "";
  if (process.env.FRAMEIN_CHALLENGE === "1") {
    const challenger = pickChallenger(lastAgent);
    if (challenger) {
      const contract = (() => { try { return loadContract(card); } catch { return null; } })();
      const cb = splitCmd(challenger.cmd);
      const { code: cc, stdout: cout } = await run(cb.bin, [
        ...cb.args,
        `[FRAMEIN CHALLENGE] You are an INDEPENDENT reviewer from a different model than the builder. ` +
        `Adversarially challenge the staged changes for task "${card}" against this frozen contract: ${contract?.spec || spec}. ` +
        `Look for: contract drift (built something other than agreed), missed edge cases, risky blast radius, and data-contract violations. ` +
        `Reply with a 3-line DECISION BRIEF: (1) verdict PASS/CONCERN/BLOCK, (2) the single biggest risk, (3) one concrete fix if any.`,
      ], { tee: true });
      if (cc === 0) {
        challengeBrief = (cout || "").trim().slice(-1200);
        await appendLedger(card, { agent: challenger.agent, event: "challenge", detail: challengeBrief.split("\n")[0]?.slice(0, 140) });
        await log("iterate", { card, actor: challenger.agent, detail: "framein: cross-model challenge produced a decision brief" });
      } else {
        await recordLimitIfAny(challenger.agent, cout, card);
        await log("error", { card, actor: challenger.agent, detail: `framein: challenge exited ${cc} (advisory — continuing)` });
      }
    } else {
      await log("iterate", { card, actor: "ralph", detail: "framein: no distinct challenger available (skipping challenge)" });
    }
  }

  // Reviewer sign-off. The reviewer agent re-checks the diff against intent +
  // conventions + data contract; here we drive its CLI and trust its exit code.
  // The default reviewer is Claude; if it's limited, fall back to any available
  // agent so review isn't blocked by a single provider's cooldown.
  backlog.setStatus(card, "review");
  const reviewCmd = process.env.LOOP_REVIEWER || `${process.execPath} ${resolve(HERE, "..", "invoke-claude.mjs")}`;
  let reviewerCmd = reviewCmd;
  if (inCooldown(agentKeyFor(reviewCmd))) {
    const alt = pickAvailableBuilder();
    if (!alt) { await wipSave(card); return "cooldown"; }
    reviewerCmd = alt.cmd;
    await log("iterate", { card, actor: alt.agent, detail: "reviewer fallback (primary in cooldown)" });
  }
  const reviewerAgent = agentKeyFor(reviewerCmd);
  const reviewer = splitCmd(reviewerCmd);
  const reviewPrompt = challengeBrief
    ? `Review the staged changes for task "${card}" against AGENTS.md and CLAUDE.md. An independent cross-model challenge raised this DECISION BRIEF — weigh it:\n${challengeBrief}\n\nIf the changes meet intent and the data contract (and the brief reveals no blocker), say APPROVED; else list fixes.`
    : `Review the staged changes for task "${card}" against AGENTS.md and CLAUDE.md. If they meet intent and the data contract, say APPROVED; else list fixes.`;
  const { code: rc, stdout: rout } = await run(reviewer.bin, [
    ...reviewer.args,
    reviewPrompt,
  ], { tee: true });
  if (rc !== 0) {
    if (await recordLimitIfAny(reviewerAgent, rout, card)) { await wipSave(card); return "cooldown"; }
    await log("error", { card, actor: reviewerAgent, detail: `reviewer exited ${rc}` });
    return "failed";
  }

  let shipped = false;
  if (!CFG.dry) {
    await commitAndPush(card);

    // Persona approval gate — the owner's persona decides, in their place, whether
    // this reviewed change ships without waking them. Conservative by design:
    // only a confident, low/medium-blast, non-sensitive change auto-deploys;
    // everything else is held for a human tap on Telegram (see persona-approve.mjs).
    // Framein: score the diff by the paths it touched and feed it to the deploy
    // gate. A "high" score (auth/, secrets, migrations, billing, the data contract)
    // forces the persona to hold for a human tap regardless of model confidence.
    // Opt out with FRAMEIN_RISK=off.
    let risk = null;
    if (process.env.FRAMEIN_RISK !== "off") {
      try {
        const contract = loadContract(card);
        risk = riskScore(changedFiles(contract?.baseline ?? null), spec);
        await log("approve", { card, actor: "framein", detail: riskLine(risk) });
      } catch (e) {
        console.error("framein: risk score failed (continuing):", e?.message ?? e);
      }
    }

    const verdict = await personaApprove({ card, spec, risk });
    if (risk) verdict.reason = `${verdict.reason} · ${riskLine(risk)}`;
    await log("approve", { card, actor: "persona", detail: verdict });

    if (verdict.decision === "approve") {
      // Auto-deploy on the persona's authority.
      try {
        const { deploy } = await import("./deploy-railway.mjs");
        await log("deploy", { card, actor: "persona", detail: `auto-deploy approved: ${verdict.reason}` });
        const deployCode = await deploy({ card });
        if (deployCode === 0) {
          shipped = true;
          await log("deploy", { card, actor: "ralph", detail: "auto-deploy succeeded" });
        } else {
          await log("error", { card, actor: "ralph", detail: `auto-deploy failed with code ${deployCode}` });
        }
      } catch (e) {
        await log("error", { card, actor: "ralph", detail: `auto-deploy failed: ${e.message}` });
      }
      await notifyMobile(card, "deployed", verdict.reason);
    } else {
      // Held: the persona escalated (or rejected). The work is committed + pushed
      // so nothing is lost, but the deploy waits for the human's tap. The Telegram
      // approval card carries an ✅ button -> telegram-listener spawns the deploy.
      await log("iterate", { card, actor: "persona", detail: `deploy withheld (${verdict.decision}): ${verdict.reason}` });
      await notifyMobile(card, "approval", verdict.reason);
    }
  }
  await log("commit", {
    card, actor: "reviewer",
    detail: CFG.dry ? "dry-run (no push)" : shipped ? "committed + pushed & deployed" : "committed + pushed; deploy held for owner approval",
  });
  return "done";
}

async function commitAndPush(card) {
  await run("git", ["add", "-A"], { timeout: 60_000 });
  await run("git", ["commit", "-m", `loop:${card}`], { timeout: 60_000 });
  await run("git", ["push"], { timeout: 120_000 });
}

// Minimal one-shot Telegram notifier for loop-level escalations (e.g. a card
// parked as terminally 'failed'). Swallows every error so a notification failure
// never breaks the loop, and no-ops without TELEGRAM_BOT_TOKEN/CHAT_ID.
async function sendTelegram(text) {
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
      const data = await res.json().catch(() => ({}));
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
async function notifyMobile(card, mode = "deployed", reason = "") {
  const shot = resolve(ROOT, ".harness", "shots", `${card}.png`);
  mkdirSync(dirname(shot), { recursive: true });
  const cap = await run(process.execPath, [
    resolve(HERE, "capture-screenshot.mjs"),
    process.env.SCREENSHOT_URL || "http://localhost:3000",
    shot,
  ]);
  let url = "";
  if (cap.code === 0) {
    // Call upload() in-process: it returns the URL directly (no stdout scraping)
    // and keeps its own optional-dependency guard, so a missing AWS SDK still
    // degrades gracefully here.
    try {
      const { upload } = await import("./upload-wasabi.mjs");
      url = await upload(shot, { key: `prod-preview/${card}.png` });
    } catch (e) {
      await log("error", { card, actor: "wasabi", detail: `upload skipped: ${e.message}` });
    }
  }
  await run(process.execPath, [
    resolve(HERE, "notify-telegram.mjs"),
    card, "success", "health gate passed", url, mode, reason,
  ]);
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
    await log("error", { actor: "persona", detail: `calibration refit failed: ${e.message}` });
  }
  try {
    const r = await synthesizePersona({ minDisagreements: Number(process.env.PERSONA_SYNTH_MIN) || 3 });
    if (r.updated) await log("iterate", { actor: "persona", detail: `persona.md updated from ${r.falseApprove}+${r.overCautious} disagreements` });
  } catch (e) {
    await log("error", { actor: "persona", detail: `synthesis failed: ${e.message}` });
  }
}

async function main() {
  mkdirSync(LOCK_DIR, { recursive: true });
  const backlog = await getBacklog();

  // One-time behavioral cloning: seed the persona's label set from git history so
  // it starts with a prior instead of cold. Idempotent — re-runs add only new
  // commits. Skip with PERSONA_BOOTSTRAP=off.
  if (process.env.PERSONA_BOOTSTRAP !== "off") {
    try {
      const b = bootstrapPersona({ limit: Number(process.env.PERSONA_BOOTSTRAP_LIMIT) || 500 });
      if (b.added) console.log(`ralph-loop: persona bootstrap added ${b.added} history labels (approve=${b.approve}, reject=${b.reject})`);
    } catch (e) {
      console.warn(`ralph-loop: persona bootstrap skipped: ${e.message}`);
    }
  }
  console.log(`ralph-loop: backend=${backlog.kind} maxIters=${CFG.maxIters} cmdTimeout=${CFG.cmdTimeout}ms once=${CFG.once} dry=${CFG.dry}`);
  const startupCooldowns = Object.entries(activeCooldowns())
    .map(([a, e]) => `${a}@${new Date(e.until).toISOString()}`).join(", ");
  if (startupCooldowns) console.log(`ralph-loop: agents in cooldown at startup: ${startupCooldowns}`);

  let idle = false; // true while the backlog has been empty — gate the idle log
  do {
    if (stopping) break;
    // 1. sync
    if (!CFG.dry) await run("git", ["pull", "--ff-only"], { timeout: 120_000 });

    // 2. find an open task
    let open = backlog.list("open");
    if (open.length === 0) {
      if (CFG.once) { console.log("backlog empty — nothing to do"); break; }

      // Autonomous shortcomings assessment
      if (!process.env.SKIP_ASSESSMENT) {
        console.log("ralph-loop: backlog is empty. Running autonomous shortcomings self-assessment...");
        try {
          await runAssessment(backlog);
          open = backlog.list("open");
          if (open.length > 0) {
            console.log(`ralph-loop: self-assessment added ${open.length} new tasks. Continuing loop.`);
            continue;
          }
        } catch (err) {
          console.error("ralph-loop: self-assessment failed:", err.message);
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
        console.error("ralph-loop: design-evolution assessment failed:", err.message);
      }

      // Log only on the transition into idle, not every 30s tick — otherwise an
      // idle server appends ~2,880 no-op rows/day to current.md forever. The same
      // transition is the right moment to learn the persona from the day's taps.
      if (!idle) {
        await learnPersona();
        await log("iterate", { actor: "ralph", detail: "backlog empty — idle" });
        idle = true;
      }
      await sleep(CFG.interval);
      continue;
    }
    idle = false;

    const task = open[0];
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
      outcome = await runTask(backlog, backlog.get(task.card));
    } catch (e) {
      await log("error", { card: task.card, actor: "ralph", detail: String(e?.stack || e) });
    } finally {
      if (outcome === "done") {
        backlog.setStatus(task.card, "done");
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
        if (attempts >= CFG.maxAttempts) {
          backlog.setStatus(task.card, "failed");
          await log("error", { card: task.card, actor: "ralph", detail: `gave up after ${attempts} attempts → 'failed' (terminal, no more requeue)` });
          await sendTelegram(`🛑 auto-fix abandoned: ${task.card}\nHealth gate still failing after ${attempts} attempts → parked as 'failed' (stopping infinite retries). A human needs to look.`);
        } else {
          backlog.setStatus(task.card, "open"); // requeue for another attempt
        }
      }
      releaseLock(task.card);
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

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
}
