// worktree.ts — per-card git worktree + branch automation for the loop.
//
// Why: every role in the loop used to build, WIP-save, and commit in the ONE
// shared working tree. Two concurrent claims — or a human editing while the
// loop runs — race each other's edits, and one agent's uncommitted fix gets
// silently absorbed into another agent's commit (the same-working-tree
// collision incident class). This module gives each claimed card its own
// isolated checkout instead:
//
//   branch    loop/<card>                (LOOP_WT_BRANCH_PREFIX to change)
//   worktree  .harness/worktrees/<card>  (gitignored; LOOP_WT_DIR to move it)
//
// Lifecycle (driven by ralph-loop when LOOP_WORKTREE=1):
//   ensure    — at claim time: create branch + worktree forked from the base
//               branch, or REUSE the surviving pair when a requeued/cooldown
//               card comes back, then sync it with the base so a long-lived
//               card doesn't drift. A sync conflict is deliberately NOT
//               aborted: the markers stay in the worktree and are reported,
//               so the builder (an agent with full git access) resolves them
//               inside its normal iterate→health loop.
//   integrate — after reviewer sign-off: merge loop/<card> into the base
//               branch in the MAIN tree (--no-ff) and push. On conflict the
//               merge is aborted — the main tree is never left conflicted —
//               and the card is requeued; the next `ensure` reproduces the
//               same conflict inside the worktree for the builder to fix.
//   remove    — after a successful integrate (or by hand for an abandoned
//               card): remove the worktree and delete the branch.
//
// Everything shells out to the git CLI (no deps). Helpers return
// { ok, reason } result objects instead of throwing, in framein.ts's
// best-effort spirit — but `ensure` failures are meant to FAIL the card in
// ralph-loop: silently falling back to the shared tree would reintroduce the
// exact collision this exists to prevent.
//
// Env:
//   LOOP_WORKTREE=1        turn per-card isolation on (ralph-loop reads this)
//   LOOP_WT_BASE           base branch to fork from / merge into
//                          (default: the branch checked out in the main tree)
//   LOOP_WT_BRANCH_PREFIX  branch namespace (default "loop/")
//   LOOP_WT_DIR            worktree parent dir (default .harness/worktrees)
//   LOOP_WT_SETUP          command run once inside a fresh worktree (e.g.
//                          "pnpm install") — a new checkout has no
//                          node_modules, so the health gate needs this on
//                          JS projects unless HEALTH_INSTALL covers it
//
// Usage (CLI): node scripts/loop/worktree.ts <ensure|integrate|remove|list> [card] [--force]
// Exit: 0 ok · 1 failed · 4 merge conflict (integrate) · 2 bad usage.

import { execFileSync, execSync } from "node:child_process";
import { resolve } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = resolve(process.cwd());

export function enabled() {
  return process.env.LOOP_WORKTREE === "1";
}

// Card ids come from the backlog and may carry characters git refs reject.
// One sanitizer feeds both the branch name and the directory name so they
// always agree.
/** A worktree git registers under our parent dir. */
export interface WorktreeEntry {
  path: string;
  branch: string | null;
  sha: string | null;
}

/**
 * ensureWorktree's answer, discriminated on `ok` so a failed isolation cannot
 * be read as a usable checkout — every caller must fail closed on it.
 */
export type EnsureResult =
  | { ok: false; reason: string }
  | {
      ok: true;
      path: string;
      branch: string;
      base: string;
      created: boolean;
      conflictFiles: string[];
      reason?: string;
    };

function slug(card: string): string {
  return String(card).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+|[.-]+$/g, "") || "card";
}

export function branchFor(card: string): string {
  return `${process.env.LOOP_WT_BRANCH_PREFIX || "loop/"}${slug(card)}`;
}

export function worktreePath(card: string): string {
  return resolve(ROOT, process.env.LOOP_WT_DIR || ".harness/worktrees", slug(card));
}

// git runner that never throws: { ok, out } with stderr folded into `out` so
// callers can surface the real git message in their `reason`.
function git(args: string[], { cwd = ROOT } = {}): { ok: boolean; out: string } {
  try {
    const out = execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, out: out.trim() };
  } catch (e) {
    const err = e as { stdout?: unknown; stderr?: unknown; message?: string };
    const out = [err.stdout, err.stderr].filter(Boolean).map(String).join("\n").trim();
    return { ok: false, out: out || String(err.message || e) };
  }
}

function branchExists(branch: string): boolean {
  return git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).ok;
}

// The branch the main tree has checked out — the fork point for a NEW card.
export function baseBranch() {
  if (process.env.LOOP_WT_BASE) return process.env.LOOP_WT_BASE;
  const r = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!r.ok || r.out === "HEAD") return null; // detached — refuse to guess
  return r.out;
}

// The base a card actually forked from, recorded at ensure time in the repo's
// git config. Re-deriving it at integrate time from the main tree's current
// HEAD would make integrate's "wrong branch" guard self-defeating: it would be
// comparing HEAD against a value read from HEAD, so it could never fire and a
// card would happily merge into whatever branch the tree had wandered onto.
const baseKey = (card: string) => `loop.worktree.${slug(card)}.base`;

function recordedBase(card: string): string | null {
  if (process.env.LOOP_WT_BASE) return process.env.LOOP_WT_BASE;
  const r = git(["config", "--local", "--get", baseKey(card)]);
  return r.ok && r.out ? r.out : null;
}

/** Worktrees registered under our parent dir: [{ path, branch, sha }]. */
export function listWorktrees(): WorktreeEntry[] {
  const r = git(["worktree", "list", "--porcelain"]);
  if (!r.ok) return [];
  const parent = resolve(ROOT, process.env.LOOP_WT_DIR || ".harness/worktrees");
  const out: WorktreeEntry[] = [];
  let cur: WorktreeEntry | null = null;
  for (const line of r.out.split("\n")) {
    if (line.startsWith("worktree ")) cur = { path: resolve(line.slice(9)), branch: null, sha: null };
    else if (line.startsWith("HEAD ") && cur) cur.sha = line.slice(5);
    else if (line.startsWith("branch ") && cur) cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
    else if (line === "" && cur) { if (cur.path.startsWith(parent)) out.push(cur); cur = null; }
  }
  if (cur && cur.path.startsWith(parent)) out.push(cur);
  return out;
}

// Unmerged (conflicted) paths in a tree — the signal we hand to the builder.
function conflictedFiles(cwd: string): string[] {
  const r = git(["diff", "--name-only", "--diff-filter=U"], { cwd });
  return r.ok && r.out ? r.out.split("\n").filter(Boolean) : [];
}

/**
 * Create — or reuse — the card's isolated branch + worktree, then sync a
 * reused one with the base branch.
 * @returns {{ ok:boolean, path?:string, branch?:string, base?:string,
 *             created?:boolean, conflictFiles?:string[], reason?:string }}
 */
export function ensureWorktree(card: string): EnsureResult {
  const base = baseBranch();
  if (!base) return { ok: false, reason: "no base branch (main tree is detached and LOOP_WT_BASE is unset)" };
  const branch = branchFor(card);
  const path = worktreePath(card);

  git(["worktree", "prune"]); // drop registrations whose dirs are gone

  // Two independent freshness signals: a fresh CHECKOUT needs LOOP_WT_SETUP
  // (no node_modules yet), a pre-existing BRANCH needs a base sync (it may
  // have drifted while the card sat requeued).
  const registered = listWorktrees().some((w) => w.path === path);
  let freshCheckout = false;
  let freshBranch = false;
  if (!registered) {
    const hadBranch = branchExists(branch);
    const add = hadBranch
      ? git(["worktree", "add", path, branch])                 // requeued card: resume its branch
      : git(["worktree", "add", "-b", branch, path, base]);    // fresh card: fork from base
    if (!add.ok) return { ok: false, reason: `git worktree add failed: ${add.out}` };
    freshCheckout = true;
    freshBranch = !hadBranch;
  }
  // Remember the fork point so integrate can tell "the tree moved" from "this is
  // the right target". Rewritten on every ensure so a card that is requeued after
  // the base branch was renamed still merges somewhere real.
  git(["config", "--local", baseKey(card), base]);
  if (!existsSync(path)) return { ok: false, reason: `worktree dir missing after add: ${path}` };

  // One-time setup for a fresh checkout (deps the health gate will need).
  // Failure is logged into `reason` but doesn't fail the ensure — the health
  // gate is the enforcement point and will say exactly what's missing.
  let reason;
  if (freshCheckout && process.env.LOOP_WT_SETUP) {
    try {
      execSync(process.env.LOOP_WT_SETUP, { cwd: path, stdio: "inherit", timeout: 600_000 });
    } catch (e) {
      reason = `LOOP_WT_SETUP failed (continuing; health gate will enforce): ${(e as Error)?.message ?? e}`;
    }
  }

  // Sync a pre-existing branch with the base so long-lived cards don't drift
  // and an integrate-time conflict is reproduced HERE, where the builder can
  // resolve it. Conflict markers are left in place on purpose. A branch just
  // forked from base has nothing to sync.
  let conflictFiles: string[] = [];
  if (!freshBranch) {
    const merge = git(["merge", "--no-edit", recordedBase(card) || base], { cwd: path });
    if (!merge.ok) {
      conflictFiles = conflictedFiles(path);
      if (!conflictFiles.length) {
        // Not a conflict (e.g. dirty WIP from a crash blocks the merge). The
        // builder resumes from whatever state is there; just say why.
        reason = reason ? `${reason}; base sync skipped: ${merge.out}` : `base sync skipped: ${merge.out}`;
      }
    }
  }

  return { ok: true, path, branch, base, created: freshBranch, conflictFiles, ...(reason ? { reason } : {}) };
}

/**
 * Merge the card's branch into the base branch in the MAIN tree and push.
 * On conflict: abort (the main tree is never left mid-merge) and report the
 * conflicted paths so the caller can requeue the card.
 * @returns {{ ok:boolean, branch?:string, base?:string, pushed?:boolean,
 *             conflictFiles?:string[], reason?:string }}
 */
export function integrate(card: string, { push = true } = {}) {
  const base = recordedBase(card);
  if (!base) return { ok: false, reason: `no recorded base for ${card} — run ensure first, or set LOOP_WT_BASE` };
  const branch = branchFor(card);
  if (!branchExists(branch)) return { ok: false, reason: `branch ${branch} does not exist` };

  const head = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!head.ok || head.out !== base) {
    return { ok: false, reason: `main tree is on '${head.out || "?"}', expected base '${base}' — refusing to merge into the wrong branch` };
  }

  const merge = git(["merge", "--no-ff", "--no-edit", "-m", `loop:${card} (merge ${branch})`, branch]);
  if (!merge.ok) {
    const conflictFiles = conflictedFiles(ROOT);
    git(["merge", "--abort"]);
    return { ok: false, base, branch, conflictFiles, reason: conflictFiles.length ? "merge conflict (aborted; main tree restored)" : `merge failed: ${merge.out}` };
  }

  let pushed = false;
  if (push) {
    let p = git(["push"]);
    // Swarm workers share one remote and race on push, exactly as commitAndPush
    // in ralph-loop does. Rebase onto the remote once and retry; a second
    // failure leaves the merge local (the next tick pushes it), so this
    // degrades to eventual consistency rather than losing the integration.
    if (!p.ok && git(["pull", "--rebase"]).ok) p = git(["push"]);
    pushed = p.ok;
    if (!p.ok) return { ok: true, base, branch, pushed, reason: `merged but push failed: ${p.out}` };
  }
  return { ok: true, base, branch, pushed };
}

/**
 * Remove the card's worktree and (by default) its branch. `force` deletes an
 * unmerged branch too — for abandoning a parked card.
 */
export function removeWorktree(card: string, { deleteBranch = true, force = false } = {}) {
  const branch = branchFor(card);
  const path = worktreePath(card);
  const reasons = [];
  if (existsSync(path)) {
    const rm = git(["worktree", "remove", "--force", path]);
    if (!rm.ok) reasons.push(`worktree remove failed: ${rm.out}`);
  }
  git(["worktree", "prune"]);
  git(["config", "--local", "--unset", baseKey(card)]);
  if (deleteBranch && branchExists(branch)) {
    const del = git(["branch", force ? "-D" : "-d", branch]);
    if (!del.ok) reasons.push(`branch delete failed (unmerged? pass --force): ${del.out}`);
  }
  return reasons.length ? { ok: false, reason: reasons.join("; ") } : { ok: true };
}

// --- CLI -----------------------------------------------------------------------

function printUsage() {
  console.error(
    [
      "usage:",
      "  worktree ensure    <card>            create/reuse the card's branch + worktree (prints its path)",
      "  worktree integrate <card> [--no-push] merge loop/<card> into the base branch and push",
      "  worktree remove    <card> [--force]  remove the worktree and delete the branch",
      "  worktree list                        list the loop's worktrees",
    ].join("\n"),
  );
}

async function cli() {
  const argv = process.argv.slice(2);
  const [verb, card] = argv;
  switch (verb) {
    case "ensure": {
      if (!card) { printUsage(); return 2; }
      const r = ensureWorktree(card);
      console.log(JSON.stringify(r, null, 2));
      return r.ok ? 0 : 1;
    }
    case "integrate": {
      if (!card) { printUsage(); return 2; }
      const r = integrate(card, { push: !argv.includes("--no-push") });
      console.log(JSON.stringify(r, null, 2));
      return r.ok ? 0 : r.conflictFiles?.length ? 4 : 1;
    }
    case "remove": {
      if (!card) { printUsage(); return 2; }
      const r = removeWorktree(card, { force: argv.includes("--force") });
      console.log(JSON.stringify(r, null, 2));
      return r.ok ? 0 : 1;
    }
    case "list": {
      console.log(JSON.stringify(listWorktrees(), null, 2));
      return 0;
    }
    default:
      printUsage();
      return 2;
  }
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
  cli().then((code) => process.exit(code || 0)).catch((e) => {
    console.error(e?.stack || String(e));
    process.exit(1);
  });
}
