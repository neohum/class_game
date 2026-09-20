#!/usr/bin/env node
// mcp-registry.ts — one place to see and change which MCP servers this project
// exposes to its agents.
//
// Every client keeps its own file: Claude reads `.mcp.json`, AGY reads
// `.agents/mcp_config.json`. Both use the same `{ mcpServers: { name: {command,
// args, env} } }` shape, so "add this server" meant hand-editing two files and
// hoping they agreed. They drift, and the drift is invisible: an agent simply
// does not have a tool the other one does.
//
// Deliberately NOT a marketplace. There is no catalogue to browse and nothing is
// downloaded — a scaffolder with zero runtime dependencies has no business
// fetching and running third-party code. What it does is make the registration
// you already perform by hand explicit, symmetric across clients, and checkable.
//
// Usage:
//   node scripts/loop/mcp-registry.ts list
//   node scripts/loop/mcp-registry.ts add <name> --command node --args a,b [--env K=V] [--client claude|agy|all]
//   node scripts/loop/mcp-registry.ts remove <name> [--client claude|agy|all]
//   node scripts/loop/mcp-registry.ts doctor
//   node scripts/loop/mcp-registry.ts tools          (what the harness server itself offers)

import { existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { resolve, dirname, delimiter } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(process.cwd());

/** One MCP server entry, in the shape every client uses. */
export interface ServerSpec {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface ClientRegistry {
  label: string;
  file: string;
  exists: boolean;
  malformed: boolean;
  servers: Record<string, ServerSpec>;
}

export interface McpConfig {
  mcpServers: Record<string, ServerSpec>;
  [key: string]: unknown;
}

export interface Problem {
  client?: string;
  server?: string;
  kind: string;
  detail?: string;
}

/** Where each client looks. Same schema, different file — that is the whole problem. */
export const CLIENTS: Record<string, { label: string; file: string }> = {
  claude: { label: "Claude Code", file: resolve(ROOT, ".mcp.json") },
  agy: { label: "AGY", file: resolve(ROOT, ".agents", "mcp_config.json") },
};

function readConfig(file: string): McpConfig | null {
  if (!existsSync(file)) return { mcpServers: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object") return { mcpServers: {} };
    parsed.mcpServers ??= {};
    return parsed as McpConfig;
  } catch {
    // A malformed config is a decision for a human, not something to overwrite.
    return null;
  }
}

function writeConfig(file: string, config: McpConfig): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
}

/** Every registered server, per client, plus which clients disagree. */
export function registry(): { byClient: Record<string, ClientRegistry>; drift: Array<{ name: string; missingFrom: string[] }> } {
  const byClient: Record<string, ClientRegistry> = {};
  for (const [key, { file, label }] of Object.entries(CLIENTS)) {
    const config = readConfig(file);
    byClient[key] = {
      label,
      file,
      exists: existsSync(file),
      malformed: config === null,
      servers: config?.mcpServers ?? {},
    };
  }
  const names = new Set(Object.values(byClient).flatMap((c) => Object.keys(c.servers)));
  const drift = [...names]
    .map((name) => ({
      name,
      missingFrom: Object.entries(byClient)
        .filter(([, c]) => !c.malformed && !(name in c.servers))
        .map(([key]) => key),
    }))
    .filter((d) => d.missingFrom.length);
  return { byClient, drift };
}

const targets = (client?: string): string[] =>
  client && client !== "all" ? [client] : Object.keys(CLIENTS);

export function addServer(name: string, spec: ServerSpec, { client = "all" }: { client?: string } = {}): string[] {
  const changed = [];
  for (const key of targets(client)) {
    const { file } = CLIENTS[key]!;
    const config = readConfig(file);
    if (config === null) throw new Error(`${file} is not valid JSON — fix it by hand first`);
    config.mcpServers[name] = { command: spec.command, args: spec.args ?? [], env: spec.env ?? {} };
    writeConfig(file, config);
    changed.push(key);
  }
  return changed;
}

export function removeServer(name: string, { client = "all" }: { client?: string } = {}): string[] {
  const changed = [];
  for (const key of targets(client)) {
    const { file } = CLIENTS[key]!;
    const config = readConfig(file);
    if (config === null) throw new Error(`${file} is not valid JSON — fix it by hand first`);
    if (!(name in config.mcpServers)) continue;
    delete config.mcpServers[name];
    writeConfig(file, config);
    changed.push(key);
  }
  return changed;
}

/** Cross-platform PATH lookup, matching the one ralph-loop uses for agent CLIs. */
function onPath(base: string): boolean {
  const dirs = (process.env.PATH || "").split(delimiter).filter(Boolean);
  const exts = process.platform === "win32"
    ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").map((e) => e.trim()).filter(Boolean)
    : [""];
  return dirs.some((dir) => exts.some((ext) => existsSync(resolve(dir, base + ext))));
}

/**
 * Can each registered server actually start?
 *
 * A server whose script was renamed or whose CLI is not installed does not error
 * — the client simply comes up without those tools, and an agent quietly cannot
 * do something it could yesterday. That is the failure this reports.
 */
export function doctor(): { problems: Problem[]; notices: Problem[] } {
  const { byClient, drift } = registry();
  const problems: Problem[] = [];

  for (const [key, client] of Object.entries(byClient)) {
    if (client.malformed) {
      problems.push({ client: key, kind: "malformed-config", detail: client.file });
      continue;
    }
    for (const [name, spec] of Object.entries(client.servers)) {
      if (!spec?.command) {
        problems.push({ client: key, server: name, kind: "no-command" });
        continue;
      }
      if (!onPath(spec.command) && !existsSync(resolve(ROOT, spec.command))) {
        problems.push({ client: key, server: name, kind: "command-not-found", detail: spec.command });
      }
      // A script argument that no longer exists is the rename failure mode: the
      // command resolves, the script it is handed does not.
      for (const arg of spec.args ?? []) {
        if (typeof arg !== "string" || !/\.(mjs|cjs|js|ts|mts)$/.test(arg)) continue;
        if (!existsSync(resolve(ROOT, arg))) {
          problems.push({ client: key, server: name, kind: "script-missing", detail: arg });
        }
      }
    }
  }

  // Drift is reported, not failed on. Registering a server for one client can be
  // deliberate — a filesystem server scoped to the agent that needs it — and a
  // check that fails on a legitimate configuration only teaches people to ignore
  // it. What cannot be deliberate is a server that could never start.
  const notices = drift.map((d) => ({
    server: d.name,
    kind: "not-registered-everywhere",
    detail: `missing from: ${d.missingFrom.join(", ")}`,
  }));
  return { problems, notices };
}

function parseFlags(args: string[]): ServerSpec & { client?: string } {
  const out: ServerSpec & { client?: string } = { command: "", env: {} };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--command") out.command = args[++i] ?? "";
    else if (a === "--args") out.args = String(args[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--client") out.client = args[++i] ?? "";
    else if (a === "--env") {
      const [k, ...v] = String(args[++i] ?? "").split("=");
      if (k) out.env![k] = v.join("=");
    }
  }
  return out;
}

// `import.meta.url` is realpath-resolved by the loader while `process.argv[1]` is
// the raw path the caller typed; on a symlinked path the two differ and a naive
// comparison makes this CLI silently no-op with exit 0.
const isMainModule = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isMainModule) {
  const [cmd, ...rest] = process.argv.slice(2);

  if (cmd === "list") {
    const { byClient, drift } = registry();
    for (const [key, client] of Object.entries(byClient)) {
      const state = client.malformed ? "MALFORMED" : client.exists ? "" : "(no config)";
      console.log(`\n${client.label} — ${client.file} ${state}`);
      const names = Object.keys(client.servers);
      if (!names.length) console.log("  (none)");
      for (const name of names) {
        const s = client.servers[name];
        if (!s) continue;
        console.log(`  ${name.padEnd(16)} ${s.command} ${(s.args ?? []).join(" ")}`);
      }
    }
    if (drift.length) {
      console.log("\nnot registered everywhere:");
      for (const d of drift) console.log(`  ${d.name} — missing from ${d.missingFrom.join(", ")}`);
    }
  } else if (cmd === "add") {
    const [name, ...flagArgs] = rest;
    const flags = parseFlags(flagArgs);
    if (!name || !flags.command) {
      console.error("usage: mcp-registry.ts add <name> --command <cmd> [--args a,b] [--env K=V] [--client claude|agy|all]");
      process.exit(2);
    }
    const changed = addServer(name, flags, { client: flags.client });
    console.log(`registered "${name}" in: ${changed.join(", ")}`);
  } else if (cmd === "remove") {
    const [name, ...flagArgs] = rest;
    const flags = parseFlags(flagArgs);
    if (!name) {
      console.error("usage: mcp-registry.ts remove <name> [--client claude|agy|all]");
      process.exit(2);
    }
    const changed = removeServer(name, { client: flags.client });
    if (!changed.length) { console.error(`no server "${name}" registered`); process.exit(1); }
    console.log(`removed "${name}" from: ${changed.join(", ")}`);
  } else if (cmd === "doctor") {
    const { problems, notices } = doctor();
    const line = (p: Problem) => `${p.kind}: ${[p.client, p.server, p.detail].filter(Boolean).join(" · ")}`;
    for (const n of notices) console.log(`note  ${line(n)}`);
    for (const p of problems) console.log(`ERROR ${line(p)}`);
    if (!problems.length) console.log("every registered MCP server resolves");
    if (problems.length) process.exit(1);
  } else if (cmd === "tools") {
    const { TOOLS, SERVER_INFO } = await import("./mcp-harness.ts");
    console.log(`${SERVER_INFO.name} v${SERVER_INFO.version} — ${TOOLS.length} tools`);
    for (const t of TOOLS) console.log(`  ${t.name.padEnd(22)} ${t.description ?? ""}`);
  } else {
    console.error("usage: mcp-registry.ts <list|add|remove|doctor|tools> ...");
    process.exit(2);
  }
}
