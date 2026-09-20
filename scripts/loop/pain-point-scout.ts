// pain-point-scout.ts — background, evidence-led user-journey audit.
//
// Ralph launches this scout while idle. It never edits product code: it inspects
// the service from a user's perspective and queues bounded, actionable cards.

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync,
  rmSync, statSync, writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getBacklog } from "./backlog.ts";
import { parseStructured, retryPrompt, type Parsed } from "./schema.ts";
import { laneArgs } from "./lanes.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(process.cwd());
const STATE_DIR = resolve(process.env.HARNESS_STATE_DIR || resolve(ROOT, ".harness"));
const LOCK_PATH = resolve(STATE_DIR, "pain-point-scout.lock");
const STATE_PATH = resolve(STATE_DIR, "pain-points.json");

const PROFILES = {
  "web-app": {
    journeys: ["first visit and onboarding", "primary task with loading/empty/error states", "keyboard and narrow-screen use"],
    qualities: ["task completion", "accessibility", "responsive feedback", "recovery"],
  },
  api: {
    journeys: ["authentication and first successful request", "invalid input and actionable error recovery", "retry, rate-limit, and partial-failure handling"],
    qualities: ["contract clarity", "safe defaults", "idempotency", "observability"],
  },
  cli: {
    journeys: ["installation and first command", "invalid arguments and error recovery", "non-interactive CI use and interruption"],
    qualities: ["discoverability", "exit codes", "actionable errors", "cross-platform behavior"],
  },
  library: {
    journeys: ["installation and smallest working example", "common integration and type feedback", "upgrade and failure diagnosis"],
    qualities: ["API ergonomics", "compatibility", "documentation accuracy", "diagnostics"],
  },
  "agent-workflow": {
    journeys: ["goal submission and progress visibility", "tool failure, retry, and human takeover", "result verification and safe rollback"],
    qualities: ["result usefulness", "grounding", "controllability", "recovery"],
  },
  service: {
    journeys: ["setup and first useful result", "primary repeated task", "failure recovery and support diagnosis"],
    qualities: ["usefulness", "reliability", "clarity", "operability"],
  },
};

type ServiceType = keyof typeof PROFILES;

/** One pain point the scout proposes, validated before it becomes a card. */
export interface Finding {
  card: string;
  journey: string;
  pain: string;
  spec: string;
  severity: string;
  evidence: string[];
  fingerprint?: string;
}

interface AgentRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

function readJson(path: string, fallback: Record<string, unknown> = {}): Record<string, any> {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}

export function detectServiceType(root = ROOT) {
  const configured = readJson(resolve(root, ".harness-service.json")).type;
  if (configured && configured !== "auto" && PROFILES[configured as ServiceType]) return configured as ServiceType;
  const pkg = readJson(resolve(root, "package.json"));
  if (pkg.bin) return "cli";
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (["next", "react", "vue", "svelte", "@angular/core"].some((x) => deps[x])) return "web-app";
  if (["express", "fastify", "koa", "hono", "@nestjs/core"].some((x) => deps[x])) return "api";
  if (existsSync(resolve(root, "wrangler.toml")) || existsSync(resolve(root, "wrangler.jsonc"))) return "api";
  if (pkg.main || pkg.exports) return "library";
  if (existsSync(resolve(root, ".claude")) || existsSync(resolve(root, ".agents"))) return "agent-workflow";
  return "service";
}

export function serviceProfile(type: string, extraJourneys: string[] = []) {
  const base = PROFILES[type as ServiceType] || PROFILES.service;
  return { ...base, journeys: [...base.journeys, ...extraJourneys.filter(Boolean)] };
}

function fingerprint(item: Finding): string {
  const normalized = `${item.journey}|${item.pain}`.toLowerCase().replace(/\s+/g, " ").trim();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 20);
}

export function selectPainPoints(
  findings: unknown,
  { max = 3, seen = [] }: { max?: number; seen?: string[] } = {},
): Finding[] {
  const known = new Set<string>(seen);
  const severity: Record<string, number> = { blocker: 4, high: 3, medium: 2, low: 1 };
  return ((Array.isArray(findings) ? findings : []) as Finding[])
    .filter((x) =>
      x && typeof x.card === "string" && /^[a-z0-9][a-z0-9-]*$/.test(x.card) &&
      typeof x.journey === "string" && typeof x.pain === "string" &&
      typeof x.spec === "string" && x.spec.length >= 20 &&
      Array.isArray(x.evidence) && x.evidence.some((e: unknown) => typeof e === "string" && e.trim()) &&
      ["blocker", "high"].includes(x.severity))
    .sort((a, b) => (severity[b.severity] ?? 0) - (severity[a.severity] ?? 0))
    .filter((x) => {
      const key = fingerprint(x);
      if (known.has(key)) return false;
      known.add(key);
      x.fingerprint = key;
      return true;
    })
    .slice(0, Math.max(0, max));
}

function config(root = ROOT) {
  const raw = readJson(resolve(root, ".harness-service.json"));
  return {
    type: detectServiceType(root),
    enabled: raw.backgroundScout?.enabled !== false && process.env.PAIN_POINT_SCOUT !== "0",
    intervalHours: Number(process.env.PAIN_POINT_INTERVAL_HOURS || raw.backgroundScout?.intervalHours || 24),
    maxFindings: Number(process.env.PAIN_POINT_MAX_FINDINGS || raw.backgroundScout?.maxFindings || 3),
    primaryJourneys: Array.isArray(raw.primaryJourneys) ? raw.primaryJourneys : [],
  };
}

function isFresh(path: string, hours: number): boolean {
  try { return Date.now() - statSync(path).mtimeMs < hours * 3_600_000; } catch { return false; }
}

export function startPainPointScout({ root = ROOT } = {}) {
  const cfg = config(root);
  if (!cfg.enabled) return { started: false, reason: "disabled" };
  mkdirSync(STATE_DIR, { recursive: true });
  const state = readJson(STATE_PATH, { lastRun: null });
  if (state.lastRun && Date.now() - Date.parse(state.lastRun) < cfg.intervalHours * 3_600_000) {
    return { started: false, reason: "cooldown" };
  }
  if (existsSync(LOCK_PATH)) {
    if (isFresh(LOCK_PATH, 2)) return { started: false, reason: "running" };
    rmSync(LOCK_PATH, { force: true });
  }
  let fd;
  try {
    fd = openSync(LOCK_PATH, "wx");
    closeSync(fd);
  } catch {
    return { started: false, reason: "running" };
  }
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--run"], {
    cwd: root,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, HARNESS_PAIN_SCOUT_CHILD: "1" },
  });
  child.once("error", () => rmSync(LOCK_PATH, { force: true }));
  child.unref();
  return { started: true, pid: child.pid, type: cfg.type };
}

const FINDINGS_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    required: ["card", "journey", "pain", "evidence", "severity", "spec"],
    properties: {
      card: { type: "string", pattern: "^[a-z0-9][a-z0-9-]*$" },
      journey: { type: "string", minLength: 3 },
      pain: { type: "string", minLength: 8 },
      evidence: { type: "array", items: { type: "string" } },
      severity: { type: "string" },
      spec: { type: "string", minLength: 20 },
    },
  },
};

function invoke(prompt: string): Promise<AgentRun> {
  const script = resolve(HERE, "..", "agent-session.ts");
  return new Promise<AgentRun>((done) => {
    const child = spawn(process.execPath, [script, ...laneArgs("painPoints"), prompt], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (x) => { stdout += x; });
    child.stderr.on("data", (x) => { stderr += x; });
    child.on("exit", (code) => done({ code, stdout, stderr }));
  });
}

interface BacklogLike {
  list(): Array<{ card: string }>;
  add(card: string, spec: string, source: string): Promise<unknown> | unknown;
}

export async function runPainPointScout(backlog: BacklogLike) {
  const cfg = config();
  const profile = serviceProfile(cfg.type, cfg.primaryJourneys);
  const state = readJson(STATE_PATH, { findings: [] });
  const prompt = [
    `Act as a background user-pain scout for a ${cfg.type} service.`,
    `Test or inspect these journeys: ${profile.journeys.join("; ")}.`,
    `Judge: ${profile.qualities.join(", ")}.`,
    "Use repository tests, logs, screenshots, traces, docs, and runnable flows. Do not edit files.",
    "Report only pains that prevent a production-usable result. Every finding must cite concrete file/test/log/trace evidence.",
    "Return only a JSON array with card, journey, pain, evidence (string array), severity (blocker|high|medium|low), and spec.",
    "The spec must name an acceptance test or observable proof. Return [] when evidence is insufficient.",
  ].join("\n");
  let result = await invoke(prompt);
  let parsed: Parsed<Finding[]> = result.code === 0
    ? parseStructured<Finding[]>(result.stdout, FINDINGS_SCHEMA)
    : { ok: false, value: null, errors: ["agent failed"] };
  if (!parsed.ok && result.code === 0) {
    result = await invoke(retryPrompt(prompt, parsed.errors, result.stdout));
    parsed = result.code === 0 ? parseStructured<Finding[]>(result.stdout, FINDINGS_SCHEMA) : parsed;
  }
  const chosen = selectPainPoints(parsed.ok ? parsed.value : [], {
    max: cfg.maxFindings,
    seen: (state.findings || []).map((x: Finding) => x.fingerprint).filter(Boolean) as string[],
  });
  const cards = new Set(backlog.list().map((x) => x.card));
  for (const item of chosen) {
    if (cards.has(item.card)) continue;
    const evidence = item.evidence.map((x: string) => `- ${x}`).join("\n");
    await backlog.add(item.card, `${item.spec}\n\nUser journey: ${item.journey}\nPain: ${item.pain}\nEvidence:\n${evidence}`, "pain-point");
  }
  writeFileSync(STATE_PATH, JSON.stringify({
    lastRun: new Date().toISOString(),
    serviceType: cfg.type,
    findings: [...(state.findings || []), ...chosen].slice(-100),
  }, null, 2) + "\n");
  return { added: chosen.length, type: cfg.type };
}

const isMain = (() => {
  try { return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

if (isMain && process.argv.includes("--run")) {
  try {
    await runPainPointScout(await getBacklog());
  } catch (error) {
    console.error(`[PainScout] ${(error as Error)?.message ?? error}`);
    process.exitCode = 1;
  } finally {
    rmSync(LOCK_PATH, { force: true });
  }
}
