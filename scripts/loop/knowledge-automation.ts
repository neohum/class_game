#!/usr/bin/env node
// knowledge-automation.ts — portable scheduling for the local knowledge loop.
// macOS uses launchd, Linux systemd --user, and Windows Task Scheduler.

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");

function shellQuote(value: string): string {
  return process.platform === "win32" ? `\"${String(value).replaceAll('"', '\\"')}\"`
    : `'${String(value).replaceAll("'", "'\\''")}'`;
}

export function automationPlan({ platform = process.platform, root = ROOT, node = process.execPath } = {}) {
  const script = join(root, "scripts", "loop", "knowledge-automation.ts");
  const command = (kind: string) => `${shellQuote(node)} ${shellQuote(script)} run ${kind}`;
  const base = {
    platform,
    sync: { every: "5h", command: command("sync") },
    garden: { every: "24h", command: command("garden") },
  };
  if (platform === "darwin") return { ...base, install: { command: "launchctl bootstrap gui/$UID <generated-plist>" } };
  if (platform === "linux") return { ...base, install: { command: "systemctl --user daemon-reload && systemctl --user enable --now agent-harness-knowledge-sync.timer agent-harness-knowledge-garden.timer" } };
  if (platform === "win32") return { ...base, install: { command: "schtasks /Create /TN AgentHarnessKnowledgeSync /SC HOURLY /MO 5 /TR <command>" } };
  return { ...base, install: { command: "unsupported platform; run the displayed commands from your scheduler" } };
}

function runKnowledge(kind: string) {
  // Sync is deliberately read-only: providers already record durable lessons at
  // task completion. Garden keeps the local index inspectable without trusting
  // an external service or operating-system-specific daemon.
  const args = [join(HERE, "knowledge.ts"), kind === "sync" ? "list" : "search", kind === "sync" ? "" : "lesson"];
  const result = spawnSync(process.execPath, args.filter(Boolean), { cwd: ROOT, stdio: "inherit", windowsHide: true });
  process.exitCode = result.status ?? 1;
}

function writeMacPlan() {
  const dir = join(homedir(), "Library", "LaunchAgents");
  mkdirSync(dir, { recursive: true });
  for (const [kind, seconds] of [["sync", 18_000], ["garden", 86_400]]) {
    const file = join(dir, `com.agent-harness.knowledge-${kind}.plist`);
    writeFileSync(file, `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>Label</key><string>com.agent-harness.knowledge-${kind}</string><key>ProgramArguments</key><array><string>${process.execPath}</string><string>${join(HERE, "knowledge-automation.ts")}</string><string>run</string><string>${kind}</string></array><key>StartInterval</key><integer>${seconds}</integer><key>WorkingDirectory</key><string>${ROOT}</string></dict></plist>`);
  }
}

function main() {
  const [command, kind] = process.argv.slice(2);
  if (command === "plan") return console.log(JSON.stringify(automationPlan(), null, 2));
  if (command === "run" && kind && ["sync", "garden"].includes(kind)) return runKnowledge(kind);
  if (command === "install") {
    const plan = automationPlan();
    if (process.platform === "darwin") writeMacPlan();
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  console.error("usage: knowledge-automation.ts <plan|install|run sync|run garden>");
  process.exitCode = 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
