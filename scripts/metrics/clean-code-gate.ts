#!/usr/bin/env node
// clean-code-gate.ts — 클린 코드 지표 감사 헬스 게이트
//
// 종합 클린니스 점수가 임계치(기본 80점) 미만이거나,
// 치명적 안티패턴(빈 catch 블록, 극단적 복잡도 등)이 1건이라도 존재하면
// exit code 1로 자율 루프 및 CI 커밋/머지를 엄격히 차단(Fail-closed)합니다.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectCleanCodeMetrics } from "./clean-code-collector.ts";
import type { CleanCodeCollectorResult, CollectorOptions } from "./clean-code-collector.ts";
import { RuleSeverity } from "./rules/anti-patterns.ts";

export interface GateOptions extends CollectorOptions {
  failFast?: boolean;
  quiet?: boolean;
  json?: boolean;
  strict?: boolean;
}

export interface GateExecutionResult {
  passed: boolean;
  exitCode: number;
  report: string;
  result: CleanCodeCollectorResult;
}

/**
 * 콘솔용 정형화된 보고서 텍스트를 생성합니다.
 */
export function formatConsoleGateReport(result: CleanCodeCollectorResult): string {
  const lines: string[] = [];
  const statusStr = result.passed ? "PASSED" : "BLOCKED (FAIL-CLOSED)";
  const fatalCount = result.summary.fatalCount;
  const warnCount = result.summary.warnCount;

  lines.push("================================================================================");
  lines.push(`                       CLEAN CODE QUALITY GATE: ${statusStr}`);
  lines.push("================================================================================");
  lines.push(`Overall Cleanliness Score : ${result.score}/100 (Threshold: >= ${result.thresholds.minScore})`);
  lines.push(`Files Analyzed            : ${result.summary.filesAnalyzed} file(s)`);
  lines.push(`Total SLOC                : ${result.summary.totalSloc} lines`);
  lines.push(`Total Violations          : ${result.summary.violationCount} (Fatal: ${fatalCount}, Warn: ${warnCount})`);
  lines.push("--------------------------------------------------------------------------------");
  lines.push("4대 핵심 평가 축 현황:");
  lines.push(
    `  1. 복잡도 제어 (Complexity)       : ${result.axisScores.complexity.score}/${result.axisScores.complexity.max} pt  (위반: ${result.axisScores.complexity.violations}건)`
  );
  lines.push(
    `  2. 코드 위생 (Code Hygiene)       : ${result.axisScores.hygiene.score}/${result.axisScores.hygiene.max} pt  (위반: ${result.axisScores.hygiene.violations}건)`
  );
  lines.push(
    `  3. 구조적 일관성 (Structural)     : ${result.axisScores.structuralConsistency.score}/${result.axisScores.structuralConsistency.max} pt  (위반: ${result.axisScores.structuralConsistency.violations}건)`
  );
  lines.push(
    `  4. 테스트 비율 (Test Ratio)       : ${result.axisScores.testRatio.score}/${result.axisScores.testRatio.max} pt  (비율: ${result.summary.testRatio})`
  );
  lines.push("--------------------------------------------------------------------------------");

  if (result.violations.length === 0) {
    lines.push("🎉 모든 클린 코드 지표 및 안티패턴 검사를 완벽히 통과했습니다.");
  } else {
    lines.push(`위반 세부 내역 (${result.violations.length}건):`);
    for (const v of result.violations) {
      const tag = v.severity === RuleSeverity.Fatal ? "[FATAL]" : "[WARN] ";
      lines.push(`  ${tag} ${v.file}:${v.line}:${v.column} — ${v.ruleName} (${v.ruleId})`);
      lines.push(`         메시지: ${v.message}`);
      lines.push(`         👉 개선 가이드: ${v.remediation}`);
    }
  }

  lines.push("================================================================================");
  if (!result.passed) {
    lines.push("❌ [차단 사유] 클린 코드 점수가 기준 미달이거나 치명적 안티패턴이 검출되었습니다.");
    lines.push("   위의 개선 가이드를 참조하여 코드를 리팩토링한 후 다시 시도하십시오.");
  } else {
    lines.push("✅ 품질 검증 완료: 다음 파이프라인 단계로 진행할 수 있습니다.");
  }
  lines.push("================================================================================");

  return lines.join("\n");
}

/**
 * 클린 코드 게이트를 실행하고 결과를 반환합니다.
 */
export function runCleanCodeGate(options: GateOptions = {}): GateExecutionResult {
  const result = collectCleanCodeMetrics(options);
  const report = formatConsoleGateReport(result);
  const exitCode = result.passed ? 0 : 1;

  if (options.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else if (!options.quiet || !result.passed) {
    process.stdout.write(report + "\n");
  }

  return {
    passed: result.passed,
    exitCode,
    report,
    result,
  };
}

/**
 * CLI 인자 파싱 및 게이트 실행
 */
export function runGateCli(argv: string[] = process.argv.slice(2)): number {
  let isJson = false;
  let isQuiet = false;
  let thresholdsPath: string | undefined;
  const files: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      isJson = true;
    } else if (arg === "--quiet") {
      isQuiet = true;
    } else if (arg === "--thresholds" && i + 1 < argv.length) {
      thresholdsPath = argv[++i];
    } else if (arg && !arg.startsWith("-")) {
      files.push(arg);
    }
  }

  const gateResult = runCleanCodeGate({
    files: files.length > 0 ? files : undefined,
    thresholdsPath,
    json: isJson,
    quiet: isQuiet,
  });

  return gateResult.exitCode;
}

// 직접 CLI로 호출될 경우 실행
const isMain =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  process.exitCode = runGateCli();
}
