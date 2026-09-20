// plan-doc.ts — the 계획서 (plan document) as the unit of work.
//
// `plan.md` already compiles flat `## Card:` items into the backlog, and that is
// enough for one-line chores. It is not enough for a feature: it carries no
// design, no file-level blast radius, no order, and no statement of who reviews
// what. So the loop learned the shape from the outside world (oh-my-openagent's
// `.omo/plans/*.md`, where "NO PLAN ON DISK MEANS YOU DO NOT START" is a hard
// rule) and made it first-class here:
//
//   plans/<slug>.plan.md   one approved design → an ORDERED set of cards
//
// Three properties are what make it worth a module instead of a convention:
//
//   1. It compiles. Steps become backlog cards in one pass, chained by
//      dependency, so a whole feature is queued from a single approved document
//      instead of hand-typed card by card.
//   2. It parallelises. Steps that declare `Parallel: yes` land in the same wave,
//      and waves() hands the scheduler the DAG levels — the loop stops running a
//      3-step feature strictly nose-to-tail when two of the steps never touch.
//   3. It gates. plan-gate.ts refuses a risky build with no approved plan, and
//      the doc names the files it may touch, so blast radius is declared BEFORE
//      the first edit rather than discovered in review.
//
// Deliberately deterministic: it parses, validates and compiles. It never calls a
// model, and it never invents a step the document did not declare.
//
// Usage:
//   node scripts/loop/plan-doc.ts init <slug> ["title"]   # write the skeleton
//   node scripts/loop/plan-doc.ts check [slug]            # validate (exit 1 on error)
//   node scripts/loop/plan-doc.ts ready <slug>            # validate, approve, compile & print wave 1
//   node scripts/loop/plan-doc.ts waves <slug>            # print the DAG levels
//   node scripts/loop/plan-doc.ts compile [--dry]         # approved docs → backlog
//   node scripts/loop/plan-doc.ts list

import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compileSpec, validateItem, type PlanItem } from "./plan-compile.ts";
import { getBacklog } from "./backlog.ts";

const ROOT = resolve(process.cwd());
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const KEY = /^(Goal|Files|File|Acceptance|Test|Tests|Depends on|Dependencies|Priority|Risk|Complexity|Allowed builders|Agent|Model|Reviewer|Path allowlist|Parallel):\s*(.*?)\s*$/i;
export const PLAN_SUFFIX = ".plan.md";
export const RISKS = ["low", "medium", "high"] as const;

/**
 * 단계가 지정할 수 있는 레인.
 *
 * `scripts/agent-session.ts`의 목록과 같아야 한다. 갈라지면 계획서가 통과한
 * 이름으로 세션을 못 여는데, 그 실패는 카드를 claim한 **뒤에** 난다.
 */
export const PLAN_AGENTS = ["claude", "codex", "agy", "gemini"] as const;

/** One step of a plan document: a backlog card plus the design fields a card has no room for. */
export interface PlanStep extends PlanItem {
  /** Files the step expects to touch. Doubles as the path allowlist when none is declared. */
  files: string[];
  /** Declared `Parallel: yes` — runs in the same wave as the step before it. */
  parallel: boolean;
  /**
   * 이 단계를 **누가** 짓는가 (`Agent:`).
   *
   * 비워 두면 라우터가 고른다. 적어 두는 이유는 단계마다 맞는 레인이 다르기
   * 때문이다 — 넓은 읽기는 장문맥 레인, 기계적 편집은 값싼 레인, 판단이 필요한
   * 설계는 비싼 레인.
   */
  agent: string;
  /**
   * 그 레인에서 **어느 모델**을 쓰는가 (`Model:`).
   *
   * 각 CLI의 최상위 모델이 기본이다. 값을 적는 것은 "이 단계는 그보다 싼/비싼
   * 모델로 충분하다"는 판단을 남기는 것이다.
   */
  model: string;
  /**
   * 이 단계를 **누가 리뷰하는가** (`Reviewer:`).
   *
   * 빌더와 같으면 거절한다(Anti-False Consensus). 비워 두면 검사하지 않는다.
   */
  reviewer: string;
}

export interface PlanDoc {
  slug: string;
  title: string;
  /** `draft` (visible, not executable) or `approved` (compiles into cards). */
  status: string;
  risk: string;
  /** Who approved it. Required at `risk: high` — a human name, not a model. */
  owner: string;
  intent: string;
  nonGoals: string[];
  verification: string;
  reviewers: string;
  steps: PlanStep[];
  /** Headings under `## Steps` that did not parse as a step — reported, never ignored. */
  badHeadings: string[];
  /** Absolute path on disk, or "" for a doc parsed from a string. */
  path: string;
}

export interface PlanConfig {
  planDir: string;
  evidenceDir: string;
  gate: { mode: string; ownerRequiredAtRisk: string };
  evidence: { requireAtRisk: string };
  waves: { maxParallel: number };
}

const DEFAULT_CONFIG: PlanConfig = {
  planDir: "plans",
  evidenceDir: "evidence",
  // `risk` — a medium/high card needs an approved plan; a one-liner does not.
  // `strict` — every card needs one. `off` — nothing does (interactive only;
  // plan-gate.ts refuses to honour it in an unattended run).
  gate: { mode: "risk", ownerRequiredAtRisk: "high" },
  evidence: { requireAtRisk: "medium" },
  waves: { maxParallel: 3 },
};

/** The `Risk:` line a compiled card carries. Absent reads as low, as elsewhere in the loop. */
export function specRisk(spec: unknown): string {
  const m = String(spec ?? "").match(/^\s*Risk:\s*(low|medium|high)\s*$/im);
  return (m?.[1] ?? "").toLowerCase();
}

/** Rank a risk word so thresholds compare. Unknown/absent reads as the floor. */
export function riskRank(risk: unknown): number {
  const i = RISKS.indexOf(String(risk ?? "").trim().toLowerCase() as (typeof RISKS)[number]);
  return i === -1 ? 0 : i;
}

/**
 * Read `.harness-plan.json`, then let env override.
 *
 * The file is the project's declaration (committed, reviewable); the env vars are
 * the operator's per-run override. Same layering as the quality profile, so a new
 * knob is added in one place and every caller sees it.
 */
export function planConfig(cwd = ROOT, env: NodeJS.ProcessEnv = process.env): PlanConfig {
  const cfg: PlanConfig = {
    ...DEFAULT_CONFIG,
    gate: { ...DEFAULT_CONFIG.gate },
    evidence: { ...DEFAULT_CONFIG.evidence },
    waves: { ...DEFAULT_CONFIG.waves },
  };
  const path = resolve(cwd, ".harness-plan.json");
  if (existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<PlanConfig>;
      if (typeof raw.planDir === "string" && raw.planDir) cfg.planDir = raw.planDir;
      if (typeof raw.evidenceDir === "string" && raw.evidenceDir) cfg.evidenceDir = raw.evidenceDir;
      if (raw.gate?.mode) cfg.gate.mode = String(raw.gate.mode);
      if (raw.gate?.ownerRequiredAtRisk) cfg.gate.ownerRequiredAtRisk = String(raw.gate.ownerRequiredAtRisk);
      if (raw.evidence?.requireAtRisk) cfg.evidence.requireAtRisk = String(raw.evidence.requireAtRisk);
      if (Number(raw.waves?.maxParallel) > 0) cfg.waves.maxParallel = Number(raw.waves?.maxParallel);
    } catch (e) {
      // A malformed profile must not silently become "no plan discipline": keep
      // the defaults (which gate) and say so loudly.
      console.error(`plan-doc: ignoring unreadable .harness-plan.json (${(e as Error)?.message})`);
    }
  }
  if (env.HARNESS_PLAN_DIR) cfg.planDir = env.HARNESS_PLAN_DIR;
  if (env.HARNESS_EVIDENCE_DIR) cfg.evidenceDir = env.HARNESS_EVIDENCE_DIR;
  if (env.HARNESS_PLAN_GATE) cfg.gate.mode = env.HARNESS_PLAN_GATE;
  if (Number(env.HARNESS_PLAN_WAVE_MAX) > 0) cfg.waves.maxParallel = Number(env.HARNESS_PLAN_WAVE_MAX);
  return cfg;
}

export function planPath(slug: string, cwd = ROOT, cfg = planConfig(cwd)): string {
  return resolve(cwd, cfg.planDir, `${slug}${PLAN_SUFFIX}`);
}

function listValue(value: string): string[] {
  return value.split(/[,;]/).map((x) => x.trim()).filter(Boolean);
}

function frontmatter(src: string): { fields: Record<string, string>; body: string } {
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { fields: {}, body: src };
  const fields: Record<string, string> = {};
  for (const line of (m[1] ?? "").split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/);
    if (kv) fields[(kv[1] ?? "").toLowerCase()] = (kv[2] ?? "").replace(/^["']|["']$/g, "");
  }
  return { fields, body: src.slice(m[0].length) };
}

function emptyStep(card: string): PlanStep {
  return {
    card,
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
    files: [],
    parallel: false,
  };
}

/**
 * Parse a plan document.
 *
 * Tolerant on the prose (a section can be missing or reordered) and strict on the
 * machine-read parts (frontmatter keys, step slugs, the `Key: value` grammar
 * plan.md already uses). Section bodies are captured verbatim so a human reading
 * the doc and an agent reading this struct see the same words.
 */
export function parsePlanDoc(text: unknown, path = ""): PlanDoc {
  const { fields, body } = frontmatter(String(text ?? ""));
  const doc: PlanDoc = {
    slug: (fields.plan || (path ? basename(path).replace(/\.plan\.md$/i, "") : "")).toLowerCase(),
    title: "",
    status: (fields.status || "draft").toLowerCase(),
    risk: (fields.risk || "").toLowerCase(),
    owner: fields.owner || "",
    intent: "",
    nonGoals: [],
    verification: "",
    reviewers: "",
    steps: [],
    badHeadings: [],
    path,
  };

  let section = "";
  let step: PlanStep | null = null;
  const prose: Record<string, string[]> = {};

  let fenced = false;
  for (const raw of body.replace(/<!--[\s\S]*?-->/g, "").split(/\r?\n/)) {
    // A fenced block is content, not structure. Without this a `###` inside a shell
    // snippet under ## Verification reads as a malformed step heading and blocks a
    // perfectly good plan.
    if (/^\s*(```|~~~)/.test(raw)) { fenced = !fenced; continue; }
    if (fenced) {
      if (step === null && section && section !== "steps") (prose[section] ||= []).push(raw);
      continue;
    }

    const h1 = raw.match(/^#\s+(?:Plan|계획서)?\s*:?\s*(.*?)\s*$/i);
    if (h1) { doc.title = doc.title || (h1[1] ?? "").trim(); continue; }

    const h2 = raw.match(/^##\s+(.*?)\s*$/);
    if (h2) {
      const name = (h2[1] ?? "").trim().toLowerCase();
      section = /^(steps?|단계)\b/.test(name) ? "steps"
        : /^(intent|goal|목표|의도)\b/.test(name) ? "intent"
        : /^(non-?goals?|하지 않는)\b/.test(name) ? "nongoals"
        : /^(verification|검증)\b/.test(name) ? "verification"
        : /^(reviewer|리뷰)/.test(name) ? "reviewers"
        : "";
      step = null;
      continue;
    }

    // A step heading. `### Step 1: slug`, `### Card: slug` and a bare `### slug`
    // all work — the slug is the card id either way, and rejecting a spelling
    // would only teach authors that the format is finicky.
    const h3 = raw.match(/^###+\s*(?:(?:Step|Card|단계)\s*\d*\s*[:.]?\s*)?([a-z0-9][a-z0-9-]*)\s*$/i);
    if (section === "steps" && /^###+\s/.test(raw)) {
      if (h3) {
        step = emptyStep((h3[1] ?? "").toLowerCase());
        doc.steps.push(step);
      } else {
        // A heading that looks like a step but is not one (a title instead of a
        // slug, say) must not be silently dropped: its Goal/Files/Tests lines
        // would then attach to the previous step and quietly widen its scope.
        doc.badHeadings.push(raw.trim());
        step = null;
      }
      continue;
    }

    if (step) {
      const line = raw.replace(/^\s*[-*]\s+/, "").trim();
      const m = line.match(KEY);
      if (!m) continue;
      const key = (m[1] ?? "").toLowerCase();
      const value = m[2] ?? "";
      if (key === "goal") step.goal = value;
      else if (key === "files" || key === "file") step.files.push(...listValue(value));
      else if (key === "acceptance") step.acceptance.push(value);
      else if (key === "test" || key === "tests") step.tests.push(value);
      else if (key === "depends on" || key === "dependencies") step.dependencies.push(...listValue(value));
      else if (key === "priority") step.priority = value;
      else if (key === "risk") step.risk = value.toLowerCase();
      else if (key === "complexity") step.complexity = value.toLowerCase();
      else if (key === "allowed builders") step.allowedBuilders.push(...listValue(value));
      else if (key === "agent") step.agent = value.trim().toLowerCase();
      else if (key === "model") step.model = value.trim();
      else if (key === "reviewer") step.reviewer = value.trim().toLowerCase();
      else if (key === "path allowlist") step.pathAllowlist.push(...listValue(value));
      else if (key === "parallel") step.parallel = /^(yes|true|1|on)$/i.test(value.trim());
      continue;
    }

    if (section && section !== "steps") (prose[section] ||= []).push(raw);
  }

  const joined = (name: string) => (prose[name] || []).join("\n").trim();
  doc.intent = joined("intent");
  doc.verification = joined("verification");
  doc.reviewers = joined("reviewers");
  doc.nonGoals = joined("nongoals").split(/\r?\n/)
    .map((l) => l.replace(/^\s*[-*]\s*/, "").trim()).filter(Boolean);

  // Sequential by default: step N waits for step N-1 unless it opted into the
  // same wave or named its own dependencies. This is the whole reason one
  // document can be compiled and then executed unattended — the order the human
  // wrote is the order the loop runs, without anyone restating it per card.
  let previous: PlanStep | null = null;
  for (const s of doc.steps) {
    if (!s.dependencies.length && previous) {
      s.dependencies = s.parallel ? [...previous.dependencies] : [previous.card];
    }
    // Files are the declared blast radius; reuse them as the path allowlist so
    // the builder's fail-closed path check needs no second list to drift from.
    if (!s.pathAllowlist.length && s.files.length) s.pathAllowlist = [...s.files];
    if (!s.risk && doc.risk) s.risk = doc.risk;
    s.status = doc.status === "approved" ? "ready" : "draft";
    previous = s;
  }
  return doc;
}

/**
 * Kahn levels plus whatever could never become ready.
 *
 * The unresolvable remainder is returned rather than thrown: validatePlanDoc
 * turns it into a readable error, and waves() can still print something useful
 * for a document that is mid-edit.
 */
export function topoSort(steps: PlanStep[]): { levels: string[][]; cycle: string[] } {
  const known = new Set(steps.map((s) => s.card));
  const pending = new Map(steps.map((s) => [s.card, s.dependencies.filter((d) => known.has(d))]));
  const done = new Set<string>();
  const levels: string[][] = [];
  while (pending.size) {
    const level = [...pending.entries()]
      .filter(([, deps]) => deps.every((d) => done.has(d)))
      .map(([card]) => card);
    if (!level.length) return { levels, cycle: [...pending.keys()] };
    for (const card of level) { pending.delete(card); done.add(card); }
    levels.push(level);
  }
  return { levels, cycle: [] };
}

/** Dependency levels. Each level may run concurrently. */
export function waves(steps: PlanStep[]): string[][] {
  const { levels, cycle } = topoSort(steps);
  return cycle.length ? [...levels, cycle] : levels;
}

const PLACEHOLDER = /<[^>\n]{3,}>/;

/**
 * Fields that still hold the skeleton's `<...>` prompt.
 *
 * validateItem() only measures length, so `Goal: <관찰 가능한 결과 한 문장>` passes it
 * — long enough, and completely empty of meaning. An approved plan made of
 * placeholders would compile into cards a builder cannot act on, which is the
 * failure "at least one Acceptance" was supposed to prevent.
 */
export function placeholderFields(doc: PlanDoc): string[] {
  const out: string[] = [];
  if (PLACEHOLDER.test(doc.intent)) out.push("## Intent");
  for (const goal of doc.nonGoals) if (PLACEHOLDER.test(goal)) out.push("## Non-goals");
  if (PLACEHOLDER.test(doc.verification)) out.push("## Verification");
  if (PLACEHOLDER.test(doc.reviewers)) out.push("## Reviewer topology");
  for (const step of doc.steps) {
    for (const [field, value] of [
      ["Goal", step.goal],
      ["Files", step.files.join(", ")],
      ["Acceptance", step.acceptance.join(" ")],
      ["Tests", step.tests.join(" ")],
    ] as const) {
      if (PLACEHOLDER.test(value)) out.push(`${step.card}: ${field}`);
    }
  }
  return [...new Set(out)];
}

export function validatePlanDoc(doc: PlanDoc): string[] {
  const errors: string[] = [];
  if (!SLUG.test(doc.slug)) errors.push("frontmatter `plan:` must be a lowercase slug");
  if (!["draft", "approved"].includes(doc.status)) errors.push("frontmatter `status:` must be draft or approved");
  if (doc.risk && !RISKS.includes(doc.risk as (typeof RISKS)[number])) errors.push("frontmatter `risk:` must be low, medium or high");
  if (doc.intent.length < 12) errors.push("## Intent must state the observable outcome");
  if (!doc.steps.length) errors.push("## Steps must declare at least one `### Step N: <card-slug>`");
  for (const heading of doc.badHeadings) {
    errors.push(`\`${heading}\` is not a step heading — use \`### Step N: <lowercase-slug>\``);
  }
  if (doc.status === "approved" && riskRank(doc.risk) >= riskRank("high") && !doc.owner) {
    errors.push("a high-risk plan needs frontmatter `owner:` — a human approves it, not a model");
  }

  const seen = new Set<string>();
  for (const step of doc.steps) {
    if (seen.has(step.card)) errors.push(`duplicate step: ${step.card}`);
    seen.add(step.card);
    if (!step.files.length) errors.push(`${step.card}: Files is required — declare the blast radius before editing`);

    // `Agent:`는 **읽히는 선언이다.**
    //
    // 옆에 있는 `Allowed builders:`는 파싱만 되고 아무도 읽지 않는다 — 적어도
    // 아무 일도 일어나지 않는 줄이다. 같은 것을 하나 더 만들지 않으려고
    // 여기서 이름을 검사한다. 오타나 없는 레인은 계획서 승인 시점에 걸리고,
    // **카드를 claim한 뒤에 실패하지 않는다.**
    if (step.agent && !PLAN_AGENTS.includes(step.agent as (typeof PLAN_AGENTS)[number])) {
      errors.push(
        `${step.card}: Agent: '${step.agent}'는 없는 레인이다 — ${PLAN_AGENTS.join(", ")} 중 하나여야 한다`,
      );
    }
    // 모델만 적고 레인을 안 적으면 어느 CLI의 모델인지 알 수 없다.
    if (step.model && !step.agent) {
      errors.push(`${step.card}: Model:을 적었으면 Agent:도 적어야 한다 — 어느 레인의 모델인지 알 수 없다`);
    }
    // 리뷰는 빌더와 다른 도메인이어야 한다(Anti-False Consensus).
    //
    // 이 검사를 처음에는 `## Reviewers` 산문에 레인 이름이 있는지로 만들었다가
    // 실제 계획서에서 **모든 단계가** 걸렸다 — 문자열 포함은 판정이 아니다.
    // 구조적 필드끼리 비교한다.
    if (step.reviewer && !PLAN_AGENTS.includes(step.reviewer as (typeof PLAN_AGENTS)[number])) {
      errors.push(
        `${step.card}: Reviewer: '${step.reviewer}'는 없는 레인이다 — ${PLAN_AGENTS.join(", ")} 중 하나여야 한다`,
      );
    }
    if (step.reviewer && step.agent && step.reviewer === step.agent) {
      errors.push(
        `${step.card}: Agent와 Reviewer가 둘 다 '${step.agent}'다 — 자기가 지은 것을 자기가 볼 수 없다`,
      );
    }
    // A draft step is legitimately incomplete; only hold an approved doc to the
    // card contract, which is the same one plan.md items must satisfy.
    if (doc.status === "approved") {
      for (const err of validateItem(step)) errors.push(`${step.card}: ${err}`);
    }

    for (const dep of step.dependencies) {
      if (!seen.has(dep) && !doc.steps.some((s) => s.card === dep)) {
        errors.push(`${step.card}: unknown dependency ${dep} (a step may only depend on a step of the same plan)`);
      }
    }
  }
  if (doc.status === "approved") {
    for (const field of placeholderFields(doc)) {
      errors.push(`${field} is still the skeleton's <placeholder> — an approved plan has no blanks`);
    }
  }
  const { cycle } = topoSort(doc.steps);
  if (cycle.length) errors.push(`dependency cycle among: ${cycle.join(", ")}`);
  return errors;
}

/** The card spec a step compiles to: the plan pointer first, then the usual contract. */
export function compileStepSpec(doc: PlanDoc, step: PlanStep): string {
  const head = [
    `Plan: ${doc.slug}`,
    `Plan doc: ${doc.path ? doc.path.split(/[\\/]/).slice(-2).join("/") : `plans/${doc.slug}${PLAN_SUFFIX}`}`,
    `Plan intent: ${doc.intent.split(/\r?\n/)[0] ?? ""}`,
  ];
  if (step.files.length) head.push(`Files: ${step.files.join(", ")}`);
  return [...head, compileSpec(step)].join("\n").slice(0, 4000);
}

/**
 * The plan, as the builder of ONE step needs to read it.
 *
 * Not the whole document: a builder handed five steps of design will helpfully
 * implement all five and blow the card's blast radius. It gets the shared intent,
 * the non-goals (the part that actually prevents scope creep), its own step, and
 * how the work will be verified and reviewed.
 */
export function stepBrief(doc: PlanDoc, card: string): string {
  const step = doc.steps.find((s) => s.card === card);
  const lines = [
    `[PLAN — approved design ${doc.slug}${doc.owner ? ` (owner: ${doc.owner})` : ""}. Implement ONLY this step.]`,
    `Intent: ${doc.intent}`,
  ];
  if (doc.nonGoals.length) lines.push(`Non-goals (do NOT do these): ${doc.nonGoals.join("; ")}`);
  if (step) {
    lines.push(
      `Step: ${step.card}`,
      `Goal: ${step.goal}`,
      `Files you may touch: ${step.files.join(", ") || "(not declared)"}`,
      `Acceptance: ${step.acceptance.join(" | ")}`,
      `Tests: ${step.tests.join(" | ")}`,
    );
    if (step.dependencies.length) lines.push(`Builds on (already done): ${step.dependencies.join(", ")}`);
  }
  if (doc.verification) lines.push(`Verification: ${doc.verification.replace(/\s+/g, " ").trim()}`);
  if (doc.reviewers) lines.push(`Reviewer topology: ${doc.reviewers.replace(/\s+/g, " ").trim()}`);
  return lines.join("\n");
}

export function listPlanDocs(cwd = ROOT, cfg = planConfig(cwd)): PlanDoc[] {
  const dir = resolve(cwd, cfg.planDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(PLAN_SUFFIX))
    .sort()
    .map((f) => parsePlanDoc(readFileSync(join(dir, f), "utf8"), join(dir, f)));
}

/** The plan document that declares this card, if any. */
export function planForCard(card: string, cwd = ROOT, cfg = planConfig(cwd)): PlanDoc | null {
  for (const doc of listPlanDocs(cwd, cfg)) {
    if (doc.steps.some((s) => s.card === card)) return doc;
  }
  return null;
}

interface BacklogLike {
  get(card: string): unknown;
  add(card: string, spec: string, source: string): unknown;
}

/**
 * Compile every APPROVED plan document into backlog cards, in one pass.
 *
 * Idempotent (a card already in the backlog is left alone) and fail-closed on a
 * broken document: an invalid plan compiles NOTHING, because half a feature in
 * the queue is worse than none — the loop would build step 1 of a design nobody
 * approved and then stall on the step that failed to parse.
 */
export async function compilePlanDocs({ cwd = ROOT, dryRun = false, backlog, cfg = planConfig(cwd), docs: customDocs }: {
  cwd?: string;
  dryRun?: boolean;
  backlog?: BacklogLike;
  cfg?: PlanConfig;
  docs?: PlanDoc[];
} = {}) {
  const docs = customDocs || listPlanDocs(cwd, cfg);
  const b = backlog || (await getBacklog());
  const added: string[] = [];
  const rejected: Array<{ plan: string; errors: string[] }> = [];
  const skipped: string[] = [];
  for (const doc of docs) {
    const errors = validatePlanDoc(doc);
    if (errors.length) { rejected.push({ plan: doc.slug || doc.path, errors }); continue; }
    if (doc.status !== "approved") { skipped.push(doc.slug); continue; }
    for (const step of doc.steps) {
      if (b.get(step.card)) continue;
      if (!dryRun) b.add(step.card, compileStepSpec(doc, step), "plan-doc");
      added.push(step.card);
    }
  }
  return { docs: docs.length, added, rejected, skipped };
}

/** The skeleton `init` writes. Filling this in IS the planning work. */
export function planTemplate(slug: string, title = ""): string {
  return `---
plan: ${slug}
status: draft
risk: low
owner:
---
# Plan: ${title || slug}

## Intent
<한 문장으로: 이 계획이 끝났을 때 관찰 가능한 결과는 무엇인가>

## Non-goals
- <일부러 하지 않는 것. 스코프 크리프는 대부분 여기가 비어 있어서 생긴다>

## Steps

### Step 1: ${slug}-first-step
- Goal: <관찰 가능한 결과 한 문장>
- Files: path/to/file.ts, tests/thing.test.ts
- Acceptance: AC-1: <리뷰어가 저장소나 테스트로 확인할 수 있는 증거>
- Tests: <acceptance를 증명하는 명령>
- Risk: low
- Complexity: low

### Step 2: ${slug}-second-step
- Goal: <...>
- Files: path/to/other.ts
- Acceptance: AC-1: <...>
- Tests: <...>
- Parallel: no   # yes → 앞 단계와 같은 wave에서 동시에 실행된다

## Verification
<3계층 게이트: Tier 1 정적검사 / Tier 2 테스트 / Tier 3 실행·시각 검증>

## Reviewer topology
<빌더와 다른 프로바이더가 리뷰한다. 예: builder=codex, reviewer=claude, challenge=on>
`;
}

/**
 * Update the frontmatter `status:` value in place while preserving all other content.
 */
export function setFrontmatterStatus(src: string, newStatus: string): string {
  const m = src.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/);
  if (!m) return src;
  const openDelimiter = m[1] ?? "---\n";
  const inner = m[2] ?? "";
  const closeDelimiter = m[3] ?? "\n---";
  const remainder = src.slice(m[0].length);

  let updatedInner: string;
  if (/^(\s*status:\s*)[^\r\n]*/im.test(inner)) {
    updatedInner = inner.replace(/^(\s*status:\s*)[^\r\n]*/im, `$1${newStatus}`);
  } else {
    const eol = openDelimiter.includes("\r\n") ? "\r\n" : "\n";
    updatedInner = inner ? `${inner}${eol}status: ${newStatus}` : `status: ${newStatus}`;
  }
  return openDelimiter + updatedInner + closeDelimiter + remainder;
}

export interface ReadyPlanResult {
  ok: boolean;
  slug: string;
  title: string;
  status: string;
  risk: string;
  totalCards: number;
  addedCards: string[];
  waves: string[][];
  wave1Steps: PlanStep[];
  errors: string[];
}

/**
 * Validate, approve (if draft), compile to backlog, and extract wave 1 cards for immediate execution.
 * Fail-closed: any placeholder or validation error blocks approval and compilation.
 */
export async function readyPlanDoc(
  slug: string,
  {
    cwd = ROOT,
    dryRun = false,
    backlog,
    cfg = planConfig(cwd),
  }: {
    cwd?: string;
    dryRun?: boolean;
    backlog?: BacklogLike;
    cfg?: PlanConfig;
  } = {},
): Promise<ReadyPlanResult> {
  const file = planPath(slug, cwd, cfg);
  if (!existsSync(file)) {
    return {
      ok: false,
      slug,
      title: "",
      status: "",
      risk: "",
      totalCards: 0,
      addedCards: [],
      waves: [],
      wave1Steps: [],
      errors: [`plan document not found: ${file}`],
    };
  }

  const raw = readFileSync(file, "utf8");
  let doc = parsePlanDoc(raw, file);

  // Validate the plan against the approved contract:
  // Even if current status is draft, readying it requires that it satisfies
  // all requirements of an approved plan (acceptance, tests, owner if high risk, no placeholders).
  const candidateDoc: PlanDoc = doc.status === "draft"
    ? {
        ...doc,
        status: "approved",
        steps: doc.steps.map((s) => ({ ...s, status: "ready" })),
      }
    : doc;

  const errors = validatePlanDoc(candidateDoc);
  const placeholders = placeholderFields(doc);
  for (const p of placeholders) {
    const msg = `${p} is still the skeleton's <placeholder> — an approved plan has no blanks`;
    if (!errors.includes(msg)) errors.push(msg);
  }

  if (errors.length > 0) {
    return {
      ok: false,
      slug: doc.slug,
      title: doc.title,
      status: doc.status,
      risk: doc.risk,
      totalCards: doc.steps.length,
      addedCards: [],
      waves: waves(doc.steps),
      wave1Steps: [],
      errors,
    };
  }

  // If status is draft, update the file's frontmatter to 'status: approved' on disk
  if (doc.status === "draft") {
    const updatedRaw = setFrontmatterStatus(raw, "approved");
    if (!dryRun) {
      writeFileSync(file, updatedRaw, "utf8");
    }
    doc = parsePlanDoc(updatedRaw, file);
  }

  // Compile the plan into backlog cards
  const compileResult = await compilePlanDocs({
    cwd,
    dryRun,
    backlog,
    cfg,
    docs: dryRun ? listPlanDocs(cwd, cfg).map((d) => (d.slug === doc.slug ? doc : d)) : undefined,
  });

  const planCards = new Set(doc.steps.map((s) => s.card));
  const planAdded = compileResult.added.filter((c) => planCards.has(c));

  const waveLevels = waves(doc.steps);
  const wave1Cards = new Set(waveLevels[0] || []);
  const wave1Steps = doc.steps.filter((s) => wave1Cards.has(s.card));

  return {
    ok: true,
    slug: doc.slug,
    title: doc.title,
    status: doc.status,
    risk: doc.risk,
    totalCards: doc.steps.length,
    addedCards: planAdded,
    waves: waveLevels,
    wave1Steps,
    errors: [],
  };
}

// CLI
const isMainModule = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isMainModule) {
  const [cmd = "list", ...rest] = process.argv.slice(2);
  const cfg = planConfig();
  const dry = process.argv.includes("--dry");

  if (cmd === "init") {
    const slug = (rest[0] || "").toLowerCase();
    if (!SLUG.test(slug)) { console.error("usage: plan-doc.ts init <lowercase-slug> [\"title\"]"); process.exit(2); }
    const out = planPath(slug, ROOT, cfg);
    if (existsSync(out)) { console.error(`plan-doc: ${out} already exists`); process.exit(1); }
    mkdirSync(resolve(ROOT, cfg.planDir), { recursive: true });
    writeFileSync(out, planTemplate(slug, rest.slice(1).join(" ")), "utf8");
    console.log(`wrote ${cfg.planDir}/${slug}${PLAN_SUFFIX} (status: draft — fill it in, then set status: approved)`);
  } else if (cmd === "check") {
    const docs = rest[0] ? listPlanDocs(ROOT, cfg).filter((d) => d.slug === rest[0]) : listPlanDocs(ROOT, cfg);
    if (!docs.length) { console.error(`plan-doc: no plan documents in ${cfg.planDir}/`); process.exit(1); }
    let bad = 0;
    for (const doc of docs) {
      const errors = validatePlanDoc(doc);
      if (errors.length) {
        bad++;
        console.error(`✗ ${doc.slug} (${doc.status})`);
        for (const e of errors) console.error(`  - ${e}`);
      } else {
        // A draft is allowed to be incomplete, but "✓" on an untouched skeleton
        // reads as "ready" — say how many blanks are left instead.
        const blanks = placeholderFields(doc);
        const note = blanks.length ? `  — ${blanks.length} unfilled placeholder(s): ${blanks.slice(0, 4).join(", ")}` : "";
        console.log(`✓ ${doc.slug} (${doc.status}, risk=${doc.risk || "unset"}, ${doc.steps.length} step(s), ${waves(doc.steps).length} wave(s))${note}`);
      }
    }
    if (bad) process.exitCode = 1;
  } else if (cmd === "waves") {
    const doc = listPlanDocs(ROOT, cfg).find((d) => d.slug === rest[0]);
    if (!doc) { console.error(`plan-doc: no such plan: ${rest[0]}`); process.exit(1); }
    waves(doc.steps).forEach((level, i) => console.log(`wave ${i + 1}: ${level.join(", ")}`));
    console.log(`maxParallel=${cfg.waves.maxParallel}`);
  } else if (cmd === "compile") {
    const r = await compilePlanDocs({ dryRun: dry, cfg });
    for (const card of r.added) console.log(`${dry ? "would-add" : "added"} ${card}`);
    for (const item of r.rejected) console.error(`rejected ${item.plan}: ${item.errors.join("; ")}`);
    for (const slug of r.skipped) console.log(`skipped ${slug} (status: draft)`);
    console.log(`plan-doc: ${r.docs} doc(s), ${r.added.length} new card(s), ${r.rejected.length} rejected`);
    if (r.rejected.length) process.exitCode = 1;
  } else if (cmd === "ready") {
    const slug = (rest[0] || "").toLowerCase();
    if (!slug) {
      console.error("usage: plan-doc.ts ready <slug>");
      process.exit(2);
    }
    const result = await readyPlanDoc(slug, { cwd: ROOT, cfg, dryRun: dry });
    if (!result.ok) {
      console.error(`✗ plan-doc ready: ${slug} has validation errors:`);
      for (const err of result.errors) console.error(`  - ${err}`);
      process.exit(1);
    }
    console.log(`Plan: ${result.slug} ("${result.title || result.slug}")`);
    console.log(`Status: ${result.status} | Risk: ${result.risk || "low"}`);
    console.log(`Compiled backlog cards: ${result.totalCards} (${result.addedCards.length} newly added)`);
    console.log(`\nWave 1 immediately actionable (${result.wave1Steps.length} card(s)):`);
    for (const step of result.wave1Steps) {
      console.log(`\n  • Card: ${step.card}`);
      console.log(`    Goal:  ${step.goal}`);
      console.log(`    Files: ${step.files.join(", ")}`);
      console.log(`    Tests: ${step.tests.join(" && ")}`);
    }
  } else {
    const docs = listPlanDocs(ROOT, cfg);
    if (!docs.length) console.log(`no plan documents in ${cfg.planDir}/ — start one with: node scripts/loop/plan-doc.ts init <slug>`);
    for (const doc of docs) {
      console.log(`${doc.status === "approved" ? "●" : "○"} ${doc.slug}  risk=${doc.risk || "unset"}  steps=${doc.steps.length}  ${doc.title}`);
    }
  }
}
