#!/usr/bin/env node
/**
 * feedback-distill.ts — shrink tool output before it becomes model input.
 *
 * The build⇄health cycle feeds a failed gate's stdout back to the builder as
 * [FEEDBACK]. Raw, that is the whole run: dependency installs, every passing
 * check, progress bars — with the two lines that actually failed buried inside.
 * The builder pays for all of it on every iteration, up to LOOP_MAX_ITERS, and
 * the signal it needs gets harder to find as the noise grows.
 *
 * So: keep the error lines and the context around them, drop the rest.
 *
 * Two rules this must never break:
 *   1. Never invent. Everything returned is verbatim from the input.
 *   2. Never return nothing. A gate that failed in a shape no pattern matches
 *      still failed, and the builder needs *something* — fall back to the tail,
 *      where a failing run's cause almost always is.
 *
 * Also exposes classify(), which answers a cheaper question: is this failure
 * one code can name outright (missing dependency, port in use)? Those get a
 * short instruction instead of a model round-trip that would rediscover it.
 *
 * Usage (CLI, for inspecting a captured log):
 *   node scripts/loop/feedback-distill.ts < health.log
 *   node scripts/loop/feedback-distill.ts --max-lines=40 < health.log
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Lines worth keeping: compiler/test/lint failures across the usual toolchains. */
const ERROR_PATTERNS = [
  /\berror\b/i,
  /\bfailed?\b/i,
  /\bfailure\b/i,
  /\bexception\b/i,
  /\bpanic:/i,
  /\bcannot find\b/i,
  /\bundefined reference\b/i,
  /\bnot found\b/i,
  /^\s*✗/,
  /^\s*×/,
  /^\s*FAIL\b/,
  /^\s*not ok\b/,          // TAP
  /\bTS\d{4}\b/,           // TypeScript
  /\bE\d{3}\b/,            // flake8 / ruff
  /^\s*at .+\(.+:\d+:\d+\)/, // JS stack frame
  /^[^\s:]+:\d+:\d+:/,     // file:line:col — gcc, go, eslint, tsc
  /\bAssertionError\b/,
  /\bTraceback\b/,
];

/** Pure progress noise — never carries the cause, always carries volume. */
const NOISE_PATTERNS = [
  /^\s*$/,
  /^\s*[✓√]/,                       // passing checks
  /^\s*ok \d+/,                     // TAP pass
  /\bdownloading\b/i,
  /\bfetching\b/i,
  /\bresolving\b/i,
  /\breused\b/i,
  /\badded \d+ packages?\b/i,
  /\bup to date\b/i,
  /^\s*\d+%\s/,                     // progress bars
  /^\s*[-=]{10,}\s*$/,              // rules
  /node_modules[/\\].*[/\\]node_modules/, // nested dep paths
];

const isError = (line: string) => ERROR_PATTERNS.some((re) => re.test(line));
const isNoise = (line: string) => NOISE_PATTERNS.some((re) => re.test(line));

/**
 * Drop ANSI SGR sequences. They carry no meaning for a model, and they also
 * defeat the anchored patterns above — a colored "✗ failed" arrives as
 * `\e[31m✗ failed`, so `/^\s*✗/` would never match it.
 */
const ANSI = new RegExp("\u001b\[[0-9;]*m", "g");
const stripAnsi = (s: string) => s.replace(ANSI, "");

/**
 * Failure classes a program can name without asking a model. Each carries a
 * `fix` the loop can act on directly — the point is to skip the round-trip
 * where the model rediscovers what the exit output already said plainly.
 */
/** An environment failure the model should not spend a round-trip diagnosing. */
interface KnownFailure {
  id: string;
  test: (text: string) => boolean;
  fix: string;
}

const KNOWN_FAILURES: KnownFailure[] = [
  {
    id: "missing-dependency",
    test: (t) => /cannot find module|module not found|no module named|unresolved import/i.test(t),
    fix: "A dependency is missing. Install it (or fix the import path) before changing any other code.",
  },
  {
    id: "port-in-use",
    test: (t) => /eaddrinuse|address already in use|port \d+ is (already )?in use/i.test(t),
    fix: "A port is already bound. Stop the process holding it, or run on another port — this is not a code defect.",
  },
  {
    id: "permission-denied",
    test: (t) => /eacces|permission denied|operation not permitted/i.test(t),
    fix: "A filesystem permission blocked the run. This is an environment problem, not a code defect.",
  },
  {
    id: "out-of-memory",
    test: (t) => /javascript heap out of memory|enomem|killed process|oomkilled/i.test(t),
    fix: "The run exhausted memory. Reduce the workload or raise the limit — editing application logic will not fix it.",
  },
  {
    id: "network-unreachable",
    test: (t) => /enotfound|econnrefused|etimedout|network is unreachable|getaddrinfo/i.test(t),
    fix: "A network call failed. Retry or work offline — this is usually not a code defect.",
  },
  {
    id: "disk-full",
    test: (t) => /enospc|no space left on device/i.test(t),
    fix: "The disk is full. Free space before retrying; no code change will help.",
  },
];

/**
 * Name the failure class if code can, so the caller can act without a model
 * round-trip. Returns null when the cause needs judgment — the common case,
 * and the one that must stay with the model.
 */
/** What classify reports: the id and the fix, without the matcher. */
export type FailureVerdict = Pick<KnownFailure, "id" | "fix">;

export function classify(output: unknown): FailureVerdict | null {
  const text = stripAnsi(String(output ?? ""));
  if (!text.trim()) return null;
  for (const f of KNOWN_FAILURES) {
    if (f.test(text)) return { id: f.id, fix: f.fix };
  }
  return null;
}

/**
 * Reduce raw tool output to the lines a builder needs to act.
 *
 * @param {string} output raw stdout/stderr
 * @param {object} [opts]
 * @param {number} [opts.maxLines=60] ceiling on returned lines
 * @param {number} [opts.context=2] lines kept around each error line
 * @param {number} [opts.tailLines=20] fallback tail when nothing matches
 * @returns {string} distilled text — verbatim input lines, never empty for
 *   non-empty input
 */
export function distill(
  output: unknown,
  opts: { maxLines?: number; context?: number; tailLines?: number } = {},
): string {
  const { maxLines = 60, context = 2, tailLines = 20 } = opts;
  const text = stripAnsi(String(output ?? ""));
  if (!text.trim()) return "";

  const lines = text.split(/\r?\n/);
  if (lines.length <= maxLines) return lines.join("\n").trim();

  // Mark error lines plus a window around them — a bare "error:" line without
  // its following detail is not actionable.
  const keep = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (!isError(lines[i] ?? "")) continue;
    for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) {
      if (!isNoise(lines[j] ?? "") || j === i) keep.add(j);
    }
  }

  // Rule 2: nothing matched, but the gate still failed. The tail is where a
  // failing run's cause almost always sits.
  if (keep.size === 0) {
    const tail = lines.slice(-tailLines).filter((l: string) => !isNoise(l));
    const body = (tail.length ? tail : lines.slice(-tailLines)).join("\n").trim();
    return body ? `[distilled: no error pattern matched; showing last ${tailLines} lines]\n${body}` : "";
  }

  // Newest wins: with more hits than budget, later errors are usually the ones
  // that stopped the run.
  let indices: number[] = [...keep].sort((a, b) => a - b);
  let dropped = 0;
  if (indices.length > maxLines) {
    dropped = indices.length - maxLines;
    indices = indices.slice(-maxLines);
  }

  const out: string[] = [];
  let prev = -1;
  for (const i of indices) {
    if (prev >= 0 && i > prev + 1) out.push(`… (${i - prev - 1} lines omitted)`);
    out.push(lines[i] ?? "");
    prev = i;
  }

  const omitted = lines.length - indices.length;
  const header = dropped
    ? `[distilled: ${omitted} of ${lines.length} lines omitted; showing the last ${maxLines} error lines]`
    : `[distilled: ${omitted} of ${lines.length} lines omitted]`;
  return `${header}\n${out.join("\n")}`.trim();
}

/**
 * What the loop actually calls: distill, and attach a named cause when code
 * could identify one.
 *
 * @returns {{ text: string, known: {id: string, fix: string} | null }}
 */
export function buildFeedback(
  output: unknown,
  opts: { maxLines?: number; context?: number; tailLines?: number } = {},
): { text: string; known: FailureVerdict | null } {
  const known = classify(output);
  const text = distill(output, opts);
  if (!known) return { text, known: null };
  return { text: `[LIKELY CAUSE: ${known.id}] ${known.fix}\n\n${text}`.trim(), known };
}

// CLI: pipe a captured log in to see what the builder would receive.
// Compare real paths, not URL strings: on Windows `file://` + a drive path never
// equals import.meta.url's `file:///C:/…`, which would leave this permanently off.
const isMainModule = (() => {
  if (!process.argv[1]) return false;
  try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]); }
  catch { return false; }
})();

if (isMainModule) {
  const arg = (flag: string, fallback: number): number => {
    const hit = process.argv.find((a) => a.startsWith(`${flag}=`));
    return hit ? Number(hit.split("=")[1] ?? fallback) : fallback;
  };
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => { raw += d; });
  process.stdin.on("end", () => {
    const { text, known } = buildFeedback(raw, {
      maxLines: arg("--max-lines", 60),
      context: arg("--context", 2),
    });
    const before = raw.length, after = text.length;
    const pct = before ? Math.round((1 - after / before) * 100) : 0;
    process.stderr.write(`${before} -> ${after} chars (${pct}% smaller)${known ? ` · ${known.id}` : ""}\n`);
    process.stdout.write(text + "\n");
  });
}
