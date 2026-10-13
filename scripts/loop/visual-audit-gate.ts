// scripts/loop/visual-audit-gate.ts
// Health Gate for Visual Grid Inspection within create-agent-harness autonomous loop.

import { existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { InspectionResult, InspectorOptions } from "../visual-inspector/types.ts";
import { inspectLayout } from "../visual-inspector/alignment-rule-engine.ts";
import { generateHtmlReport } from "../visual-inspector/html-reporter.ts";
import { renderSvgOverlay } from "../visual-inspector/overlay-renderer.ts";

export interface VisualAuditGateOptions {
  inputPath?: string;
  rawData?: unknown;
  card?: string;
  maxErrors?: number;
  tolerance?: number;
  gridBase?: 4 | 8;
  minTouchTarget?: number;
  evidenceDir?: string;
  cwd?: string;
}

export interface VisualAuditGateResult {
  passed: boolean;
  result: InspectionResult;
  htmlPath?: string;
  jsonPath?: string;
  svgPath?: string;
}

export function localDateStamp(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`;
}

export function runVisualAuditGate(options: VisualAuditGateOptions = {}): VisualAuditGateResult {
  const cwd = options.cwd ?? process.cwd();
  const maxErrors = options.maxErrors ?? 0;
  let rawData = options.rawData;

  if (!rawData && options.inputPath) {
    const fullInput = resolve(cwd, options.inputPath);
    if (existsSync(fullInput)) {
      try {
        const text = readFileSync(fullInput, "utf8");
        rawData = JSON.parse(text);
      } catch (err) {
        console.error(`[VISUAL AUDIT GATE] 입력 데이터 파싱 실패: ${(err as Error).message}`);
      }
    }
  }

  // Fallback to empty array if no input data
  if (!rawData) {
    rawData = [];
  }

  const inspectorOptions: InspectorOptions = {
    tolerance: options.tolerance ?? 2,
    gridBase: options.gridBase ?? 4,
    minTouchTarget: options.minTouchTarget ?? 44,
    maxErrors,
  };

  const result = inspectLayout(rawData, inspectorOptions);

  // Determine evidence directory
  let targetDir = options.evidenceDir;
  if (!targetDir) {
    const card = options.card || "visual-grid-inspection";
    targetDir = resolve(cwd, "evidence", `${localDateStamp()}-${card}`);
  } else {
    targetDir = resolve(cwd, targetDir);
  }

  let htmlPath: string | undefined;
  let jsonPath: string | undefined;
  let svgPath: string | undefined;

  try {
    mkdirSync(targetDir, { recursive: true });

    htmlPath = join(targetDir, "visual-audit-report.html");
    const html = generateHtmlReport(result, "Visual Grid Inspection Gate Report");
    writeFileSync(htmlPath, html, "utf8");

    jsonPath = join(targetDir, "visual-audit-summary.json");
    writeFileSync(jsonPath, JSON.stringify(result, null, 2), "utf8");

    svgPath = join(targetDir, "visual-audit-overlay.svg");
    const svg = renderSvgOverlay(result);
    writeFileSync(svgPath, svg, "utf8");
  } catch (err) {
    console.warn(`[VISUAL AUDIT GATE] 산출물 저장 경고: ${(err as Error).message}`);
  }

  return {
    passed: result.summary.passed,
    result,
    htmlPath,
    jsonPath,
    svgPath,
  };
}

export function runVisualAuditGateCli(argv = process.argv.slice(2)): number {
  let inputPath: string | undefined;
  let card: string | undefined;
  let maxErrors = 0;
  let jsonOutput = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--input" && i + 1 < argv.length) {
      inputPath = argv[++i];
    } else if (arg.startsWith("--input=")) {
      inputPath = arg.slice("--input=".length);
    } else if (arg === "--card" && i + 1 < argv.length) {
      card = argv[++i];
    } else if (arg.startsWith("--card=")) {
      card = arg.slice("--card=".length);
    } else if (arg === "--max-errors" && i + 1 < argv.length) {
      maxErrors = parseInt(argv[++i]!, 10) || 0;
    } else if (arg.startsWith("--max-errors=")) {
      maxErrors = parseInt(arg.slice("--max-errors=".length), 10) || 0;
    } else if (arg === "--json") {
      jsonOutput = true;
    } else if (!arg.startsWith("-") && !inputPath) {
      inputPath = arg;
    }
  }

  const res = runVisualAuditGate({
    inputPath,
    card,
    maxErrors,
  });

  if (jsonOutput) {
    console.log(JSON.stringify(res, null, 2));
  } else {
    console.log("\n[HEALTH GATE: VISUAL GRID INSPECTION]");
    console.log(`- 결과: ${res.passed ? "✓ PASS" : "❌ FAIL"}`);
    console.log(`- 종합 점수: ${res.result.summary.score}/100`);
    console.log(`- 총 결함: ${res.result.summary.totalViolations}건 (허용 기준: ${maxErrors}건)`);
    if (res.htmlPath) {
      console.log(`- HTML 증거: ${res.htmlPath}`);
    }
    if (res.jsonPath) {
      console.log(`- JSON 요약: ${res.jsonPath}`);
    }
  }

  return res.passed ? 0 : 1;
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
  process.exitCode = runVisualAuditGateCli();
}
