#!/usr/bin/env node
// invoke-agy.ts — drive the official `agy` CLI as the researcher.
// Usage: node scripts/invoke-agy.ts "<question>" [--input <file>]

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { record } from "./loop/knowledge.ts";
import { agyCliBin } from "./loop/agy-cli.ts";
import { spawnSandboxed } from "./loop/sandbox.ts";

const args = process.argv.slice(2);
let inputFile = null;
const rest = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--input") inputFile = args[++i];
  else rest.push(args[i]);
}

const question = rest.join(" ").trim();
if (!question) {
  console.error('usage: node scripts/invoke-agy.ts "<question>" [--input <file>]');
  process.exit(2);
}

try {
  await record({
    title: `[AGY] ${question.slice(0, 60)}${question.length > 60 ? "..." : ""}`,
    body: `Prompt: ${question}${inputFile ? `\nInput File: ${inputFile}` : ""}`,
    tags: "researcher,prompt",
    source: "agy-agent",
    card: process.env.LOOP_CARD || null,
  });
} catch (err) {
  console.error("[knowledge] auto-save prompt failed:", (err as Error)?.message ?? err);
}

let persona = "";
try {
  const { existsSync, readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const candidates = [
    resolve(process.cwd(), ".agents", "persona.md"),
    resolve(process.cwd(), ".claude", "persona.md"),
  ];
  const personaPath = candidates.find((candidate) => existsSync(candidate));
  if (personaPath) persona = readFileSync(personaPath, "utf8");
} catch (err) {
  console.warn("[Harness] Warning: could not read persona.md:", (err as Error).message);
}

const corpus = inputFile ? await readFile(inputFile, "utf8") : "";
const isBuilder = Boolean(process.env.LOOP_CARD);
const prompt = [
  isBuilder
    ? "You are the **AGY builder** agent for an autonomous loop card."
    : "You are the **researcher** agent. Long-context synthesis only.",
  persona ? `\n--- Developer Persona (Act and decide as this person) ---\n${persona}\n` : "",
  ...(isBuilder ? [
    "Read AGENTS.md and the relevant .agents skills before changing code.",
    "Implement the card in this checkout using red-green-refactor: add or update tests, run the focused tests, then the surrounding suite.",
    "Keep the diff scoped, preserve existing work, and leave verifiable evidence for the independent reviewer.",
  ] : [
    "Return:",
    "  1. a 5-bullet executive summary,",
    "  2. a detailed section grouped by question, with citations (file:line or page#).",
    "Do not write or edit application code.",
  ]),
  "",
  `Question: ${question}`,
  corpus ? `\n--- Corpus (${inputFile}) ---\n${corpus}` : "",
].join("\n");

function launch(command: string, commandArgs: string[], fallback: (() => void) | null = null): void {
  const bin = command === "agy"
    ? agyCliBin()
    : (process.platform === "win32" ? "antigravity.cmd" : "antigravity");
  if (!bin) {
    if (fallback) return fallback();
    console.error("AGY CLI not found. Install: https://antigravity.google/docs/cli");
    process.exit(127);
  }
  const child = spawnSandboxed(bin, commandArgs, { stdio: "inherit", cwd: process.cwd() });
  child.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT" && fallback) {
      console.warn(`[Harness] ${command} not found; trying legacy antigravity command.`);
      fallback();
      return;
    }
    if (err.code === "ENOENT") {
      console.error("AGY CLI not found. Install: https://antigravity.google/docs/cli");
      process.exit(127);
    }
    throw err;
  });
  child.on("exit", (code) => process.exit(code ?? 0));
}

// Top model by default (AGENTS.md): agy's default is its strongest; AGY_MODEL
// pins a specific one when the CLI supports --model.
const agyModelArgs = process.env.AGY_MODEL ? ["--model", process.env.AGY_MODEL] : [];
launch(
  "agy",
  [...agyModelArgs, "--print", prompt],
  () => launch("antigravity", [...agyModelArgs, "-p", prompt]),
);
