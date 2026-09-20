#!/usr/bin/env node
// invoke-codex.mjs — drive the `codex` CLI as the typist.
// Usage: node scripts/invoke-codex.mjs "<task>"

import { spawn } from "node:child_process";
import { record } from "./loop/knowledge.mjs";

const task = process.argv.slice(2).join(" ").trim();
if (!task) {
  console.error('usage: node scripts/invoke-codex.mjs "<task>"');
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
  console.error("[knowledge] auto-save prompt failed:", err?.message ?? err);
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
  console.warn("[Harness] Warning: could not read persona.md:", err.message);
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

const child = spawn("codex", ["exec", prompt], {
  stdio: "inherit",
  shell: process.platform === "win32",
});
child.on("error", (e) => {
  if (e.code === "ENOENT") {
    console.error("codex CLI not found. Install: https://github.com/openai/codex");
    process.exit(127);
  }
  throw e;
});
child.on("exit", (code) => process.exit(code ?? 0));
