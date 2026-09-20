// Resolve the official AGY CLI before PATH. WindowsApps can register agy.exe
// for the desktop app, which opens the GUI instead of accepting CLI arguments.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

function pathCandidates(name: string): string[] {
  const found = spawnSync("where.exe", [name], { encoding: "utf8", windowsHide: true });
  if (found.status !== 0) return [];
  return String(found.stdout || "").split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
}

function isWindowsAppAlias(path: string): boolean {
  return path.toLowerCase().includes("\\microsoft\\windowsapps\\");
}

export function agyCliBin({ platform = process.platform, env = process.env } = {}) {
  if (platform !== "win32") return "agy";

  // This is the official Windows installer location. Prefer it even if an app
  // execution alias happens to appear earlier in PATH.
  const installed = env.LOCALAPPDATA && join(env.LOCALAPPDATA, "agy", "bin", "agy.exe");
  if (installed && existsSync(installed)) return installed;

  return pathCandidates("agy.exe").find((path) => !isWindowsAppAlias(path)) || null;
}
