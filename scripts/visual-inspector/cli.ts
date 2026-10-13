// scripts/visual-inspector/cli.ts
// Command-line interface for the Visual Grid Inspector.

import { existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectLayout } from "./alignment-rule-engine.ts";
import { generateHtmlReport } from "./html-reporter.ts";
import type { InspectorOptions } from "./types.ts";

export interface CliParsedArgs {
  inputPath?: string;
  maxErrors: number;
  reportPath?: string;
  jsonOutputPath?: string;
  jsonStdout: boolean;
  gridBase: 4 | 8;
  tolerance: number;
  minTouchTarget: number;
}

export function parseCliArgs(argv: string[]): CliParsedArgs {
  let inputPath: string | undefined;
  let maxErrors = 0;
  let reportPath: string | undefined;
  let jsonOutputPath: string | undefined;
  let jsonStdout = false;
  let gridBase: 4 | 8 = 4;
  let tolerance = 2;
  let minTouchTarget = 44;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--input" && i + 1 < argv.length) {
      inputPath = argv[++i];
    } else if (arg.startsWith("--input=")) {
      inputPath = arg.slice("--input=".length);
    } else if (arg === "--max-errors" && i + 1 < argv.length) {
      maxErrors = parseInt(argv[++i]!, 10) || 0;
    } else if (arg.startsWith("--max-errors=")) {
      maxErrors = parseInt(arg.slice("--max-errors=".length), 10) || 0;
    } else if (arg === "--report" && i + 1 < argv.length) {
      reportPath = argv[++i];
    } else if (arg.startsWith("--report=")) {
      reportPath = arg.slice("--report=".length);
    } else if (arg === "--json-output" && i + 1 < argv.length) {
      jsonOutputPath = argv[++i];
    } else if (arg.startsWith("--json-output=")) {
      jsonOutputPath = arg.slice("--json-output=".length);
    } else if (arg === "--json") {
      jsonStdout = true;
    } else if (arg === "--grid" && i + 1 < argv.length) {
      const g = parseInt(argv[++i]!, 10);
      if (g === 8) gridBase = 8;
    } else if (arg.startsWith("--grid=")) {
      const g = parseInt(arg.slice("--grid=".length), 10);
      if (g === 8) gridBase = 8;
    } else if (arg === "--tolerance" && i + 1 < argv.length) {
      tolerance = parseFloat(argv[++i]!) || 0;
    } else if (arg.startsWith("--tolerance=")) {
      tolerance = parseFloat(arg.slice("--tolerance=".length)) || 0;
    } else if (arg === "--min-touch" && i + 1 < argv.length) {
      minTouchTarget = parseInt(argv[++i]!, 10) || 44;
    } else if (arg.startsWith("--min-touch=")) {
      minTouchTarget = parseInt(arg.slice("--min-touch=".length), 10) || 44;
    } else if (!arg.startsWith("-") && !inputPath) {
      inputPath = arg;
    }
  }

  return {
    inputPath,
    maxErrors,
    reportPath,
    jsonOutputPath,
    jsonStdout,
    gridBase,
    tolerance,
    minTouchTarget,
  };
}

export function runVisualInspectorCli(argv = process.argv.slice(2)): number {
  const args = parseCliArgs(argv);

  if (!args.inputPath) {
    console.error("오류: 입력 파일이 지정되지 않았습니다 (--input <경로> 필요).");
    console.error("사용법: visual-inspector --input <boxes.json> [--max-errors <n>] [--report <out.html>] [--json]");
    return 2;
  }

  const resolvedInput = resolve(process.cwd(), args.inputPath);
  if (!existsSync(resolvedInput)) {
    console.error(`오류: 지정된 입력 파일을 찾을 수 없습니다: ${resolvedInput}`);
    return 2;
  }

  let rawData: unknown;
  try {
    const rawContent = readFileSync(resolvedInput, "utf8");
    rawData = JSON.parse(rawContent);
  } catch (err) {
    console.error(`오류: JSON 파일 파싱 실패 (${args.inputPath}):`, (err as Error).message);
    return 2;
  }

  const options: InspectorOptions = {
    tolerance: args.tolerance,
    gridBase: args.gridBase,
    minTouchTarget: args.minTouchTarget,
    maxErrors: args.maxErrors,
  };

  const result = inspectLayout(rawData, options);

  // Write HTML report if requested
  if (args.reportPath) {
    const outHtml = resolve(process.cwd(), args.reportPath);
    mkdirSync(dirname(outHtml), { recursive: true });
    const html = generateHtmlReport(result);
    writeFileSync(outHtml, html, "utf8");
  }

  // Write JSON output file if requested
  if (args.jsonOutputPath) {
    const outJson = resolve(process.cwd(), args.jsonOutputPath);
    mkdirSync(dirname(outJson), { recursive: true });
    writeFileSync(outJson, JSON.stringify(result, null, 2), "utf8");
  }

  // Emit stdout
  if (args.jsonStdout) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log("\n[VISUAL GRID INSPECTOR]");
    console.log(`- 결과: ${result.summary.passed ? "✓ 통과 (PASSED)" : "❌ 탈락 (FAILED)"}`);
    console.log(`- 정렬 품질 점수: ${result.summary.score} / 100`);
    console.log(`- 총 요소 수: ${result.summary.visibleElements} (필터된 숨김 요소: ${result.summary.filteredElements})`);
    console.log(`- 총 결함 수: ${result.summary.totalViolations} (허용 임계치: ${args.maxErrors})`);
    if (result.summary.totalViolations > 0) {
      console.log(`  * 충돌(Collision): ${result.summary.collisionViolationsCount}건`);
      console.log(`  * 터치 타겟 미달: ${result.summary.touchTargetViolationsCount}건`);
      console.log(`  * 오정렬(Offset): ${result.summary.alignmentViolationsCount}건`);
      console.log(`  * 간격 규칙 위반: ${result.summary.spacingViolationsCount}건`);
    }
    if (args.reportPath) {
      console.log(`- HTML 보고서 생성: ${args.reportPath}`);
    }
  }

  return result.summary.passed ? 0 : 1;
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
  process.exitCode = runVisualInspectorCli();
}
