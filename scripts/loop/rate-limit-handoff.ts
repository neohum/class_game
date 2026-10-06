#!/usr/bin/env node
// rate-limit-handoff.ts — Proactive rate-limit detection, state wrap-up, and auto-transfer across models.
//
// When a model hits or is about to hit usage/rate limits or quota exhaustion:
// 1. Detects rate-limit risk from stdout/stderr/context size.
// 2. Performs an orderly wrap-up of ongoing work (captures git status, diff, completed steps).
// 3. Persists structured handoff artifacts (.harness/handoff.json and memory handoff notes).
// 4. Selects the next available agent/model with remaining quota (excluding cooled-down models).
// 5. Constructs a continuation prompt so the next agent resumes seamlessly without losing progress.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_WINDOWS, inCooldown, parseResetTime, setCooldown } from "./cooldown.ts";

export const RATE_LIMIT_PATTERNS = [
  /usage limit/i,
  /limit reached/i,
  /rate[_ ]?limit/i,
  /exceed(?:ed)? your account/i,
  /too many requests/i,
  /\bquota\b/i,
  /subscription/i,
  /resource(?:s)? exhausted/i,
  /\b429\b/,
  /insufficient_quota/i,
  /tokens per minute/i,
  /requests per minute/i,
  /overloaded_error/i,
  /credit balance is too low/i,
  /daily request limit/i,
  /model is currently overloaded/i,
];

export const MAX_CONTEXT_DIFF = 32_000;
export const MAX_OUTPUT_TAIL = 8_000;

export interface HandoffGitContext {
  branch: string;
  head: string;
  modifiedFiles: string[];
  untrackedFiles: string[];
  diffStat: string;
  diffSnippet: string;
}

export interface HandoffPackage {
  version: "1.0.0";
  timestamp: string;
  originalTask: string;
  fromAgent: string;
  fromModel: string | null;
  toAgent: string | null;
  toModel: string | null;
  reason: string;
  resetTime: number | null;
  git: HandoffGitContext;
  stateSummary: {
    completedSteps: string[];
    pendingSteps: string[];
    recentOutputTail: string;
  };
  continuationPrompt: string;
}

export function isLimitOutput(output: unknown): boolean {
  const text = String(output || "");
  return RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(text));
}

export function detectRateLimitRisk(output: unknown): {
  isRisk: boolean;
  reason: string | null;
  resetTime: number | null;
} {
  const text = String(output || "");
  const matched = RATE_LIMIT_PATTERNS.find((pattern) => pattern.test(text));
  if (!matched) {
    return { isRisk: false, reason: null, resetTime: null };
  }
  const resetTime = parseResetTime(text);
  return {
    isRisk: true,
    reason: `Rate limit matched pattern: ${matched.toString()}`,
    resetTime,
  };
}

export function cooldownKey(agent: string): string {
  return agent === "agy" ? "antigravity" : agent;
}

export function getGitContext(cwd: string): HandoffGitContext {
  const run = (args: string[]) => {
    try {
      const res = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 10_000, windowsHide: true });
      return res.status === 0 ? (res.stdout || "").trim() : "";
    } catch {
      return "";
    }
  };

  const branch = run(["branch", "--show-current"]) || "unknown";
  const head = run(["log", "-1", "--format=%h %s"]) || "unknown";
  const rawStatus = run(["status", "--porcelain"]);
  const diffStat = run(["diff", "--stat"]);
  const diff = run(["diff", "--no-ext-diff", "--"]);

  const modifiedFiles: string[] = [];
  const untrackedFiles: string[] = [];

  if (rawStatus) {
    for (const line of rawStatus.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const status = trimmed.slice(0, 2);
      const filePath = trimmed.slice(3).trim();
      if (status.includes("?")) {
        untrackedFiles.push(filePath);
      } else {
        modifiedFiles.push(filePath);
      }
    }
  }

  return {
    branch,
    head,
    modifiedFiles,
    untrackedFiles,
    diffStat,
    diffSnippet: diff.slice(-MAX_CONTEXT_DIFF),
  };
}

export function extractCompletedAndPending(output: string): {
  completedSteps: string[];
  pendingSteps: string[];
} {
  const completed: string[] = [];
  const pending: string[] = [];
  const lines = output.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^[✓✔]|\[x\]|passed|success|created|updated/i.test(trimmed) && trimmed.length < 160) {
      completed.push(trimmed);
    } else if (/^[-*]\s*\[\s*\]|todo|pending|next:/i.test(trimmed) && trimmed.length < 160) {
      pending.push(trimmed);
    }
  }

  return {
    completedSteps: completed.slice(-10),
    pendingSteps: pending.slice(-10),
  };
}

export function buildContinuationPrompt(pkg: Omit<HandoffPackage, "continuationPrompt">): string {
  const sections: string[] = [
    `# [Harness Auto-Transfer] Task Continuation handed off from ${pkg.fromAgent}${pkg.fromModel ? ` (${pkg.fromModel})` : ""}`,
    `**Handoff Reason**: ${pkg.reason}`,
    `**Timestamp**: ${pkg.timestamp}`,
    `**Target Agent**: ${pkg.toAgent || "Next Available Agent"}`,
    "",
    "## 🎯 Original task:",
    pkg.originalTask,
    "",
    "## 🧭 Working Tree & Git Status",
    `- **Branch**: ${pkg.git.branch}`,
    `- **HEAD**: ${pkg.git.head}`,
    pkg.git.modifiedFiles.length > 0 ? `- **Modified Files**:\n${pkg.git.modifiedFiles.map((f) => `  * ${f}`).join("\n")}` : "- **Modified Files**: None",
    pkg.git.untrackedFiles.length > 0 ? `- **Untracked Files**:\n${pkg.git.untrackedFiles.map((f) => `  * ${f}`).join("\n")}` : "",
    pkg.git.diffStat ? `\n**Diff Stat**:\n\`\`\`\n${pkg.git.diffStat}\n\`\`\`` : "",
  ];

  if (pkg.stateSummary.completedSteps.length > 0) {
    sections.push(
      "",
      "## ✅ Completed Steps (DO NOT REPEAT)",
      pkg.stateSummary.completedSteps.map((s) => `- ${s}`).join("\n"),
    );
  }

  if (pkg.stateSummary.pendingSteps.length > 0) {
    sections.push(
      "",
      "## ⏳ Pending Steps",
      pkg.stateSummary.pendingSteps.map((s) => `- ${s}`).join("\n"),
    );
  }

  if (pkg.stateSummary.recentOutputTail) {
    sections.push(
      "",
      "## ⚠️ Final Output Before Handoff",
      "```",
      pkg.stateSummary.recentOutputTail,
      "```",
    );
  }

  if (pkg.git.diffSnippet) {
    sections.push(
      "",
      "## 📝 In-Flight Working-Tree Diff",
      "```diff",
      pkg.git.diffSnippet,
      "```",
    );
  }

  sections.push(
    "",
    "## 📋 Instructions for Resuming Agent",
    "1. Inspect the current working directory and git diff to verify existing progress.",
    "2. DO NOT re-implement or overwrite work that has already passed or been saved.",
    "3. Pick up directly from the unfinished step and complete the original task under the project health gate.",
  );

  return sections.filter((s) => s !== null && s !== undefined).join("\n");
}

export function createHandoffPackage(opts: {
  cwd: string;
  originalTask: string;
  fromAgent: string;
  fromModel?: string | null;
  toAgent?: string | null;
  toModel?: string | null;
  output?: string;
  reason?: string;
  resetTime?: number | null;
}): HandoffPackage {
  const cwd = opts.cwd || process.cwd();
  const output = opts.output || "";
  const git = getGitContext(cwd);
  const { completedSteps, pendingSteps } = extractCompletedAndPending(output);
  const recentOutputTail = output.slice(-MAX_OUTPUT_TAIL);

  const basePkg: Omit<HandoffPackage, "continuationPrompt"> = {
    version: "1.0.0",
    timestamp: new Date().toISOString(),
    originalTask: opts.originalTask,
    fromAgent: opts.fromAgent,
    fromModel: opts.fromModel || null,
    toAgent: opts.toAgent || null,
    toModel: opts.toModel || null,
    reason: opts.reason || "Provider rate limit or quota exceeded",
    resetTime: opts.resetTime ?? null,
    git,
    stateSummary: {
      completedSteps,
      pendingSteps,
      recentOutputTail,
    },
  };

  const continuationPrompt = buildContinuationPrompt(basePkg);
  return {
    ...basePkg,
    continuationPrompt,
  };
}

export function writeHandoffArtifacts(
  pkg: HandoffPackage,
  cwd = process.cwd(),
): { jsonPath: string; markdownPath?: string } {
  const harnessDir = resolve(process.env.HARNESS_STATE_DIR || join(cwd, ".harness"));
  mkdirSync(harnessDir, { recursive: true });
  const jsonPath = join(harnessDir, "handoff.json");
  writeFileSync(jsonPath, JSON.stringify(pkg, null, 2), "utf8");

  let markdownPath: string | undefined;
  const memoryHandoffDir = join(cwd, "memory", "06-state", "handoffs");
  if (existsSync(join(cwd, "memory"))) {
    try {
      mkdirSync(memoryHandoffDir, { recursive: true });
      const dateStr = new Date().toISOString().slice(0, 10);
      markdownPath = join(memoryHandoffDir, `${dateStr}-rate-limit-handoff.md`);
      writeFileSync(markdownPath, pkg.continuationPrompt, "utf8");
    } catch {
      // Memory update is best-effort
    }
  }

  return { jsonPath, markdownPath };
}

export function readLatestHandoff(cwd = process.cwd()): HandoffPackage | null {
  const harnessDir = resolve(process.env.HARNESS_STATE_DIR || join(cwd, ".harness"));
  const jsonPath = join(harnessDir, "handoff.json");
  if (!existsSync(jsonPath)) return null;
  try {
    return JSON.parse(readFileSync(jsonPath, "utf8")) as HandoffPackage;
  } catch {
    return null;
  }
}

export function selectNextAvailableAgent({
  currentAgent,
  roster,
  isInstalled = () => true,
  isCoolingDown = inCooldown,
}: {
  currentAgent: string;
  roster: string[];
  isInstalled?: (agent: string) => boolean;
  isCoolingDown?: (key: string) => boolean;
}): string | null {
  for (const candidate of roster) {
    if (candidate === currentAgent) continue;
    const key = cooldownKey(candidate);
    if (isInstalled(candidate) && !isCoolingDown(key)) {
      return candidate;
    }
  }
  return null;
}

export function executeRateLimitHandoff({
  cwd = process.cwd(),
  task,
  fromAgent,
  fromModel = null,
  toAgent = null,
  toModel = null,
  output,
  reason,
  resetTime = null,
}: {
  cwd?: string;
  task: string;
  fromAgent: string;
  fromModel?: string | null;
  toAgent?: string | null;
  toModel?: string | null;
  output: string;
  reason?: string;
  resetTime?: number | null;
}): {
  pkg: HandoffPackage;
  artifacts: { jsonPath: string; markdownPath?: string };
} {
  const pkg = createHandoffPackage({
    cwd,
    originalTask: task,
    fromAgent,
    fromModel,
    toAgent,
    toModel,
    output,
    reason: reason || "Rate limit reached during execution",
    resetTime,
  });

  const artifacts = writeHandoffArtifacts(pkg, cwd);
  return { pkg, artifacts };
}

export function runHandoffCli(): void {
  const args = process.argv.slice(2);
  const cwd = process.cwd();

  if (args.includes("--check")) {
    const handoff = readLatestHandoff(cwd);
    if (!handoff) {
      console.log("[RateLimitHandoff] No active handoff found in .harness/handoff.json.");
      process.exit(0);
    }
    console.log(`[RateLimitHandoff] Found handoff from ${handoff.fromAgent} at ${handoff.timestamp}`);
    console.log(`Reason: ${handoff.reason}`);
    console.log(`Branch: ${handoff.git.branch} | Modified files: ${handoff.git.modifiedFiles.length}`);
    process.exit(0);
  }

  if (args.includes("--prompt")) {
    const handoff = readLatestHandoff(cwd);
    if (!handoff) {
      console.error("[RateLimitHandoff] Error: No handoff found.");
      process.exit(1);
    }
    console.log(handoff.continuationPrompt);
    process.exit(0);
  }

  console.log("Usage: node rate-limit-handoff.ts [--check|--prompt]");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runHandoffCli();
}
