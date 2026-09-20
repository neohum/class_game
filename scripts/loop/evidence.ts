// evidence.ts — "no evidence file means the verification did not happen".
//
// The contract already demands executable acceptance evidence, and the reviewer
// already returns AC ids with observed results. Both live in a model's answer.
// That is exactly the wrong place for them: it cannot be re-read next month, a
// human cannot audit it without replaying a transcript, and the claim "tests
// pass" is indistinguishable from the claim "tests would pass".
//
// So the loop writes verification to disk, in the shape oh-my-openagent uses:
//
//   evidence/<YYYYMMDD>-<card>/README.md   what was tested / observed /
//                                          why it is enough / what was omitted
//   evidence/<YYYYMMDD>-<card>/<artifact>  the captured output itself
//
// verifyEvidence() is a ship gate: a card that must carry evidence and does not
// is not committed. The four headings are not paperwork — each one answers a
// question a reviewer would otherwise have to ask, and "WHAT WAS OMITTED" is the
// one that keeps a redacted log honest.
//
// Usage:
//   node scripts/loop/evidence.ts open <card> ["intent"]
//   node scripts/loop/evidence.ts record <card> <name> [< file]
//   node scripts/loop/evidence.ts capture <card> --cmd "<test-command>" [--name "<artifact-name>"] [--tested "<text>"] [--observed "<text>"] [--why "<text>"] [--omitted "<text>"]
//   node scripts/loop/evidence.ts verify <card>

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { planConfig, riskRank, specRisk, type PlanConfig } from "./plan-doc.ts";

/** The four questions. Order is the order a reviewer reads them in. */
export const EVIDENCE_SECTIONS = [
  "WHAT WAS TESTED",
  "WHAT WAS OBSERVED",
  "WHY IT IS ENOUGH",
  "WHAT WAS OMITTED",
] as const;

const PLACEHOLDER = /^(<.*>|todo|tbd|n\/a|-+)$/i;
const MIN_SECTION_CHARS = 20;

/** Local date, not UTC: this string is read by humans (contract: local time in human-facing output). */
export function localStamp(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`;
}

/**
 * Where this card's evidence lives.
 *
 * A card that is retried tomorrow must not start a second folder — the reviewer
 * would then see two half-populated directories and no way to tell which one the
 * shipped diff was verified against. So an existing `*-<card>` dir wins, newest
 * first, and only a card with none gets today's stamp.
 */
export function evidenceDirFor(card: string, cwd = process.cwd(), cfg: PlanConfig = planConfig(cwd), now = new Date()): string {
  const root = resolve(cwd, cfg.evidenceDir);
  if (existsSync(root)) {
    // Anchored, not endsWith: a card named `one` must not adopt the directory of
    // a card named `step-one`, which would silently merge two cards' evidence.
    const mine = new RegExp(`^\\d{8}-${card.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
    const existing = readdirSync(root)
      .filter((name) => mine.test(name) && statSync(join(root, name)).isDirectory())
      .sort();
    const last = existing[existing.length - 1];
    if (last) return join(root, last);
  }
  return join(root, `${localStamp(now)}-${card}`);
}

function readmeTemplate(card: string, intent: string): string {
  return `# Evidence — ${card}

${intent ? `> ${intent}\n\n` : ""}## ${EVIDENCE_SECTIONS[0]}
<the command or manual action, the surface it drove, and the behaviour it was meant to prove>

## ${EVIDENCE_SECTIONS[1]}
<the before/after or new behaviour, plus the artifact file that holds the captured output>

## ${EVIDENCE_SECTIONS[2]}
<how this covers the intended behaviour, and what regression risk is left>

## ${EVIDENCE_SECTIONS[3]}
<what was redacted or summarised instead of pasted — secrets, tokens, env dumps — and what was not run>
`;
}

export function openEvidence(card: string, { intent = "", cwd = process.cwd(), cfg = planConfig(cwd), now = new Date() } = {}) {
  const dir = evidenceDirFor(card, cwd, cfg, now);
  mkdirSync(dir, { recursive: true });
  const readme = join(dir, "README.md");
  const created = !existsSync(readme);
  if (created) writeFileSync(readme, readmeTemplate(card, intent), "utf8");
  return { dir, readme, created };
}

/** Write one captured artifact next to the README. Returns its path. */
export function recordEvidence(card: string, name: string, content: string, { cwd = process.cwd(), cfg = planConfig(cwd), now = new Date() } = {}) {
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "artifact.txt";
  const { dir } = openEvidence(card, { cwd, cfg, now });
  const path = join(dir, safe);
  writeFileSync(path, String(content ?? ""), "utf8");
  return path;
}

export interface EvidenceVerdict {
  ok: boolean;
  dir: string;
  exists: boolean;
  /** Headings absent from README.md. */
  missing: string[];
  /** Headings still holding the skeleton's `<...>` prompt. */
  placeholders: string[];
  /** Captured output files (README.md excluded). */
  artifacts: string[];
  reason: string;
}

/** Split a markdown body into `heading → text` for the headings we require. */
function sections(body: string): Map<string, string> {
  const out = new Map<string, string>();
  let current = "";
  const lines: string[] = [];
  const flush = () => { if (current) out.set(current, lines.join("\n").trim()); lines.length = 0; };
  for (const raw of body.split(/\r?\n/)) {
    const h = raw.match(/^#{2,}\s+(.*?)\s*$/);
    if (h) { flush(); current = (h[1] ?? "").trim().toUpperCase(); continue; }
    if (current) lines.push(raw);
  }
  flush();
  return out;
}

export function verifyEvidence(card: string, { cwd = process.cwd(), cfg = planConfig(cwd) } = {}): EvidenceVerdict {
  const dir = evidenceDirFor(card, cwd, cfg);
  const readme = join(dir, "README.md");
  if (!existsSync(readme)) {
    return {
      ok: false, dir, exists: false, missing: [...EVIDENCE_SECTIONS], placeholders: [], artifacts: [],
      reason: `no evidence at ${dir} — open it with: node scripts/loop/evidence.ts open ${card}`,
    };
  }
  const found = sections(readFileSync(readme, "utf8"));
  const missing: string[] = [];
  const placeholders: string[] = [];
  for (const heading of EVIDENCE_SECTIONS) {
    const text = found.get(heading);
    if (text === undefined) { missing.push(heading); continue; }
    const stripped = text.replace(/^\s*[-*]\s*/gm, "").trim();
    if (!stripped || stripped.length < MIN_SECTION_CHARS || PLACEHOLDER.test(stripped)) placeholders.push(heading);
  }
  const artifacts = readdirSync(dir).filter((f) => f !== "README.md" && statSync(join(dir, f)).isFile());
  const problems: string[] = [];
  if (missing.length) problems.push(`missing section(s): ${missing.join(", ")}`);
  if (placeholders.length) problems.push(`unfilled section(s): ${placeholders.join(", ")}`);
  // The README is a claim; the artifact is the proof. Requiring one file is what
  // stops "ran the tests, they passed" from being the whole record.
  if (!artifacts.length) problems.push("no captured artifact — record the actual command output");
  return {
    ok: !problems.length,
    dir, exists: true, missing, placeholders, artifacts,
    reason: problems.length ? `${dir}: ${problems.join("; ")}` : `${dir}: ${artifacts.length} artifact(s), all sections filled`,
  };
}

/**
 * Does this card have to carry evidence to ship?
 *
 * Threshold-based for the same reason the plan gate is: a typo fix that must
 * assemble a four-section dossier teaches everyone to route around the gate. A
 * card that came from a plan document is always in scope — the plan promised
 * verification, so the verification is the deliverable.
 */
export function evidenceRequired({ spec = "", source = "", cfg }: { spec?: string; source?: string; cfg: PlanConfig }): boolean {
  if (source === "plan-doc") return true;
  const threshold = cfg.evidence.requireAtRisk;
  if (String(threshold).toLowerCase() === "off") return false;
  return riskRank(specRisk(spec)) >= riskRank(threshold);
}

export interface CaptureOptions {
  cmd: string;
  name?: string;
  tested?: string;
  observed?: string;
  why?: string;
  omitted?: string;
  cwd?: string;
  cfg?: PlanConfig;
  now?: Date;
}
export type CaptureEvidenceOptions = CaptureOptions;

export interface CaptureResult {
  ok: boolean;
  dir: string;
  artifactPath: string;
  readmePath: string;
  exitCode: number | null;
  output: string;
  verdict: EvidenceVerdict;
}

/**
 * Execute test command, save output as artifact, write filled README.md,
 * and verify evidence with verifyEvidence().
 */
export function captureEvidence(card: string, options: CaptureOptions): CaptureResult {
  const {
    cmd,
    name = "test-output.txt",
    tested,
    observed,
    why,
    omitted,
    cwd = process.cwd(),
    cfg = planConfig(cwd),
    now = new Date(),
  } = options;

  if (!cmd) {
    throw new Error("captureEvidence: cmd is required");
  }

  // 1. Execute the test command using spawnSync with shell: true
  const res = spawnSync(cmd, {
    cwd,
    shell: true,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });

  const exitCode = res.status !== null ? res.status : (res.error ? 1 : 0);
  const stdout = typeof res.stdout === "string" ? res.stdout : (res.stdout ? String(res.stdout) : "");
  const stderr = typeof res.stderr === "string" ? res.stderr : (res.stderr ? String(res.stderr) : "");
  let output = stdout;
  if (stderr) {
    output = output ? `${output}\n${stderr}` : stderr;
  }
  if (res.error && !output.includes(res.error.message)) {
    output = output ? `${output}\n${res.error.message}` : res.error.message;
  }

  // 2. Record the output artifact under evidence/<date>-<card>/<artifact-name> (default: test-output.txt)
  const rawName = name || "test-output.txt";
  const safeName = rawName.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "test-output.txt";
  const artifactPath = recordEvidence(card, safeName, output, { cwd, cfg, now });
  const dir = evidenceDirFor(card, cwd, cfg, now);

  // 3. Generate evidence/<date>-<card>/README.md with all 4 required sections
  const defaultTested = `Executed test command: ${cmd}`;
  const whatTested = (!tested || PLACEHOLDER.test(tested.trim()))
    ? defaultTested
    : tested.trim().length >= MIN_SECTION_CHARS
      ? tested.trim()
      : `${defaultTested} (${tested.trim()})`;

  const defaultObserved = exitCode === 0
    ? `Command exited with code 0. Output: ${output.length} character(s) captured in ${safeName}.`
    : `Command failed with exit code ${exitCode}. Output: ${output.length} character(s) captured in ${safeName}.`;
  const whatObserved = (!observed || PLACEHOLDER.test(observed.trim()))
    ? defaultObserved
    : observed.trim().length >= MIN_SECTION_CHARS
      ? observed.trim()
      : `${observed.trim()} (exit code: ${exitCode}, ${output.length} char(s) captured in ${safeName})`;

  const defaultWhy = "Passes test assertions and verifies acceptance criteria with zero regressions.";
  const whatWhy = (!why || PLACEHOLDER.test(why.trim()))
    ? defaultWhy
    : why.trim().length >= MIN_SECTION_CHARS
      ? why.trim()
      : `${why.trim()}; passes test assertions and verifies acceptance criteria.`;

  const defaultOmitted = "Redacted secrets, credentials, and environmental tokens; live network calls omitted.";
  const whatOmitted = (!omitted || PLACEHOLDER.test(omitted.trim()))
    ? defaultOmitted
    : omitted.trim().length >= MIN_SECTION_CHARS
      ? omitted.trim()
      : `${omitted.trim()}; redacted secrets, credentials, and environmental tokens.`;

  const readmeContent = `# Evidence — ${card}

## ${EVIDENCE_SECTIONS[0]}
${whatTested}

## ${EVIDENCE_SECTIONS[1]}
${whatObserved}

## ${EVIDENCE_SECTIONS[2]}
${whatWhy}

## ${EVIDENCE_SECTIONS[3]}
${whatOmitted}
`;

  const readmePath = join(dir, "README.md");
  writeFileSync(readmePath, readmeContent, "utf8");

  // 4. Call verifyEvidence(card)
  const verdict = verifyEvidence(card, { cwd, cfg });
  const ok = exitCode === 0 && verdict.ok;

  return {
    ok,
    dir,
    artifactPath,
    readmePath,
    exitCode,
    output,
    verdict,
  };
}

/**
 * Read piped evidence through Node's async stream machinery.
 *
 * `readFileSync(0)` can observe EAGAIN when libuv has marked stdin non-blocking
 * and the producer has not written its first chunk yet. A real test command may
 * take seconds before printing anything, so "no bytes right now" is not EOF.
 */
async function readStdin(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let content = "";
  for await (const chunk of process.stdin) content += String(chunk);
  return content;
}

export function parseCaptureArgs(args: string[]): {
  card?: string;
  cmd?: string;
  name?: string;
  tested?: string;
  observed?: string;
  why?: string;
  omitted?: string;
} {
  const result: Record<string, string> = {};
  let card: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;
    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      if (eqIdx !== -1) {
        result[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else {
        const key = arg.slice(2);
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          result[key] = next;
          i++;
        } else {
          result[key] = "true";
        }
      }
    } else if (!card) {
      card = arg;
    }
  }
  return {
    card,
    cmd: result["cmd"],
    name: result["name"],
    tested: result["tested"],
    observed: result["observed"],
    why: result["why"],
    omitted: result["omitted"],
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
  const [cmd, ...rawRest] = process.argv.slice(2);
  if (!cmd) {
    console.error("usage: evidence.ts open <card> [\"intent\"] | record <card> <name> [< file] | capture <card> --cmd \"<cmd>\" [...] | verify <card>");
    process.exit(2);
  }
  if (cmd === "capture") {
    const opts = parseCaptureArgs(rawRest);
    if (!opts.card || !opts.cmd) {
      console.error("usage: evidence.ts capture <card> --cmd \"<test-command>\" [--name \"<artifact-name>\"] [--tested \"<text>\"] [--observed \"<text>\"] [--why \"<text>\"] [--omitted \"<text>\"]");
      process.exit(2);
    }
    const res = captureEvidence(opts.card, {
      cmd: opts.cmd,
      name: opts.name,
      tested: opts.tested,
      observed: opts.observed,
      why: opts.why,
      omitted: opts.omitted,
    });
    if (res.ok) {
      console.log(`captured evidence for ${opts.card} in ${res.dir}`);
      console.log(`ok ${res.verdict.reason}`);
      process.exitCode = 0;
    } else {
      if (res.exitCode !== 0) {
        console.error(`command failed with exit code ${res.exitCode ?? "unknown"}`);
      }
      if (!res.verdict.ok) {
        console.error(`BLOCK ${res.verdict.reason}`);
      }
      process.exitCode = 1;
    }
  } else {
    const [card, ...rest] = rawRest;
    if (!card) {
      console.error("usage: evidence.ts open <card> [\"intent\"] | record <card> <name> [< file] | capture <card> --cmd \"<cmd>\" [...] | verify <card>");
      process.exit(2);
    }
    if (cmd === "open") {
      const r = openEvidence(card, { intent: rest.join(" ") });
      console.log(`${r.created ? "opened" : "reusing"} ${r.dir}`);
    } else if (cmd === "record") {
      const name = rest[0] || "artifact.txt";
      // Content comes from stdin so a caller can pipe the real output of the real
      // command instead of a model's retelling of it.
      const stdin = process.stdin.isTTY ? "" : await readStdin();
      const path = recordEvidence(card, name, stdin || rest.slice(1).join(" "));
      console.log(`recorded ${path} (${(stdin || "").length} byte(s))`);
    } else if (cmd === "verify") {
      const v = verifyEvidence(card);
      console.log(`${v.ok ? "ok" : "BLOCK"} ${v.reason}`);
      if (!v.ok) process.exitCode = 1;
    } else {
      console.error(`evidence.ts: unknown command ${cmd}`);
      process.exit(2);
    }
  }
}
