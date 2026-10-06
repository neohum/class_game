// blast-radius.ts — pre-flight simulation of destructive commands.
//
// Inspired by Anthropic claude.dev best practices:
// Simulates the affected files and bytes before executing destructive operations
// (rm -rf, rmdir, del, Remove-Item, git clean, etc.) to prevent unintended destruction.
//
// Usage:
//   node scripts/loop/blast-radius.ts "rm -rf dist/"
//   node scripts/loop/blast-radius.ts --command "rm -rf node_modules" --json
//   node scripts/loop/blast-radius.ts "rm test.txt" --strict

import { existsSync, lstatSync, readdirSync, statSync, realpathSync } from "node:fs";
import { resolve, join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

export type BlastSeverity = "safe" | "low" | "medium" | "high" | "critical";

export interface AffectedItem {
  path: string;
  sizeBytes: number;
  isDirectory: boolean;
}

export interface BlastRadiusResult {
  command: string;
  isDestructive: boolean;
  operation?: string;
  targetPaths: string[];
  totalFiles: number;
  totalDirectories: number;
  totalBytes: number;
  severity: BlastSeverity;
  warnings: string[];
  affectedItems: AffectedItem[];
}

const DESTRUCTIVE_OPS = [
  /^(?:rm|unlink)\b/,
  /^rmdir\b/,
  /^del\b/i,
  /^erase\b/i,
  /^rd\b/i,
  /^Remove-Item\b/i,
  /^ri\b/i,
  /^git\s+clean\b/,
  /^shred\b/,
  /^truncate\b/,
];

const CRITICAL_TARGETS = [
  /^[/\\]$/,
  /^[A-Za-z]:[/\\]?$/,
  /^[~]$/,
  /^\.{1,2}$/,
  /^[/\\]etc\b/i,
  /^[/\\]usr\b/i,
  /^[/\\]var\b/i,
  /^[/\\]System\b/i,
  /^[/\\]Windows\b/i,
  /\.git\b/i,
];

/** Parses a shell command to identify destructive operations and candidate target paths. */
export function parseDestructiveCommand(commandLine: string): {
  isDestructive: boolean;
  operation?: string;
  rawTargets: string[];
} {
  const trimmed = commandLine.trim();
  if (!trimmed) {
    return { isDestructive: false, rawTargets: [] };
  }

  // Check against known destructive operations
  let matchedOp: string | undefined;
  for (const regex of DESTRUCTIVE_OPS) {
    const match = trimmed.match(regex);
    if (match) {
      matchedOp = match[0];
      break;
    }
  }

  if (!matchedOp) {
    return { isDestructive: false, rawTargets: [] };
  }

  // Tokenize arguments (handling basic quotes)
  const tokens: string[] = [];
  const tokenRegex = /[^\s"']+|"([^"]*)"|'([^']*)'/g;
  let m: RegExpExecArray | null;
  while ((m = tokenRegex.exec(trimmed)) !== null) {
    tokens.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[0]);
  }

  if (tokens.length <= 1) {
    return { isDestructive: true, operation: matchedOp, rawTargets: [] };
  }

  // Filter out the command itself and flag arguments
  const rawTargets: string[] = [];
  const isGitClean = matchedOp.startsWith("git");

  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;
    if (isGitClean && i === 1 && token === "clean") continue;

    // Skip flags (starts with - or / for cmd)
    if (/^-[a-zA-Z0-9_-]+$/.test(token) || /^\/[a-zA-Z0-9?]+$/.test(token)) {
      continue;
    }
    rawTargets.push(token);
  }

  return { isDestructive: true, operation: matchedOp, rawTargets };
}

/** Recursively counts files and bytes in a directory without following external symlinks. */
function scanDirectory(
  dirPath: string,
  cwd: string,
  items: AffectedItem[],
  maxDepth = 20,
  currentDepth = 0,
): { files: number; dirs: number; bytes: number } {
  let files = 0;
  let dirs = 1;
  let bytes = 0;

  if (currentDepth > maxDepth || files > 5000) return { files, dirs, bytes };

  let entries: string[] = [];
  try {
    entries = readdirSync(dirPath);
  } catch {
    return { files, dirs, bytes };
  }

  for (const entry of entries) {
    if (files > 5000) break;
    const full = join(dirPath, entry);
    try {
      const lstat = lstatSync(full);
      if (lstat.isSymbolicLink()) {
        files++;
        if (items.length < 50) {
          items.push({ path: relative(cwd, full), sizeBytes: 0, isDirectory: false });
        }
      } else if (lstat.isDirectory()) {
        if (items.length < 50) {
          items.push({ path: relative(cwd, full), sizeBytes: 0, isDirectory: true });
        }
        const sub = scanDirectory(full, cwd, items, maxDepth, currentDepth + 1);
        files += sub.files;
        dirs += sub.dirs;
        bytes += sub.bytes;
      } else {
        files++;
        bytes += lstat.size;
        if (items.length < 50) {
          items.push({ path: relative(cwd, full), sizeBytes: lstat.size, isDirectory: false });
        }
      }
    } catch {
      // Ignore unreadable entries
    }
  }

  return { files, dirs, bytes };
}

/** Simulates and measures the blast radius of a given command. */
export function measureBlastRadius(commandLine: string, cwd = process.cwd()): BlastRadiusResult {
  const parsed = parseDestructiveCommand(commandLine);
  const warnings: string[] = [];
  const affectedItems: AffectedItem[] = [];

  if (!parsed.isDestructive) {
    return {
      command: commandLine,
      isDestructive: false,
      targetPaths: [],
      totalFiles: 0,
      totalDirectories: 0,
      totalBytes: 0,
      severity: "safe",
      warnings: [],
      affectedItems: [],
    };
  }

  let totalFiles = 0;
  let totalDirectories = 0;
  let totalBytes = 0;
  let hasCriticalTarget = false;

  for (const raw of parsed.rawTargets) {
    let isCriticalPath = false;
    // Check against critical target patterns
    for (const pat of CRITICAL_TARGETS) {
      if (pat.test(raw.trim())) {
        hasCriticalTarget = true;
        isCriticalPath = true;
        warnings.push(`Target '${raw}' matches critical path pattern (${pat.source})`);
        break;
      }
    }

    // Never traverse unbounded root/home/repo-root filesystem trees
    if (isCriticalPath && (/^[/\\]$/.test(raw.trim()) || /^[~]$/.test(raw.trim()) || /^\.{1,2}$/.test(raw.trim()))) {
      warnings.push(`Skipping deep filesystem traversal for root-level critical target '${raw}'`);
      affectedItems.push({ path: raw, sizeBytes: 0, isDirectory: true });
      totalDirectories++;
      continue;
    }

    const resolved = resolve(cwd, raw);

    if (!existsSync(resolved)) {
      warnings.push(`Target '${raw}' does not exist on disk.`);
      continue;
    }

    try {
      const lstat = lstatSync(resolved);
      if (lstat.isDirectory()) {
        totalDirectories++;
        if (affectedItems.length < 50) {
          affectedItems.push({ path: relative(cwd, resolved) || raw, sizeBytes: 0, isDirectory: true });
        }
        const sub = scanDirectory(resolved, cwd, affectedItems);
        totalFiles += sub.files;
        totalDirectories += (sub.dirs - 1);
        totalBytes += sub.bytes;
      } else {
        totalFiles++;
        totalBytes += lstat.size;
        if (affectedItems.length < 50) {
          affectedItems.push({ path: relative(cwd, resolved) || raw, sizeBytes: lstat.size, isDirectory: false });
        }
      }
    } catch (err) {
      warnings.push(`Could not read target '${raw}': ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Calculate severity
  let severity: BlastSeverity = "safe";
  if (hasCriticalTarget) {
    severity = "critical";
  } else if (totalFiles === 0 && totalDirectories === 0 && totalBytes === 0) {
    severity = "safe";
  } else if (totalFiles > 500 || totalBytes > 104_857_600) { // > 500 files or > 100 MB
    severity = "critical";
  } else if (totalFiles > 50 || totalBytes > 10_485_760) {    // > 50 files or > 10 MB
    severity = "high";
  } else if (totalFiles > 10 || totalBytes > 1_048_576) {     // > 10 files or > 1 MB
    severity = "medium";
  } else {
    severity = "low";
  }

  return {
    command: commandLine,
    isDestructive: true,
    operation: parsed.operation,
    targetPaths: parsed.rawTargets,
    totalFiles,
    totalDirectories,
    totalBytes,
    severity,
    warnings,
    affectedItems,
  };
}

/** Formats bytes into a human-readable string. */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

export function formatReport(result: BlastRadiusResult): string {
  const lines: string[] = [];
  lines.push("==================================================");
  lines.push("        BLAST RADIUS PRE-FLIGHT REPORT            ");
  lines.push("==================================================");
  lines.push(`Command:      ${result.command}`);
  lines.push(`Destructive:  ${result.isDestructive ? "YES" : "NO"}`);
  if (result.operation) {
    lines.push(`Operation:    ${result.operation}`);
  }
  lines.push(`Severity:     [${result.severity.toUpperCase()}]`);
  lines.push(`Targets:      ${result.targetPaths.join(", ") || "(none)"}`);
  lines.push(`Total Files:  ${result.totalFiles.toLocaleString()}`);
  lines.push(`Total Dirs:   ${result.totalDirectories.toLocaleString()}`);
  lines.push(`Total Volume: ${formatBytes(result.totalBytes)} (${result.totalBytes.toLocaleString()} bytes)`);

  if (result.warnings.length > 0) {
    lines.push("--------------------------------------------------");
    lines.push("WARNINGS:");
    for (const w of result.warnings) {
      lines.push(`  ! ${w}`);
    }
  }

  if (result.affectedItems.length > 0) {
    lines.push("--------------------------------------------------");
    lines.push(`Sample Affected Items (showing first ${Math.min(10, result.affectedItems.length)} of ${result.affectedItems.length}):`);
    for (const item of result.affectedItems.slice(0, 10)) {
      lines.push(`  ${item.isDirectory ? "[DIR] " : "[FILE]"} ${item.path} (${formatBytes(item.sizeBytes)})`);
    }
  }
  lines.push("==================================================");
  return lines.join("\n");
}

export function runBlastRadiusCli(args = process.argv.slice(2), cwd = process.cwd()): number {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log("Usage: blast-radius.ts <command> [--json] [--strict]");
    console.log("       blast-radius.ts --command <command> [--json] [--strict]");
    console.log("");
    console.log("Options:");
    console.log("  --json    Output machine-readable JSON");
    console.log("  --strict  Exit with code 1 if severity is HIGH or CRITICAL");
    return 2;
  }

  let commandStr = "";
  let jsonOutput = false;
  let strictMode = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;
    if (arg === "--json") {
      jsonOutput = true;
    } else if (arg === "--strict") {
      strictMode = true;
    } else if (arg === "--command" && i + 1 < args.length) {
      const next = args[++i];
      if (next) commandStr = next;
    } else if (!commandStr && !arg.startsWith("-")) {
      commandStr = arg;
    }
  }

  if (!commandStr) {
    console.error("Error: No command specified for blast radius analysis.");
    return 2;
  }

  const result = measureBlastRadius(commandStr, cwd);

  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatReport(result));
  }

  if (strictMode && (result.severity === "high" || result.severity === "critical")) {
    return 1;
  }
  return 0;
}

const isMain = process.argv[1] && (
  process.argv[1] === fileURLToPath(import.meta.url) ||
  process.argv[1].endsWith("/blast-radius.ts")
);

if (isMain) {
  process.exit(runBlastRadiusCli());
}
