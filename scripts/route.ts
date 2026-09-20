#!/usr/bin/env node
// route.ts — heuristic task router for the multi-agent harness.
//
// Usage:
//   node scripts/route.ts "<task description>" [--agent=architect|researcher|typist|builder] [--run]
//
// Prints the picked agent and a one-line rationale. With --run, dispatches via
// the matching scripts/invoke-<cli>.ts wrapper. Each role resolves to the first
// CLI installed on THIS machine — see resolveRole.

import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { installed } from "./agent-session.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

// Korean terms are matched WITHOUT \b — see the note on the builder patterns
// below. Keeping them inside an ASCII-anchored \b group meant every Korean
// signal here silently scored 0 in a Korean-first repo.
const SIGNALS = {
  researcher: [
    /\b(pdf|hwp|docx?|epub|paper|spec|specs|specification)\b/i,
    /(논문|명세서)/,
    /\b(summari[sz]e|extract|compare|synthesi[sz]e|analy[sz]e)\b/i,
    /(요약|분석|정리해)/,
    /\b(long[- ]?context|large[- ]?context|big[- ]?file)\b/i,
    /(많은\s*파일|장문)/,
    /\b(rag|retriev|embed|index)\b/i,
  ],
  typist: [
    /\b(rename|inline|stub|boilerplate|snippet|complete|completion|autocomplete)\b/i,
    /\bapply\b.*\b(pattern|fix|change|hook|wrapper)\b.*\b(across|to all|throughout|in (every|all)|everywhere)\b/i,
    /\b(fix typo|add missing test|fill in|migrate calls?)\b/i,
  ],
  // Ordinary implementation work — the bulk of coding. Routed to a local node so
  // it costs no cloud quota; `architect` still wins on design/risk wording.
  builder: [
    /\b(implement|write|add|build|create|fix|bug|feature|function|endpoint|handler)\b/i,
    /\b(test|tests|coverage|unit|integration)\b/i,
    // No \b here: it is defined on ASCII word chars, so it never matches at a
    // Hangul boundary — "버그 수정해줘" would score 0 and silently fall through
    // to the architect default.
    /(구현|작성|추가|수정|버그|고쳐|만들어|리팩터|테스트)/,
  ],
  architect: [
    /\b(design|architect|refactor|restructur|propose|trade-?off|approach)\b/i,
    /(설계|아키텍처|구조\s*개선|검토해)/,
    /\b(ui|ux|component|screen|page|layout|flow)\b/i,
    /(화면|레이아웃|컴포넌트)/,
    /\b(migration|schema|auth|security|risk|threat)\b/i,
    /(마이그레이션|스키마|인증|보안|리스크)/,
  ],
};

type Agent = keyof typeof SIGNALS;
type Scores = Record<Agent, number>;

function score(task: string): Scores {
  const out: Scores = { architect: 0, researcher: 0, typist: 0, builder: 0 };
  for (const agent of Object.keys(SIGNALS) as Agent[]) {
    for (const re of SIGNALS[agent]) if (re.test(task)) out[agent]++;
  }
  return out;
}

function pick(task: string): { agent: Agent; s: Scores } {
  const s = score(task);
  // researcher wins if it has any signal — it's the rarest case and most expensive to misroute
  if (s.researcher > 0 && s.researcher >= s.architect) return { agent: "researcher", s };
  if (s.typist > s.architect) return { agent: "typist", s };
  // Implementation outranks a bare architect keyword: "design the schema" is a
  // design task, but "implement the login endpoint" is coding and belongs on a
  // local node. Ties still go to architect — judgment-first is the safer default.
  if (s.builder > s.architect) return { agent: "builder", s };
  return { agent: "architect", s };
}

function rationale(agent: Agent, s: Scores): string {
  if (agent === "researcher") return `signals=${s.researcher} (long-context / synthesis)`;
  if (agent === "typist")     return `signals=${s.typist} (mechanical / pattern application)`;
  if (agent === "builder")    return `signals=${s.builder} (implementation — local LLM node)`;
  return `default + signals=${s.architect} (design / reasoning)`;
}

// True when the winning agent matched NO signal of its own — i.e. the pick is a
// fallback, not a positive match. The heuristic is keyword-only, so a task
// phrased in words it doesn't recognize (synonyms, another language, mixed
// intent) collapses here silently unless we say so. Surfacing it lets the caller
// correct with --agent= instead of trusting a coin-flip default.
function isLowConfidence(agent: Agent, s: Scores): boolean {
  return (s[agent] || 0) === 0;
}

/**
 * Which CLI each role prefers, best first.
 *
 * A role is a job description, not a vendor: "reason about this design" and
 * "make this mechanical edit" want different models, and which vendor supplies
 * them depends on the machine. So each role carries an ORDER, and the first
 * installed entry wins.
 *
 * The orders encode the split Aider's architect/editor mode measured: strong
 * reasoning up front, cheap-and-precise for the edits. `architect` therefore
 * leads with the frontier CLIs and `typist`/`builder` lead with the unmetered
 * local nodes, falling back to metered ones only when no local node is
 * configured. `researcher` leads with the large-context lanes.
 *
 * ROUTE_<ROLE>_CLI still pins one explicitly; it is placed first and the rest of
 * the chain remains as fallback.
 */
const ROLE_CHAINS: Record<string, string[]> = {
  architect:  ["claude", "agy", "codex", "gemini"],
  researcher: ["agy", "gemini", "claude", "codex"],
  typist:     ["codex", "gemini", "claude", "agy"],
  builder:    ["codex", "claude", "agy", "gemini"],
};

/** What a role resolved to on THIS machine, and what it had to skip to get there. */
export interface Resolution {
  cli: string | null;
  /** preferred entries that are not installed here, in order */
  skipped: string[];
  /** true when an explicit ROUTE_<ROLE>_CLI pinned the choice */
  pinned: boolean;
}

/**
 * Resolve a role to a CLI that actually exists here.
 *
 * The old mapping named one CLI per role and only discovered it was absent by
 * spawning it and reading the ENOENT — which meant the printed decision (the
 * common case, without --run) confidently recommended a CLI the machine does not
 * have. Availability is cheap to check, so it is checked before advising.
 */
/** Every role this router knows, for the availability line. */
export const ROLES = ["architect", "researcher", "typist", "builder"];

export function resolveRole(
  role: string,
  { isInstalled = installed, env = process.env }: { isInstalled?: (a: string) => boolean; env?: NodeJS.ProcessEnv } = {},
): Resolution {
  const pin = env[`ROUTE_${role.toUpperCase()}_CLI`]?.trim();
  const chain = [...(pin ? [pin] : []), ...(ROLE_CHAINS[role] ?? [role])]
    .filter((c, i, a) => a.indexOf(c) === i);
  const skipped: string[] = [];
  for (const cli of chain) {
    if (isInstalled(cli)) return { cli, skipped, pinned: Boolean(pin) && cli === pin };
    skipped.push(cli);
  }
  return { cli: null, skipped: chain, pinned: false };
}

function wrapperArgs(cliName: string, task: string): string[] {
  // Built at runtime, so the migration codemod could not see it — this literal
  // stayed .mjs while every wrapper it names became .ts, and the --run branch
  // has no test that would have caught the ENOENT.
  return [resolve(HERE, `invoke-${cliName}.ts`), task];
}

async function run(agent: string, task: string) {
  const resolved = resolveRole(agent);
  if (!resolved.cli) {
    throw new Error(
      `no CLI available for role '${agent}'. Tried: ${resolved.skipped.join(", ")}. `
      + `Install one, or pin an installed CLI with ROUTE_${agent.toUpperCase()}_CLI.`,
    );
  }
  const cli = resolved.cli;

  // Everything still installed, minus the one we are about to try. Resolution
  // already skipped what is absent, so a fallback here means "it was installed
  // but the run failed", not "it was never there".
  const fallbacks = (ROLE_CHAINS[agent] ?? [])
    .filter((c) => c !== cli && installed(c));

  const tryInvoke = (cliName: string) => {
    return new Promise<number>((res, rej) => {
      console.log(`[route] Dispatching via ${cliName} wrapper...`);
      const child = spawn(process.execPath, wrapperArgs(cliName, task), { stdio: "inherit" });
      child.on("exit", (code) => (code === 0 ? res(0) : rej(new Error(`Agent ${cliName} exited with code ${code}`))));
    });
  };

  try {
    return await tryInvoke(cli);
  } catch (err) {
    console.warn(`[route] Primary agent '${cli}' failed/unavailable (${(err as Error)?.message}). Trying fallback agents...`);
    for (const fb of fallbacks) {
      try {
        console.log(`[route] Fallback attempt with '${fb}'...`);
        return await tryInvoke(fb);
      } catch {
        /* try next fallback */
      }
    }
    throw new Error(`All agent dispatches failed. Please check CLI installations.`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const flags: { agent?: string; run?: boolean } = {};
  const rest: string[] = [];
  for (const a of args) {
    if (a.startsWith("--agent=")) flags.agent = a.split("=", 2)[1] ?? "";
    else if (a === "--run") flags.run = true;
    else rest.push(a);
  }
  const task = rest.join(" ").trim();
  if (!task) {
    console.error('usage: node scripts/route.ts "<task description>" [--agent=...] [--run]');
    process.exit(2);
  }

  // A manual override skips scoring, so it carries no per-agent signal counts —
  // rationale() is not called for it (see the ternary below).
  const decision: { agent: string; s: Scores | null } = flags.agent
    ? { agent: flags.agent, s: null }
    : pick(task);

  console.log(`→ agent: ${decision.agent}`);
  console.log(`  why:   ${flags.agent ? "manual override" : rationale(decision.agent as Agent, decision.s!)}`);
  if (!flags.agent && decision.s) {
    const { architect = 0, researcher = 0, typist = 0, builder = 0 } = decision.s;
    console.log(`  scores: architect=${architect} researcher=${researcher} typist=${typist} builder=${builder}`);
    // Don't let a keyword miss masquerade as a confident pick — say so, and point
    // at the override, so the caller isn't silently handed a coin-flip default.
    if (isLowConfidence(decision.agent as Agent, decision.s)) {
      console.log(`  note:  low confidence — no signal matched; defaulted to ${decision.agent}. Override with --agent=architect|researcher|typist|builder`);
    }
  }
  console.log(`  task:  ${task}`);

  // Say which CLI this actually lands on HERE. Printing a role without naming
  // the CLI let the decision look valid on a machine that has none of them, and
  // the caller only found out by running it.
  const resolved = resolveRole(decision.agent);
  if (!resolved.cli) {
    console.log(`  cli:   (none installed — tried ${resolved.skipped.join(", ")})`);
    console.log(`  fix:   install one of them, or pin an installed CLI with ROUTE_${decision.agent.toUpperCase()}_CLI`);
  } else {
    const via = resolved.pinned ? " (pinned)"
      : resolved.skipped.length ? `  [not installed: ${resolved.skipped.join(", ")}]`
      : "";
    console.log(`  cli:   ${resolved.cli}${via}`);
  }
  console.log(`  ready: ${ROLES.map((r) => `${r}=${resolveRole(r).cli ?? "—"}`).join("  ")}`);

  if (flags.run) await run(decision.agent, task);
}

// Every other script here carries this guard; route.ts did not, so importing it
// to test the routing rules ran the CLI instead.
// `import.meta.url` is realpath-resolved by the loader, while `process.argv[1]` is
// the raw path the caller typed. On a symlinked path (macOS /tmp -> /private/tmp,
// /var -> /private/var, linked checkouts) the two differ and a naive comparison
// makes this CLI silently no-op with exit 0. Compare both through realpath.
const isMainModule = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isMainModule) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
