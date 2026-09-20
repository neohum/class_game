// plan-compile.ts — compile explicit plan items into idempotent backlog cards.
// This is deliberately deterministic: it never invents work or calls a model.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getBacklog } from "./backlog.ts";

const ROOT = resolve(process.cwd());
const DEFAULT_PLAN = resolve(ROOT, "plan.md");
const KEY = /^(Goal|Acceptance|Test|Tests|Depends on|Dependencies|Priority|Risk|Complexity|Allowed builders|Agent|Model|Reviewer|Path allowlist|Status):\s*(.*?)\s*$/i;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** One card as plan.md declares it, before it becomes a backlog spec. */
export interface PlanItem {
  card: string;
  goal: string;
  acceptance: string[];
  tests: string[];
  dependencies: string[];
  allowedBuilders: string[];
  agent: string;
  model: string;
  reviewer: string;
  pathAllowlist: string[];
  priority: string;
  risk: string;
  complexity: string;
  status: string;
}

function listValue(value: string): string[] {
  return value.split(/[,;]/).map((x) => x.trim()).filter(Boolean);
}

export function parsePlan(text: unknown): PlanItem[] {
  const items: PlanItem[] = [];
  let current: PlanItem | null = null;
  // Strip HTML comments first, exactly as spec-sync does. The shipped plan.md
  // demonstrates the format with a fully-formed `## Card: example-card`, and a
  // commented block must stay inert — otherwise the file's own instructions
  // compile into the backlog and the loop opens work nobody asked for. An
  // unterminated comment drops the rest, which is how it renders.
  const src = String(text || "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!--[\s\S]*$/, "");
  for (const raw of src.split(/\r?\n/)) {
    const heading = raw.match(/^##+\s+(?:Card|Task|Plan Item):\s*([a-z0-9][a-z0-9-]*)\s*$/i);
    if (heading) {
      current = {
        card: (heading[1] ?? "").toLowerCase(),
        goal: "",
        acceptance: [],
        tests: [],
        dependencies: [],
        status: "ready",
        priority: "",
        risk: "",
        complexity: "",
        allowedBuilders: [],
        agent: "",
        model: "",
        reviewer: "",
        pathAllowlist: [],
      };
      items.push(current);
      continue;
    }
    if (!current) continue;
    const line = raw.replace(/^\s*[-*]\s+/, "").trim();
    const m = line.match(KEY);
    if (!m) continue;
    const key = (m[1] ?? "").toLowerCase();
    const value = m[2] ?? "";
    if (key === "goal") current.goal = value;
    else if (key === "acceptance") current.acceptance.push(value);
    else if (key === "test" || key === "tests") current.tests.push(value);
    else if (key === "depends on" || key === "dependencies") current.dependencies.push(...listValue(value));
    else if (key === "priority") current.priority = value;
    else if (key === "risk") current.risk = value;
    else if (key === "complexity") current.complexity = value;
    else if (key === "allowed builders") current.allowedBuilders.push(...listValue(value));
    else if (key === "agent") current.agent = value.trim().toLowerCase();
    else if (key === "model") current.model = value.trim();
    else if (key === "reviewer") current.reviewer = value.trim().toLowerCase();
    else if (key === "path allowlist") current.pathAllowlist.push(...listValue(value));
    else if (key === "status") current.status = value.toLowerCase();
  }
  return items;
}

export function validateItem(item: PlanItem): string[] {
  const errors: string[] = [];
  if (!SLUG.test(item.card)) errors.push("card must be a lowercase slug");
  if (!item.goal || item.goal.length < 8) errors.push("Goal is required");
  if (!item.acceptance.length) errors.push("at least one Acceptance criterion is required");
  if (!item.tests.length) errors.push("at least one Tests/evidence command is required");
  if (["draft", "parked", "done", "blocked"].includes(item.status)) errors.push(`status=${item.status} is not executable`);
  if (item.risk && !["low", "medium", "high"].includes(item.risk.toLowerCase())) errors.push("Risk must be low, medium, or high");
  if (item.complexity && !["low", "medium", "high"].includes(item.complexity.toLowerCase())) errors.push("Complexity must be low, medium, or high");
  for (const dep of item.dependencies) if (!SLUG.test(dep)) errors.push(`invalid dependency: ${dep}`);
  for (const path of item.pathAllowlist) {
    if (path.startsWith("/") || /^[a-z]:/i.test(path) || path.split(/[\\/]/).includes("..")) {
      errors.push(`Path allowlist must contain relative project paths: ${path}`);
    }
  }
  return errors;
}

export function compileSpec(item: PlanItem): string {
  const lines = [
    `Goal: ${item.goal}`,
    "Acceptance criteria:",
    ...item.acceptance.map((x: string, index: number) => `- ${/^AC-\d+\s*:/i.test(x) ? x : `AC-${index + 1}: ${x}`}`),
  ];
  if (item.tests.length) lines.push("Tests/evidence:", ...item.tests.map((x: string) => `- ${x}`));
  if (item.dependencies.length) lines.push(`Dependencies: ${item.dependencies.join(", ")}`);
  if (item.priority) lines.push(`Priority: ${item.priority}`);
  if (item.risk) lines.push(`Risk: ${item.risk}`);
  if (item.complexity) lines.push(`Complexity: ${item.complexity}`);
  if (item.allowedBuilders.length) lines.push(`Allowed builders: ${item.allowedBuilders.join(", ")}`);
  // 빌더가 카드만 보고도 어느 레인·모델로 지어야 하는지 알아야 한다.
  if (item.agent) lines.push(`Agent: ${item.agent}`);
  if (item.model) lines.push(`Model: ${item.model}`);
  if (item.reviewer) lines.push(`Reviewer: ${item.reviewer}`);
  if (item.pathAllowlist.length) lines.push(`Path allowlist: ${item.pathAllowlist.join(", ")}`);
  return lines.join("\n").slice(0, 4000);
}

interface BacklogLike {
  get(card: string): unknown;
  add(card: string, spec: string, source: string): Promise<unknown> | unknown;
}

export async function compilePlan({ path = DEFAULT_PLAN, dryRun = false, backlog }: {
  path?: string;
  dryRun?: boolean;
  backlog?: BacklogLike;
} = {}) {
  if (!existsSync(path)) return { path, items: 0, added: [], rejected: [] };
  const parsed = parsePlan(readFileSync(path, "utf8"));
  const b = backlog || (await getBacklog());
  const added = [], rejected = [];
  for (const item of parsed) {
    const errors = validateItem(item);
    if (errors.length) { rejected.push({ card: item.card, errors }); continue; }
    if (!dryRun && !b.get(item.card)) { b.add(item.card, compileSpec(item), "plan"); added.push(item.card); }
    else if (dryRun && !b.get(item.card)) added.push(item.card);
  }
  return { path, items: parsed.length, added, rejected };
}

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
  const args = process.argv.slice(2).filter((x) => x !== "--dry");
  const result = await compilePlan({ path: resolve(ROOT, args[0] || "plan.md"), dryRun: process.argv.includes("--dry") });
  for (const card of result.added) console.log(`${process.argv.includes("--dry") ? "would-add" : "added"} ${card}`);
  for (const item of result.rejected) console.error(`rejected ${item.card}: ${item.errors.join("; ")}`);
  console.log(`plan-compile: ${result.items} item(s), ${result.added.length} new, ${result.rejected.length} rejected`);
  if (result.rejected.length) process.exitCode = 1;
}
