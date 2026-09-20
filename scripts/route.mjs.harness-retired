#!/usr/bin/env node
// route.mjs — heuristic task router for the multi-agent harness.
//
// Usage:
//   node scripts/route.mjs "<task description>" [--agent=architect|researcher|typist] [--run]
//
// Prints the picked agent and a one-line rationale. With --run, dispatches via
// the matching scripts/invoke-<agent>.mjs wrapper.

import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

const SIGNALS = {
  researcher: [
    /\b(pdf|hwp|docx?|epub|논문|paper|spec|specs|specification)\b/i,
    /\b(summari[sz]e|extract|compare|synthesi[sz]e|analy[sz]e)\b/i,
    /\b(long[- ]?context|large[- ]?context|big[- ]?file|많은\s*파일|장문)\b/i,
    /\b(rag|retriev|embed|index)\b/i,
  ],
  typist: [
    /\b(rename|inline|stub|boilerplate|snippet|complete|completion|autocomplete)\b/i,
    /\bapply\b.*\b(pattern|fix|change|hook|wrapper)\b.*\b(across|to all|throughout|in (every|all)|everywhere)\b/i,
    /\b(fix typo|add missing test|fill in|migrate calls?)\b/i,
  ],
  architect: [
    /\b(design|architect|refactor|restructur|propose|trade-?off|approach)\b/i,
    /\b(ui|ux|component|screen|page|layout|flow)\b/i,
    /\b(migration|schema|auth|security|risk|threat)\b/i,
  ],
};

function score(task) {
  const out = { architect: 0, researcher: 0, typist: 0 };
  for (const agent of Object.keys(SIGNALS)) {
    for (const re of SIGNALS[agent]) if (re.test(task)) out[agent]++;
  }
  return out;
}

function pick(task) {
  const s = score(task);
  // researcher wins if it has any signal — it's the rarest case and most expensive to misroute
  if (s.researcher > 0 && s.researcher >= s.architect) return { agent: "researcher", s };
  if (s.typist > s.architect) return { agent: "typist", s };
  // default fallback: architect — judgment-first is safer than typing-first
  return { agent: "architect", s };
}

function rationale(agent, s) {
  if (agent === "researcher") return `signals=${s.researcher} (long-context / synthesis)`;
  if (agent === "typist")     return `signals=${s.typist} (mechanical / pattern application)`;
  return `default + signals=${s.architect} (design / reasoning)`;
}

const AGENT_TO_CLI = {
  architect: "claude",
  researcher: "agy",
  typist: "codex",
};

async function run(agent, task) {
  const cli = AGENT_TO_CLI[agent] || agent;
  const wrapper = resolve(HERE, `invoke-${cli}.mjs`);
  return await new Promise((res, rej) => {
    const child = spawn(process.execPath, [wrapper, task], { stdio: "inherit" });
    child.on("exit", (code) => (code === 0 ? res(0) : rej(new Error(`agent exited ${code}`))));
  });
}

async function main() {
  const args = process.argv.slice(2);
  const flags = {};
  const rest = [];
  for (const a of args) {
    if (a.startsWith("--agent=")) flags.agent = a.split("=", 2)[1];
    else if (a === "--run") flags.run = true;
    else rest.push(a);
  }
  const task = rest.join(" ").trim();
  if (!task) {
    console.error('usage: node scripts/route.mjs "<task description>" [--agent=...] [--run]');
    process.exit(2);
  }

  const decision = flags.agent
    ? { agent: flags.agent, s: { override: 1 } }
    : pick(task);

  console.log(`→ agent: ${decision.agent}`);
  console.log(`  why:   ${flags.agent ? "manual override" : rationale(decision.agent, decision.s)}`);
  console.log(`  task:  ${task}`);

  if (flags.run) await run(decision.agent, task);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
