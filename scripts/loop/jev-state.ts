// jev-state.ts — turn a working diff into a Jev `state` that fits the 32k limit.
//
// This is the point of the whole Jev layer: framein's regex risk scorer reads
// FILE NAMES only, so a permission check deleted inside server.ts scores "low".
// Feeding Jev the actual hunks is what closes that false negative, so this
// module's job is to spend a bounded character budget on the lines that carry
// signal — and to be honest in the state itself when it had to drop some.
//
// Every hunk leaving this module passes through redact.ts: this is the first
// path in the harness that sends source code to a third-party API.

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { redactText } from "./redact.ts";

/**
 * Character budget for the diff body. The API limit is 32k TOKENS for state;
 * at a conservative ~3 chars/token for source code this stays well inside it
 * while leaving room for the questions (which share the 64k total).
 */
export const JEV_STATE_MAX_CHARS = 60_000;

/**
 * Cap on files given a body. The char budget bounds PAYLOAD; this bounds COST:
 * each body costs up to two synchronous git spawns and execFileSync blocks the
 * event loop entirely, so an unbounded list adds seconds of dead time to the
 * ship gate — outside the client's own timeout.
 */
export const JEV_STATE_MAX_FILES = 40;

/**
 * The empty-file path for `git diff --no-index`. Git for Windows accepts
 * "/dev/null" in its own MSYS layer, but `nul` is what native Windows resolves,
 * and this repo runs on both PowerShell and Git Bash.
 */
const NUL_DEVICE = process.platform === "win32" ? "nul" : "/dev/null";

/**
 * Smallest body worth sending. Below roughly this, a hunk carries a header and
 * no decidable lines — it costs tokens and invites a confident wrong answer.
 */
const MIN_USEFUL_BODY_CHARS = 400;

/**
 * Secret shapes that `redact.ts` does not catch.
 *
 * redact.ts is scoped to "persisted/exported harness data" — local files and a
 * trusted hub — and its name-suffix rule (`*_TOKEN`, `*_SECRET`, …) misses
 * `JWT_SIGNING_KEY`, `AWS_ACCESS_KEY_ID`, `client_secret`, a bare `password:`,
 * and PEM blocks. That is defensible for a log file. It is NOT defensible as the
 * only control on a network egress path, where a leak is irreversible.
 *
 * Still best-effort pattern matching, not a guarantee — see `looksUnscrubbed`
 * and JEV_REDACT_STRICT for the fail-closed option.
 */
const EGRESS_SECRET_PATTERNS: [RegExp, string][] = [
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_AWS_KEY]"],
  [/\bASIA[0-9A-Z]{16}\b/g, "[REDACTED_AWS_KEY]"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, "[REDACTED_GOOGLE_KEY]"],
  [/\bGOCSPX-[0-9A-Za-z_-]{20,}/g, "[REDACTED_OAUTH_SECRET]"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, "[REDACTED_JWT]"],
];

/**
 * Assignment-shaped credentials, handled separately so the NAME survives —
 * the identifier is signal Jev should read; only the value is dangerous.
 *
 * The credential word may sit anywhere in the identifier (`client_secret`,
 * `apiKey`, `JWT_SIGNING_KEY`, a bare `password`), so the surrounding name
 * parts are lazy: a greedy prefix would swallow the keyword and never match.
 */
const EGRESS_ASSIGNMENT =
  /([A-Za-z0-9_.-]*?(?:secret|passwd|password|api[_-]?key|apikey|signing[_-]?key|private[_-]?key|access[_-]?key|auth|credential|token)[A-Za-z0-9_.-]*?)(\s*[:=]\s*)(["']?)([^\s"',;)]{6,})\3/gi;

/**
 * Scrub secret shapes that would otherwise cross the network, on top of
 * redact.ts. Best-effort: see JEV_REDACT_STRICT to fail closed instead.
 */
export function scrubForEgress(text: string): string {
  let out = text;
  for (const [re, replacement] of EGRESS_SECRET_PATTERNS) out = out.replace(re, replacement);
  return out.replace(EGRESS_ASSIGNMENT, (_m, name, sep, quote) => `${name}${sep}${quote}[REDACTED]${quote}`);
}

/**
 * Does this text still look like it carries a credential after scrubbing?
 * Heuristic for opaque high-entropy blobs no name-based rule can reach. Used
 * only by JEV_REDACT_STRICT, because alone it also flags minified code and
 * hashes — acceptable when the caller chose "drop rather than risk it".
 */
export function looksUnscrubbed(text: string): boolean {
  return /(?:secret|password|passwd|credential|api[_-]?key|private[_-]?key|token|auth)[^\r\n]{0,40}[A-Za-z0-9+/_-]{24,}/i.test(text);
}

/** Files whose contents are noise: generated, locked, minified, or binary. */
const BODY_EXCLUDED = [
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|npm-shrinkwrap\.json)$/i,
  /(^|\/)(go\.sum|Cargo\.lock|poetry\.lock|Gemfile\.lock|composer\.lock)$/i,
  /\.min\.(js|css|mjs|cjs)$/i,
  /(^|\/)(\.harness|node_modules|dist|build|coverage|out)\//,
  /\.(png|jpe?g|gif|webp|avif|ico|svg|pdf|zip|gz|tar|woff2?|ttf|eot|mp4|mp3|wasm|exe|dll|so|dylib)$/i,
  /(^|\/)(evidence)\/.*\.(json|png)$/i,
];

export interface JevDiffFile {
  path: string;
  /** Redacted, possibly truncated hunk text. Absent for excluded/binary files. */
  body?: string;
  /** Set when this file's own body was cut short. */
  truncated?: boolean;
  /** Why the body is absent: generated/locked/binary noise. */
  excluded?: boolean;
  /** Body withheld by JEV_REDACT_STRICT because it still looked like a secret. */
  suspectedSecret?: boolean;
}

export interface JevDiffState {
  /** Present so the model never assumes it saw the whole change. */
  note: string;
  baseline: string;
  fileCount: number;
  files: JevDiffFile[];
  /** True when any body was cut or any file was dropped entirely. */
  truncated: boolean;
  /** Files omitted from `files` entirely because the budget ran out. */
  omittedFiles: number;
}

export function isBodyExcluded(path: string): boolean {
  return BODY_EXCLUDED.some((re) => re.test(path));
}

function git(args: string[], cwd: string): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      // Every other git wrapper in the loop silences stderr; without this a
      // missing path prints "error: Could not access …" into the loop console
      // and reads as a loop failure.
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    });
  } catch (error) {
    // `git diff --no-index` exits 1 when the files DIFFER — that is the success
    // case for us, and the diff is on stdout. Only a missing stdout is a failure.
    const stdout = (error as { stdout?: string }).stdout;
    return typeof stdout === "string" ? stdout : "";
  }
}

/**
 * Diff every tracked path in ONE git call, split back out per file.
 *
 * Each spawn costs ~80ms on Windows and `execFileSync` blocks the event loop
 * outright, so N×2 spawns turned a 40-file card into seconds of dead time in
 * the ship gate. One batched call is ~80ms total.
 */
export function diffForFiles(paths: string[], baseline: string, cwd: string): Map<string, string> {
  const out = new Map<string, string>();
  if (paths.length === 0) return out;

  const combined = git(["diff", "--unified=3", baseline, "--", ...paths], cwd);
  // `diff --git a/<path> b/<path>` starts each file's section.
  const chunks = combined.split(/^(?=diff --git )/m).filter((c) => c.trim());
  for (const chunk of chunks) {
    const header = /^diff --git a\/(.+?) b\/(.+?)$/m.exec(chunk);
    const name = header?.[2] ?? header?.[1];
    if (name) out.set(name, chunk);
  }
  return out;
}

/** Per-file diff text against a baseline, including untracked files. */
export function diffForFile(path: string, baseline: string, cwd: string): string {
  const tracked = git(["diff", "--unified=3", baseline, "--", path], cwd);
  if (tracked.trim()) return tracked;
  // Untracked files are invisible to `git diff <baseline>`, but they are exactly
  // where a new auth/secret file would hide. Compare against the empty tree so
  // the whole file shows as added lines — without touching the index (`add -N`
  // would mutate repository state from what must stay a read-only scorer).
  return git(["diff", "--no-index", "--unified=3", NUL_DEVICE, path], cwd);
}

/**
 * Split a character budget across files as evenly as possible, giving unused
 * remainder back to the files that still want it.
 *
 * A flat per-file cap would waste the budget when most files are tiny; this
 * keeps small files whole and only truncates the genuinely large ones.
 */
export function allocateBudget(sizes: number[], total: number): number[] {
  const out = new Array(sizes.length).fill(0);
  let remaining = total;
  let open = sizes.map((_, i) => i).filter((i) => (sizes[i] ?? 0) > 0);

  // A sliver of a diff is worse than none: it reads as a complete hunk to the
  // model while showing nothing decidable. So when the budget cannot give every
  // file either its whole body or a useful excerpt, fund fewer files properly
  // rather than all of them badly. Files that fit entirely never count as
  // slivers, so a crowd of tiny diffs is still delivered whole.
  const wanted = open.reduce((n, i) => n + (sizes[i] ?? 0), 0);
  if (wanted > total) {
    const affordable = Math.floor(total / MIN_USEFUL_BODY_CHARS);
    if (affordable < 1) return out;
    // Smallest-first: maximises how many files arrive complete.
    open = [...open].sort((a, b) => (sizes[a] ?? 0) - (sizes[b] ?? 0));
    let kept = 0;
    let left = total;
    const fundable: number[] = [];
    for (const i of open) {
      const cost = Math.min(sizes[i] ?? 0, MIN_USEFUL_BODY_CHARS);
      if (left < cost) break;
      left -= cost;
      fundable.push(i);
      kept += 1;
    }
    open = kept > 0 ? fundable.sort((a, b) => a - b) : [];
    if (open.length === 0) return out;
  }

  while (open.length > 0 && remaining > 0) {
    const share = Math.floor(remaining / open.length);
    if (share <= 0) break;
    const next: number[] = [];
    for (const i of open) {
      const size = sizes[i] ?? 0;
      const want = size - (out[i] ?? 0);
      const give = Math.min(want, share);
      out[i] = (out[i] ?? 0) + give;
      remaining -= give;
      if (size > (out[i] ?? 0)) next.push(i);
    }
    // No file could take more of its share — stop rather than spin.
    if (next.length === open.length && next.every((i) => (out[i] ?? 0) === 0)) break;
    open = next;
  }
  return out;
}

/**
 * Build the state object handed to Jev.
 *
 * @param files  changed paths (caller supplies them — framein already computes this)
 */
export function buildDiffState(
  files: string[],
  { baseline = "HEAD", cwd = process.cwd(), maxChars = JEV_STATE_MAX_CHARS, env = process.env, maxFiles = JEV_STATE_MAX_FILES }: {
    baseline?: string;
    cwd?: string;
    maxChars?: number;
    env?: NodeJS.ProcessEnv;
    maxFiles?: number;
  } = {},
): JevDiffState {
  const strict = /^(1|on|true)$/i.test(String(env.JEV_REDACT_STRICT ?? "").trim());
  const all = [...new Set(files.filter(Boolean))];
  // Cap SPAWNS, not just characters.
  const paths = all.slice(0, maxFiles);
  const droppedForCount = all.length - paths.length;

  // One batched git call for all tracked paths; only paths it returns nothing
  // for (untracked/new files) fall back to their own spawn.
  const batched = diffForFiles(paths.filter((p) => !isBodyExcluded(p)), baseline, cwd);
  // One more batched call to learn which paths are untracked, so the per-file
  // fallback fires only for genuinely new files.
  // No --exclude-standard: in a self-hosting checkout the interesting files are
  // often gitignored, and a risk scorer must still read them.
  const untracked = new Set(
    git(["ls-files", "--others", "--", ...paths], cwd)
      .split("\n").map((s) => s.trim()).filter(Boolean),
  );

  const bodied: { path: string; text: string }[] = [];
  const entries: JevDiffFile[] = [];
  for (const path of paths) {
    if (isBodyExcluded(path)) {
      entries.push({ path, excluded: true });
      continue;
    }
    // Two passes: redact.ts (harness-wide rules) then the egress-only scrubber.
    // The batch covers every tracked change. Only spend a second spawn when the
    // path is absent from it AND untracked on disk — that is the new-file case
    // (where a fresh auth/secret file would hide). An unchanged or deleted path
    // gets nothing from either, so spawning for it is pure blocking cost.
    const raw = batched.get(path) ?? (untracked.has(path) ? diffForFile(path, baseline, cwd) : "");
    const text = scrubForEgress(redactText(raw, env));
    // Fail-closed option: lose a hunk rather than risk a credential egressing.
    if (strict && looksUnscrubbed(text)) {
      entries.push({ path, excluded: true, suspectedSecret: true });
      continue;
    }
    bodied.push({ path, text });
  }

  const budgets = allocateBudget(bodied.map((f) => f.text.length), maxChars);

  let truncated = false;
  let omittedFiles = 0;
  bodied.forEach((file, i) => {
    const budget = budgets[i] ?? 0;
    if (budget <= 0) {
      // No budget at all: keep the NAME (the regex floor still sees it) but say so.
      omittedFiles += 1;
      truncated = true;
      entries.push({ path: file.path, truncated: true });
      return;
    }
    const cut = file.text.length > budget;
    if (cut) truncated = true;
    entries.push({
      path: file.path,
      body: cut ? `${file.text.slice(0, budget)}\n… [truncated]` : file.text,
      ...(cut ? { truncated: true } : {}),
    });
  });

  return {
    note: truncated || droppedForCount > 0
      ? `PARTIAL DIFF — some file bodies were truncated or omitted${droppedForCount > 0 ? ` (${droppedForCount} file(s) not inspected at all)` : ""}. Judge only what is shown; absence of evidence here is not evidence of absence.`
      : "Complete working diff for the changed files.",
    baseline,
    // The real total, not just what was inspected — an under-count would let
    // the model conclude it saw the whole change.
    fileCount: all.length,
    files: entries,
    truncated: truncated || droppedForCount > 0,
    omittedFiles: omittedFiles + droppedForCount,
  };
}

const isMain = (() => {
  try { return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

if (isMain) {
  const baseline = process.argv[2] || "HEAD";
  const changed = git(["diff", "--name-only", baseline], process.cwd())
    .split("\n").map((s) => s.trim()).filter(Boolean);
  const state = buildDiffState(changed, { baseline });
  console.log(JSON.stringify(state, null, 2));
}
