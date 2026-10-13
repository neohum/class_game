// clean-code-collector.ts — 클린 코드 지표 수집 및 종합 점수 산출기
//
// 지정 파일, 디렉터리, 또는 소스 코드 문자열을 분석하여
// 4대 핵심 축(복잡도, 코드 위생, 구조적 일관성, 테스트 비율) 점수와
// 위반 목록, 종합 합격/차단 여부(0~100점)를 구조화된 JSON 데이터로 출력합니다.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve, relative, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  analyzeSourceCode,
  calculateSloc,
  DEFAULT_THRESHOLDS,
  RuleCategory,
  RuleSeverity,
} from "./rules/anti-patterns.ts";
import type {
  AntiPatternAnalysisResult,
  CleanCodeThresholds,
  CustomCleanCodeThresholds,
  CleanCodeViolation,
} from "./rules/anti-patterns.ts";

export interface AxisScoreDetail {
  score: number;
  max: number;
  weight: number;
  violations: number;
}

export interface CleanCodeCollectorResult {
  score: number;
  passed: boolean;
  timestamp: string;
  thresholds: CleanCodeThresholds;
  summary: {
    filesAnalyzed: number;
    totalSloc: number;
    totalLines: number;
    totalFunctions: number;
    maxCognitiveComplexity: number;
    maxNestingDepth: number;
    maxFunctionSloc: number;
    emptyCatchCount: number;
    emptyFinallyCount: number;
    anyLeakCount: number;
    aiCommentCount: number;
    longFunctionCount: number;
    violationCount: number;
    fatalCount: number;
    warnCount: number;
    testRatio: number;
  };
  axisScores: {
    complexity: AxisScoreDetail;
    hygiene: AxisScoreDetail;
    structuralConsistency: AxisScoreDetail;
    testRatio: AxisScoreDetail;
  };
  violations: CleanCodeViolation[];
  fileResults: AntiPatternAnalysisResult[];
}

export interface CollectorOptions {
  files?: string[];
  sourceCode?: string;
  sourceFilePath?: string;
  rootDir?: string;
  thresholdsPath?: string;
  customThresholds?: CustomCleanCodeThresholds;
  testRatioOverride?: number;
}

const SUPPORTED_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const IGNORED_DIRS = new Set(["node_modules", "dist", ".git", ".dagger", "coverage", ".claude"]);

/**
 * 설정 파일에서 임계치를 불러옵니다. 파일이 없거나 오류 발생 시 기본 임계치를 반환합니다.
 */
export function loadThresholds(configPath?: string, rootDir?: string): CleanCodeThresholds {
  const candidates: string[] = [];
  if (configPath) {
    candidates.push(configPath);
  }
  const root = rootDir ?? process.cwd();
  candidates.push(
    resolve(root, "template/config/clean-code-thresholds.json"),
    resolve(root, "config/clean-code-thresholds.json")
  );

  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        const raw = readFileSync(p, "utf-8");
        const parsed = JSON.parse(raw) as Partial<CleanCodeThresholds>;
        return {
          ...DEFAULT_THRESHOLDS,
          ...parsed,
          thresholds: {
            ...DEFAULT_THRESHOLDS.thresholds,
            ...(parsed.thresholds ?? {}),
          },
          penalties: {
            ...DEFAULT_THRESHOLDS.penalties,
            ...(parsed.penalties ?? {}),
          },
          weights: {
            ...DEFAULT_THRESHOLDS.weights,
            ...(parsed.weights ?? {}),
          },
        };
      } catch {
        // 읽기 실패 시 다음 후보로 이동
      }
    }
  }

  return DEFAULT_THRESHOLDS;
}

/**
 * 디렉터리를 재귀적으로 탐색하여 소스 및 테스트 파일 목록을 수집합니다.
 */
function walkDirectory(dir: string, fileList: string[] = []): string[] {
  if (!existsSync(dir)) return fileList;
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDirectory(fullPath, fileList);
      } else if (entry.isFile()) {
        const ext = extname(entry.name);
        if (SUPPORTED_EXTS.has(ext) && !entry.name.endsWith(".d.ts")) {
          fileList.push(fullPath);
        }
      }
    }
  } catch {
    // 권한 또는 읽기 오류 방어
  }
  return fileList;
}

/**
 * 파일이 테스트 파일인지 판정합니다.
 */
function isTestFile(filePath: string): boolean {
  return (
    /\.(test|spec)\.[tj]sx?$/.test(filePath) ||
    filePath.includes("/tests/") ||
    filePath.includes("\\tests\\")
  );
}

/**
 * 지정된 파일 목록 또는 코드 문자열을 분석하여 클린 코드 지표를 수집합니다.
 */
export function collectCleanCodeMetrics(options: CollectorOptions = {}): CleanCodeCollectorResult {
  const rootDir = options.rootDir ?? process.cwd();
  const loadedThresholds = loadThresholds(options.thresholdsPath, rootDir);
  const thresholds: CleanCodeThresholds = {
    ...loadedThresholds,
    ...(options.customThresholds ?? {}),
    thresholds: {
      ...loadedThresholds.thresholds,
      ...(options.customThresholds?.thresholds ?? {}),
    },
    penalties: {
      ...loadedThresholds.penalties,
      ...(options.customThresholds?.penalties ?? {}),
    },
    weights: {
      ...loadedThresholds.weights,
      ...(options.customThresholds?.weights ?? {}),
    },
  };

  const fileResults: AntiPatternAnalysisResult[] = [];
  let sourceSlocTotal = 0;
  let testSlocTotal = 0;

  // 1. 단일 코드 문자열 직접 분석 모드
  if (options.sourceCode !== undefined) {
    const filePath = options.sourceFilePath ?? "in-memory.ts";
    const res = analyzeSourceCode(options.sourceCode, filePath, thresholds);
    fileResults.push(res);
    sourceSlocTotal += res.sloc;
  } else {
    // 2. 파일 목록 분석 모드
    let targetFiles = options.files;
    if (!targetFiles || targetFiles.length === 0) {
      // 대상 파일 미지정 시 기본 소스 디렉터리 탐색
      const detected = walkDirectory(rootDir);
      targetFiles = detected.filter((f) => !isTestFile(f));
      // 전체 테스트 파일 SLOC 계산
      const testFiles = detected.filter((f) => isTestFile(f));
      for (const tf of testFiles) {
        try {
          const content = readFileSync(tf, "utf-8");
          testSlocTotal += calculateSloc(content);
        } catch {
          // 건너뜀
        }
      }
    }

    for (const rawPath of targetFiles) {
      const fullPath = resolve(rootDir, rawPath);
      if (!existsSync(fullPath)) continue;
      try {
        const content = readFileSync(fullPath, "utf-8");
        const relPath = relative(rootDir, fullPath);
        const res = analyzeSourceCode(content, relPath, thresholds);
        fileResults.push(res);
        if (isTestFile(relPath)) {
          testSlocTotal += res.sloc;
        } else {
          sourceSlocTotal += res.sloc;
        }
      } catch {
        // 파싱 실패 또는 I/O 오류 방어
      }
    }

    // 파일 목록으로 실행되었으나 테스트 파일이 목록에 없는 경우, 디스크의 테스트 디렉터리 자동 확인
    if (testSlocTotal === 0 && options.testRatioOverride === undefined) {
      const testsDir = resolve(rootDir, "tests");
      if (existsSync(testsDir)) {
        const detectedTests = walkDirectory(testsDir).filter(isTestFile);
        for (const tf of detectedTests) {
          try {
            const content = readFileSync(tf, "utf-8");
            testSlocTotal += calculateSloc(content);
          } catch {
            // 건너뜀
          }
        }
      }
    }
  }

  // 모든 위반 사항 수집
  const allViolations: CleanCodeViolation[] = [];
  let totalLines = 0;
  let totalFunctions = 0;
  let maxCognitiveComplexity = 0;
  let maxNestingDepth = 0;
  let maxFunctionSloc = 0;
  let emptyCatchCount = 0;
  let emptyFinallyCount = 0;
  let anyLeakCount = 0;
  let aiCommentCount = 0;
  let longFunctionCount = 0;
  let fatalCount = 0;
  let warnCount = 0;

  for (const fr of fileResults) {
    allViolations.push(...fr.violations);
    totalLines += fr.totalLines;
    totalFunctions += fr.functions.length;
    maxCognitiveComplexity = Math.max(maxCognitiveComplexity, fr.metrics.maxCognitiveComplexity);
    maxNestingDepth = Math.max(maxNestingDepth, fr.metrics.maxNestingDepth);
    maxFunctionSloc = Math.max(maxFunctionSloc, fr.metrics.maxFunctionSloc);
    emptyCatchCount += fr.metrics.emptyCatchCount;
    emptyFinallyCount += fr.metrics.emptyFinallyCount;
    anyLeakCount += fr.metrics.anyCount;
    aiCommentCount += fr.metrics.aiCommentCount;
    fatalCount += fr.metrics.fatalCount;
    warnCount += fr.metrics.warnCount;

    for (const f of fr.functions) {
      if (f.sloc > thresholds.thresholds.maxFunctionSloc) {
        longFunctionCount++;
      }
    }
  }

  // 테스트 비율 계산
  let calculatedTestRatio = 1.0;
  if (options.testRatioOverride !== undefined) {
    calculatedTestRatio = options.testRatioOverride;
  } else if (sourceSlocTotal > 0) {
    calculatedTestRatio = Number((testSlocTotal / sourceSlocTotal).toFixed(2));
  }

  // 4대 축 점수 계산
  const complexityViolations = allViolations.filter((v) => v.category === RuleCategory.Complexity);
  const hygieneViolations = allViolations.filter((v) => v.category === RuleCategory.Hygiene);
  const structuralViolations = allViolations.filter((v) => v.category === RuleCategory.Structural);

  // 축 1: Complexity (만점 weights.complexity)
  let complexityPenalty = 0;
  for (const v of complexityViolations) {
    if (v.ruleId === "cognitive-complexity") {
      complexityPenalty +=
        v.severity === RuleSeverity.Fatal
          ? thresholds.penalties.fatalCognitiveComplexity
          : thresholds.penalties.cognitiveComplexity;
    } else if (v.ruleId === "max-nesting-depth") {
      complexityPenalty += thresholds.penalties.nestingDepth;
    } else if (v.ruleId === "function-sloc") {
      complexityPenalty += thresholds.penalties.functionSloc;
    }
  }
  const complexityScore = Math.max(0, thresholds.weights.complexity - complexityPenalty);

  // 축 2: Hygiene (만점 weights.hygiene)
  let hygienePenalty = 0;
  for (const v of hygieneViolations) {
    if (v.ruleId === "empty-catch") {
      hygienePenalty += thresholds.penalties.emptyCatch;
    } else if (v.ruleId === "type-leak-any") {
      hygienePenalty += thresholds.penalties.anyLeak;
    } else if (v.ruleId === "ai-comment-residue") {
      hygienePenalty += thresholds.penalties.aiComment;
    } else if (v.ruleId === "empty-finally") {
      hygienePenalty += 2;
    }
  }
  const hygieneScore = Math.max(0, thresholds.weights.hygiene - hygienePenalty);

  // 축 3: Structural (만점 weights.structuralConsistency)
  let structuralPenalty = 0;
  for (const v of structuralViolations) {
    if (v.ruleId === "file-sloc") {
      structuralPenalty += thresholds.penalties.fileSloc;
    }
  }
  const structuralScore = Math.max(0, thresholds.weights.structuralConsistency - structuralPenalty);

  // 축 4: Test Ratio (만점 weights.testRatio)
  let testScore = thresholds.weights.testRatio;
  if (calculatedTestRatio < thresholds.thresholds.minTestRatio) {
    const deficitRatio = 1 - calculatedTestRatio / thresholds.thresholds.minTestRatio;
    const testPenalty = Math.round(deficitRatio * thresholds.penalties.lowTestRatio);
    testScore = Math.max(0, thresholds.weights.testRatio - testPenalty);
  }

  // 종합 점수 (0 ~ 100)
  const totalScore = Math.min(
    100,
    Math.max(0, complexityScore + hygieneScore + structuralScore + testScore)
  );

  // 판정 (Fail-closed)
  const isFatalBlocked = thresholds.failOnFatal && fatalCount > 0;
  const isScoreBlocked = totalScore < thresholds.minScore;
  const passed = !isFatalBlocked && !isScoreBlocked;

  return {
    score: totalScore,
    passed,
    timestamp: new Date().toISOString(),
    thresholds,
    summary: {
      filesAnalyzed: fileResults.length,
      totalSloc: sourceSlocTotal + testSlocTotal,
      totalLines,
      totalFunctions,
      maxCognitiveComplexity,
      maxNestingDepth,
      maxFunctionSloc,
      emptyCatchCount,
      emptyFinallyCount,
      anyLeakCount,
      aiCommentCount,
      longFunctionCount,
      violationCount: allViolations.length,
      fatalCount,
      warnCount,
      testRatio: calculatedTestRatio,
    },
    axisScores: {
      complexity: {
        score: complexityScore,
        max: thresholds.weights.complexity,
        weight: thresholds.weights.complexity,
        violations: complexityViolations.length,
      },
      hygiene: {
        score: hygieneScore,
        max: thresholds.weights.hygiene,
        weight: thresholds.weights.hygiene,
        violations: hygieneViolations.length,
      },
      structuralConsistency: {
        score: structuralScore,
        max: thresholds.weights.structuralConsistency,
        weight: thresholds.weights.structuralConsistency,
        violations: structuralViolations.length,
      },
      testRatio: {
        score: testScore,
        max: thresholds.weights.testRatio,
        weight: thresholds.weights.testRatio,
        violations: calculatedTestRatio < thresholds.thresholds.minTestRatio ? 1 : 0,
      },
    },
    violations: allViolations,
    fileResults,
  };
}

/**
 * CLI 실행기
 */
export function runCollectorCli(argv: string[] = process.argv.slice(2)): number {
  let isJson = false;
  let isCheck = false;
  let thresholdsPath: string | undefined;
  const files: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      isJson = true;
    } else if (arg === "--check") {
      isCheck = true;
    } else if (arg === "--thresholds" && i + 1 < argv.length) {
      thresholdsPath = argv[++i];
    } else if (arg && !arg.startsWith("-")) {
      files.push(arg);
    }
  }

  const result = collectCleanCodeMetrics({
    files: files.length > 0 ? files : undefined,
    thresholdsPath,
  });

  if (isJson) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stdout.write(
      `Clean Code Score: ${result.score}/100 [${result.passed ? "PASS" : "FAIL"}]\n` +
        `Files Analyzed: ${result.summary.filesAnalyzed}, Violations: ${result.summary.violationCount} (Fatal: ${result.summary.fatalCount})\n`
    );
  }

  return isCheck && !result.passed ? 1 : 0;
}

// 직접 CLI로 호출될 경우 실행
const isMain =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  process.exitCode = runCollectorCli();
}
