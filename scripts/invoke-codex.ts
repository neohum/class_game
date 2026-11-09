#!/usr/bin/env node
// invoke-codex.ts — drive the `codex` CLI as the typist.
// Usage: node scripts/invoke-codex.ts "<task>"

import { spawn } from "node:child_process";
import { record } from "./loop/knowledge.ts";
import { spawnSandboxed, sandboxSummary } from "./loop/sandbox.ts";

const task = process.argv.slice(2).join(" ").trim();
if (!task) {
  console.error('usage: node scripts/invoke-codex.ts "<task>"');
  process.exit(2);
}

// Auto-save prompt to knowledge base
try {
  await record({
    title: `[Codex] ${task.slice(0, 60)}${task.length > 60 ? "..." : ""}`,
    body: `Prompt: ${task}`,
    tags: "typist,prompt",
    source: "codex-agent",
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
  "You are the **typist** agent. Apply the change with the smallest possible diff.",
  persona ? `\n--- Developer Persona (Act and decide as this person) ---\n${persona}\n` : "",
  "Do not redesign anything; do not invent new abstractions.",
  "If the task implies a design call, stop and say so.",
  "",
  "Task:",
  task,
].join("\n");

const bin = process.platform === "win32" ? "codex.cmd" : "codex";
// When the harness supplies the outer sandbox (docker/inside), codex must not
// wrap the task in its OWN bubblewrap sandbox — nested user namespaces fail
// under our cap-dropped, no-new-privileges container ("bwrap: No permissions
// to create a new namespace") — and it must run without interactive approvals
// (exec is non-interactive, so an approval prompt just rejects the write). This
// is codex's documented switch for "already externally sandboxed" automation.
// In host mode we deliberately DO NOT pass it, so codex keeps its own guard rails.
const execArgs = ["exec"];
if (sandboxSummary().isolated) execArgs.push("--dangerously-bypass-approvals-and-sandbox");
// Tiered model allocation by role: for typist/builder tasks, use medium
// reasoning effort by default (low under fast speed mode) to prevent burning
// excessive reasoning tokens on routine edits or TDD loops. High reasoning is
// reserved for architect/lead or explicit AGENT_REASONING_EFFORT="high".
const speedMode = process.env.HARNESS_SPEED || "balanced";
const defaultEffort = speedMode === "fast" ? "low" : "medium";
const effort = process.env.AGENT_REASONING_EFFORT || defaultEffort;
if (process.env.CODEX_MODEL) execArgs.push("-m", process.env.CODEX_MODEL);
execArgs.push("-c", `model_reasoning_effort="${effort}"`);
execArgs.push(prompt);
const child = spawnSandboxed(bin, execArgs, { stdio: "inherit", cwd: process.cwd() });
child.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "ENOENT") {
    console.error("codex CLI not found. Install: https://github.com/openai/codex");
    process.exit(127);
  }
  throw e;
});
child.on("exit", (code) => process.exit(code ?? 0));
