#!/usr/bin/env node
// invoke-agy.mjs — drive the official `agy` CLI as the researcher.
// Usage: node scripts/invoke-agy.mjs "<question>" [--input <file>]

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { record } from "./loop/knowledge.mjs";

const args = process.argv.slice(2);
let inputFile = null;
const rest = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--input") inputFile = args[++i];
  else rest.push(args[i]);
}

const question = rest.join(" ").trim();
if (!question) {
  console.error('usage: node scripts/invoke-agy.mjs "<question>" [--input <file>]');
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
  console.error("[knowledge] auto-save prompt failed:", err?.message ?? err);
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
  console.warn("[Harness] Warning: could not read persona.md:", err.message);
}

const corpus = inputFile ? await readFile(inputFile, "utf8") : "";
const prompt = [
  "You are the **researcher** agent. Long-context synthesis only.",
  persona ? `\n--- Developer Persona (Act and decide as this person) ---\n${persona}\n` : "",
  "Return:",
  "  1. a 5-bullet executive summary,",
  "  2. a detailed section grouped by question, with citations (file:line or page#).",
  "Do not write or edit application code.",
  "",
  `Question: ${question}`,
  corpus ? `\n--- Corpus (${inputFile}) ---\n${corpus}` : "",
].join("\n");

function launch(command, commandArgs, fallback = null) {
  const child = spawn(command, commandArgs, { stdio: "inherit" });
  child.on("error", (err) => {
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

launch(
  "agy",
  ["--print", prompt, "--dangerously-skip-permissions"],
  () => launch("antigravity", ["-p", prompt, "--dangerously-skip-permissions"]),
);
