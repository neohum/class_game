// assess-shortcomings.mjs — audits the codebase for improvements and adds them to the backlog.
//
// When the backlog runs dry or a task completes, the loop can run this assessment
// step. It invokes the Claude/Gemini CLI, instructs it to inspect the workspace,
// test results, and persona.md, and output a JSON array of shortcomings.
// We then parse this array and add the cards directly to the backlog.

import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { getBacklog } from "./backlog.mjs";
import { log } from "./telemetry.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(process.cwd());

/**
 * Runs the shortcomings self-assessment and adds generated tasks to the backlog.
 * @param {object} backlog backlog backend
 */
export async function runAssessment(backlog) {
  try {
    await log("iterate", { actor: "ralph", detail: "starting autonomous shortcomings assessment" });
  } catch {}
  console.log("[Assess] Spawning agent to inspect workspace for shortcomings...");

  const assessmentPrompt = [
    "You are a Senior QA/Developer Auditor assessing this workspace, working as a STRUCTURED DEVIL'S ADVOCATE.",
    "Examine the codebase files, folder structure, test runner setup, and logs to identify shortcomings.",
    "Specifically look for: bugs, missing tests, UI/UX gaps (referencing DESIGN.md), incomplete features, todo comments, and violations of the developer's values in .claude/persona.md.",
    "",
    "Resist confirmation bias: an audit that only confirms the project is healthy is a failed audit.",
    "Argue against the current direction, not just for more of it. Prioritize:",
    "  - security exposure before any user touches it (auth, secrets, data in API responses, injection, vulnerable deps),",
    "  - missing tests for logic that already shipped (each fixed bug should leave behind a regression test),",
    "  - scope creep already in the codebase (features built that no evidence justified),",
    "  - structural/architectural debt that will compound as usage grows.",
    "Before proposing a fix, consider whether a similar problem was already solved elsewhere; if the central hub is",
    "reachable you may consult prior knowledge with: node scripts/loop/knowledge.mjs recall \"<topic>\".",
    "",
    "Output your findings ONLY as a raw JSON array of task cards.",
    "Each object in the array MUST have:",
    "  - 'card': a URL-friendly lowercase unique slug (using hyphens only, e.g., 'add-error-boundary')",
    "  - 'spec': a clear, actionable instruction for a builder to implement, INCLUDING the acceptance criterion (what evidence proves it is fixed).",
    "",
    "Do NOT wrap the output in markdown code blocks like ```json. Do NOT include any conversation or text outside the JSON array.",
    "If no shortcomings or gaps are found, return an empty array: []",
    "",
    "Format example: [{\"card\": \"add-unit-test-login\", \"spec\": \"Add unit tests for user authentication states in tests/auth.test.js; accept when the failing trailing-space email case is covered and green\"}]",
  ].join("\n");

  const invokeScript = resolve(HERE, "..", "invoke-claude.mjs");
  const child = spawn(process.execPath, [invokeScript, assessmentPrompt], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => { stdout += d.toString(); });
  child.stderr.on("data", (d) => { stderr += d.toString(); });

  const code = await new Promise((res) => child.on("exit", res));

  if (code !== 0) {
    console.error(`[Assess] Agent assessment exited with code ${code}`);
    console.error(stderr);
    try {
      await log("error", { actor: "ralph", detail: `shortcomings assessment failed with code ${code}` });
    } catch {}
    return;
  }

  // Parse the JSON array
  let tasks = [];
  try {
    const jsonMatch = stdout.match(/\[\s*\{[\s\S]*\}\s*\]/);
    if (jsonMatch) {
      tasks = JSON.parse(jsonMatch[0]);
    } else {
      tasks = JSON.parse(stdout.trim());
    }
  } catch (err) {
    console.error("[Assess] Failed to parse assessment JSON from output. Raw output was:");
    console.log(stdout);
    try {
      await log("error", { actor: "ralph", detail: "failed to parse shortcomings assessment output" });
    } catch {}
    return;
  }

  if (!Array.isArray(tasks)) {
    console.error("[Assess] Assessment did not return an array.");
    return;
  }

  console.log(`[Assess] Agent found ${tasks.length} potential improvements/tasks.`);

  let addedCount = 0;
  const allTasks = backlog.list();
  const existingCards = new Set(allTasks.map((t) => t.card));

  for (const t of tasks) {
    if (!t.card || !t.spec) continue;
    if (existingCards.has(t.card)) {
      console.log(`[Assess] Task ${t.card} already exists. Skipping.`);
      continue;
    }
    await backlog.add(t.card, t.spec);
    try {
      await log("iterate", { card: t.card, actor: "ralph", detail: `automatically added shortcoming task: ${t.spec}` });
    } catch {}
    console.log(`[Assess] Added new task: ${t.card}`);
    addedCount++;
  }

  console.log(`[Assess] Added ${addedCount} new tasks to the backlog.`);
}

// CLI entry point
if (import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) {
  const b = await getBacklog();
  runAssessment(b).catch(console.error);
}
