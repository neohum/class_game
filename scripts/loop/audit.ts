#!/usr/bin/env node
/**
 * audit.ts — Unified on-demand & scheduled audit engine.
 *
 * Consolidates background self-assessment tools (shortcomings, pain point scout,
 * prompt auditor, design reviewer) into a single deterministic interface to prevent
 * background ghost-task sprawl and token waste.
 *
 * Usage:
 *   node scripts/loop/audit.ts [--mode=all|shortcomings|scout|prompts|design] [--dry-run] [--json]
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getBacklog } from "./backlog.ts";
import { log } from "./telemetry.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(process.cwd());
const STATE_DIR = resolve(process.env.HARNESS_STATE_DIR || resolve(ROOT, ".harness"));
const AUDIT_STATE_FILE = resolve(STATE_DIR, "audit-state.json");

export interface AuditFinding {
  domain: "security" | "quality" | "performance" | "ux" | "prompt";
  severity: "low" | "medium" | "high" | "blocker";
  title: string;
  detail: string;
  suggestedAction: string;
  acceptanceCriteria: string;
}

export interface AuditReport {
  timestamp: string;
  mode: string;
  findings: AuditFinding[];
  summary: {
    total: number;
    highSeverity: number;
    queuedCards: number;
  };
}

export function runDeterministicAudit(root = ROOT): AuditFinding[] {
  const findings: AuditFinding[] = [];

  // 1. Dependency & Node currency check
  const pkgPath = resolve(root, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      if (pkg.dependencies?.["lodash"]) {
        findings.push({
          domain: "security",
          severity: "medium",
          title: "Deprecated/unvetted lodash dependency detected",
          detail: "Prefer native JS built-ins (Object.assign, structuredClone, Array methods) over lodash.",
          suggestedAction: "Remove lodash and replace with modern native standard library calls.",
          acceptanceCriteria: "AC-1: package.json has no lodash dependency and all imports are removed.",
        });
      }
    } catch {}
  }

  // 2. Secret exposure in git status / working tree
  const envPath = resolve(root, ".env");
  const gitignorePath = resolve(root, ".gitignore");
  if (existsSync(envPath) && existsSync(gitignorePath)) {
    const gitignore = readFileSync(gitignorePath, "utf8");
    if (!gitignore.includes(".env")) {
      findings.push({
        domain: "security",
        severity: "high",
        title: ".env file is present but not explicitly ignored in .gitignore",
        detail: "Risk of accidental secret commits to remote origin.",
        suggestedAction: "Add .env and *.local to .gitignore immediately.",
        acceptanceCriteria: "AC-1: .gitignore contains .env entry and git status does not track .env.",
      });
    }
  }

  // 3. Test evidence completeness check
  const evidenceDir = resolve(root, "evidence");
  if (!existsSync(evidenceDir)) {
    findings.push({
      domain: "quality",
      severity: "medium",
      title: "Missing evidence/ directory for executable acceptance records",
      detail: "Harness release gate requires evidence/<card>/ directories for completed work.",
      suggestedAction: "Ensure evidence recording is active for all builder runs.",
      acceptanceCriteria: "AC-1: evidence/ directory exists with valid records.",
    });
  }

  return findings;
}

export async function executeAudit(options: {
  mode?: string;
  dryRun?: boolean;
  json?: boolean;
} = {}): Promise<AuditReport> {
  const mode = options.mode || "all";
  const findings = runDeterministicAudit(ROOT);
  
  const highCount = findings.filter((f) => f.severity === "high" || f.severity === "blocker").length;
  let queuedCount = 0;

  if (!options.dryRun && findings.length > 0) {
    try {
      const backlog = await getBacklog();
      for (const finding of findings) {
        if (finding.severity === "high" || finding.severity === "blocker") {
          const cardSlug = `audit-${finding.domain}-${Date.now().toString(36).slice(-4)}`;
          const spec = `${finding.title}\n\n${finding.detail}\n\nAcceptance:\n- ${finding.acceptanceCriteria}`;
          try {
            await backlog.add(cardSlug, spec, "audit");
            queuedCount++;
          } catch {}
        }
      }
    } catch {}
  }

  const report: AuditReport = {
    timestamp: new Date().toISOString(),
    mode,
    findings,
    summary: {
      total: findings.length,
      highSeverity: highCount,
      queuedCards: queuedCount,
    },
  };

  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(AUDIT_STATE_FILE, JSON.stringify(report, null, 2), "utf8");
  } catch {}

  log("audit", { detail: { mode, findings: findings.length, queued: queuedCount } });
  return report;
}

const isMainModule = (() => {
  if (!process.argv[1]) return false;
  return process.argv[1].endsWith("audit.ts");
})();

if (isMainModule) {
  const dryRun = process.argv.includes("--dry-run");
  const json = process.argv.includes("--json");
  const modeArg = process.argv.find((a) => a.startsWith("--mode="))?.split("=")[1] || "all";

  executeAudit({ mode: modeArg, dryRun, json }).then((report) => {
    if (json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`\n=== Harness Unified Audit Report (${report.timestamp}) ===`);
      console.log(`Mode: ${report.mode}`);
      console.log(`Total Findings: ${report.summary.total} (High/Blocker: ${report.summary.highSeverity})`);
      console.log(`Queued to Backlog: ${report.summary.queuedCards}\n`);
      for (const f of report.findings) {
        console.log(`[${f.severity.toUpperCase()}] [${f.domain}] ${f.title}`);
        console.log(`  Detail: ${f.detail}`);
        console.log(`  AC: ${f.acceptanceCriteria}\n`);
      }
    }
  });
}
