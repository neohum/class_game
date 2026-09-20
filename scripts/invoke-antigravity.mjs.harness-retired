#!/usr/bin/env node
// invoke-antigravity.mjs — drive the `antigravity` CLI as the researcher.
// Usage: node scripts/invoke-antigravity.mjs "<question>" [--input <file>]

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
  console.error('usage: node scripts/invoke-antigravity.mjs "<question>" [--input <file>]');
  process.exit(2);
}

// Auto-save prompt to knowledge base
try {
  await record({
    title: `[Antigravity] ${question.slice(0, 60)}${question.length > 60 ? "..." : ""}`,
    body: `Prompt: ${question}${inputFile ? `\nInput File: ${inputFile}` : ""}`,
    tags: "researcher,prompt",
    source: "antigravity-agent",
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

const child = spawn("antigravity", ["-p", prompt], { stdio: "inherit" });
child.on("error", (e) => {
  if (e.code === "ENOENT") {
    console.error("antigravity CLI not found. Install: https://github.com/google-gemini/antigravity-cli");
    process.exit(127);
  }
  throw e;
});
child.on("exit", (code) => process.exit(code ?? 0));
