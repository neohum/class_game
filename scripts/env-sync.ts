#!/usr/bin/env node
/**
 * env-sync.ts — Autonomous Infisical Vault Synchronization for Agent Harness
 *
 * Capabilities:
 *  - pull:   Fetches secrets from Infisical vault and performs Smart Merge with local .env
 *  - push:   Uploads local .env secrets to Infisical vault (preserves .env.local isolation)
 *  - watch:  Continuously monitors .env changes and automatically pushes updates to vault
 *  - status: Shows diff between local .env and remote Infisical vault
 *
 * Zero external npm dependencies: uses native Node.js 18+ fetch and fs APIs.
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

interface InfisicalSecret {
  secretKey: string;
  secretValue: string;
  secretComment?: string;
}

interface AuthConfig {
  domain: string;
  clientId?: string;
  clientSecret?: string;
  token?: string;
}

const DEFAULT_DOMAIN = "https://infisicalinfisicallatest-postgres-production-b6ca.up.railway.app";
const DEFAULT_ENV = "dev";

// ============================================================================
// 1. Authentication
// ============================================================================

function getSavedAuthConfig(): AuthConfig | null {
  // 1. Check environment variables
  if (process.env.INFISICAL_TOKEN) {
    return {
      domain: process.env.INFISICAL_DOMAIN || DEFAULT_DOMAIN,
      token: process.env.INFISICAL_TOKEN,
    };
  }
  if (process.env.INFISICAL_CLIENT_ID && process.env.INFISICAL_CLIENT_SECRET) {
    return {
      domain: process.env.INFISICAL_DOMAIN || DEFAULT_DOMAIN,
      clientId: process.env.INFISICAL_CLIENT_ID,
      clientSecret: process.env.INFISICAL_CLIENT_SECRET,
    };
  }

  // 2. Check ~/.infisical/harness-auth.json (Machine Identity)
  const harnessAuthPath = path.join(os.homedir(), ".infisical", "harness-auth.json");
  if (fs.existsSync(harnessAuthPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(harnessAuthPath, "utf8"));
      if (data.clientId && data.clientSecret) {
        return {
          domain: data.domain || DEFAULT_DOMAIN,
          clientId: data.clientId,
          clientSecret: data.clientSecret,
        };
      }
    } catch {}
  }

  // 3. Fallback: Windows Credential Manager if on Windows
  if (process.platform === "win32") {
    try {
      const psCode = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class CM {
    [DllImport("Advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredRead(string target, int type, int reservedFlag, out IntPtr credentialPtr);
    [DllImport("Advapi32.dll", EntryPoint = "CredFree", SetLastError = true)]
    public static extern void CredFree(IntPtr cred);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct CREDENTIAL {
        public int Flags; public int Type; public string TargetName; public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
        public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
    }
    public static string GetSecret(string target) {
        IntPtr ptr;
        if (CredRead(target, 1, 0, out ptr)) {
            CREDENTIAL cred = (CREDENTIAL)Marshal.PtrToStructure(ptr, typeof(CREDENTIAL));
            byte[] bytes = new byte[cred.CredentialBlobSize];
            Marshal.Copy(cred.CredentialBlob, bytes, 0, cred.CredentialBlobSize);
            CredFree(ptr);
            return Encoding.UTF8.GetString(bytes);
        }
        return null;
    }
}
"@; [CM]::GetSecret('infisical-cli:neohum77@gmail.com')
`;
      const out = execSync(`powershell -NoProfile -Command "${psCode.replace(/"/g, '\\"')}"`, {
        encoding: "utf8",
        timeout: 5000,
        windowsHide: true,
      }).trim();
      if (out) {
        const parsed = JSON.parse(out);
        if (parsed.JTWToken) {
          return {
            domain: DEFAULT_DOMAIN,
            token: parsed.JTWToken,
          };
        }
      }
    } catch {}
  }

  return null;
}

async function getAccessToken(auth: AuthConfig): Promise<string> {
  if (auth.token) {
    return auth.token;
  }

  if (auth.clientId && auth.clientSecret) {
    const res = await fetch(`${auth.domain}/api/v1/auth/universal-auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: auth.clientId,
        clientSecret: auth.clientSecret,
      }),
    });

    if (!res.ok) {
      throw new Error(`Universal Auth Login failed (status: ${res.status}): ${await res.text()}`);
    }

    const data = await res.json() as any;
    return data.accessToken;
  }

  throw new Error("No valid authentication credentials found. Run 'npx @infisical/cli login' or configure ~/.infisical/harness-auth.json.");
}

// ============================================================================
// 2. Project & Workspace Resolution
// ============================================================================

function detectProjectName(customProject?: string): string {
  if (customProject) return customProject;

  const cwd = process.cwd();

  // 1. Check .harness-version.json
  const harnessVerPath = path.join(cwd, ".harness-version.json");
  if (fs.existsSync(harnessVerPath)) {
    try {
      const hv = JSON.parse(fs.readFileSync(harnessVerPath, "utf8"));
      if (hv.projectName) return hv.projectName;
      if (hv.name) return hv.name;
    } catch {}
  }

  // 2. Check package.json
  const pkgPath = path.join(cwd, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      if (pkg.name) {
        // Strip scope if present: @org/app -> app
        return pkg.name.startsWith("@") ? pkg.name.split("/")[1] : pkg.name;
      }
    } catch {}
  }

  // 3. Fallback: directory name
  return path.basename(cwd);
}

async function resolveWorkspace(domain: string, token: string, projectName: string): Promise<{ id: string; name: string }> {
  const res = await fetch(`${domain}/api/v1/workspace`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    throw new Error(`Failed to list workspaces (status: ${res.status}): ${await res.text()}`);
  }

  const data = await res.json() as any;
  const workspaces = data.workspaces || [];

  const norm = (s: string) => s.toLowerCase().replace(/[-_]/g, "");
  const found = workspaces.find((w: any) =>
    norm(w.name) === norm(projectName) ||
    w.slug.toLowerCase().startsWith(projectName.toLowerCase().replace(/_/g, "-")) ||
    w.slug.toLowerCase().startsWith(projectName.toLowerCase().replace(/-/g, "_")),
  );

  if (found) {
    return { id: found.id, name: found.name };
  }

  // Auto-create workspace if not found
  console.log(`[env-sync] Workspace [${projectName}] not found in Infisical. Creating automatically...`);
  const createRes = await fetch(`${domain}/api/v2/workspace`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      projectName,
      type: "secret-manager",
    }),
  });

  if (!createRes.ok) {
    throw new Error(`Failed to auto-create workspace [${projectName}]: ${await createRes.text()}`);
  }

  const createData = await createRes.json() as any;
  return { id: createData.project.id, name: createData.project.name };
}

// ============================================================================
// 3. .env Parser & Smart Merge
// ============================================================================

interface EnvLine {
  type: "comment" | "blank" | "keyvalue";
  raw: string;
  key?: string;
  value?: string;
}

function parseEnvFileLines(filePath: string): EnvLine[] {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/);
  const result: EnvLine[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      result.push({ type: "blank", raw: line });
    } else if (trimmed.startsWith("#")) {
      result.push({ type: "comment", raw: line });
    } else {
      const idx = line.indexOf("=");
      if (idx !== -1) {
        const key = line.slice(0, idx).trim();
        let val = line.slice(idx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        result.push({ type: "keyvalue", raw: line, key, value: val });
      } else {
        result.push({ type: "comment", raw: line });
      }
    }
  }

  return result;
}

function smartMerge(existingLines: EnvLine[], remoteSecrets: InfisicalSecret[]): { mergedContent: string; stats: { updated: number; added: number; preserved: number } } {
  const remoteMap = new Map<string, string>();
  for (const s of remoteSecrets) {
    remoteMap.set(s.secretKey, s.secretValue);
  }

  const updatedLines: string[] = [];
  const handledKeys = new Set<string>();
  let updatedCount = 0;
  let preservedCount = 0;

  for (const item of existingLines) {
    if (item.type === "keyvalue" && item.key) {
      handledKeys.add(item.key);
      if (remoteMap.has(item.key)) {
        const remoteVal = remoteMap.get(item.key)!;
        if (item.value !== remoteVal) {
          updatedLines.push(`${item.key}=${formatEnvValue(remoteVal)}`);
          updatedCount++;
        } else {
          updatedLines.push(item.raw);
        }
      } else {
        // Preserved local-only key
        updatedLines.push(item.raw);
        preservedCount++;
      }
    } else {
      updatedLines.push(item.raw);
    }
  }

  // Add new remote keys that were not in the local file
  const addedKeys: string[] = [];
  for (const [rKey, rVal] of remoteMap.entries()) {
    if (!handledKeys.has(rKey)) {
      addedKeys.push(`${rKey}=${formatEnvValue(rVal)}`);
    }
  }

  if (addedKeys.length > 0) {
    if (updatedLines.length > 0 && updatedLines[updatedLines.length - 1] !== "") {
      updatedLines.push("");
    }
    updatedLines.push("# Synced from Infisical");
    for (const line of addedKeys) {
      updatedLines.push(line);
    }
  }

  return {
    mergedContent: updatedLines.join("\n") + "\n",
    stats: { updated: updatedCount, added: addedKeys.length, preserved: preservedCount },
  };
}

function formatEnvValue(val: string): string {
  if (val.includes("\n") || val.includes(" ") || val.includes('"') || val.includes("#")) {
    return `"${val.replace(/"/g, '\\"')}"`;
  }
  return val;
}

function readLocalEnvSecrets(filePath: string): InfisicalSecret[] {
  const lines = parseEnvFileLines(filePath);
  const secrets: InfisicalSecret[] = [];
  for (const line of lines) {
    if (line.type === "keyvalue" && line.key) {
      secrets.push({
        secretKey: line.key,
        secretValue: line.value || "",
      });
    }
  }
  return secrets;
}

// ============================================================================
// 4. Remote Operations (Pull, Push, Status)
// ============================================================================

async function fetchRemoteSecrets(domain: string, token: string, workspaceId: string, env: string): Promise<InfisicalSecret[]> {
  const res = await fetch(`${domain}/api/v3/secrets/raw?workspaceId=${workspaceId}&environment=${env}&secretPath=/`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch secrets (status: ${res.status}): ${await res.text()}`);
  }

  const data = await res.json() as any;
  const secrets = (data.secrets || []) as any[];
  return secrets.map(s => ({
    secretKey: s.secretKey,
    secretValue: s.secretValue,
    secretComment: s.secretComment || "",
  }));
}

async function pushSecretsToRemote(domain: string, token: string, workspaceId: string, env: string, secrets: InfisicalSecret[]): Promise<boolean> {
  if (secrets.length === 0) return true;

  // Try batch create first
  const postRes = await fetch(`${domain}/api/v3/secrets/batch/raw`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      workspaceId,
      environment: env,
      secretPath: "/",
      secrets,
    }),
  });

  if (postRes.ok) return true;

  // If some keys already exist, use PATCH
  const patchRes = await fetch(`${domain}/api/v3/secrets/batch/raw`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      workspaceId,
      environment: env,
      secretPath: "/",
      secrets,
    }),
  });

  if (patchRes.ok) return true;

  const errText = await patchRes.text();
  console.error(`[env-sync] Push error: ${errText}`);
  return false;
}

// ============================================================================
// 5. CLI Commands
// ============================================================================

export async function pullCommand(options: { project?: string; env?: string; silent?: boolean } = {}) {
  const auth = getSavedAuthConfig();
  if (!auth) {
    if (!options.silent) console.error("[env-sync] ⚠️  Not authenticated to Infisical. Run 'npx @infisical/cli login' first.");
    return;
  }

  const token = await getAccessToken(auth);
  const projectName = detectProjectName(options.project);
  const env = options.env || DEFAULT_ENV;
  const envFilePath = path.join(process.cwd(), ".env");

  const workspace = await resolveWorkspace(auth.domain, token, projectName);
  const remoteSecrets = await fetchRemoteSecrets(auth.domain, token, workspace.id, env);

  const existingLines = fs.existsSync(envFilePath) ? parseEnvFileLines(envFilePath) : [];
  const { mergedContent, stats } = smartMerge(existingLines, remoteSecrets);

  // Safe write
  if (fs.existsSync(envFilePath)) {
    fs.copyFileSync(envFilePath, `${envFilePath}.bak`);
  }
  fs.writeFileSync(envFilePath, mergedContent, "utf8");

  if (!options.silent) {
    console.log(`[env-sync] ✓ Synced [.env] for [${workspace.name}] (${env}):`);
    console.log(`           Remote keys: ${remoteSecrets.length} | Updated: ${stats.updated} | Added: ${stats.added} | Local preserved: ${stats.preserved}`);
  }
}

export async function pushCommand(options: { project?: string; env?: string; silent?: boolean } = {}) {
  const auth = getSavedAuthConfig();
  if (!auth) {
    if (!options.silent) console.error("[env-sync] ⚠️  Not authenticated to Infisical.");
    return;
  }

  const token = await getAccessToken(auth);
  const projectName = detectProjectName(options.project);
  const env = options.env || DEFAULT_ENV;
  const envFilePath = path.join(process.cwd(), ".env");

  if (!fs.existsSync(envFilePath)) {
    console.warn(`[env-sync] No .env file found at ${envFilePath}`);
    return;
  }

  const localSecrets = readLocalEnvSecrets(envFilePath);
  const workspace = await resolveWorkspace(auth.domain, token, projectName);

  const success = await pushSecretsToRemote(auth.domain, token, workspace.id, env, localSecrets);
  if (success && !options.silent) {
    console.log(`[env-sync] ✓ Pushed ${localSecrets.length} secrets from [.env] to [${workspace.name}] (${env}).`);
  }
}

export async function statusCommand(options: { project?: string; env?: string } = {}) {
  const auth = getSavedAuthConfig();
  if (!auth) {
    console.error("[env-sync] ⚠️  Not authenticated to Infisical.");
    return;
  }

  const token = await getAccessToken(auth);
  const projectName = detectProjectName(options.project);
  const env = options.env || DEFAULT_ENV;
  const envFilePath = path.join(process.cwd(), ".env");

  const workspace = await resolveWorkspace(auth.domain, token, projectName);
  const remoteSecrets = await fetchRemoteSecrets(auth.domain, token, workspace.id, env);
  const localSecrets = fs.existsSync(envFilePath) ? readLocalEnvSecrets(envFilePath) : [];

  const localMap = new Map(localSecrets.map(s => [s.secretKey, s.secretValue]));
  const remoteMap = new Map(remoteSecrets.map(s => [s.secretKey, s.secretValue]));

  console.log(`\n=== [env-sync] Status: [${workspace.name}] (${env}) ===`);
  console.log(`Local .env:     ${localSecrets.length} keys`);
  console.log(`Remote Vault:   ${remoteSecrets.length} keys\n`);

  let inSync = true;
  for (const [key, rVal] of remoteMap.entries()) {
    if (!localMap.has(key)) {
      console.log(`  + MISSING LOCALLY: ${key}`);
      inSync = false;
    } else if (localMap.get(key) !== rVal) {
      console.log(`  ~ VALUE MISMATCH:  ${key}`);
      inSync = false;
    }
  }

  for (const key of localMap.keys()) {
    if (!remoteMap.has(key)) {
      console.log(`  ? LOCAL ONLY:      ${key}`);
      inSync = false;
    }
  }

  if (inSync) {
    console.log("  ✓ Local .env is fully synchronized with Infisical vault.\n");
  } else {
    console.log("\n  Run 'node scripts/env-sync.ts pull' or 'push' to synchronize.\n");
  }
}

export async function watchCommand(options: { project?: string; env?: string } = {}) {
  const auth = getSavedAuthConfig();
  if (!auth) {
    console.error("[env-sync] ⚠️  Not authenticated to Infisical.");
    return;
  }

  const token = await getAccessToken(auth);
  const projectName = detectProjectName(options.project);
  const env = options.env || DEFAULT_ENV;
  const envFilePath = path.join(process.cwd(), ".env");

  const workspace = await resolveWorkspace(auth.domain, token, projectName);
  console.log(`[env-sync] 👀 Watching [${envFilePath}] for changes -> Auto-sync to [${workspace.name}] (${env})...`);
  console.log(`           (Press Ctrl+C to exit)`);

  let debounceTimer: NodeJS.Timeout | null = null;
  fs.watch(envFilePath, (eventType) => {
    if (eventType !== "change") return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      try {
        const secrets = readLocalEnvSecrets(envFilePath);
        console.log(`[env-sync] 🔄 Detected change in .env. Syncing ${secrets.length} secrets to Infisical...`);
        const ok = await pushSecretsToRemote(auth.domain, token, workspace.id, env, secrets);
        if (ok) {
          console.log(`[env-sync] ✓ Updated Infisical vault successfully.`);
        }
      } catch (err: any) {
        console.error(`[env-sync] Auto-sync failed: ${err.message}`);
      }
    }, 600);
  });
}

async function runAllProjects(action: "pull" | "push" | "status", env: string) {
  let projects: { name: string; path: string }[] = [];
  try {
    const out = execSync("orca repo list --json", { encoding: "utf8", windowsHide: true });
    const repos = (JSON.parse(out).result?.repos || []) as any[];
    const seen = new Set<string>();
    for (const r of repos) {
      if (!fs.existsSync(r.path) || seen.has(r.displayName)) continue;
      seen.add(r.displayName);
      projects.push({ name: r.displayName, path: r.path });
    }
  } catch {
    console.error("[env-sync] Failed to list projects from Orca.");
    return;
  }

  console.log(`\n=== [env-sync] Running [${action}] in parallel across ${projects.length} Orca projects ===\n`);

  const auth = getSavedAuthConfig();
  if (!auth) {
    console.error("[env-sync] ⚠️  Not authenticated to Infisical.");
    return;
  }
  const token = await getAccessToken(auth);

  const results = await Promise.allSettled(
    projects.map(async (p) => {
      const workspace = await resolveWorkspace(auth.domain, token, p.name);
      const envFile = path.join(p.path, ".env");

      if (action === "status") {
        const remoteSecrets = await fetchRemoteSecrets(auth.domain, token, workspace.id, env);
        const localSecrets = fs.existsSync(envFile) ? readLocalEnvSecrets(envFile) : [];
        const localMap = new Map(localSecrets.map(s => [s.secretKey, s.secretValue]));
        const remoteMap = new Map(remoteSecrets.map(s => [s.secretKey, s.secretValue]));
        let diffs = 0;
        for (const [k, v] of remoteMap.entries()) {
          if (!localMap.has(k) || localMap.get(k) !== v) diffs++;
        }
        for (const k of localMap.keys()) {
          if (!remoteMap.has(k)) diffs++;
        }
        return { name: p.name, local: localSecrets.length, remote: remoteSecrets.length, inSync: diffs === 0 };
      } else if (action === "pull") {
        const remoteSecrets = await fetchRemoteSecrets(auth.domain, token, workspace.id, env);
        const existingLines = fs.existsSync(envFile) ? parseEnvFileLines(envFile) : [];
        const { mergedContent, stats } = smartMerge(existingLines, remoteSecrets);
        if (fs.existsSync(envFile)) {
          fs.copyFileSync(envFile, `${envFile}.bak`);
        }
        fs.writeFileSync(envFile, mergedContent, "utf8");
        return { name: p.name, remote: remoteSecrets.length, updated: stats.updated, added: stats.added };
      } else if (action === "push") {
        if (!fs.existsSync(envFile)) {
          return { name: p.name, pushed: 0, skipped: true };
        }
        const localSecrets = readLocalEnvSecrets(envFile);
        await pushSecretsToRemote(auth.domain, token, workspace.id, env, localSecrets);
        return { name: p.name, pushed: localSecrets.length, skipped: false };
      }
    })
  );

  if (action === "status") {
    console.log("----------------------------------------------------------------------------------");
    console.log("Project Name".padEnd(25) + "Local Keys".padEnd(15) + "Remote Vault Keys".padEnd(20) + "Status");
    console.log("----------------------------------------------------------------------------------");
    for (const res of results) {
      if (res.status === "fulfilled" && res.value) {
        const v = res.value;
        const statusText = v.inSync ? "✓ In Sync" : "⚠️  Differs";
        console.log(v.name.padEnd(25) + String(v.local).padEnd(15) + String(v.remote).padEnd(20) + statusText);
      } else if (res.status === "rejected") {
        console.log("ERROR: " + res.reason?.message);
      }
    }
    console.log("----------------------------------------------------------------------------------\n");
  } else if (action === "pull") {
    for (const res of results) {
      if (res.status === "fulfilled" && res.value) {
        const v = res.value;
        console.log(`  ✓ [${v.name}] Synced ${v.remote} keys (updated: ${v.updated}, added: ${v.added})`);
      }
    }
    console.log("\n  ✓ Parallel pull complete across all projects.\n");
  } else if (action === "push") {
    for (const res of results) {
      if (res.status === "fulfilled" && res.value) {
        const v = res.value;
        if (v.skipped) {
          console.log(`  - [${v.name}] Skipped (no local .env)`);
        } else {
          console.log(`  ✓ [${v.name}] Pushed ${v.pushed} keys to remote vault`);
        }
      }
    }
    console.log("\n  ✓ Parallel push complete across all projects.\n");
  }
}

// ============================================================================
// 6. CLI Entrypoint
// ============================================================================

async function runCli() {
  const args = process.argv.slice(2);
  const command = args[0] || "pull";

  const getArg = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : undefined;
  };

  const project = getArg("--project");
  const env = getArg("--env") || DEFAULT_ENV;
  const silent = args.includes("--silent");
  const all = args.includes("--all") || project === "all";

  try {
    if (all && ["pull", "push", "status"].includes(command)) {
      await runAllProjects(command as any, env);
      return;
    }

    switch (command) {
      case "pull":
        await pullCommand({ project, env, silent });
        break;
      case "push":
        await pushCommand({ project, env, silent });
        break;
      case "status":
        await statusCommand({ project, env });
        break;
      case "watch":
        await watchCommand({ project, env });
        break;
      default:
        console.log(`Usage: node scripts/env-sync.ts [pull|push|status|watch] [--project <name>|--all] [--env <dev|staging|prod>] [--silent]`);
    }
  } catch (err: any) {
    if (!silent) {
      console.error(`[env-sync] Error: ${err.message}`);
    }
    process.exit(silent ? 0 : 1);
  }
}

if (process.argv[1] && (process.argv[1].endsWith("env-sync.ts") || process.argv[1].endsWith("env-sync.cjs") || process.argv[1].endsWith("env-sync.js"))) {
  runCli();
}
