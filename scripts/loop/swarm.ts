// swarm.ts — run N ralph-loop workers in parallel, each in its own checkout.
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
// absorbed by commitAndPush's rebase-and-retry in ralph-loop.ts.
//
// Requirements & limits (deliberate):
//   - an `origin` remote must exist — workers ship through it, not through the
//     primary working tree (pushing into a non-bare checkout is a git error).
//   - untracked local files (.env, node_modules) do NOT follow into workers;
//     the health gate's install step provisions each checkout, and secrets
//     should come from the environment, not the tree.
//
// Usage:
//   node scripts/loop/swarm.ts start [N]      # N defaults to the plan profile's
//                                            # waves.maxParallel (.harness-plan.json)
//   node scripts/loop/swarm.ts start 4 --fresh  # re-clone worker checkouts
//   node scripts/loop/swarm.ts plan [N]       # print what would run, run nothing

import { spawn, execFileSync } from "node:child_process";
import { resolve, join } from "node:path";
import { existsSync, rmSync, mkdirSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = resolve(process.cwd());
const STATE_DIR = resolve(process.env.HARNESS_STATE_DIR || resolve(ROOT, ".harness"));
const LOCK_DIR = resolve(process.env.HARNESS_LOCK_DIR || resolve(ROOT, "current_tasks"));
const SWARM_DIR = resolve(STATE_DIR, "swarm");

function git(args: string[], cwd = ROOT): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function originUrl() {
  try {
    return git(["remote", "get-url", "origin"]);
  } catch {
    return null;
  }
}

export function workerDir(i: number): string {
  return join(SWARM_DIR, `worker-${i}`);
}

export function providerLane(index: number, providers: string[] = ["codex", ]): string {
  const lanes = providers.length ? providers : ["codex"];
  const provider = lanes[index % lanes.length] || "codex";
  // Every lane enters through the common session router so model fallbacks and
  // provider handoffs work inside the long-running Ralph loop as well.
  return `${process.execPath} ${join("scripts", "agent-session.ts")} --agent ${provider} --same-provider-only`;
}

/**
 * Ensure worker checkout `i` exists: clone the primary repo locally (fast,
 * hardlinked objects), then point its origin at the REAL remote so pushes ship.
 */
export function ensureWorker(i: number, origin: string, { fresh = false } = {}): string {
  const dir = workerDir(i);
  if (fresh) rmSync(dir, { recursive: true, force: true });
  if (!existsSync(dir)) {
    mkdirSync(SWARM_DIR, { recursive: true });
    execFileSync("git", ["clone", ROOT, dir], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    git(["remote", "set-url", "origin", origin], dir);
  }
  return dir;
}

function prefixPipe(stream: NodeJS.ReadableStream, tag: string, out: NodeJS.WriteStream): void {
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

async function start(n: number, { fresh = false, dry = false } = {}) {
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
  const children: import("node:child_process").ChildProcess[] = [];
  const providerLanes = (process.env.FACTORY_PROVIDER_LANES || "codex")
    .split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  const failoverOrder = (process.env.HARNESS_AGENT_FAILOVER_ORDER || "agy,codex")
    .split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  for (let i = 1; i <= n; i++) {
    const dir = ensureWorker(i, origin, { fresh });
    // Freshen the checkout before the worker starts (best-effort).
    try { git(["pull", "--ff-only"], dir); } catch {}
    const child = spawn(process.execPath, [join(dir, "scripts", "loop", "ralph-loop.ts")], {
      cwd: dir,
      env: {
        ...process.env,
        HARNESS_STATE_DIR: STATE_DIR,
        HARNESS_LOCK_DIR: LOCK_DIR,
        LOOP_WORKER: `worker-${i}`,
        LOOP_BUILDERS: [
          providerLane(i - 1, providerLanes),
          ...failoverOrder
            .filter((name) => name !== providerLanes[(i - 1) % providerLanes.length])
            .map((name) => providerLane(0, [name])),
        ].join(","),
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
      for (const c of children) { try { c.kill(sig as NodeJS.Signals); } catch {} }
    });
  }

  const codes = await Promise.all(children.map((c) => new Promise((res) => c.on("exit", res))));
  const failed = codes.filter((c) => c !== 0).length;
  console.log(`swarm: all workers done (${failed} non-zero)`);
  process.exit(failed ? 1 : 0);
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
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  // No count given → size the swarm to the plan profile's wave width. That number
  // is how many cards a plan document expects to run at once
  // (`.harness-plan.json` waves.maxParallel), so it is the one honest default:
  // more workers than the wave contend for the same claim, fewer leave a wave
  // running single-file.
  const { planConfig } = await import("./plan-doc.ts");
  const n = Math.max(1, Number(argv[1]) || planConfig(ROOT).waves.maxParallel || 2);
  const fresh = argv.includes("--fresh");
  if (cmd === "start") {
    start(n, { fresh }).catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
  } else if (cmd === "plan") {
    start(n, { fresh, dry: true }).catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
  } else {
    console.error("usage: swarm.ts <start|plan> [N] [--fresh]");
    process.exit(2);
  }
}
