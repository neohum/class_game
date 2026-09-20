// version-sync.ts — one semantic patch bump per harness change-set.

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PRODUCT_NAME = "@neohum77/create-agent-harness";
const VERSION_RE = /^\d+\.\d+\.\d+$/;

export type VersionSyncStatus = "bumped" | "already-bumped" | "docs-only" | "not-applicable";

export interface VersionSyncResult {
  applicable: boolean;
  status: VersionSyncStatus;
  version: string;
  changed: string[];
}

export interface VersionCheckResult {
  applicable: boolean;
  ok: boolean;
  version: string;
  changed: string[];
  errors: string[];
}

interface Surface {
  path: string;
  readVersion(content: string): string[];
  writeVersion(content: string, version: string): string;
}

function git(root: string, args: string[]): string | null {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  return result.status === 0 ? String(result.stdout) : null;
}

function lines(value: string | null): string[] {
  return value === null ? [] : value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

export function changedPaths(root = process.cwd()): string[] {
  return [...new Set([
    ...lines(git(root, ["diff", "--name-only", "HEAD", "--"])),
    ...lines(git(root, ["ls-files", "--others", "--exclude-standard"])),
  ].map((path) => path.replace(/\\/g, "/")))];
}

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, "utf8"));
}

function jsonSurface(path: string, mutate: (value: Record<string, any>, version: string) => void, extract: (value: Record<string, any>) => string[]): Surface {
  return {
    path,
    readVersion: (content) => extract(JSON.parse(content)),
    writeVersion: (content, version) => {
      const value = JSON.parse(content);
      mutate(value, version);
      return JSON.stringify(value, null, 2) + "\n";
    },
  };
}

function surfaces(root: string): Surface[] {
  const candidates: Surface[] = [
    jsonSurface("package.json", (v, n) => { v.version = n; }, (v) => [v.version]),
    jsonSurface("package-lock.json", (v, n) => {
      v.version = n;
      if (v.packages?.[""]) v.packages[""].version = n;
    }, (v) => [v.version, v.packages?.[""]?.version].filter(Boolean)),
    jsonSurface(".harness-version.json", (v, n) => { v.version = n; }, (v) => [v.version]),
    jsonSurface("studio/frontend/package.json", (v, n) => { v.version = n; }, (v) => [v.version]),
    jsonSurface("studio/frontend/package-lock.json", (v, n) => {
      v.version = n;
      if (v.packages?.[""]) v.packages[""].version = n;
    }, (v) => [v.version, v.packages?.[""]?.version].filter(Boolean)),
    {
      path: "studio/build/config.yml",
      readVersion: (content) => [content.match(/^\s{2}version:\s*["'](\d+\.\d+\.\d+)["']\s*$/m)?.[1] || ""],
      writeVersion: (content, version) => content.replace(/^(\s{2}version:\s*)["']\d+\.\d+\.\d+["']\s*$/m, `$1"${version}"`),
    },
    {
      path: "studio/build/darwin/Info.plist",
      readVersion: (content) => [
        content.match(/<key>CFBundleVersion<\/key>\s*<string>([^<]+)<\/string>/)?.[1] || "",
        content.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/)?.[1] || "",
      ],
      writeVersion: (content, version) => content
        .replace(/(<key>CFBundleVersion<\/key>\s*<string>)[^<]+(<\/string>)/, `$1${version}$2`)
        .replace(/(<key>CFBundleShortVersionString<\/key>\s*<string>)[^<]+(<\/string>)/, `$1${version}$2`),
    },
    jsonSurface("studio/build/windows/info.json", (v, n) => {
      if (v.fixed) v.fixed.file_version = n;
      if (v.info?.["0000"]) v.info["0000"].ProductVersion = n;
    }, (v) => [v.fixed?.file_version, v.info?.["0000"]?.ProductVersion].filter(Boolean)),
    {
      path: "studio/build/windows/wails.exe.manifest",
      readVersion: (content) => [content.match(/<assemblyIdentity\b[^>]*\bversion="(\d+\.\d+\.\d+)"/)?.[1] || ""],
      writeVersion: (content, version) => content.replace(/(<assemblyIdentity\b[^>]*\bversion=")\d+\.\d+\.\d+("[^>]*>)/, `$1${version}$2`),
    },
  ];
  return candidates.filter((surface) => existsSync(join(root, surface.path)));
}

function baselineFile(root: string, path: string): string | null {
  return git(root, ["show", `HEAD:${path}`]);
}

function baselineVersion(root: string): string | null {
  const source = baselineFile(root, "package.json");
  if (!source) return null;
  try {
    const value = JSON.parse(source).version;
    return VERSION_RE.test(value) ? value : null;
  } catch {
    return null;
  }
}

function nextPatch(version: string): string {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
  return `${major}.${minor}.${patch + 1}`;
}

function isDocumentationOrState(path: string): boolean {
  const value = path.replace(/\\/g, "/");
  if (value === "AGENTS.md" || value.startsWith("template/")) return false;
  if (/^(evidence|plans|docs|\.hallmark|\.harness|current_tasks)\//.test(value)) return true;
  // README는 어느 깊이에 있든 문서다. 루트에만 매칭하면 `evals/README.md` 같은 설명
  // 파일을 고칠 때마다 버전이 올라가고, 그 올림을 설명하려고 다시 README를 고치게 된다.
  if (/(^|\/)README\.md$/i.test(value)) return true;
  if (/^(README|CHANGELOG|DESIGN|lat|spec|plan|current)\.md$/i.test(value)) return true;
  return /\.plan\.md$/i.test(value);
}

function normalizedSurface(surface: Surface, content: string): string {
  try { return surface.writeVersion(content, "0.0.0"); }
  catch { return content; }
}

function isVersionOnlySurfaceChange(root: string, path: string, all: Surface[]): boolean {
  const surface = all.find((candidate) => candidate.path === path);
  if (!surface || !existsSync(join(root, path))) return false;
  const before = baselineFile(root, path);
  if (before === null) return false;
  return normalizedSurface(surface, before) === normalizedSurface(surface, readFileSync(join(root, path), "utf8"));
}

export function relevantHarnessChanges(root: string, paths = changedPaths(root)): string[] {
  const all = surfaces(root);
  return paths.filter((path) => !isDocumentationOrState(path) && !isVersionOnlySurfaceChange(root, path, all));
}

function productVersion(root: string): { name: string; version: string } | null {
  try {
    const value = readJson(join(root, "package.json"));
    return typeof value.name === "string" && typeof value.version === "string"
      ? { name: value.name, version: value.version }
      : null;
  } catch {
    return null;
  }
}

function surfaceErrors(root: string, expected: string): string[] {
  const errors: string[] = [];
  for (const surface of surfaces(root)) {
    let versions: string[] = [];
    try { versions = surface.readVersion(readFileSync(join(root, surface.path), "utf8")); }
    catch (error) {
      errors.push(`${surface.path}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (versions.length === 0 || versions.some((version) => version !== expected)) {
      errors.push(`${surface.path}: expected ${expected}, found ${versions.filter(Boolean).join(", ") || "missing version"}`);
    }
  }
  return errors;
}

export function checkHarnessVersion(root = process.cwd()): VersionCheckResult {
  root = resolve(root);
  const product = productVersion(root);
  if (!product || product.name !== PRODUCT_NAME) {
    return { applicable: false, ok: true, version: product?.version || "", changed: [], errors: [] };
  }
  const baseline = baselineVersion(root);
  if (!baseline) {
    return { applicable: false, ok: true, version: product.version, changed: [], errors: [] };
  }
  const changed = relevantHarnessChanges(root);
  const expected = changed.length > 0 ? nextPatch(baseline) : baseline;
  const errors = surfaceErrors(root, product.version);
  if (product.version !== expected) {
    errors.unshift(changed.length > 0
      ? `harness source changed: bump ${baseline} to exactly ${expected} before review`
      : `documentation/state-only change must keep baseline version ${baseline}`);
  }
  return { applicable: true, ok: errors.length === 0, version: product.version, changed, errors };
}

function writeTransaction(root: string, updates: Map<string, string>): void {
  const originals = new Map<string, string>();
  const temps = new Map<string, string>();
  try {
    for (const [path, content] of updates) {
      const target = join(root, path);
      const temp = join(dirname(target), `.${basename(target)}.version-sync-${process.pid}`);
      originals.set(path, readFileSync(target, "utf8"));
      writeFileSync(temp, content, "utf8");
      chmodSync(temp, statSync(target).mode);
      temps.set(path, temp);
    }
    for (const [path, temp] of temps) renameSync(temp, join(root, path));
  } catch (error) {
    for (const [path, content] of originals) {
      try { writeFileSync(join(root, path), content, "utf8"); } catch {}
    }
    throw error;
  } finally {
    for (const temp of temps.values()) rmSync(temp, { force: true });
  }
}

export function syncHarnessVersion(root = process.cwd()): VersionSyncResult {
  root = resolve(root);
  const product = productVersion(root);
  if (!product || product.name !== PRODUCT_NAME) {
    return { applicable: false, status: "not-applicable", version: product?.version || "", changed: [] };
  }
  const baseline = baselineVersion(root);
  if (!baseline) {
    return { applicable: false, status: "not-applicable", version: product.version, changed: [] };
  }
  const changed = relevantHarnessChanges(root);
  const target = changed.length > 0 ? nextPatch(baseline) : baseline;
  if (product.version !== baseline && product.version !== target) {
    throw new Error(`unexpected harness version ${product.version}; baseline=${baseline}, expected=${target}`);
  }
  const status: VersionSyncStatus = changed.length === 0
    ? "docs-only"
    : product.version === baseline ? "bumped" : "already-bumped";
  const updates = new Map<string, string>();
  for (const surface of surfaces(root)) {
    const path = join(root, surface.path);
    const before = readFileSync(path, "utf8");
    const after = surface.writeVersion(before, target);
    if (before !== after) updates.set(surface.path, after);
  }
  writeTransaction(root, updates);
  const verdict = checkHarnessVersion(root);
  if (!verdict.ok) throw new Error("version sync remained inconsistent:\n" + verdict.errors.join("\n"));
  return { applicable: true, status, version: target, changed };
}

export function runVersionSyncCli(argv = process.argv.slice(2), root = process.cwd()): number {
  const command = argv[0] || "check";
  if (command === "check") {
    const verdict = checkHarnessVersion(root);
    if (!verdict.applicable) console.log("harness version: not applicable");
    else if (verdict.ok) console.log(`harness version: ${verdict.version} consistent`);
    else {
      console.error("harness version: blocked\n" + verdict.errors.map((error) => `- ${error}`).join("\n"));
      return 1;
    }
    return 0;
  }
  if (command === "bump") {
    try {
      const result = syncHarnessVersion(root);
      console.log(`harness version: ${result.status}${result.version ? ` (${result.version})` : ""}`);
      return 0;
    } catch (error) {
      console.error(`harness version: blocked\n- ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }
  console.error("usage: version-sync.ts <check|bump>");
  return 2;
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]); }
  catch { return false; }
})();

if (isMain) process.exitCode = runVersionSyncCli();
