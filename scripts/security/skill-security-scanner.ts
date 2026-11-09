#!/usr/bin/env node
// skill-security-scanner.ts — Static Security & Threat Scanner for Agent Skills (SKILL.md).
// Inspects external skill packages and SKILL.md files for prompt injection, arbitrary code execution,
// credential harvesting, and suspicious network exfiltration before installation.

import { existsSync, readFileSync, statSync, readdirSync } from "node:fs";
import { resolve, join, extname } from "node:path";
import { fileURLToPath } from "node:url";

export interface ScanFinding {
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  category: "PROMPT_INJECTION" | "SECRET_EXFILTRATION" | "DESTRUCTIVE_COMMAND" | "SUSPICIOUS_NETWORK" | "OBFUSCATION";
  message: string;
  file: string;
  line?: number;
  matchedText?: string;
}

export interface ScanReport {
  targetPath: string;
  scannedFiles: number;
  clean: boolean;
  findings: ScanFinding[];
  summary: {
    critical: number;
    high: number;
    medium: number;
    low: number;
  };
}

// Security rule patterns
const PATTERNS: Array<{
  regex: RegExp;
  severity: ScanFinding["severity"];
  category: ScanFinding["category"];
  message: string;
}> = [
  // 1. Prompt Injection & Adversarial System Prompts
  {
    regex: /(?:ignore\s+all\s+previous\s+instructions|disregard\s+(?:all\s+)?prior\s+instructions|system\s+override\s+mode|bypass\s+safety\s+guardrails|jailbreak)/i,
    severity: "CRITICAL",
    category: "PROMPT_INJECTION",
    message: "Prompt injection or safety override directive detected.",
  },
  {
    regex: /(?:forget\s+all\s+(?:your\s+)?rules|you\s+are\s+no\s+longer\s+bound\s+by|do\s+not\s+tell\s+the\s+user)/i,
    severity: "CRITICAL",
    category: "PROMPT_INJECTION",
    message: "Rule suppression or concealment directive detected.",
  },

  // 2. Secret Harvesting & Exfiltration
  {
    regex: /(?:curl|wget|fetch|Invoke-WebRequest|nc|ncat)\s+.*(?:https?:\/\/|\$)(?:webhook|pastebin|requestbin|discord\.com\/api\/webhooks|pipedream|ngrok)/i,
    severity: "CRITICAL",
    category: "SECRET_EXFILTRATION",
    message: "Potential data exfiltration endpoint (webhook/pastebin/ngrok) detected.",
  },
  {
    regex: /(?:cat|\$env:|process\.env|Get-Content)\s+.*(?:\.env|id_rsa|id_ed25519|\.aws\/credentials|\.npmrc)/i,
    severity: "HIGH",
    category: "SECRET_EXFILTRATION",
    message: "Attempt to read sensitive credential files or keys.",
  },

  // 3. Destructive File & System Commands
  {
    regex: /(?:rm\s+-rf\s+(?:\/|\*|~|\$HOME)|Remove-Item\s+-Recurse\s+.*(?:C:\\|\$env:SystemDrive|\*)|Format-Volume|mkfs)/i,
    severity: "CRITICAL",
    category: "DESTRUCTIVE_COMMAND",
    message: "Catastrophic file/system deletion command detected.",
  },
  {
    regex: /(?:Set-ExecutionPolicy\s+Bypass|chmod\s+777|curl\s+.*\|\s*(?:bash|sh|pwsh)|wget\s+.*\|\s*(?:bash|sh))/i,
    severity: "HIGH",
    category: "DESTRUCTIVE_COMMAND",
    message: "Dangerous execution policy bypass, wide open permissions, or pipe-to-shell detected.",
  },

  // 4. Obfuscation & Encoded Payloads
  {
    regex: /(?:powershell.*-enc(?:odedcommand)?\s+[A-Za-z0-9+/=]{20,}|eval\(Buffer\.from\(|base64\s+-d\s*\|)/i,
    severity: "HIGH",
    category: "OBFUSCATION",
    message: "Obfuscated or base64-encoded executable payload detected.",
  },
];

/**
 * Recursively scans files in target directory or single file.
 */
function collectFiles(target: string): string[] {
  if (!existsSync(target)) return [];
  const stat = statSync(target);
  if (stat.isFile()) return [target];

  const results: string[] = [];
  const entries = readdirSync(target, { withFileTypes: true });
  for (const ent of entries) {
    if (ent.name === "node_modules" || ent.name === ".git") continue;
    const full = join(target, ent.name);
    if (ent.isDirectory()) {
      results.push(...collectFiles(full));
    } else if (ent.isFile()) {
      const ext = extname(ent.name).toLowerCase();
      if ([".md", ".txt", ".json", ".js", ".ts", ".sh", ".ps1", ".py"].includes(ext) || ent.name === "SKILL.md") {
        results.push(full);
      }
    }
  }
  return results;
}

export function scanSkill(targetPath: string): ScanReport {
  const resolved = resolve(targetPath);
  const files = collectFiles(resolved);
  const findings: ScanFinding[] = [];

  for (const file of files) {
    try {
      const content = readFileSync(file, "utf8");
      const lines = content.split(/\r?\n/);

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (typeof line !== "string") continue;
        for (const rule of PATTERNS) {
          if (rule.regex.test(line)) {
            findings.push({
              severity: rule.severity,
              category: rule.category,
              message: rule.message,
              file,
              line: i + 1,
              matchedText: line.trim().substring(0, 120),
            });
          }
        }
      }
    } catch {
      // Ignore unreadable files
    }
  }

  const summary = {
    critical: findings.filter((f) => f.severity === "CRITICAL").length,
    high: findings.filter((f) => f.severity === "HIGH").length,
    medium: findings.filter((f) => f.severity === "MEDIUM").length,
    low: findings.filter((f) => f.severity === "LOW").length,
  };

  const clean = summary.critical === 0 && summary.high === 0;

  return {
    targetPath: resolved,
    scannedFiles: files.length,
    clean,
    findings,
    summary,
  };
}

export function runSkillSecurityScanCli(argv = process.argv.slice(2)): number {
  const target = argv[0];
  if (!target) {
    console.error("Usage: node skill-security-scanner.ts <skill-directory-or-file>");
    return 1;
  }

  console.log(`🛡️ [Skill Security Scanner] Scanning: ${target}...`);
  const report = scanSkill(target);

  console.log(`   Scanned files: ${report.scannedFiles}`);
  console.log(`   Summary: Critical=${report.summary.critical}, High=${report.summary.high}, Medium=${report.summary.medium}, Low=${report.summary.low}`);

  if (report.findings.length > 0) {
    console.log("\n⚠️ Security Findings:");
    for (const f of report.findings) {
      const lineStr = f.line ? `:${f.line}` : "";
      console.log(`   [${f.severity}] [${f.category}] ${f.file}${lineStr}`);
      console.log(`      Reason: ${f.message}`);
      if (f.matchedText) {
        console.log(`      Match:  ${f.matchedText}`);
      }
    }
  }

  if (!report.clean) {
    console.error(`\n❌ [BLOCKED] Skill failed security verification. Installation or execution prohibited.`);
    return 1;
  }

  console.log(`\n✅ [PASSED] Skill verified safe. No critical or high security threats detected.`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = runSkillSecurityScanCli();
}
