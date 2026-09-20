// dashboard.ts — the harness's local observability UI (the "studio").
//
// A zero-dependency web dashboard for watching and steering the autonomous loop,
// following the LangGraph-Studio / trace-viewer playbook, implemented on plain
// node:http against the harness's own state stores:
//
//   pipeline view   — the card state graph with the CURRENT node highlighted
//                     (live, from .harness/graph checkpoints)
//   span waterfall  — the nested execution timeline per card (trace.ts): which
//                     node ran, which tool/CLI it invoked, duration, exit status
//   breakpoints     — click a node to arm/disarm a breakpoint; the loop pauses
//                     BEFORE that node and parks the card as 'paused'
//   state editor    — inspect and PATCH a paused card's checkpoint state, then
//                     ▶ resume (sets the card back to 'open')
//   time-travel     — rewind to any earlier step from the history trail
//   screenshots     — the .harness/shots gallery (what the agent's app looked
//                     like at approval time)
//
// State arrives over SSE (`/api/stream`). The loop is a separate process, so
// something has to poll the state stores — but it is the server that does it,
// once for every viewer, and it writes to the stream only when the payload
// actually changed. That is what makes the motion in this page legible: a card
// element survives across ticks, so a status change is a transition on a living
// node rather than a full innerHTML rebuild that has nothing to animate from.
// No LLM is called anywhere in this file; the whole console is free to run.
//
// Run:  node scripts/loop/dashboard.ts            (http://127.0.0.1:4780)
// Env:  HARNESS_DASHBOARD_PORT (default 4780)
//       HARNESS_DASHBOARD_POLL_MS (default 1000) — stream refresh interval
//
// Binds 127.0.0.1 only — this is a local operator console, not a public site.
// For hosted observability, set OTEL_EXPORTER_OTLP_ENDPOINT instead and read the
// same spans in Phoenix / Jaeger / LangSmith (see trace.ts).

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve, join, basename } from "node:path";
import { existsSync, readdirSync, readFileSync, statSync, realpathSync, openSync, readSync, closeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { exec, execSync } from "node:child_process";
import { homedir } from "node:os";
import { getBacklog } from "./backlog.ts";
import { activeCooldowns } from "./cooldown.ts";
import { spans, recentTraces } from "./trace.ts";
import { recent as recentEvents } from "./telemetry.ts";
import { RECURRING_JOBS, laneFor } from "./lanes.ts";
import { budgetStatus } from "./budget.ts";
import {
  LIFECYCLE_SCHEMA_VERSION,
  LifecycleStream,
  buildLifecycleView,
  lifecycleStreamTiming,
  type LifecycleView,
} from "./lifecycle.ts";
import {
  loadCheckpoint, listCheckpoints, patchCheckpointState, rewind, clearCheckpoint,
  breakpoints, setBreakpoint, clearBreakpoint,
} from "./graph.ts";

const ROOT = resolve(process.cwd());
const STATE_DIR = resolve(process.env.HARNESS_STATE_DIR || resolve(ROOT, ".harness"));
const SHOTS_DIR = resolve(STATE_DIR, "shots");
const PORT = Number(process.env.HARNESS_DASHBOARD_PORT) || 4780;
const STREAM_TIMING = lifecycleStreamTiming(Number(process.env.HARNESS_DASHBOARD_POLL_MS) || 1000);
const STREAM_POLL_MS = STREAM_TIMING.pollMs;
const PING_EVERY_TICKS = STREAM_TIMING.pingEveryTicks;

// The card pipeline as declared in ralph-loop.ts — kept here for rendering only;
// the live "where is it now" comes from the checkpoint, not from this list.
const PIPELINE = ["prime", "build", "strictHealth", "challenge", "review", "ship"];
const lifecycleFeed = new LifecycleStream<LifecycleView>({
  staleAfterMs: STREAM_TIMING.staleAfterMs,
});

function json(res: ServerResponse, code: number, data: unknown): void {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<Record<string, any>> {
  return new Promise<Record<string, any>>((res, rej) => {
    let body = "";
    req.on("data", (d: Buffer) => { body += d; if (body.length > 1_000_000) req.destroy(); });
    req.on("end", () => { try { res(body ? JSON.parse(body) : {}); } catch (e) { rej(e); } });
    req.on("error", rej);
  });
}

/**
 * Where the timer-driven work is pointed right now, and whether that lane can
 * currently take it.
 *
 * This is the operator's cost question answered structurally. The loop records no
 * token counts anywhere — inventing a spend chart would be decoration — but
 * "which lane does each recurring job ask for, and is it cooling down" is real,
 * and it is the knob that actually moves the bill.
 */
function laneReport() {
  const cooling = new Set(Object.keys(activeCooldowns()));
  return RECURRING_JOBS.map((job) => {
    const lane = laneFor(job);
    return {
      job,
      lane,
      // agy is the shipped default; anything else means an env override is in play.
      overridden: lane !== "agy",
      coolingDown: cooling.has(lane) || (lane === "agy" && cooling.has("antigravity")),
    };
  });
}

async function overviewPayload(): Promise<Record<string, unknown>> {
  const backlog = await getBacklog();
  // Human prompts captured in the knowledge base but not yet triaged into
  // cards (assess-prompts.ts runs only when the backlog empties). Optional:
  // in a repo without knowledge.ts the import fails and the panel stays empty.
  let pendingPrompts: Array<{ id: number; text: string }> = [];
  try {
    const { pendingPrompts: pending } = await import("./assess-prompts.ts");
    pendingPrompts = (await pending(50)).map((e: { id: number; body?: string; title?: string }) => ({
      id: e.id,
      text: String(e.body || e.title || "").slice(0, 160),
    }));
  } catch {}
  // The telemetry trail is the loop's own account of what it did — claims,
  // guards, deploys, rejections. It was reachable only over MCP and the CLI,
  // so the one surface an operator actually watches could not show it.
  let activity: Awaited<ReturnType<typeof recentEvents>> = [];
  try { activity = await recentEvents(40); } catch {}

  // What the loop actually spent. The lane panel below answers "which lane is
  // this pointed at"; this answers "and how much has that cost", which nothing
  // could report until budget.ts started keeping the ledger.
  let budget: Awaited<ReturnType<typeof budgetStatus>> | null = null;
  try { budget = await budgetStatus(); } catch {}

  const base = {
    budget,
    pipeline: PIPELINE,
    cards: backlog.list(),
    pendingPrompts,
    cooldowns: activeCooldowns(),
    checkpoints: listCheckpoints(),
    breakpoints: breakpoints(),
    traces: await recentTraces(30),
    activity,
    lanes: laneReport(),
  };
  const lifecycle = buildLifecycleView({
    cards: base.cards,
    checkpoints: base.checkpoints,
    activity: base.activity,
    budget: base.budget,
    lanes: base.lanes,
  });
  lifecycleFeed.update(lifecycle);
  const current = lifecycleFeed.currentSnapshot();
  return {
    ...base,
    schemaVersion: LIFECYCLE_SCHEMA_VERSION,
    streamId: current.streamId,
    sequence: current.sequence,
    freshness: current.freshness,
    lifecycle,
  };
}

async function cardPayload(card: string): Promise<Record<string, unknown>> {
  const backlog = await getBacklog();
  return {
    row: backlog.get(card),
    checkpoint: loadCheckpoint(card),
    spans: await spans(card),
  };
}

function shotsPayload(): Array<{ name: string; mtime: number }> {
  if (!existsSync(SHOTS_DIR)) return [];
  return readdirSync(SHOTS_DIR).filter((f) => f.endsWith(".png"))
    .map((f) => ({ name: f, mtime: statSync(join(SHOTS_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime).slice(0, 24);
}

// --- Multi-Agent Live Session & File Explorer Engines -------------------------

const HOME_DIR = homedir();
const AGY_BRAIN_DIR = join(HOME_DIR, ".gemini", "antigravity-cli", "brain");
const CLAUDE_PROJECTS_DIR = join(HOME_DIR, ".claude", "projects");

export function readLastLines(filePath: string, maxLines = 30): string[] {
  try {
    if (!existsSync(filePath)) return [];
    const stat = statSync(filePath);
    if (stat.size === 0) return [];
    const bufferSize = Math.min(stat.size, 128 * 1024);
    const fd = openSync(filePath, "r");
    const buffer = Buffer.alloc(bufferSize);
    readSync(fd, buffer, 0, bufferSize, Math.max(0, stat.size - bufferSize));
    closeSync(fd);
    const text = buffer.toString("utf8");
    return text.split("\n").filter(Boolean).slice(-maxLines);
  } catch {
    return [];
  }
}

export function scanAgySessions(maxSessions = 6): Array<Record<string, any>> {
  const sessions: Array<Record<string, any>> = [];
  try {
    if (!existsSync(AGY_BRAIN_DIR)) return sessions;
    const entries = readdirSync(AGY_BRAIN_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => {
        const dirPath = join(AGY_BRAIN_DIR, d.name);
        try { return { id: d.name, dirPath, mtime: statSync(dirPath).mtimeMs }; }
        catch { return null; }
      })
      .filter(Boolean) as Array<{ id: string; dirPath: string; mtime: number }>;

    entries.sort((a, b) => b.mtime - a.mtime);
    const now = Date.now();

    for (const entry of entries.slice(0, maxSessions)) {
      const logPath = join(entry.dirPath, ".system_generated", "logs", "transcript.jsonl");
      if (!existsSync(logPath)) continue;

      let logMtime = entry.mtime;
      try { logMtime = statSync(logPath).mtimeMs; } catch {}
      const isLive = now - logMtime < 1000 * 60 * 15;
      const isRecent = now - logMtime < 1000 * 60 * 60 * 24;
      if (!isRecent) continue;

      const lines = readLastLines(logPath, 40);
      if (!lines.length) continue;

      let userGoal = "";
      let latestAction = "대기 중 (Idle)";
      let latestTool = "";
      let latestStepIndex = 0;
      let codeSnippet = "";
      let targetFile = "";
      const activeFiles = new Set<string>();
      const recentActions: Array<Record<string, any>> = [];

      for (const line of lines) {
        try {
          const step = JSON.parse(line);
          if (typeof step.step_index === "number") latestStepIndex = Math.max(latestStepIndex, step.step_index);
          if (step.type === "USER_INPUT" && step.content) {
            const raw = String(step.content).replace(/<USER_REQUEST>|<\/USER_REQUEST>/g, "").trim();
            if (raw && !userGoal) userGoal = raw.slice(0, 160);
          }
          if (step.tool_calls && Array.isArray(step.tool_calls)) {
            for (const call of step.tool_calls) {
              latestTool = call.name || "tool_call";
              const actionName = call.args?.toolAction || call.args?.toolSummary || call.name;
              latestAction = actionName;

              const fileArg = call.args?.TargetFile || call.args?.AbsolutePath || call.args?.SearchPath || call.args?.CommandLine;
              if (fileArg && typeof fileArg === "string") {
                targetFile = fileArg.replace(/^["']|["']$/g, "");
                const base = basename(targetFile);
                if (base && !base.startsWith("git ") && !base.startsWith("npm ")) {
                  activeFiles.add(base);
                }
              }

              if (call.name === "write_to_file" && call.args?.CodeContent) {
                codeSnippet = String(call.args.CodeContent).slice(0, 1000);
              } else if (call.name === "replace_file_content") {
                const target = call.args?.TargetContent ? `// --- Target:\n${call.args.TargetContent}\n` : "";
                const repl = call.args?.ReplacementContent ? `// +++ Replacement:\n${call.args.ReplacementContent}` : "";
                codeSnippet = (target + repl).slice(0, 1000);
              } else if (call.name === "run_command" && call.args?.CommandLine) {
                codeSnippet = `$ ${call.args.CommandLine}`;
              }

              recentActions.push({
                stepIndex: step.step_index,
                tool: call.name,
                summary: actionName,
                time: step.created_at || new Date(logMtime).toISOString(),
                status: step.status || "DONE",
              });
            }
          }
        } catch {}
      }

      sessions.push({
        id: entry.id,
        type: "agy",
        role: "AGY Explorer / Control",
        lane: "lane/agy",
        status: isLive ? "active" : "idle",
        lastActiveAt: new Date(logMtime).toISOString(),
        stepCount: latestStepIndex,
        userGoal: userGoal || "자율 작업 수행 중",
        latestTool: latestTool || "planner",
        latestAction,
        targetFile,
        codeSnippet,
        activeFiles: Array.from(activeFiles).slice(0, 8),
        recentActions: recentActions.slice(-6).reverse(),
      });
    }
  } catch {}
  return sessions;
}

export function scanClaudeSessions(maxSessions = 6): Array<Record<string, any>> {
  const sessions: Array<Record<string, any>> = [];
  try {
    if (!existsSync(CLAUDE_PROJECTS_DIR)) return sessions;
    const projectDirs = readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(CLAUDE_PROJECTS_DIR, d.name));

    const jsonlFiles: Array<{ id: string; filePath: string; mtime: number }> = [];
    for (const pDir of projectDirs) {
      try {
        const files = readdirSync(pDir).filter((f) => f.endsWith(".jsonl"));
        for (const f of files) {
          const fp = join(pDir, f);
          try {
            jsonlFiles.push({ id: f.replace(".jsonl", ""), filePath: fp, mtime: statSync(fp).mtimeMs });
          } catch {}
        }
      } catch {}
    }

    jsonlFiles.sort((a, b) => b.mtime - a.mtime);
    const now = Date.now();

    for (const entry of jsonlFiles.slice(0, maxSessions)) {
      const isLive = now - entry.mtime < 1000 * 60 * 15;
      const isRecent = now - entry.mtime < 1000 * 60 * 60 * 24;
      if (!isRecent) continue;

      const lines = readLastLines(entry.filePath, 40);
      if (!lines.length) continue;

      let userGoal = "";
      let latestAction = "작업 완료 (Standby)";
      let latestTool = "";
      let codeSnippet = "";
      let targetFile = "";
      const activeFiles = new Set<string>();
      const recentActions: Array<Record<string, any>> = [];

      for (const line of lines) {
        try {
          const item = JSON.parse(line);
          if (item.type === "user" && item.message?.content) {
            const content = typeof item.message.content === "string" ? item.message.content : JSON.stringify(item.message.content);
            if (!userGoal) userGoal = content.slice(0, 160);
          }
          if (item.message?.content && Array.isArray(item.message.content)) {
            for (const part of item.message.content) {
              if (part.type === "tool_use") {
                latestTool = part.name;
                const toolInput = part.input || {};
                const summary = toolInput.command || toolInput.file_path || toolInput.path || part.name;
                latestAction = `${part.name}: ${String(summary).slice(0, 60)}`;
                if (toolInput.file_path || toolInput.path) {
                  targetFile = String(toolInput.file_path || toolInput.path);
                  activeFiles.add(basename(targetFile));
                }
                if (toolInput.content) codeSnippet = String(toolInput.content).slice(0, 1000);
                else if (toolInput.replacement) codeSnippet = String(toolInput.replacement).slice(0, 1000);
                else if (toolInput.command) codeSnippet = `$ ${toolInput.command}`;

                recentActions.push({
                  tool: part.name,
                  summary: String(summary).slice(0, 70),
                  time: item.timestamp || new Date(entry.mtime).toISOString(),
                  status: "DONE",
                });
              }
            }
          }
        } catch {}
      }

      sessions.push({
        id: entry.id,
        type: "claude",
        role: "Claude Lead / Reviewer",
        lane: "lane/claude",
        status: isLive ? "active" : "idle",
        lastActiveAt: new Date(entry.mtime).toISOString(),
        userGoal: userGoal || "카드 검증 및 사슬 조율",
        latestTool: latestTool || "Claude Assistant",
        latestAction,
        targetFile,
        codeSnippet,
        activeFiles: Array.from(activeFiles).filter(Boolean).slice(0, 8),
        recentActions: recentActions.slice(-6).reverse(),
      });
    }
  } catch {}
  return sessions;
}

export function scanWorktrees(): Array<Record<string, any>> {
  const worktrees: Array<Record<string, any>> = [];
  try {
    const raw = execSync("git worktree list --porcelain", { cwd: ROOT, encoding: "utf8", timeout: 3000 });
    const entries = raw.split("\n\n").filter(Boolean);
    for (const block of entries) {
      const lines = block.split("\n");
      let wtPath = "";
      let head = "";
      let branch = "HEAD (detached)";
      for (const line of lines) {
        if (line.startsWith("worktree ")) wtPath = line.replace("worktree ", "").trim();
        if (line.startsWith("HEAD ")) head = line.replace("HEAD ", "").trim().slice(0, 8);
        if (line.startsWith("branch refs/heads/")) branch = line.replace("branch refs/heads/", "").trim();
      }
      if (!wtPath || !existsSync(wtPath)) continue;

      let dirtyFiles: string[] = [];
      let lastCommit = "";
      let diffSnippet = "";

      try {
        const st = execSync("git status --porcelain", { cwd: wtPath, encoding: "utf8", timeout: 2000 }).trim();
        if (st) dirtyFiles = st.split("\n").map((l) => l.trim()).slice(0, 10);
      } catch {}

      try {
        lastCommit = execSync('git log -n 1 "--format=%h - %s (%cr)"', { cwd: wtPath, encoding: "utf8", timeout: 2000 }).trim();
      } catch {}

      // Avoid heavy git diff HEAD on every tick to prevent blocking event loop
      diffSnippet = dirtyFiles.length > 0 ? `Changed files:\n${dirtyFiles.join("\n")}` : "";

      worktrees.push({
        path: wtPath,
        name: basename(wtPath),
        branch,
        head,
        dirtyCount: dirtyFiles.length,
        dirtyFiles,
        lastCommit,
        diffSnippet,
        isMain: resolve(wtPath).toLowerCase() === resolve(ROOT).toLowerCase(),
      });
    }
  } catch {}
  return worktrees;
}

let cachedStudioSnapshot: Record<string, any> | null = null;
let lastStudioSnapshotMs = 0;
const STUDIO_SNAPSHOT_TTL_MS = 1500;

export function getAgentStudioSnapshot(): Record<string, any> {
  const now = Date.now();
  if (cachedStudioSnapshot && (now - lastStudioSnapshotMs) < STUDIO_SNAPSHOT_TTL_MS) {
    return cachedStudioSnapshot;
  }

  const agy = scanAgySessions(6);
  const claude = scanClaudeSessions(6);
  const worktrees = scanWorktrees();
  const allSessions = [...agy, ...claude].sort((a, b) => {
    const ta = new Date(a.lastActiveAt || 0).getTime();
    const tb = new Date(b.lastActiveAt || 0).getTime();
    return tb - ta;
  });
  const activeCount = allSessions.filter((s) => s.status === "active").length;
  const totalDirty = worktrees.reduce((acc, w) => acc + w.dirtyCount, 0);

  const snapshot = {
    ok: true,
    metrics: {
      totalSessions: allSessions.length,
      activeSessions: activeCount,
      totalWorktrees: worktrees.length,
      dirtyFilesCount: totalDirty,
      lanes: {
        agy: agy.length,
        claude: claude.length,
        worktrees: worktrees.length,
      },
    },
    sessions: allSessions,
    worktrees,
  };
  cachedStudioSnapshot = snapshot;
  lastStudioSnapshotMs = now;
  return snapshot;
}

export function getDirectoryTree(relDir = ""): { dir: string; entries: Array<{ name: string; isDir: boolean; path: string; size?: number; dirty?: boolean }> } {
  const normalizedRel = relDir.replace(/^\/+/, "").replace(/\.\./g, "");
  const targetDir = resolve(ROOT, normalizedRel);
  if (!targetDir.startsWith(ROOT)) {
    throw new Error("Access denied: path outside workspace");
  }
  if (!existsSync(targetDir) || !statSync(targetDir).isDirectory()) {
    throw new Error(`Directory not found: ${relDir}`);
  }

  const IGNORED = new Set([
    ".git", "node_modules", ".next", "dist", ".gemini", "coverage", ".turbo", "build",
    ".cache", ".vscode", ".idea", ".DS_Store"
  ]);

  const dirtySet = new Set<string>();
  try {
    const gitStatus = execSync("git status --porcelain", { cwd: ROOT, encoding: "utf8", timeout: 2000 });
    for (const line of gitStatus.split("\n")) {
      const trimmed = line.trim();
      if (trimmed) {
        const filePath = trimmed.slice(3).trim().replace(/\\/g, "/");
        dirtySet.add(filePath);
      }
    }
  } catch {}

  const rawEntries = readdirSync(targetDir, { withFileTypes: true });
  const entries = rawEntries
    .filter((e) => !IGNORED.has(e.name) && !e.name.endsWith(".harness-retired"))
    .map((e) => {
      const childRelPath = join(normalizedRel, e.name).replace(/\\/g, "/");
      const isDir = e.isDirectory();
      let size: number | undefined = undefined;
      if (!isDir) {
        try { size = statSync(join(targetDir, e.name)).size; } catch {}
      }
      const dirty = dirtySet.has(childRelPath) || Array.from(dirtySet).some((d) => d.startsWith(childRelPath + "/"));
      return {
        name: e.name,
        isDir,
        path: childRelPath,
        size,
        dirty,
      };
    })
    .sort((a, b) => {
      if (a.isDir && !b.isDir) return -1;
      if (!a.isDir && b.isDir) return 1;
      return a.name.localeCompare(b.name);
    });

  return { dir: normalizedRel, entries };
}

export function readFileContent(relPath: string): { path: string; content: string; lines: number; size: number } {
  if (!relPath) throw new Error("path required");
  const normalizedRel = relPath.replace(/^\/+/, "").replace(/\.\./g, "");
  const fullPath = resolve(ROOT, normalizedRel);
  if (!fullPath.startsWith(ROOT)) {
    throw new Error("Access denied: path outside workspace");
  }
  if (!existsSync(fullPath) || statSync(fullPath).isDirectory()) {
    throw new Error(`File not found: ${relPath}`);
  }
  const stat = statSync(fullPath);
  if (stat.size > 2 * 1024 * 1024) {
    throw new Error("File exceeds 2MB limit for direct preview");
  }
  const content = readFileSync(fullPath, "utf8");
  const lines = content.split("\n").length;
  return { path: normalizedRel, content, lines, size: stat.size };
}

export function getFileDiff(relPath: string): { path: string; diff: string; hasChanges: boolean } {
  if (!relPath) throw new Error("path required");
  const normalizedRel = relPath.replace(/^\/+/, "").replace(/\.\./g, "");
  const fullPath = resolve(ROOT, normalizedRel);
  if (!fullPath.startsWith(ROOT)) {
    throw new Error("Access denied: path outside workspace");
  }
  try {
    const diff = execSync(`git diff HEAD -- "${normalizedRel}"`, {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 3000,
    }).trim();
    return {
      path: normalizedRel,
      diff: diff || "(변경 사항 없음 - Clean)",
      hasChanges: Boolean(diff),
    };
  } catch (err: any) {
    return {
      path: normalizedRel,
      diff: `Diff error: ${err.message}`,
      hasChanges: false,
    };
  }
}

export function openInChrome(url: string): void {
  const chromeCmd = process.platform === "win32"
    ? `cmd /c start chrome "${url}"`
    : process.platform === "darwin"
    ? `open -a "Google Chrome" "${url}"`
    : `google-chrome "${url}" || chromium-browser "${url}" || chromium "${url}"`;

  exec(chromeCmd, (err) => {
    if (err) {
      const fallback = process.platform === "win32"
        ? `cmd /c start "" "${url}"`
        : process.platform === "darwin"
        ? `open "${url}"`
        : `xdg-open "${url}"`;
      exec(fallback).unref();
    }
  });
}

async function api(req: IncomingMessage, url: URL): Promise<unknown> {
  const [, , verb, arg] = url.pathname.split("/"); // /api/<verb>/<arg?>
  const backlog = await getBacklog();

  if (req.method === "GET" && verb === "overview") return overviewPayload();
  if (req.method === "GET" && verb === "lifecycle") {
    await overviewPayload();
    return lifecycleFeed.currentSnapshot();
  }
  if (req.method === "GET" && verb === "card" && arg) return cardPayload(arg);
  if (req.method === "GET" && verb === "shots") return shotsPayload();
  if (req.method === "GET" && (verb === "live-sessions" || (verb === "agent-studio" && arg === "sessions"))) {
    return getAgentStudioSnapshot();
  }
  if (req.method === "GET" && verb === "fs") {
    if (arg === "tree") {
      return getDirectoryTree(url.searchParams.get("dir") || "");
    }
    if (arg === "read") {
      return readFileContent(url.searchParams.get("path") || "");
    }
    if (arg === "diff") {
      return getFileDiff(url.searchParams.get("path") || "");
    }
  }
  if (req.method === "POST" && verb === "breakpoint") {
    const { key, node, on } = await readBody(req);
    if (!key || !node) throw new Error("key and node required");
    return on ? setBreakpoint(key, node) : clearBreakpoint(key, node);
  }
  if (req.method === "POST" && verb === "state" && arg) {
    const patch = await readBody(req);
    const cp = patchCheckpointState(arg, patch);
    if (!cp) throw new Error(`no checkpoint for "${arg}"`);
    return cp;
  }
  if (req.method === "POST" && verb === "rewind" && arg) {
    const { step } = await readBody(req);
    const cp = rewind(arg, Number(step));
    if (!cp) throw new Error(`cannot rewind "${arg}" to step ${step}`);
    return cp;
  }
  if (req.method === "POST" && verb === "resume" && arg) {
    const card = backlog.get(arg);
    if (!card) throw new Error(`no card "${arg}"`);
    if (card.status !== "paused") throw new Error(`card "${arg}" is not paused`);
    backlog.setStatus(arg, "open");
    return { card: arg, status: "open" };
  }
  if (req.method === "POST" && verb === "checkpoint-clear" && arg) {
    clearCheckpoint(arg);
    return { cleared: arg };
  }
  throw new Error(`unknown api: ${req.method} ${url.pathname}`);
}

// --- the live stream -------------------------------------------------------------
//
// One ticker serves every viewer and only exists while someone is watching. Each
// subscriber remembers the last body it was sent per event name, so an idle loop
// costs the browser nothing: the socket stays open and silent until the state
// stores actually differ. `card` is per-subscriber (whatever card that operator
// selected); `overview` and `shots` are shared and computed once per tick.

type Subscriber = {
  res: ServerResponse;
  card: string | null;
  /** last body written per event name — the change gate */
  last: Record<string, string>;
  lifecycleStreamId: string | null;
  lifecycleSequence: number;
};

const subscribers = new Set<Subscriber>();
let ticker: ReturnType<typeof setInterval> | null = null;
let pumping = false;
let ticks = 0;

function send(sub: Subscriber, event: string, data: unknown): void {
  const body = JSON.stringify(data ?? null);
  if (sub.last[event] === body) return;
  sub.last[event] = body;
  // JSON.stringify escapes newlines, so a payload can never break the framing.
  try { sub.res.write(`event: ${event}\ndata: ${body}\n\n`); } catch { drop(sub); }
}

function drop(sub: Subscriber): void {
  if (!subscribers.delete(sub)) return;
  if (!subscribers.size && ticker) { clearInterval(ticker); ticker = null; }
}

async function pump(): Promise<void> {
  if (pumping || !subscribers.size) return;
  pumping = true;
  try {
    const overview = await overviewPayload();
    const shots = shotsPayload();
    const agentStudio = getAgentStudioSnapshot();
    const cards = new Map<string, unknown>();
    for (const sub of [...subscribers]) {
      send(sub, "overview", overview);
      send(sub, "agent-sessions", agentStudio);
      const lifecycleItems = lifecycleFeed.resume({
        streamId: sub.lifecycleStreamId,
        sequence: sub.lifecycleSequence,
      });
      for (const item of lifecycleItems) {
        send(sub, `lifecycle-${item.kind}`, item);
        sub.lifecycleStreamId = item.streamId;
        sub.lifecycleSequence = item.sequence;
      }
      send(sub, "shots", shots);
      if (sub.card) {
        if (!cards.has(sub.card)) cards.set(sub.card, await cardPayload(sub.card));
        send(sub, "card", cards.get(sub.card));
      }
    }
    // A silent socket is indistinguishable from a dead one. Ping so the page can
    // tell "nothing is happening" from "the loop host went away".
    if (++ticks % PING_EVERY_TICKS === 0) {
      for (const sub of [...subscribers]) {
        try { sub.res.write(": ping\n\n"); } catch { drop(sub); }
      }
    }
  } catch (e) {
    // A transient read error must surface in the console, not kill it — the
    // operator needs to know the panels went stale rather than see them freeze.
    const detail = String((e as Error)?.message ?? e);
    for (const sub of [...subscribers]) send(sub, "stream-error", { error: detail, at: ticks });
  } finally {
    pumping = false;
  }
}

function subscribe(req: IncomingMessage, res: ServerResponse, url: URL): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  res.write(": open\n\n");

  const sub: Subscriber = {
    res,
    card: url.searchParams.get("card") || null,
    last: {},
    lifecycleStreamId: url.searchParams.get("streamId"),
    lifecycleSequence: Math.max(0, Number(url.searchParams.get("since")) || 0),
  };
  subscribers.add(sub);
  req.on("close", () => drop(sub));
  res.on("close", () => drop(sub));
  // A socket that dies mid-write (browser tab closed, laptop slept) reports it
  // asynchronously, which the try/catch around res.write cannot see. Without a
  // listener that EPIPE is an unhandled 'error' event and takes the whole
  // console down — a long-lived stream makes this ordinary, not exotic.
  res.on("error", () => drop(sub));

  if (!ticker) {
    ticker = setInterval(() => { void pump(); }, STREAM_POLL_MS);
    ticker.unref();
  }
  void pump();
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  try {
    if (url.pathname === "/api/stream") {
      subscribe(req, res, url);
      return;
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE);
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      json(res, 200, await api(req, url));
      return;
    }
    if (url.pathname.startsWith("/shots/")) {
      const name = url.pathname.slice("/shots/".length);
      // strict allowlist: a plain .png basename only — no separators, no traversal
      const p = /^[\w.-]+\.png$/.test(name) ? join(SHOTS_DIR, name) : null;
      if (p && existsSync(p)) {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(readFileSync(p));
        return;
      }
      json(res, 404, { error: "not found" });
      return;
    }
    json(res, 404, { error: "not found" });
  } catch (e) {
    json(res, 400, { error: String((e as Error)?.message ?? e) });
  }
});

// --- the single-page UI (inline, no CDN — works fully offline) --------------------

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>harness studio</title>
<style>
  :root { --bg:#0e1116; --panel:#161b22; --line:#2d333b; --fg:#c9d1d9; --dim:#768390;
          --ok:#3fb950; --err:#f85149; --run:#d29922; --acc:#539bf5; --bp:#e5534b;
          --runq:rgba(210,153,34,.45); --accq:rgba(83,155,245,.30); }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg);
         font:13px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace; }
  header { padding:10px 16px; border-bottom:1px solid var(--line); display:flex; gap:16px; align-items:baseline; }
  header h1 { font-size:14px; margin:0; color:var(--acc); }
  header .dim { color:var(--dim); }
  main { display:grid; grid-template-columns:270px 1fr; min-height:calc(100vh - 41px); }
  #side { border-right:1px solid var(--line); padding:12px; overflow-y:auto; }
  #main { padding:16px; overflow-x:auto; }
  h2 { font-size:12px; text-transform:uppercase; letter-spacing:.08em; color:var(--dim); margin:18px 0 8px; }
  h2:first-child { margin-top:0; }
  .muted { color:var(--dim); }
  .row { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
  .flash { color:var(--ok); }
  /* one row per lane, with the share drawn behind the text */
  .lane { position:relative; display:flex; justify-content:space-between; gap:8px; padding:1px 4px; }
  .lane i { position:absolute; left:0; bottom:0; height:2px; background:var(--acc); opacity:.5;
            transition:width .4s ease; }
  [hidden] { display:none !important; }
  .list:empty::after { content:attr(data-empty); color:var(--dim); }

  /* --- stream health --------------------------------------------------- */
  .live { display:inline-block; width:8px; height:8px; border-radius:50%; background:var(--dim);
          transition:background-color .3s ease; }
  .live.on { background:var(--ok); animation:beat 2.4s ease-in-out infinite; }
  .live.off { background:var(--err); animation:beat .9s ease-in-out infinite; }
  @keyframes beat { 0%,100% { opacity:1; transform:scale(1); } 50% { opacity:.35; transform:scale(.75); } }

  /* --- enter / exit ----------------------------------------------------- */
  /* The stream only writes on change, so these fire when the loop actually
     moved — an animation here is information, not decoration. */
  .enter { animation:enter .38s cubic-bezier(.2,.8,.3,1) both; }
  .exit  { animation:exit .22s ease-in both; pointer-events:none; }
  @keyframes enter { from { opacity:0; transform:translateY(-6px); } to { opacity:1; transform:none; } }
  @keyframes exit  { to { opacity:0; transform:translateX(10px); } }
  .bump { animation:bump .7s ease-out; }
  @keyframes bump { 0% { box-shadow:0 0 0 0 var(--accq); } 30% { box-shadow:0 0 0 4px var(--accq); }
                    100% { box-shadow:0 0 0 0 transparent; } }

  /* --- backlog ---------------------------------------------------------- */
  .card { padding:6px 8px; border:1px solid var(--line); border-radius:6px; margin-bottom:6px; cursor:pointer;
          display:flex; justify-content:space-between; gap:8px;
          transition:border-color .25s ease, background-color .25s ease; }
  .card:hover, .card.sel { border-color:var(--acc); }
  .card.sel { background:var(--panel); }
  .pill { font-size:11px; padding:0 7px; border-radius:9px; border:1px solid var(--line); white-space:nowrap;
          transition:color .35s ease, border-color .35s ease; }
  .src { font-size:10px; color:var(--dim); border:1px solid var(--line); border-radius:4px; padding:0 4px; white-space:nowrap; }
  .src-prompt { color:var(--acc); } .src-spec { color:var(--ok); }
  .st-open { color:var(--acc); } .st-claimed { color:var(--run); } .st-review { color:var(--run); }
  .st-done { color:var(--ok); } .st-failed { color:var(--err); } .st-paused { color:var(--bp); }

  /* --- pipeline --------------------------------------------------------- */
  #pipe { display:flex; align-items:center; flex-wrap:wrap; margin:8px 0 4px; }
  .step { display:inline-flex; align-items:center; }
  .step.last .arrow { display:none; }
  .node { position:relative; border:1px solid var(--line); border-radius:8px; padding:8px 14px; background:var(--panel);
          transition:border-color .4s ease, color .4s ease, background-color .4s ease, opacity .4s ease; }
  .step.past .node { color:var(--dim); opacity:.65; border-color:var(--line); }
  .step.cur .node { border-color:var(--run); color:var(--run); animation:pulse 1.9s ease-in-out infinite; }
  @keyframes pulse { 0%,100% { box-shadow:0 0 0 1px var(--run), 0 0 0 0 var(--runq); }
                     50%     { box-shadow:0 0 0 1px var(--run), 0 0 0 9px transparent; } }
  .node .bp { position:absolute; top:-6px; right:-6px; width:12px; height:12px; border-radius:50%;
              border:1px solid var(--line); background:var(--bg); cursor:pointer;
              transition:background-color .2s ease, border-color .2s ease, transform .2s ease; }
  .node .bp:hover { transform:scale(1.35); }
  .node .bp.on { background:var(--bp); border-color:var(--bp); }
  .arrow { color:var(--dim); padding:0 8px; transition:color .4s ease; }
  .step.past .arrow { color:var(--dim); opacity:.5; }
  /* the beam only runs on the edge leaving the node the loop is standing on */
  .step.cur .arrow { color:transparent; background-image:linear-gradient(90deg,var(--dim) 0 35%,var(--run) 50%,var(--dim) 65% 100%);
                     background-size:250% 100%; -webkit-background-clip:text; background-clip:text;
                     animation:beam 1.5s linear infinite; }
  @keyframes beam { from { background-position:150% 0; } to { background-position:-100% 0; } }

  /* --- tables / waterfall ----------------------------------------------- */
  table { border-collapse:collapse; width:100%; }
  td, th { padding:3px 8px; text-align:left; border-bottom:1px solid var(--line); vertical-align:top; }
  .bar-wrap { position:relative; background:var(--panel); height:14px; border-radius:3px; min-width:260px; overflow:hidden; }
  .bar { position:absolute; top:2px; height:10px; border-radius:2px; background:var(--acc); opacity:.85;
         transform-origin:left center; transition:left .35s ease, width .35s ease, background-color .3s ease; }
  .bar.err { background:var(--err); } .bar.node-k { background:var(--run); }
  tr.enter .bar { animation:grow .45s cubic-bezier(.2,.8,.3,1) both; }
  @keyframes grow { from { transform:scaleX(0); } to { transform:scaleX(1); } }
  /* a span with no end_ms is still running — say so, don't draw a finished bar */
  .bar.live::after { content:""; position:absolute; inset:0; border-radius:2px;
                     background:linear-gradient(90deg,transparent,rgba(255,255,255,.35),transparent);
                     animation:sweep 1.2s linear infinite; }
  @keyframes sweep { from { transform:translateX(-100%); } to { transform:translateX(100%); } }
  #activity tr.enter td { animation:hit 1.1s ease-out both; }
  @keyframes hit { 0% { background:var(--accq); } 100% { background:transparent; } }

  button { background:var(--panel); color:var(--fg); border:1px solid var(--line); border-radius:6px;
           padding:4px 10px; cursor:pointer; font:inherit; transition:border-color .2s ease; }
  button:hover { border-color:var(--acc); }
  button.warn { color:var(--bp); }
  textarea { width:100%; min-height:140px; background:var(--panel); color:var(--fg);
             border:1px solid var(--line); border-radius:6px; padding:8px; font:inherit; }
  #shots { display:flex; gap:10px; flex-wrap:wrap; }
  #shots img { width:180px; border:1px solid var(--line); border-radius:6px;
               transition:transform .2s ease, border-color .2s ease; }
  #shots img:hover { transform:scale(1.03); border-color:var(--acc); }

  @media (prefers-reduced-motion:reduce) {
    *, *::before, *::after { animation:none !important; transition:none !important; }
  }
  .nav-tab { background:#161b22; color:#c9d1d9; border:1px solid var(--line); border-radius:6px; padding:4px 10px; cursor:pointer; font:12px inherit; }
  .nav-tab:hover { border-color:var(--acc); }
  .nav-tab.active { background:var(--acc); color:#0e1116; font-weight:bold; border-color:var(--acc); }
  .nav-action { border-color:var(--ok); color:var(--ok); }
  .nav-action:hover { background:rgba(63,185,80,0.15); }
  .fs-item { padding:4px 6px; border-radius:4px; cursor:pointer; font-size:12px; display:flex; justify-content:space-between; align-items:center; }
  .fs-item:hover { background:#21262d; }
  .fs-item.sel { background:rgba(83,155,245,0.2); color:#539bf5; }
  .fs-dirty { color:#d29922; font-size:10px; font-weight:bold; margin-left:4px; }
  .diff-add { color:#3fb950; background:rgba(63,185,80,0.1); display:block; }
  .diff-del { color:#f85149; background:rgba(248,81,73,0.1); display:block; }
</style>
</head>
<body>
<header>
  <h1>harness studio</h1>
  <span class="live off" id="live" title="connecting…"></span>
  <span class="dim" id="meta">connecting…</span>
  <div style="margin-left:auto;display:flex;gap:6px;align-items:center;">
    <button class="nav-tab active" id="navPipe" onclick="showTab('pipe')">📊 파이프라인</button>
    <button class="nav-tab" id="navLive" onclick="showTab('live')">⚡ 실시간 코드 관제</button>
    <button class="nav-tab" id="navFiles" onclick="showTab('files')">📁 파일 탐색기</button>
    <button class="nav-tab nav-action" onclick="window.open(location.href,'_blank')">🌐 새 창 열기</button>
  </div>
</header>
<main id="pipeTab">
  <div id="side">
    <h2>Backlog</h2>
    <div id="cards" class="list" data-empty="(empty)"></div>
    <h2>Prompts awaiting triage</h2>
    <div id="pending" class="list" data-empty="(none — every captured prompt is triaged)"></div>
    <h2>Spend (24h)</h2>
    <div id="budget" class="list" data-empty="(no agent calls recorded)"></div>
    <h2>Cooldowns</h2>
    <div id="cooldowns" class="list" data-empty="none — all agents available"></div>
    <h2>Recurring lanes</h2>
    <div id="lanes" class="list" data-empty="(none)"></div>
    <h2>Recent traces</h2>
    <div id="traces" class="list" data-empty="(none yet)"></div>
  </div>
  <div id="main">
    <h2>Pipeline <span class="muted" id="pipecard">select a card</span></h2>
    <div id="pipe"></div>
    <div id="ctrl" class="row"></div>
    <h2>Span waterfall</h2>
    <div id="waterHint" class="muted">no spans yet</div>
    <table><tbody id="water"></tbody></table>
    <h2>Checkpoint history (click a step to rewind)</h2>
    <div id="hist" class="muted">—</div>
    <h2>State editor <span class="muted">(patch merges into the checkpoint state)</span></h2>
    <textarea id="state" spellcheck="false" placeholder='{"feedback": ""}'></textarea>
    <div class="row" style="margin-top:6px">
      <button id="saveState">save state patch</button>
      <span id="stateMsg"></span>
    </div>
    <h2>Activity <span class="muted">(the loop's own trail — claims, guards, deploys, rejections)</span></h2>
    <div id="activityHint" class="muted">(no events yet)</div>
    <table>
      <thead id="activityHead" hidden><tr><th>when</th><th>kind</th><th>card</th><th>actor</th><th>detail</th></tr></thead>
      <tbody id="activity"></tbody>
    </table>
    <h2>Screenshots (.harness/shots)</h2>
    <div id="shots" class="list" data-empty="(none)"></div>
  </div>
</main>
<div id="liveTab" class="view-panel" style="display:none;padding:16px;">
  <div class="row" style="justify-content:space-between;margin-bottom:12px;">
    <h2>동시 실행 세션 실시간 코드 스트림 <span class="muted" id="sessionCountText">0 active</span></h2>
    <div class="row">
      <span class="pill" id="livePill">● STREAMING</span>
      <button onclick="refreshLiveSessions()" style="padding:2px 8px;font-size:11px;cursor:pointer;">새로고침</button>
    </div>
  </div>
  <div id="liveGrid" style="display:grid;grid-template-columns:repeat(auto-fit, minmax(360px, 1fr));gap:14px;">
    <div class="muted" style="padding:20px;">감지된 활성 에이전트 세션이 없습니다. (Claude, AGY, Codex 세션 실행 시 자동 표시)</div>
  </div>
</div>
<div id="filesTab" class="view-panel" style="display:none;padding:16px;">
  <div style="display:grid;grid-template-columns:300px 1fr;gap:16px;min-height:calc(100vh - 80px);">
    <div style="border:1px solid var(--line);border-radius:8px;background:var(--panel);padding:12px;display:flex;flex-direction:column;gap:8px;">
      <div class="row" style="justify-content:space-between;">
        <h2 style="margin:0;">파일 탐색기</h2>
        <button id="btnFsRefresh" style="padding:2px 8px;font-size:11px;cursor:pointer;">새로고침</button>
      </div>
      <div id="fsBreadcrumb" style="font-size:11px;color:var(--dim);cursor:pointer;word-break:break-all;">/ (root)</div>
      <input id="fsSearch" placeholder="파일 검색..." style="background:var(--bg);border:1px solid var(--line);color:var(--fg);padding:4px 8px;border-radius:4px;font-size:12px;">
      <div id="fsList" style="flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:2px;"></div>
    </div>
    <div style="border:1px solid var(--line);border-radius:8px;background:var(--panel);padding:12px;display:flex;flex-direction:column;gap:10px;">
      <div class="row" style="justify-content:space-between;">
        <div id="selectedFilePath" style="font-weight:600;color:var(--acc);font-size:13px;">파일을 선택하세요</div>
        <div class="row" style="gap:6px;">
          <button id="btnViewRaw" class="pill st-done" style="cursor:pointer;">코드 원문</button>
          <button id="btnViewDiff" class="pill" style="cursor:pointer;">Git Diff</button>
          <button id="btnCopyFile" style="padding:2px 8px;font-size:11px;cursor:pointer;">복사</button>
        </div>
      </div>
      <div id="fsCodeContainer" style="flex:1;background:#090d16;border:1px solid #1e293b;border-radius:6px;padding:10px;font-family:monospace;font-size:12px;line-height:1.6;overflow:auto;white-space:pre-wrap;color:#e6edf3;">(좌측 탐색기에서 파일을 선택하면 실시간 내용 및 변경사항이 표시됩니다)</div>
    </div>
  </div>
</div>
<script>
var sel = null, overview = null, cardData = null, es = null;
/* breakpoint toggles the server has not confirmed yet — without this the next
   push (up to a tick away) would visibly snap the dot back under the cursor. */
var pendingBp = {};

function el(id) { return document.getElementById(id); }
function esc(s) { return String(s == null ? "" : s).replace(/[&<>'"]/g, function (c) {
  return { "&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", '"':"&quot;" }[c]; }); }
function api(path, body) {
  var opts = body ? { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify(body) } : {};
  return fetch(path, opts).then(function (r) { return r.json(); });
}

/* --- DOM primitives ---------------------------------------------------------
   The stream writes only when state changed, so the page must *update* nodes
   rather than rebuild them: a transition needs the element it started on to
   still be there. setHTML also stops the screenshot gallery from re-requesting
   every image on every tick. */
function tpl(html) {
  var t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}
function setHTML(box, html) { if (box.__html !== html) { box.__html = html; box.innerHTML = html; } }
function setText(box, s) { if (box.textContent !== s) box.textContent = s; }
function setClass(box, cls) { if (box.className !== cls) box.className = cls; }
function bump(n) {
  n.classList.remove("bump");
  void n.offsetWidth; /* restart the keyframe on a node that is already mounted */
  n.classList.add("bump");
  setTimeout(function () { n.classList.remove("bump"); }, 720);
}

/* Keyed reconciliation: a row that survives a push is the same DOM node, so only
   what actually moved animates. Departing rows hold their slot while they fade
   so the rows around them do not jump. */
function syncList(box, items, keyOf, create, update) {
  var live = box.__live || (box.__live = {});
  var dying = box.__dying || (box.__dying = {});
  var next = {};
  var cursor = box.firstChild;
  items.forEach(function (item) {
    var k = String(keyOf(item));
    var n = live[k] || null;
    if (!n && dying[k]) {
      n = dying[k];
      clearTimeout(n.__timer); n.__dying = false; n.classList.remove("exit"); delete dying[k];
    }
    if (!n) {
      n = create(item);
      n.classList.add("enter");
      n.__timer = setTimeout(function () { n.classList.remove("enter"); }, 420);
    }
    update(n, item);
    next[k] = n;
    while (cursor && cursor.__dying) cursor = cursor.nextSibling;
    if (cursor === n) cursor = cursor.nextSibling;
    else box.insertBefore(n, cursor);
  });
  Object.keys(live).forEach(function (k) {
    if (next[k]) return;
    var n = live[k];
    n.__dying = true;
    n.classList.remove("enter");
    n.classList.add("exit");
    dying[k] = n;
    clearTimeout(n.__timer);
    n.__timer = setTimeout(function () {
      delete dying[k];
      if (n.parentNode) n.parentNode.removeChild(n);
    }, 240);
  });
  box.__live = next;
}

/* --- panels ------------------------------------------------------------- */
function renderOverview(o) {
  overview = o;
  setText(el("meta"), o.cards.length + " cards · " + o.checkpoints.length + " live checkpoints");
  renderCards(o.cards);

  setHTML(el("pending"), (o.pendingPrompts || []).map(function (p) {
    return '<div class="card" title="kb#' + esc(p.id) + '"><span>' + esc(p.text) + '</span></div>';
  }).join(""));

  renderBudget(o.budget);

  setHTML(el("cooldowns"), Object.keys(o.cooldowns || {}).map(function (a) {
    return '<div>' + esc(a) + ' → ' + esc(new Date(o.cooldowns[a].until).toLocaleTimeString()) + '</div>';
  }).join(""));

  // Where the timer-driven work is pointed. No token counts are recorded anywhere
  // in the loop, so this answers the cost question with the knob that moves it
  // rather than with a spend chart nothing could populate honestly.
  setHTML(el("lanes"), (o.lanes || []).map(function (l) {
    var cls = l.coolingDown ? "st-failed" : (l.overridden ? "st-claimed" : "st-done");
    var note = l.coolingDown ? " (cooling down)" : (l.overridden ? " (override)" : "");
    return '<div>' + esc(l.job) + ' <span class="' + cls + '">→ ' + esc(l.lane) + esc(note) + '</span></div>';
  }).join(""));

  setHTML(el("traces"), (o.traces || []).map(function (t) {
    return '<div class="card" data-trace="' + esc(t.trace_id) + '"><span>' + esc(t.trace_id) +
      '</span><span class="pill">' + esc(t.n) + ' spans</span></div>';
  }).join(""));

  renderActivity(o.activity || []);
  renderPipe(cardData && cardData.checkpoint, o.breakpoints);
}

/* Spend, stated as precisely as the ledger can honestly state it: calls and
   wall-clock are true of every lane, token counts only of the lanes that
   reported them — so the panel names that denominator instead of printing a
   confident 0 for a lane that simply never said. */
function renderBudget(b) {
  if (!b || !b.today || !b.today.calls) { setHTML(el("budget"), ""); return; }
  var t = b.today, rows = [];
  rows.push('<div>' + t.calls + ' calls · ' + Math.round(t.ms / 1000) + 's agent time</div>');
  rows.push('<div>' + (t.tokens ? t.tokens + ' tokens' : 'tokens not reported') +
    ' <span class="muted">(' + t.reportedCalls + '/' + t.calls + ' lanes reporting)</span></div>');
  /* By lane, not just in total: the un-rationed lane SHOULD dominate this — that
     is what routing verification to it means — and a metered lane climbing the
     list is the thing worth noticing. */
  (b.todayByAgent || []).forEach(function (lane) {
    var share = t.calls ? Math.round((lane.calls / t.calls) * 100) : 0;
    rows.push('<div class="lane"><span>' + esc(lane.agent) + '</span>'
      + '<span class="muted">' + lane.calls + ' · ' + share + '%</span>'
      + '<i style="width:' + share + '%"></i></div>');
  });
  var caps = Object.keys(b.limits || {}).filter(function (k) { return b.limits[k] != null; });
  rows.push(caps.length
    ? '<div class="muted">caps: ' + caps.map(function (k) { return esc(k) + '=' + esc(b.limits[k]); }).join(", ") + '</div>'
    : '<div class="st-failed">no cap set — nothing bounds the spend</div>');
  if (b.tokenCapBlind) rows.push('<div class="st-paused">token cap set but no lane reports counts — it cannot bite</div>');
  (b.exceeded || []).forEach(function (r) { rows.push('<div class="st-failed">OVER: ' + esc(r) + '</div>'); });
  setHTML(el("budget"), rows.join(""));
}

function renderCards(list) {
  syncList(el("cards"), list, function (c) { return c.card; },
    function (c) {
      var n = tpl('<div class="card"><span class="nm"></span><span class="pill"></span></div>');
      n.addEventListener("click", function () { pick(c.card); });
      return n;
    },
    function (n, c) {
      var nm = n.querySelector(".nm"), pill = n.querySelector(".pill");
      setHTML(nm, esc(c.card) +
        (c.source ? ' <span class="src src-' + esc(c.source) + '">' + esc(c.source) + '</span>' : ""));
      if (n.__status && n.__status !== c.status) bump(n); /* the card really moved */
      n.__status = c.status;
      setText(pill, c.status);
      pill.className = "pill st-" + c.status;
      n.classList.toggle("sel", sel === c.card);
    });
}

function renderActivity(rows) {
  el("activityHint").hidden = rows.length > 0;
  el("activityHead").hidden = rows.length === 0;
  /* trail rows come from SQLite or not at all, so the row id is the key — a
     composite fallback could collide, and a duplicate key orphans a node in the
     DOM on every push. */
  syncList(el("activity"), rows, function (e) { return e.id; },
    function () {
      return tpl('<tr><td class="muted when"></td><td class="kind"></td><td class="who"></td>' +
                 '<td class="actor"></td><td class="detail"></td></tr>');
    },
    function (n, e) {
      setText(n.querySelector(".when"), String(e.ts || "").replace("T", " ").slice(0, 19));
      var k = n.querySelector(".kind");
      setText(k, e.kind);
      setClass(k, "kind " + (e.kind === "error" || e.kind === "reject" ? "st-failed"
        : e.kind === "guard" ? "st-paused"
        : e.kind === "deploy" || e.kind === "approve" ? "st-done" : ""));
      setText(n.querySelector(".who"), e.card || "");
      setText(n.querySelector(".actor"), e.actor || "");
      setText(n.querySelector(".detail"), String(e.detail || "").slice(0, 200));
    });
}

function renderPipe(cp, bps) {
  if (!overview) return;
  var armed = ((bps && bps[sel]) || []).concat((bps && bps["*"]) || []);
  var cur = cp && cp.node;
  var steps = overview.pipeline || [];
  var curIx = steps.indexOf(cur);
  syncList(el("pipe"), steps, function (name) { return name; },
    function (name) {
      var n = tpl('<span class="step"><span class="node"><span class="lbl"></span>' +
                  '<span class="bp" title="toggle breakpoint"></span></span><span class="arrow">──▶</span></span>');
      n.querySelector(".bp").addEventListener("click", function (ev) {
        ev.stopPropagation();
        var dot = n.querySelector(".bp");
        var on = !dot.classList.contains("on");
        pendingBp[name] = on;
        dot.classList.toggle("on", on);
        toggleBp(name, on);
      });
      return n;
    },
    function (n, name) {
      var ix = steps.indexOf(name);
      var on = armed.indexOf(name) >= 0;
      if (pendingBp[name] != null) {
        if (pendingBp[name] === on) delete pendingBp[name]; else on = pendingBp[name];
      }
      setText(n.querySelector(".lbl"), name);
      n.querySelector(".bp").classList.toggle("on", on);
      n.classList.toggle("cur", name === cur);
      n.classList.toggle("past", curIx >= 0 && ix < curIx);
      n.classList.toggle("last", ix === steps.length - 1);
    });
  setText(el("pipecard"), sel
    ? "· " + sel + (cur ? " @ " + cur + " (step " + cp.step + ")" : " (no live checkpoint)")
    : "select a card");
}

function renderWater(rows) {
  el("waterHint").hidden = rows.length > 0;
  /* An open span has not ended, so it runs to *now* — measuring it to its own
     start draws a 1px sliver for work that may have been going for minutes, and
     leaves the running shimmer nothing to live on. Clamping to start_ms keeps a
     browser clock behind the loop host's from producing a negative width. */
  var now = Date.now();
  function endOf(r) { return r.end_ms || Math.max(r.start_ms, now); }
  var t0 = 0, span = 1, depth = {};
  if (rows.length) {
    t0 = Math.min.apply(null, rows.map(function (r) { return r.start_ms; }));
    var t1 = Math.max.apply(null, rows.map(endOf));
    span = Math.max(1, t1 - t0);
    rows.forEach(function (r) {
      depth[r.span_id] = r.parent_id && depth[r.parent_id] != null ? depth[r.parent_id] + 1 : 0;
    });
  }
  syncList(el("water"), rows, function (r) { return r.span_id; },
    function () {
      return tpl('<tr><td class="nm" style="white-space:nowrap"></td><td class="muted kind"></td>' +
                 '<td class="muted ms"></td><td><div class="bar-wrap"><div class="bar"></div></div></td></tr>');
    },
    function (n, r) {
      var l = ((r.start_ms - t0) / span) * 100;
      var w = Math.max(0.6, ((endOf(r) - r.start_ms) / span) * 100);
      var nm = n.querySelector(".nm");
      setText(nm, (r.status === "error" ? "✗ " : "") + r.name);
      nm.style.paddingLeft = (depth[r.span_id] * 16 + 8) + "px";
      setText(n.querySelector(".kind"), r.kind);
      setText(n.querySelector(".ms"), r.end_ms ? (r.end_ms - r.start_ms) + "ms" : "…");
      var bar = n.querySelector(".bar");
      /* no end_ms means the span is still open — draw it as running, not finished */
      setClass(bar, "bar" + (r.status === "error" ? " err" : r.kind === "node" ? " node-k" : "") +
        (r.end_ms ? "" : " live"));
      bar.style.left = l + "%";
      bar.style.width = w + "%";
    });
}

function renderHist(cp) {
  setHTML(el("hist"), cp && cp.history && cp.history.length
    ? "<table>" + cp.history.map(function (h) {
        return '<tr><td><button data-rewind="' + esc(h.step) + '">⏪ ' + esc(h.step) + '</button></td><td>' +
          esc(h.node) + " → " + esc(h.next) + '</td><td class="muted">' + esc(h.at) + "</td></tr>";
      }).join("") + "</table>"
    : '<span class="muted">no checkpoint</span>');
}

function renderCtrl(row, cp) {
  var b = [];
  if (row && row.status === "paused") b.push('<button data-act="resume">▶ resume (set open)</button>');
  if (cp) b.push('<button class="warn" data-act="clearcp">discard checkpoint (restart card)</button>');
  setHTML(el("ctrl"), b.join(" "));
}

function renderShots(list) {
  setHTML(el("shots"), (list || []).map(function (s) {
    return '<a href="/shots/' + esc(s.name) + '" target="_blank">' +
      '<img src="/shots/' + esc(s.name) + '" title="' + esc(s.name) + '"></a>';
  }).join(""));
}

function renderCard(d) {
  cardData = d;
  renderPipe(d.checkpoint, overview && overview.breakpoints);
  renderWater(d.spans || []);
  renderHist(d.checkpoint);
  renderCtrl(d.row, d.checkpoint);
  if (document.activeElement !== el("state")) {
    var v = d.checkpoint ? JSON.stringify(d.checkpoint.state, null, 2) : "";
    if (el("state").value !== v) el("state").value = v;
  }
}

/* --- actions ------------------------------------------------------------- */
function pick(card) {
  if (sel === card) return;
  sel = card;
  cardData = null;
  pendingBp = {};
  if (overview) renderCards(overview.cards);
  connect(); /* resubscribe so the server streams this card's spans */
}
function toggleBp(node, on) {
  if (!sel) return;
  /* the optimistic dot has to be surrendered if the server never took the
     toggle, or it disagrees with the loop for as long as the page is open */
  api("/api/breakpoint", { key: sel, node: node, on: on })
    .then(function (r) { if (r && r.error) throw new Error(r.error); })
    .catch(function (e) {
      delete pendingBp[node];
      setText(el("meta"), "breakpoint failed: " + (e && e.message ? e.message : e));
    });
}
function saveState() {
  if (!sel) return;
  var patch;
  try { patch = JSON.parse(el("state").value); }
  catch (e) { setText(el("stateMsg"), "invalid JSON"); return; }
  api("/api/state/" + encodeURIComponent(sel), patch).then(function () {
    el("stateMsg").innerHTML = '<span class="flash">saved</span>';
    setTimeout(function () { el("stateMsg").textContent = ""; }, 1500);
  });
}

el("saveState").addEventListener("click", saveState);
el("traces").addEventListener("click", function (ev) {
  var t = ev.target.closest("[data-trace]");
  if (t) pick(t.getAttribute("data-trace"));
});
el("hist").addEventListener("click", function (ev) {
  var b = ev.target.closest("[data-rewind]");
  if (b && sel) api("/api/rewind/" + encodeURIComponent(sel), { step: Number(b.getAttribute("data-rewind")) });
});
el("ctrl").addEventListener("click", function (ev) {
  var b = ev.target.closest("[data-act]");
  if (!b || !sel) return;
  if (b.getAttribute("data-act") === "resume") api("/api/resume/" + encodeURIComponent(sel), {});
  else api("/api/checkpoint-clear/" + encodeURIComponent(sel), {});
});

/* --- tabs, live code streaming, and file explorer --------------------- */
var activeTab = 'pipe';
function showTab(t) {
  activeTab = t;
  el('pipeTab').style.display = t === 'pipe' ? 'grid' : 'none';
  el('liveTab').style.display = t === 'live' ? 'block' : 'none';
  el('filesTab').style.display = t === 'files' ? 'block' : 'none';
  el('navPipe').className = 'nav-tab' + (t === 'pipe' ? ' active' : '');
  el('navLive').className = 'nav-tab' + (t === 'live' ? ' active' : '');
  el('navFiles').className = 'nav-tab' + (t === 'files' ? ' active' : '');
  if (t === 'live') refreshLiveSessions();
  if (t === 'files' && !currentFsEntries.length) loadFsTree('');
}

var currentLiveSessions = [];
function renderAgentSessions(data) {
  if (!data || !data.sessions) return;
  currentLiveSessions = data.sessions;
  var act = (data.metrics ? data.metrics.activeSessions : 0);
  setText(el('sessionCountText'), act + ' active / ' + currentLiveSessions.length + ' total');
  var html = currentLiveSessions.map(function(s) {
    var isLive = s.status === 'active';
    var ago = s.lastActiveAt ? Math.max(0, Math.round((Date.now() - new Date(s.lastActiveAt).getTime()) / 1000)) : 0;
    return '<div class="session-card" style="border:1px solid var(--line);border-radius:8px;background:var(--panel);padding:12px;display:flex;flex-direction:column;gap:8px;">' +
      '<div class="row" style="justify-content:space-between;">' +
        '<div class="row" style="gap:6px;">' +
          '<span class="pill ' + (isLive ? 'st-done' : 'st-open') + '">' + esc(s.role || s.type) + '</span>' +
          '<span class="src">' + esc(s.id.slice(0,8)) + '</span>' +
        '</div>' +
        '<span class="muted" style="font-size:11px;">' + ago + 's ago</span>' +
      '</div>' +
      '<div style="font-size:12px;font-weight:600;color:var(--acc);">' + esc(s.userGoal || '자율 작업 진행 중') + '</div>' +
      '<div class="row" style="font-size:11px;color:var(--dim);gap:6px;">' +
        '<span>⚡ <b>' + esc(s.latestTool || 'idle') + '</b></span>' +
        (s.targetFile ? '<span class="pill" style="border-color:var(--acc);color:var(--acc);max-width:240px;overflow:hidden;text-overflow:ellipsis;">📄 ' + esc(s.targetFile) + '</span>' : '') +
      '</div>' +
      '<div style="background:#090d16;border:1px solid #1e293b;border-radius:6px;padding:8px;font-family:monospace;font-size:11px;max-height:220px;overflow-y:auto;white-space:pre-wrap;color:#a5d6ff;">' +
        esc(s.codeSnippet || s.latestAction || '(코드 생성 대기 중)') +
      '</div>' +
      '<div style="font-size:11px;color:var(--dim);">' +
        (s.recentActions && s.recentActions.length ? '최근: ' + esc(s.recentActions[0].summary) : '') +
      '</div>' +
    '</div>';
  }).join('');
  if (!html) html = '<div class="muted" style="padding:20px;">감지된 활성 에이전트 세션이 없습니다. (Claude, AGY, Codex 세션 실행 시 자동 표시)</div>';
  setHTML(el('liveGrid'), html);
}

function refreshLiveSessions() {
  api('/api/live-sessions').then(renderAgentSessions);
}

var currentFsDir = '';
var currentFsEntries = [];
var selectedFile = '';
var fileMode = 'raw';
var currentRawContent = '';
var currentDiffContent = '';

function loadFsTree(dir) {
  currentFsDir = dir || '';
  api('/api/fs/tree?dir=' + encodeURIComponent(currentFsDir)).then(function(res) {
    if (!res || !res.entries) return;
    currentFsEntries = res.entries;
    setText(el('fsBreadcrumb'), '/' + (res.dir || '(root)'));
    renderFsList(currentFsEntries);
  });
}

function renderFsList(entries) {
  var b = [];
  if (currentFsDir) {
    var parts = currentFsDir.split('/');
    var parent = parts.slice(0, -1).join('/');
    b.push('<div class="fs-item" data-fs-dir="' + esc(parent) + '">📁 .. (상위 폴더)</div>');
  }
  entries.forEach(function(e) {
    var icon = e.isDir ? '📁' : '📄';
    var dirty = e.dirty ? '<span class="fs-dirty">[M]</span>' : '';
    if (e.isDir) {
      b.push('<div class="fs-item" data-fs-dir="' + esc(e.path) + '"><span>' + icon + ' ' + esc(e.name) + '</span>' + dirty + '</div>');
    } else {
      var isSel = selectedFile === e.path ? ' sel' : '';
      b.push('<div class="fs-item' + isSel + '" data-fs-file="' + esc(e.path) + '"><span>' + icon + ' ' + esc(e.name) + '</span>' + dirty + '</div>');
    }
  });
  setHTML(el('fsList'), b.join(''));
}

function filterFsTree(q) {
  if (!q) return renderFsList(currentFsEntries);
  var filtered = currentFsEntries.filter(function(e) {
    return e.name.toLowerCase().indexOf(q.toLowerCase()) !== -1;
  });
  renderFsList(filtered);
}

function selectFile(p) {
  selectedFile = p;
  renderFsList(currentFsEntries);
  setText(el('selectedFilePath'), p);
  api('/api/fs/read?path=' + encodeURIComponent(p)).then(function(r) {
    currentRawContent = r && r.content ? r.content : '(빈 파일)';
    api('/api/fs/diff?path=' + encodeURIComponent(p)).then(function(d) {
      currentDiffContent = d && d.diff ? d.diff : '(변경 사항 없음 - Clean)';
      updateFileDisplay();
    });
  }).catch(function(e) {
    currentRawContent = 'Error reading file: ' + e.message;
    updateFileDisplay();
  });
}

function switchFileMode(m) {
  fileMode = m;
  el('btnViewRaw').className = 'pill' + (m === 'raw' ? ' st-done' : '');
  el('btnViewDiff').className = 'pill' + (m === 'diff' ? ' st-done' : '');
  updateFileDisplay();
}

function updateFileDisplay() {
  var box = el('fsCodeContainer');
  if (fileMode === 'raw') {
    box.textContent = currentRawContent;
  } else {
    var lines = currentDiffContent.split(String.fromCharCode(10));
    var html = lines.map(function(l) {
      if (l.startsWith('+') && !l.startsWith('+++')) return '<span class="diff-add">' + esc(l) + '</span>';
      if (l.startsWith('-') && !l.startsWith('---')) return '<span class="diff-del">' + esc(l) + '</span>';
      return '<span>' + esc(l) + '</span>';
    }).join('');
    box.innerHTML = html;
  }
}

function copyFileContent() {
  var text = fileMode === 'raw' ? currentRawContent : currentDiffContent;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(function() {
      alert('클립보드에 복사되었습니다.');
    });
  }
}
el('fsList').addEventListener('click', function(ev) {
  var item = ev.target.closest('.fs-item');
  if (!item) return;
  var dir = item.getAttribute('data-fs-dir');
  if (dir !== null) { loadFsTree(dir); return; }
  var file = item.getAttribute('data-fs-file');
  if (file !== null) { selectFile(file); return; }
});
el('btnFsRefresh').addEventListener('click', function() { loadFsTree(currentFsDir); });
el('fsBreadcrumb').addEventListener('click', function() { loadFsTree(''); });
el('fsSearch').addEventListener('input', function(e) { filterFsTree(e.target.value); });
el('btnViewRaw').addEventListener('click', function() { switchFileMode('raw'); });
el('btnViewDiff').addEventListener('click', function() { switchFileMode('diff'); });
el('btnCopyFile').addEventListener('click', copyFileContent);

/* --- the stream ----------------------------------------------------------
   EventSource reconnects on its own, so there is no retry loop here; the dot in
   the header is the only thing that has to know the link went down. */
function connect() {
  if (es) es.close();
  es = new EventSource("/api/stream" + (sel ? "?card=" + encodeURIComponent(sel) : ""));
  es.addEventListener("overview", function (e) { renderOverview(JSON.parse(e.data)); });
  es.addEventListener("card", function (e) { renderCard(JSON.parse(e.data)); });
  es.addEventListener("shots", function (e) { renderShots(JSON.parse(e.data)); });
  es.addEventListener("agent-sessions", function (e) { renderAgentSessions(JSON.parse(e.data)); });
  /* named so it cannot collide with EventSource's own transport "error" event */
  es.addEventListener("stream-error", function (e) {
    setText(el("meta"), "stream error: " + JSON.parse(e.data).error);
  });
  es.onopen = function () {
    setClass(el("live"), "live on");
    el("live").title = "live";
    if (el("meta").textContent === "connecting…") setText(el("meta"), "live · waiting for events");
  };
  es.onerror = function () { setClass(el("live"), "live off"); el("live").title = "reconnecting…"; };
}

// Instant bootstrap: fetch overview & live sessions via REST immediately without waiting for SSE tick
api("/api/overview").then(function(o) { if (o) renderOverview(o); }).catch(function() {});
api("/api/live-sessions").then(function(s) { if (s) renderAgentSessions(s); }).catch(function() {});
connect();
</script>
</body>
</html>`;

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
  const shouldOpenChrome = process.argv.includes("--chrome") || process.argv.includes("--open") || process.env.HARNESS_STUDIO_CHROME === "1";
  const portArg = process.argv.find((a) => a.startsWith("--port="))?.split("=")[1];
  const listenPort = Number(portArg) || PORT;

  server.listen(listenPort, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${listenPort}`;
    console.log(`harness studio → ${url}  (state: ${STATE_DIR})`);
    if (shouldOpenChrome) {
      console.log(`[Studio] Google Chrome 실행: ${url}`);
      openInChrome(url);
    }
  });
}

export { server, api, PORT };
