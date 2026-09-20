#!/usr/bin/env node
/**
 * test-fast.ts — Incremental & Targeted Fast Test Runner for AI Coding Agents.
 *
 * Speeds up test execution by 10x-50x during iterative agent turns by:
 *   1. Running only tests corresponding to git-modified files instead of the full test suite.
 *   2. Providing instant targeted feedback (<1.5s vs 40s+).
 *   3. Supporting explicit file/module target pointers.
 *
 * Usage:
 *   node scripts/loop/test-fast.ts [specific-test-or-source-file]
 *   node scripts/loop/test-fast.ts --quick
 *   node scripts/loop/test-fast.ts --all
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { availableParallelism, cpus } from "node:os";
import { resolve, basename, extname } from "node:path";

export function getTestConcurrency(): number {
  if (process.env.TEST_CONCURRENCY) {
    const parsed = Math.floor(Number(process.env.TEST_CONCURRENCY));
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  const cores = typeof availableParallelism === "function" ? availableParallelism() : cpus().length;
  return Math.max(1, Math.min(Math.floor(cores), 8));
}

const ROOT = resolve(process.cwd());
const TESTS_DIR = resolve(ROOT, "tests");

export const DEFAULT_SANITY_TESTS: readonly string[] = [
  "tests/typecheck.test.ts",
  "tests/context-budget.test.ts",
  "tests/quality-gates.test.ts",
];

export function getGitChangedFiles(): string[] {
  try {
    const res = spawnSync("git", ["status", "--porcelain"], {
      cwd: ROOT,
      encoding: "utf8",
      windowsHide: true,
    });
    if (res.status !== 0) return [];
    return res.stdout
      .split("\n")
      .map((rawLine) => {
        const line = rawLine.replace(/\r$/, "");
        if (!line || line.length < 4) return "";
        let pathPart = line.slice(3).trim();
        if (pathPart.includes("->")) {
          const parts = pathPart.split("->");
          pathPart = (parts[parts.length - 1] ?? "").trim();
        }
        if (pathPart.startsWith('"') && pathPart.endsWith('"')) {
          pathPart = pathPart.slice(1, -1);
        }
        return pathPart.replace(/\\/g, "/");
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function findMatchingTests(files: string[]): string[] {
  const allTests = existsSync(TESTS_DIR)
    ? readdirSync(TESTS_DIR).filter((f) => f.endsWith(".test.ts"))
    : [];
  const matched = new Set<string>();

  for (const file of files) {
    const normalized = file.replace(/\\/g, "/");
    const base = basename(normalized, extname(normalized)).replace(/\.tmpl$/, "");

    // Direct test file modified
    if (normalized.startsWith("tests/") && normalized.endsWith(".test.ts")) {
      matched.add(normalized);
      continue;
    }

    // Direct match: <name>.ts -> tests/<name>.test.ts
    const directCandidate = `${base}.test.ts`;
    if (allTests.includes(directCandidate)) {
      matched.add(`tests/${directCandidate}`);
    }

    // Domain mappings:
    // evidence -> tests/evidence-capture.test.ts, tests/quality-gates.test.ts
    if (normalized.includes("evidence")) {
      matched.add("tests/evidence-capture.test.ts");
      matched.add("tests/quality-gates.test.ts");
    }

    // plan-doc -> tests/plan-doc.test.ts
    if (normalized.includes("plan-doc")) {
      matched.add("tests/plan-doc.test.ts");
    }

    // ship -> tests/ship.test.ts
    if (normalized.includes("ship")) {
      matched.add("tests/ship.test.ts");
    }

    // test-fast -> tests/test-fast.test.ts
    if (normalized.includes("test-fast")) {
      matched.add("tests/test-fast.test.ts");
    }

    // Additional harness domain mappings
    if (normalized.includes("mode") || normalized.includes("collaborator")) {
      matched.add("tests/typecheck.test.ts");
    }
    if (
      normalized.includes("context") ||
      normalized.includes("AGENTS") ||
      normalized.includes("CLAUDE") ||
      normalized.includes("rules")
    ) {
      matched.add("tests/context-budget.test.ts");
    }
    if (normalized.includes("quality") || normalized.includes("gates")) {
      matched.add("tests/quality-gates.test.ts");
    }
    if (normalized.includes("version") || normalized.includes("package")) {
      matched.add("tests/version-sync.test.ts");
    }
  }

  return Array.from(matched);
}

export function resolveTestTargets(targetArg?: string, changedFiles?: string[]): string[] {
  let testTargets: string[] = [];

  if (targetArg && targetArg !== "--quick" && targetArg !== "--all") {
    if (existsSync(resolve(ROOT, targetArg))) {
      testTargets = [targetArg];
    } else if (existsSync(resolve(TESTS_DIR, targetArg))) {
      testTargets = [`tests/${targetArg}`];
    } else if (existsSync(resolve(TESTS_DIR, `${targetArg}.test.ts`))) {
      testTargets = [`tests/${targetArg}.test.ts`];
    }
  }

  if (targetArg === "--quick" || (!testTargets.length && !targetArg)) {
    const changed = changedFiles ?? getGitChangedFiles();
    testTargets = findMatchingTests(changed);
    if (!testTargets.length) {
      // Default fast sanity suite
      testTargets = [...DEFAULT_SANITY_TESTS];
    }
  }

  if (targetArg === "--all") {
    testTargets = ["tests/**/*.test.ts"];
  }

  return testTargets;
}

export function runFastTests(targetArg?: string): number {
  let testTargets = resolveTestTargets(targetArg);

  // When running targeted tests (not glob pattern), filter to files that exist on disk
  if (!testTargets.includes("tests/**/*.test.ts")) {
    const existing = testTargets.filter((t) => existsSync(resolve(ROOT, t)));
    if (existing.length > 0) {
      testTargets = existing;
    } else {
      testTargets = DEFAULT_SANITY_TESTS.filter((t) => existsSync(resolve(ROOT, t)));
    }
  }

  const concurrency = getTestConcurrency();
  console.log(`\n⚡ [Fast Test Runner] Running targeted tests: ${testTargets.join(", ")} (concurrency: ${concurrency})`);
  const startTime = Date.now();

  const res = spawnSync(
    process.execPath,
    ["--test", `--test-concurrency=${concurrency}`, ...testTargets],
    {
      cwd: ROOT,
      stdio: "inherit",
      windowsHide: true,
    }
  );

  const durationMs = Date.now() - startTime;
  console.log(`⏱️ 완료 소요 시간: ${(durationMs / 1000).toFixed(2)}s\n`);
  return res.status ?? 0;
}

const isMainModule = (() => {
  if (!process.argv[1]) return false;
  const entry = process.argv[1].replace(/\\/g, "/");
  if (entry.endsWith(".test.ts") || entry.endsWith(".test.js")) return false;
  return (
    entry.endsWith("/test-fast.ts") ||
    entry.endsWith("/test-fast.js") ||
    entry === "test-fast.ts" ||
    entry === "test-fast.js"
  );
})();

if (isMainModule) {
  const arg = process.argv[2];
  process.exit(runFastTests(arg));
}
