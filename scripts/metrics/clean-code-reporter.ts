// clean-code-reporter.ts — 클린 코드 마크다운 보고서 생성기
//
// `evidence/YYYYMMDD-card/clean-code-report.md` 형식에 호환되는
// 4대 축 점수, 임계치 준수 대조표, 위반 목록, 기계 판독 가능 메타데이터를 포함한 마크다운 보고서를 생성합니다.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { CleanCodeCollectorResult } from "./clean-code-collector.ts";
import { RuleSeverity } from "./rules/anti-patterns.ts";

export interface ReporterMetadata {
  cardId?: string;
  date?: string;
  author?: string;
}

/**
 * 수집기 결과를 바탕으로 규격화된 마크다운 보고서 문자열을 생성합니다.
 */
export function generateMarkdownReport(
  result: CleanCodeCollectorResult,
  meta: ReporterMetadata = {}
): string {
  const cardId = meta.cardId ?? "unspecified-card";
  const dateStr = meta.date ?? new Date().toISOString().split("T")[0] ?? "unknown-date";
  const statusStr = result.passed ? "PASS" : "FAIL";

  const lines: string[] = [];

  // 1. 기계 판독 가능한 프론트매터 (YAML Frontmatter)
  lines.push("---");
  lines.push("type: clean-code-metrics");
  lines.push(`card: ${cardId}`);
  lines.push(`date: ${dateStr}`);
  lines.push(`status: ${statusStr.toLowerCase()}`);
  lines.push(`score: ${result.score}`);
  lines.push(`minScore: ${result.thresholds.minScore}`);
  lines.push(`passed: ${result.passed}`);
  lines.push(`totalSloc: ${result.summary.totalSloc}`);
  lines.push(`filesAnalyzed: ${result.summary.filesAnalyzed}`);
  lines.push(`violationCount: ${result.summary.violationCount}`);
  lines.push(`fatalCount: ${result.summary.fatalCount}`);
  lines.push(`warnCount: ${result.summary.warnCount}`);
  lines.push(`timestamp: ${result.timestamp}`);
  lines.push("---");
  lines.push("");

  // 2. 제목 및 개요
  lines.push(`# Clean Code Metrics Report: ${cardId}`);
  lines.push("");
  lines.push(`- **평가 일시**: \`${result.timestamp}\``);
  lines.push(`- **게이트 판정**: **${result.passed ? "✅ PASSED" : "❌ BLOCKED (FAIL-CLOSED)"}**`);
  lines.push(
    `- **종합 점수**: **\`${result.score} / 100\`** (최소 합격 기준: \`${result.thresholds.minScore}\`점)`
  );
  lines.push(
    `- **분석 대상**: \`${result.summary.filesAnalyzed}\`개 파일, 총 \`${result.summary.totalSloc}\` SLOC`
  );
  lines.push(
    `- **위반 현황**: 총 \`${result.summary.violationCount}\`건 (치명적: \`${result.summary.fatalCount}\`건, 경고: \`${result.summary.warnCount}\`건)`
  );
  lines.push("");

  // 3. 4대 핵심 축 평가 현황 (Core Axes Breakdown)
  lines.push("## 1. 4대 핵심 축 평가 현황");
  lines.push("");
  lines.push("| 평가 축 (Axis) | 배점 가중치 | 획득 점수 | 위반 건수 | 상태 |");
  lines.push("|---|:---:|:---:|:---:|:---:|");

  const getAxisStatus = (score: number, max: number) => {
    if (score === max) return "🟢 만점 (Clean)";
    if (score >= max * 0.8) return "🟡 양호 (Minor)";
    return "🔴 위험 (Degraded)";
  };

  lines.push(
    `| **복잡도 제어 (Complexity)** | ${result.axisScores.complexity.max} pt | ${result.axisScores.complexity.score} pt | ${result.axisScores.complexity.violations}건 | ${getAxisStatus(result.axisScores.complexity.score, result.axisScores.complexity.max)} |`
  );
  lines.push(
    `| **코드 위생 (Hygiene)** | ${result.axisScores.hygiene.max} pt | ${result.axisScores.hygiene.score} pt | ${result.axisScores.hygiene.violations}건 | ${getAxisStatus(result.axisScores.hygiene.score, result.axisScores.hygiene.max)} |`
  );
  lines.push(
    `| **구조적 일관성 (Structural)** | ${result.axisScores.structuralConsistency.max} pt | ${result.axisScores.structuralConsistency.score} pt | ${result.axisScores.structuralConsistency.violations}건 | ${getAxisStatus(result.axisScores.structuralConsistency.score, result.axisScores.structuralConsistency.max)} |`
  );
  lines.push(
    `| **테스트 비율 (Test Ratio)** | ${result.axisScores.testRatio.max} pt | ${result.axisScores.testRatio.score} pt | ${result.axisScores.testRatio.violations}건 | ${getAxisStatus(result.axisScores.testRatio.score, result.axisScores.testRatio.max)} |`
  );
  lines.push("");

  // 4. 임계치 준수 대조표 (Threshold Compliance)
  lines.push("## 2. 임계치 준수 대조표");
  lines.push("");
  lines.push("| 정량 지표 | 목표 임계치 | 측정값 | 통과 여부 |");
  lines.push("|---|:---:|:---:|:---:|");
  lines.push(
    `| 최대 인지 복잡도 (Cognitive Complexity) | &le; ${result.thresholds.thresholds.maxCognitiveComplexity} | ${result.summary.maxCognitiveComplexity} | ${result.summary.maxCognitiveComplexity <= result.thresholds.thresholds.maxCognitiveComplexity ? "PASS" : "FAIL"} |`
  );
  lines.push(
    `| 최대 제어 중첩 깊이 (Max Nesting Depth) | &le; ${result.thresholds.thresholds.maxNestingDepth} | ${result.summary.maxNestingDepth} | ${result.summary.maxNestingDepth <= result.thresholds.thresholds.maxNestingDepth ? "PASS" : "FAIL"} |`
  );
  lines.push(
    `| 최대 단일 함수 SLOC | &le; ${result.thresholds.thresholds.maxFunctionSloc} | ${result.summary.maxFunctionSloc} | ${result.summary.maxFunctionSloc <= result.thresholds.thresholds.maxFunctionSloc ? "PASS" : "FAIL"} |`
  );
  lines.push(
    `| 빈 catch / finally 블록 | 0건 (치명적) | ${result.summary.emptyCatchCount + result.summary.emptyFinallyCount}건 | ${result.summary.emptyCatchCount === 0 && result.summary.emptyFinallyCount === 0 ? "PASS" : "FAIL"} |`
  );
  lines.push(
    `| 타입 누수 (\`any\` 사용) | 0건 | ${result.summary.anyLeakCount}건 | ${result.summary.anyLeakCount === 0 ? "PASS" : "WARN"} |`
  );
  lines.push(
    `| AI 설명성 주석 찌꺼기 | 0건 | ${result.summary.aiCommentCount}건 | ${result.summary.aiCommentCount === 0 ? "PASS" : "WARN"} |`
  );
  lines.push(
    `| 테스트/코드 비율 | &ge; ${result.thresholds.thresholds.minTestRatio} | ${result.summary.testRatio} | ${result.summary.testRatio >= result.thresholds.thresholds.minTestRatio ? "PASS" : "WARN"} |`
  );
  lines.push("");

  // 5. 위반 세부 내역 (Violations)
  lines.push("## 3. 위반 세부 내역 및 개선 가이드");
  lines.push("");
  if (result.violations.length === 0) {
    lines.push("> ✨ **위반 사항 없음**: 모든 코드가 클린 코드 임계치 기준을 충족합니다.");
  } else {
    lines.push("| 심각도 | 위치 (File:Line:Col) | 규칙 ID | 위반 내용 | 개선 조치 가이드 |");
    lines.push("|:---:|---|---|---|---|");
    for (const v of result.violations) {
      const sevBadge = v.severity === RuleSeverity.Fatal ? "**FATAL**" : "WARN";
      const loc = `\`${v.file}:${v.line}:${v.column}\``;
      const cleanMsg = v.message.replace(/\|/g, "\\|");
      const cleanRem = v.remediation.replace(/\|/g, "\\|");
      lines.push(`| ${sevBadge} | ${loc} | \`${v.ruleId}\` | ${cleanMsg} | ${cleanRem} |`);
    }
  }
  lines.push("");

  // 6. 파일별 통계 (File Breakdown)
  if (result.fileResults.length > 0) {
    lines.push("## 4. 파일별 분석 요약");
    lines.push("");
    lines.push("| 파일 경로 | SLOC | 함수 수 | 최대 인지 복잡도 | 최대 중첩 | 위반 건수 |");
    lines.push("|---|:---:|:---:|:---:|:---:|:---:|");
    for (const fr of result.fileResults) {
      lines.push(
        `| \`${fr.file}\` | ${fr.sloc} | ${fr.functions.length} | ${fr.metrics.maxCognitiveComplexity} | ${fr.metrics.maxNestingDepth} | ${fr.violations.length} |`
      );
    }
    lines.push("");
  }

  // 7. 결론
  lines.push("---");
  lines.push("### 종합 권고 사항");
  if (result.passed) {
    lines.push("- 코드가 규정된 클린니스 기준(80점 이상 및 치명적 위반 0건)을 모두 충족했습니다.");
    lines.push("- 현재 상태로 자율 루프 커밋 및 머지 승인을 권고합니다.");
  } else {
    lines.push("- **차단됨**: 코드 품질 지표가 기준치를 만족하지 못했습니다.");
    lines.push("- 치명적 위반(빈 예외 처리 등)을 수정하거나 복잡한 구조를 리팩토링한 후 다시 측정하십시오.");
  }

  return lines.join("\n") + "\n";
}

/**
 * 마크다운 보고서를 지정 경로의 파일로 저장합니다.
 */
export function saveCleanCodeReport(
  result: CleanCodeCollectorResult,
  outputPath: string,
  meta?: ReporterMetadata
): string {
  const markdown = generateMarkdownReport(result, meta);
  const resolvedPath = resolve(process.cwd(), outputPath);
  mkdirSync(dirname(resolvedPath), { recursive: true });
  writeFileSync(resolvedPath, markdown, "utf-8");
  return resolvedPath;
}
