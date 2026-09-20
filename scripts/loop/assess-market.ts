// assess-market.ts — evidence-led market research that feeds the backlog.

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getBacklog } from "./backlog.ts";
import { parseStructured, retryPrompt, type Parsed } from "./schema.ts";
import { laneArgs } from "./lanes.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(process.cwd());
const SCHEMA = {
  type: "array",
  items: {
    type: "object",
    required: ["card", "opportunity", "evidence", "spec"],
    properties: {
      card: { type: "string", pattern: "^[a-z0-9][a-z0-9-]*$" },
      opportunity: { type: "string", minLength: 8 },
      evidence: { type: "array", items: { type: "string" } },
      spec: { type: "string", minLength: 20 },
    },
  },
};

/** What one agent-session run returned. */
interface AgentRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** One market opportunity the agent proposed, shaped by SCHEMA. */
interface Opportunity {
  card: string;
  opportunity: string;
  evidence?: string[];
  spec: string;
}

/** The minimum of backlog.ts this needs — kept narrow so it stays injectable in tests. */
interface BacklogLike {
  list(): Array<{ card: string }>;
  add(card: string, spec: string, source: string): Promise<unknown> | unknown;
}

function invoke(prompt: string): Promise<AgentRun> {
  return new Promise<AgentRun>((done) => {
    const child = spawn(process.execPath, [resolve(HERE, "..", "agent-session.ts"), ...laneArgs("market"), prompt], {
      cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (x) => { stdout += x; });
    child.stderr.on("data", (x) => { stderr += x; });
    child.on("exit", (code) => done({ code, stdout, stderr }));
  });
}

export async function assessMarket(backlog: BacklogLike) {
  const prompt = [
    "Act as a market researcher for this repository. Read README, DESIGN, specs, and recent telemetry.",
    "Use current, attributable evidence. When an Orca built-in browser is available, research competitor positioning, user complaints, pricing, and workflow gaps there.",
    "Do not edit code. Propose only opportunities that fit the product direction and can be validated cheaply.",
    "Return only JSON array objects: card, opportunity, evidence (URLs or repository paths), spec.",
    "Every spec must contain a measurable acceptance criterion and a test/experiment. Return [] if evidence is weak.",
  ].join("\n");
  let result = await invoke(prompt);
  // The failure arm is a Parsed too, so callers see one shape whether the agent
  // ran or not — a literal missing `value` used to split this into a union.
  let parsed: Parsed<Opportunity[]> = result.code === 0
    ? parseStructured<Opportunity[]>(result.stdout, SCHEMA)
    : { ok: false, value: null, errors: ["agent failed"] };
  if (!parsed.ok && result.code === 0) {
    result = await invoke(retryPrompt(prompt, parsed.errors, result.stdout));
    parsed = result.code === 0 ? parseStructured<Opportunity[]>(result.stdout, SCHEMA) : parsed;
  }
  const existing = new Set(backlog.list().map((x) => x.card));
  const added: string[] = [];
  const proposals: Opportunity[] = parsed.ok ? (parsed.value ?? []).slice(0, 3) : [];
  for (const item of proposals) {
    if (existing.has(item.card) || !item.evidence?.length) continue;
    await backlog.add(
      item.card,
      `${item.spec}\n\nMarket opportunity: ${item.opportunity}\nEvidence:\n${(item.evidence ?? []).map((x) => `- ${x}`).join("\n")}`,
      "market",
    );
    added.push(item.card);
  }
  return { added };
}

const isMain = (() => {
  try { return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (isMain) assessMarket(await getBacklog()).then(console.log).catch((e) => { console.error(e); process.exit(1); });
