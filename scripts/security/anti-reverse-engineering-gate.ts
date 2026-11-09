#!/usr/bin/env node
// scripts/security/anti-reverse-engineering-gate.ts
// Unified Anti-Reverse-Engineering Security Gate (CLI + Programmatic API)
// Combines the 3-Axis Defense Triad Validator (Encryption, Obfuscation, Server Verification)
// and the Bundle Secret & Sourcemap Scanner into a single fail-closed quality gate.

import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateDefenseTriad,
  type TriadInputItem,
  type TriadSeverity,
  type TriadValidationResult,
} from "./defense-triad-validator.ts";
import {
  scanBundleSecrets,
  type BundleScanResult,
  type BundleScanTarget,
} from "./bundle-secret-scanner.ts";

export interface AntiReverseEngineeringGateOptions {
  rootDir?: string;
  root?: string;
  targets?: Array<TriadInputItem | BundleScanTarget>;
  filesOrSnippets?: Array<TriadInputItem | BundleScanTarget>;
  reportPath?: string;
  report?: string;
  includeTests?: boolean;
  failOnHigh?: boolean;
}

export interface AntiReverseEngineeringGateResult {
  passed: boolean;
  exitCode: 0 | 1;
  score: number;
  grade: TriadSeverity;
  riskLevel: TriadSeverity;
  triad: TriadValidationResult;
  bundle: BundleScanResult;
  counts: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    total: number;
  };
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  remediations: string[];
  reportPath?: string;
  reportHtmlPath?: string;
  timestamp: string;
  summary: string;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Render a Markdown audit report for evidence directories (e.g., evidence/YYYYMMDD-card/security-triad-report.md).
 */
export function renderGateMarkdownReport(result: AntiReverseEngineeringGateResult): string {
  const statusBadge = result.passed ? "PASS (통과)" : "BLOCKED (차단 - Fail-closed)";
  const lines: string[] = [
    "# 리버스 엔지니어링 방어 3대 축 보안 감사 리포트 (Security Triad Gate Report)",
    "",
    `- **판정 결과**: **${statusBadge}**`,
    `- **종합 점수**: **${result.score} / 100** (등급: \`${result.grade.toUpperCase()}\`)`,
    `- **점검 시각**: \`${result.timestamp}\``,
    `- **요약**: ${result.summary}`,
    "",
    "## 1. 방어 3대 축 영역별 점수 (Triad Axis Scores)",
    "",
    "| 방어 축 (Pillar) | 점수 | 상태 | 감지된 표준 보안 신호 |",
    "| :--- | :---: | :---: | :--- |",
    `| **암호화 (Encryption)** | ${result.triad.axisScores.encryption}/100 | ${result.triad.axisScores.encryption >= 70 ? "PASS" : "FAIL"} | ${result.triad.positiveSignals.encryption.join(", ") || "-"} |`,
    `| **난독화 (Obfuscation)** | ${result.triad.axisScores.obfuscation}/100 | ${result.triad.axisScores.obfuscation >= 70 ? "PASS" : "FAIL"} | ${result.triad.positiveSignals.obfuscation.join(", ") || "-"} |`,
    `| **서버 무결성 검증 (Server Verification)** | ${result.triad.axisScores.serverVerification}/100 | ${result.triad.axisScores.serverVerification >= 70 ? "PASS" : "FAIL"} | ${result.triad.positiveSignals.serverVerification.join(", ") || "-"} |`,
    "",
    "## 2. 위반 통계 (Violation Summary)",
    "",
    `- **Critical**: ${result.counts.critical}건`,
    `- **High**: ${result.counts.high}건`,
    `- **Medium**: ${result.counts.medium}건`,
    `- **Low**: ${result.counts.low}건`,
    `- **총 위반 건수**: ${result.counts.total}건`,
    "",
  ];

  if (result.triad.violations.length > 0) {
    lines.push("## 3. 3대 방어 축 위반 상세 (Defense Triad Violations)", "");
    for (const v of result.triad.violations) {
      lines.push(
        `### [${v.severity.toUpperCase()}] \`${v.ruleId}\` (${v.axis}) — \`${v.file}:${v.line}:${v.column}\``,
        `- **내용**: ${v.message}`,
        `- **코드 스니펫**: \`${v.snippet}\``,
        `- **교정 가이드**: ${v.remediation}`,
        "",
      );
    }
  }

  if (result.bundle.findings.length > 0) {
    lines.push("## 4. 번들 시크릿·소스맵 노출 상세 (Bundle Secret & Exposure Findings)", "");
    for (const f of result.bundle.findings) {
      lines.push(
        `### [${f.severity.toUpperCase()}] \`${f.ruleId}\` (${f.category}) — \`${f.file}:${f.line}:${f.column}\``,
        `- **내용**: ${f.message}`,
        `- **마스킹 미리보기**: \`${f.redactedPreview}\``,
        `- **교정 가이드**: ${f.remediation}`,
        "",
      );
    }
  }

  if (result.remediations.length > 0) {
    lines.push("## 5. 필수 교정 가이드 (Remediation Checklist)", "");
    for (const r of result.remediations) {
      lines.push(`- ${r}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Render a companion HTML report for immediate browser inspection.
 */
export function renderGateHtmlReport(result: AntiReverseEngineeringGateResult): string {
  const statusColor = result.passed ? "#16a34a" : "#dc2626";
  const statusText = result.passed ? "PASS (통과)" : "BLOCKED (Fail-closed 차단)";

  const triadRows = result.triad.violations
    .map(
      (v) =>
        `<tr>
          <td><strong>${escapeHtml(v.severity.toUpperCase())}</strong></td>
          <td><code>${escapeHtml(v.ruleId)}</code></td>
          <td>${escapeHtml(v.axis)}</td>
          <td><code>${escapeHtml(v.file)}:${v.line}:${v.column}</code></td>
          <td>${escapeHtml(v.message)}<br><small>교정: ${escapeHtml(v.remediation)}</small></td>
        </tr>`,
    )
    .join("\n");

  const bundleRows = result.bundle.findings
    .map(
      (f) =>
        `<tr>
          <td><strong>${escapeHtml(f.severity.toUpperCase())}</strong></td>
          <td><code>${escapeHtml(f.ruleId)}</code></td>
          <td>${escapeHtml(f.category)}</td>
          <td><code>${escapeHtml(f.file)}:${f.line}:${f.column}</code></td>
          <td>${escapeHtml(f.message)}<br><small>교정: ${escapeHtml(f.remediation)}</small></td>
        </tr>`,
    )
    .join("\n");

  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Security Triad Gate Report</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 32px; background: #0f172a; color: #f8fafc; word-break: keep-all; }
    .container { max-width: 1080px; margin: 0 auto; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 24px; margin-bottom: 24px; }
    .badge { display: inline-block; padding: 6px 14px; border-radius: 999px; font-weight: 700; background: ${statusColor}; color: #fff; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; }
    th, td { border: 1px solid #334155; padding: 10px 12px; text-align: left; font-size: 14px; }
    th { background: #0f172a; }
    code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; color: #93c5fd; }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <h1>리버스 엔지니어링 방어 3대 축 보안 감사 리포트</h1>
      <p><span class="badge">${escapeHtml(statusText)}</span> &nbsp; 점수: <strong>${result.score}/100</strong> (등급: <code>${escapeHtml(result.grade.toUpperCase())}</code>)</p>
      <p>${escapeHtml(result.summary)}</p>
    </div>
    <div class="card">
      <h2>3대 방어 축 영역별 점수</h2>
      <table>
        <thead><tr><th>방어 축</th><th>점수</th><th>표준 보안 신호</th></tr></thead>
        <tbody>
          <tr><td>암호화 (Encryption)</td><td>${result.triad.axisScores.encryption}/100</td><td>${escapeHtml(result.triad.positiveSignals.encryption.join(", ") || "-")}</td></tr>
          <tr><td>난독화 (Obfuscation)</td><td>${result.triad.axisScores.obfuscation}/100</td><td>${escapeHtml(result.triad.positiveSignals.obfuscation.join(", ") || "-")}</td></tr>
          <tr><td>서버 무결성 검증 (Server Verification)</td><td>${result.triad.axisScores.serverVerification}/100</td><td>${escapeHtml(result.triad.positiveSignals.serverVerification.join(", ") || "-")}</td></tr>
        </tbody>
      </table>
    </div>
    <div class="card">
      <h2>위반 상세 (총 ${result.counts.total}건)</h2>
      <table>
        <thead><tr><th>등급</th><th>규칙 ID</th><th>분류</th><th>위치</th><th>설명 및 교정 가이드</th></tr></thead>
        <tbody>
          ${triadRows || bundleRows ? `${triadRows}\n${bundleRows}` : '<tr><td colspan="5">탐지된 보안 위반이 없습니다.</td></tr>'}
        </tbody>
      </table>
    </div>
  </div>
</body>
</html>`;
}

/**
 * Execute both the 3-Axis Defense Triad Validator and the Bundle Secret Scanner.
 */
export function runAntiReverseEngineeringGate(
  options: AntiReverseEngineeringGateOptions = {},
): AntiReverseEngineeringGateResult {
  const rootDir = resolve(options.rootDir ?? options.root ?? process.cwd());
  const includeTests = options.includeTests ?? false;
  const failOnHigh = options.failOnHigh ?? false;

  const rawTargets = options.targets ?? options.filesOrSnippets ?? [rootDir];

  const triad = validateDefenseTriad(rawTargets, {
    rootDir,
    includeTests,
    failOnHigh,
  });

  const bundle = scanBundleSecrets(rawTargets, {
    rootDir,
    includeTests,
  });

  const criticalCount = triad.criticalCount + bundle.criticalCount;
  const highCount = triad.highCount + bundle.highCount;
  const mediumCount = triad.mediumCount + bundle.mediumCount;
  const lowCount = triad.lowCount + bundle.lowCount;
  const total = criticalCount + highCount + mediumCount + lowCount;

  const bundlePenalty = bundle.criticalCount * 30 + bundle.highCount * 18 + bundle.mediumCount * 8;
  const score = Math.max(0, Math.min(100, triad.score - bundlePenalty));

  let grade: TriadSeverity = triad.grade;
  if (criticalCount > 0 || score < 40) {
    grade = "critical";
  } else if (highCount > 0 || score < 70) {
    grade = "high";
  } else if (mediumCount > 0 || score < 90) {
    grade = "medium";
  }

  // Fail-closed: any critical violation in either triad or bundle scanner immediately blocks
  const passed =
    criticalCount === 0 &&
    triad.passed &&
    bundle.passed &&
    (!failOnHigh || highCount === 0);

  const exitCode: 0 | 1 = passed ? 0 : 1;

  const remediationSet = new Set<string>();
  for (const r of triad.recommendations) remediationSet.add(r);
  for (const v of triad.violations) remediationSet.add(`[${v.ruleId}] ${v.remediation}`);
  for (const f of bundle.findings) remediationSet.add(`[${f.ruleId}] ${f.remediation}`);
  const remediations = [...remediationSet];

  const timestamp = new Date().toISOString();
  const summary = passed
    ? `리버스 엔지니어링 방어 3대 축 및 번들 보안 게이트 통과 (점수: ${score}/100, 위반: ${total}건)`
    : `리버스 엔지니어링 방어 보안 게이트 차단 (Fail-closed) — 점수: ${score}/100, 등급: ${grade.toUpperCase()} (critical: ${criticalCount}건, high: ${highCount}건, 총 위반: ${total}건)`;

  const result: AntiReverseEngineeringGateResult = {
    passed,
    exitCode,
    score,
    grade,
    riskLevel: grade,
    triad,
    bundle,
    counts: {
      critical: criticalCount,
      high: highCount,
      medium: mediumCount,
      low: lowCount,
      total,
    },
    criticalCount,
    highCount,
    mediumCount,
    lowCount,
    remediations,
    timestamp,
    summary,
  };

  const reportTarget = options.reportPath ?? options.report;
  if (reportTarget) {
    const absReportPath = resolve(rootDir, reportTarget);
    mkdirSync(dirname(absReportPath), { recursive: true });
    writeFileSync(absReportPath, renderGateMarkdownReport(result), "utf8");
    result.reportPath = absReportPath;

    const absHtmlPath = absReportPath.endsWith(".md")
      ? `${absReportPath.slice(0, -3)}.html`
      : `${absReportPath}.html`;
    writeFileSync(absHtmlPath, renderGateHtmlReport(result), "utf8");
    result.reportHtmlPath = absHtmlPath;
  }

  return result;
}

export function parseCliArgs(argv: string[]): {
  json: boolean;
  reportPath?: string;
  rootDir?: string;
  includeTests: boolean;
  failOnHigh: boolean;
  targets: string[];
} {
  let json = false;
  let reportPath: string | undefined;
  let rootDir: string | undefined;
  let includeTests = false;
  let failOnHigh = false;
  const targets: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--json") {
      json = true;
    } else if (arg === "--include-tests") {
      includeTests = true;
    } else if (arg === "--fail-on-high") {
      failOnHigh = true;
    } else if (arg === "--report") {
      reportPath = argv[++i];
    } else if (arg.startsWith("--report=")) {
      reportPath = arg.slice("--report=".length);
    } else if (arg === "--root") {
      rootDir = argv[++i];
    } else if (arg.startsWith("--root=")) {
      rootDir = arg.slice("--root=".length);
    } else if (!arg.startsWith("-")) {
      targets.push(arg);
    }
  }

  return {
    json,
    reportPath,
    rootDir,
    includeTests,
    failOnHigh,
    targets,
  };
}

const isMainModule = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isMainModule) {
  const parsed = parseCliArgs(process.argv.slice(2));
  const result = runAntiReverseEngineeringGate({
    rootDir: parsed.rootDir,
    reportPath: parsed.reportPath,
    includeTests: parsed.includeTests,
    failOnHigh: parsed.failOnHigh,
    targets: parsed.targets.length > 0 ? parsed.targets : undefined,
  });

  if (parsed.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`[SECURITY TRIAD GATE] ${result.summary}`);
    console.log(
      `  Axes => Encryption: ${result.triad.axisScores.encryption}/100 | Obfuscation: ${result.triad.axisScores.obfuscation}/100 | Server Verification: ${result.triad.axisScores.serverVerification}/100`,
    );
    if (result.triad.violations.length > 0) {
      console.log("\n[Defense Triad Violations]");
      for (const v of result.triad.violations) {
        console.log(`  - [${v.severity.toUpperCase()}] [${v.ruleId}] ${v.file}:${v.line}:${v.column}: ${v.message}`);
        console.log(`    교정 가이드: ${v.remediation}`);
      }
    }
    if (result.bundle.findings.length > 0) {
      console.log("\n[Bundle Secret & Exposure Findings]");
      for (const f of result.bundle.findings) {
        console.log(`  - [${f.severity.toUpperCase()}] [${f.ruleId}] ${f.file}:${f.line}:${f.column}: ${f.message}`);
        console.log(`    교정 가이드: ${f.remediation}`);
      }
    }
    if (result.remediations.length > 0 && !result.passed) {
      console.log("\n[Remediation Guidance]");
      for (const r of result.remediations) {
        console.log(`  * ${r}`);
      }
    }
    if (result.reportPath) {
      console.log(`\n[Report Written] ${result.reportPath}`);
    }
  }

  process.exit(result.exitCode);
}
