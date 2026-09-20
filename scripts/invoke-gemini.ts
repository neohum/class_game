#!/usr/bin/env node
// invoke-gemini.ts — drive the `gemini` CLI as the researcher.
// Usage: node scripts/invoke-gemini.ts "<question>" [--input <file>]
//
// Long corpora go on stdin: pipe a file in, or pass --input <file> and it will
// be streamed as context. Gemini's large context window is the point — read a
// lot, return a tight, cited summary.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { record } from "./loop/knowledge.ts";
import { spawnSandboxed } from "./loop/sandbox.ts";

const argv = process.argv.slice(2);
let inputFile = null;
const rest = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--input") inputFile = argv[++i];
  else rest.push(argv[i]);
}
const task = rest.join(" ").trim();
if (!task) {
  console.error('usage: node scripts/invoke-gemini.ts "<question>" [--input <file>]');
  process.exit(2);
}

// Auto-save prompt to knowledge base
try {
  await record({
    title: `[Gemini] ${task.slice(0, 60)}${task.length > 60 ? "..." : ""}`,
    body: `Prompt: ${task}${inputFile ? `\nInput File: ${inputFile}` : ""}`,
    tags: "researcher,prompt",
    source: "gemini-agent",
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
  "You are the **researcher** agent. Read a lot, return a little.",
  persona ? `\n--- Developer Persona (Act and decide as this person) ---\n${persona}\n` : "",
  "Output an executive 5-bullet summary first, then detail organized by question,",
  "with file/page citations. Mark quotes as quotes. Do NOT edit code — surface options.",
  "",
  "Question:",
  task,
].join("\n");

// If --input was given, prepend its contents as the corpus on stdin.
let stdinPayload = null;
if (inputFile) {
  try {
    stdinPayload = `=== CORPUS: ${inputFile} ===\n` + readFileSync(inputFile, "utf8");
  } catch (e) {
    console.error(`could not read --input ${inputFile}: ${(e as Error).message}`);
    process.exit(2);
  }
}

// Top model by default (AGENTS.md): gemini's default is already its flagship;
// GEMINI_MODEL pins a specific one (e.g. the largest-context tier for corpus work).
const geminiArgs = [...(process.env.GEMINI_MODEL ? ["-m", process.env.GEMINI_MODEL] : []), "-p", prompt];
const child = spawnSandboxed("gemini", geminiArgs, {
  cwd: process.cwd(),
  stdio: [stdinPayload ? "pipe" : "inherit", "inherit", "inherit"],
});
child.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "ENOENT") {
    console.error("gemini CLI not found. Install: https://github.com/google-gemini/gemini-cli");
    process.exit(127);
  }
  throw e;
});
if (stdinPayload) {
  child.stdin?.write(stdinPayload);
  child.stdin?.end();
}
child.on("exit", (code) => process.exit(code ?? 0));
