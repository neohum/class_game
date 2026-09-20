#!/usr/bin/env node
// invoke-claude.ts — drive the `claude` CLI as the architect.
// Usage: node scripts/invoke-claude.ts "<task>"
// For provider-neutral limit failover, use agent-session.ts instead.

import { spawn } from "node:child_process";
import { setCooldown, parseResetTime, DEFAULT_WINDOWS } from "./loop/cooldown.ts";
import { record } from "./loop/knowledge.ts";
import { spawnSandboxed } from "./loop/sandbox.ts";

const task = process.argv.slice(2).join(" ").trim();
if (!task) {
  console.error('usage: node scripts/invoke-claude.ts "<task>"');
  process.exit(2);
}

// Auto-save prompt to knowledge base
try {
  await record({
    title: `[Claude] ${task.slice(0, 60)}${task.length > 60 ? "..." : ""}`,
    body: `Prompt: ${task}`,
    tags: "architect,prompt",
    source: "claude-agent",
    card: process.env.LOOP_CARD || null,
  });
} catch (err) {
  console.error("[knowledge] auto-save prompt failed:", (err as Error)?.message ?? err);
}

let persona = "";
try {
  const { existsSync, readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const personaPath = resolve(process.cwd(), ".claude", "persona.md");
  if (existsSync(personaPath)) {
    persona = readFileSync(personaPath, "utf8");
  }
} catch (err) {
  console.warn("[Harness] Warning: could not read persona.md:", (err as Error).message);
}

const prompt = [
  "You are the **architect** agent for this repo.",
  "Read CLAUDE.md, lat.md, and DESIGN.md first (cite them if you rely on them).",
  persona ? `\n--- Developer Persona (Act and decide as this person) ---\n${persona}\n` : "",
  "Then handle this task with the minimum diff that solves the stated problem:",
  "",
  task,
].join("\n");

const forceFallback = process.env.FORCE_FALLBACK === "1" || process.env.USE_FALLBACK === "1";

// Top model by default (AGENTS.md): every CLI runs its strongest model unless
// the env overrides it. "opus" is the documented claude alias for latest Opus.
const speedMode = process.env.HARNESS_SPEED || "balanced";
const defaultClaude = speedMode === "fast" ? "sonnet" : "opus";
const defaultEffort = speedMode === "fast" ? "medium" : "high";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || defaultClaude;
const GEMINI_MODEL = process.env.GEMINI_MODEL || null; // gemini's own default is already its flagship
const CODEX_EFFORT = process.env.AGENT_REASONING_EFFORT || defaultEffort;
const codexModelArgs = [
  ...(process.env.CODEX_MODEL ? ["-m", process.env.CODEX_MODEL] : []),
  "-c", `model_reasoning_effort="${CODEX_EFFORT}"`,
];

function runFallback() {
  console.warn("\n[Harness] Launching Gemini fallback...");
  const geminiBin = process.platform === "win32" ? "gemini.cmd" : "gemini";
  const geminiArgs = [...(GEMINI_MODEL ? ["-m", GEMINI_MODEL] : []), "-p", prompt];
  const geminiChild = spawnSandboxed(geminiBin, geminiArgs, { stdio: "inherit", cwd: process.cwd() });
  geminiChild.on("error", (ge: NodeJS.ErrnoException) => {
    if (ge.code === "ENOENT") {
      console.warn("\n[Harness] gemini CLI not found. Trying Codex fallback...");
      runCodexFallback();
    } else {
      console.error(`\n[Harness] Gemini failed to launch: ${ge.message}`);
      process.exit(1);
    }
  });
  geminiChild.on("exit", (gCode) => {
    if (gCode !== 0) {
      console.warn(`\n[Harness] Gemini exited with code ${gCode}. Trying Codex fallback...`);
      runCodexFallback();
    } else {
      process.exit(0);
    }
  });
}

function runCodexFallback() {
  console.warn("\n[Harness] Launching Codex fallback...");
  const codexBin = process.platform === "win32" ? "codex.cmd" : "codex";
  const codexChild = spawnSandboxed(codexBin, ["exec", ...codexModelArgs, prompt], { stdio: "inherit", cwd: process.cwd() });
  codexChild.on("error", (ce: NodeJS.ErrnoException) => {
    if (ce.code === "ENOENT") {
      console.error("\n[Harness] codex CLI not found. All fallbacks exhausted.");
      process.exit(127);
    } else {
      console.error(`\n[Harness] Codex failed to launch: ${ce.message}`);
      process.exit(1);
    }
  });
  codexChild.on("exit", (cCode) => {
    process.exit(cCode ?? 0);
  });
}

if (forceFallback) {
  console.warn("\n[Harness] Force fallback enabled. Skipping Claude CLI.");
  runFallback();
} else {
  let output = "";
  const claudeBin = process.platform === "win32" ? "claude.exe" : "claude";
  const child = spawnSandboxed(claudeBin, ["-p", "--model", CLAUDE_MODEL, prompt], {
    cwd: process.cwd(),
    stdio: ["inherit", "pipe", "pipe"]
  });

  child.stdout?.on("data", (data) => {
    process.stdout.write(data);
    output += data.toString();
  });

  child.stderr?.on("data", (data) => {
    process.stderr.write(data);
    output += data.toString();
  });

  let fallbackLaunched = false;

  child.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") {
      console.warn("\n[Harness] claude CLI not found. Falling back to Gemini/Codex...");
      fallbackLaunched = true;
      runFallback();
    } else {
      throw e;
    }
  });

  child.on("exit", (code) => {
    if (fallbackLaunched) return;
    if (code !== 0) {
      // Verified Claude CLI limit phrasings: "Claude usage limit reached",
      // "5-hour limit reached", "Opus weekly limit reached", the headless
      // "usage limit reached|<epoch>" form, and wrapped 429 rate_limit_error.
      const isLimit = /usage limit reached|limit reached|rate[_ ]?limit|exceed your account|too many requests|quota|subscription|\b429\b/i.test(output);
      if (isLimit) {
        // Record WHEN Claude is allowed again so the loop can bring it back to
        // its primary role automatically. Prefer a reset time parsed from the
        // CLI's own message; fall back to the documented rolling window.
        const until = parseResetTime(output) ?? (Date.now() + DEFAULT_WINDOWS.claude);
        const entry = setCooldown("claude", until, { reason: `exit ${code}: limit detected` });
        console.warn(`\n[Harness] Claude limit detected (exited ${code}). Cooldown until ${new Date(entry.until).toISOString()}. Falling back to Gemini/Codex...`);
        fallbackLaunched = true;
        runFallback();
      } else {
        process.exit(code ?? 1);
      }
    } else {
      process.exit(0);
    }
  });
}
