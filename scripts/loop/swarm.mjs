// swarm.mjs — run N ralph-loop workers in parallel, each in its own checkout.
//
// The claim protocol (SQLite txn + O_EXCL lock file) was always race-safe, but
// two loops in ONE working tree still trample each other's files. This runner
// removes that limit the multi-agent-swarm way: every worker gets an ISOLATED
// git clone (its own working tree, its own builder sandbox) while sharing the
// primary repo's coordination state through two env vars the loop modules honor:
//
//   HARNESS_STATE_DIR = <primary>/.harness      (backlog, telemetry, cooldowns,
//                                                framein contracts, graph
//                                                checkpoints — one truth)
//   HARNESS_LOCK_DIR  = <primary>/current_tasks (the O_EXCL claim locks)
//
// Workers push finished cards to the shared `origin` remote; the primary repo
// (and every other worker) picks them up on its next `git pull`. Push races are
// absorbed by commitAndPush's rebase-and-retry in ralph-loop.mjs.
//
// Requirements & limits (deliberate):
//   - an `origin` remote must exist — workers ship through it, not through the
//     primary working tree (pushing into a non-bare checkout is a git error).
//   - untracked local files (.env, node_modules) do NOT follow into workers;
//     the health gate's install step provisions each checkout, and secrets
//     should come from the environment, not the tree.
//
// Usage:
//   node scripts/loop/swarm.mjs start [N]      # default 2 workers
//   node scripts/loop/swarm.mjs start 4 --fresh  # re-clone worker checkouts
//   node scripts/loop/swarm.mjs plan [N]       # print what would run, run nothing

import { spawn, execFileSync } from "node:child_process";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync, rmSync, mkdirSync } from "node:fs";

const ROOT = resolve(process.cwd());
const STATE_DIR = resolve(process.env.HARNESS_STATE_DIR || resolve(ROOT, ".harness"));
const LOCK_DIR = resolve(process.env.HARNESS_LOCK_DIR || resolve(ROOT, "current_tasks"));
const SWARM_DIR = resolve(STATE_DIR, "swarm");

function git(args, cwd = ROOT) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function originUrl() {
  try {
    return git(["remote", "get-url", "origin"]);
  } catch {
    return null;
  }
}

export function workerDir(i) {
  return join(SWARM_DIR, `worker-${i}`);
}

/**
 * Ensure worker checkout `i` exists: clone the primary repo locally (fast,
 * hardlinked objects), then point its origin at the REAL remote so pushes ship.
 */
export function ensureWorker(i, origin, { fresh = false } = {}) {
  const dir = workerDir(i);
  if (fresh) rmSync(dir, { recursive: true, force: true });
  if (!existsSync(dir)) {
    mkdirSync(SWARM_DIR, { recursive: true });
    execFileSync("git", ["clone", ROOT, dir], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    git(["remote", "set-url", "origin", origin], dir);
  }
  return dir;
}

function prefixPipe(stream, tag, out) {
  let buf = "";
  stream.on("data", (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      out.write(`[${tag}] ${buf.slice(0, nl)}\n`);
      buf = buf.slice(nl + 1);
    }
  });
  stream.on("end", () => { if (buf) out.write(`[${tag}] ${buf}\n`); });
}

async function start(n, { fresh = false, dry = false } = {}) {
  const origin = originUrl();
  if (!origin) {
    console.error("swarm: no `origin` remote — workers ship through origin, so one is required.");
    console.error("       add one (git remote add origin <url>) or run a single loop instead.");
    process.exit(2);
  }

  console.log(`swarm: ${n} worker(s), origin=${origin}`);
  console.log(`swarm: shared state=${STATE_DIR} locks=${LOCK_DIR}`);
  if (dry) {
    for (let i = 1; i <= n; i++) console.log(`swarm: would run worker-${i} in ${workerDir(i)}`);
    return;
  }

  mkdirSync(LOCK_DIR, { recursive: true });
  const children = [];
  for (let i = 1; i <= n; i++) {
    const dir = ensureWorker(i, origin, { fresh });
    // Freshen the checkout before the worker starts (best-effort).
    try { git(["pull", "--ff-only"], dir); } catch {}
    const child = spawn(process.execPath, [join(dir, "scripts", "loop", "ralph-loop.mjs")], {
      cwd: dir,
      env: {
        ...process.env,
        HARNESS_STATE_DIR: STATE_DIR,
        HARNESS_LOCK_DIR: LOCK_DIR,
        LOOP_WORKER: `worker-${i}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    prefixPipe(child.stdout, `w${i}`, process.stdout);
    prefixPipe(child.stderr, `w${i}`, process.stderr);
    child.on("exit", (code) => console.log(`swarm: worker-${i} exited with code ${code}`));
    children.push(child);
    console.log(`swarm: worker-${i} started (pid ${child.pid}) in ${dir}`);
  }

  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      console.log(`\nswarm: ${sig} — forwarding to workers (each finishes its current iteration)`);
      for (const c of children) { try { c.kill(sig); } catch {} }
    });
  }

  const codes = await Promise.all(children.map((c) => new Promise((res) => c.on("exit", res))));
  const failed = codes.filter((c) => c !== 0).length;
  console.log(`swarm: all workers done (${failed} non-zero)`);
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const n = Math.max(1, Number(argv[1]) || 2);
  const fresh = argv.includes("--fresh");
  if (cmd === "start") {
    start(n, { fresh }).catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
  } else if (cmd === "plan") {
    start(n, { fresh, dry: true }).catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
  } else {
    console.error("usage: swarm.mjs <start|plan> [N] [--fresh]");
    process.exit(2);
  }
}
