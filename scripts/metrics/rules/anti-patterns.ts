// anti-patterns.ts — 에이전트 고유 안티패턴 및 클린 코드 위반 탐지 규칙 엔진
//
// 1. 빈 catch / finally 블록 탐지 (Empty catch/finally)
// 2. 타입 누수 (any 키워드 남용) 탐지
// 3. 설명성 주석 찌꺼기 잔재 탐지 (Explanatory AI comments)
// 4. 깊은 중첩 (Max nesting depth > 4) 탐지
// 5. 인지 복잡도 (Cognitive Complexity > 15) 계산
// 6. 단일 함수 길이 (Function SLOC > 50) 탐지

import ts from "typescript";
import type { Node, SourceFile } from "typescript";

export const RuleSeverity = {
  Fatal: "fatal",
  Warn: "warn",
  Info: "info",
} as const;
export type RuleSeverity = typeof RuleSeverity[keyof typeof RuleSeverity];

export const RuleCategory = {
  Complexity: "complexity",
  Hygiene: "hygiene",
  Structural: "structural",
  Test: "test",
} as const;
export type RuleCategory = typeof RuleCategory[keyof typeof RuleCategory];

export interface CleanCodeViolation {
  ruleId: string;
  ruleName: string;
  category: RuleCategory;
  severity: RuleSeverity;
  message: string;
  file: string;
  line: number;
  column: number;
  remediation: string;
  details?: Record<string, unknown>;
}

export interface FunctionAnalysisMetric {
  name: string;
  startLine: number;
  endLine: number;
  sloc: number;
  cognitiveComplexity: number;
  maxNesting: number;
}

export interface CleanCodeThresholds {
  version?: string;
  minScore: number;
  failOnFatal: boolean;
  weights: {
    complexity: number;
    hygiene: number;
    structuralConsistency: number;
    testRatio: number;
  };
  thresholds: {
    maxCognitiveComplexity: number;
    fatalCognitiveComplexity: number;
    maxNestingDepth: number;
    maxFunctionSloc: number;
    maxFileSloc: number;
    maxEmptyCatch: number;
    maxAnyCount: number;
    maxAiComments: number;
    minTestRatio: number;
  };
  penalties: {
    emptyCatch: number;
    fatalCognitiveComplexity: number;
    cognitiveComplexity: number;
    nestingDepth: number;
    functionSloc: number;
    anyLeak: number;
    aiComment: number;
    fileSloc: number;
    lowTestRatio: number;
  };
}

export type CustomCleanCodeThresholds = {
  version?: string;
  minScore?: number;
  failOnFatal?: boolean;
  weights?: Partial<CleanCodeThresholds["weights"]>;
  thresholds?: Partial<CleanCodeThresholds["thresholds"]>;
  penalties?: Partial<CleanCodeThresholds["penalties"]>;
};

export const DEFAULT_THRESHOLDS: CleanCodeThresholds = {
  version: "1.0.0",
  minScore: 80,
  failOnFatal: true,
  weights: {
    complexity: 30,
    hygiene: 30,
    structuralConsistency: 20,
    testRatio: 20,
  },
  thresholds: {
    maxCognitiveComplexity: 15,
    fatalCognitiveComplexity: 25,
    maxNestingDepth: 4,
    maxFunctionSloc: 50,
    maxFileSloc: 400,
    maxEmptyCatch: 0,
    maxAnyCount: 0,
    maxAiComments: 0,
    minTestRatio: 0.5,
  },
  penalties: {
    emptyCatch: 25,
    fatalCognitiveComplexity: 15,
    cognitiveComplexity: 5,
    nestingDepth: 4,
    functionSloc: 3,
    anyLeak: 5,
    aiComment: 2,
    fileSloc: 4,
    lowTestRatio: 10,
  },
};

export interface AntiPatternAnalysisResult {
  file: string;
  sloc: number;
  totalLines: number;
  functions: FunctionAnalysisMetric[];
  violations: CleanCodeViolation[];
  metrics: {
    maxCognitiveComplexity: number;
    maxNestingDepth: number;
    maxFunctionSloc: number;
    emptyCatchCount: number;
    emptyFinallyCount: number;
    anyCount: number;
    aiCommentCount: number;
    fatalCount: number;
    warnCount: number;
  };
}

const AI_COMMENT_PATTERNS = [
  /^\s*(?:\/\/|\/\*+)\s*(?:Here\b|Here,?\s+we|In this (?:step|function|method|file)|Added by agent|AI[- ]generated|Step \d+:|Helper function to|This (?:function|method|block|code) (?:will|is used to|handles|returns|checks)|Check if .* and then|Temporary fix|TODO: implement|Auto-generated)/i,
  /^\s*(?:\/\/|\/\*+)\s*(?:에이전트가 추가|AI 생성|여기서는?|이 (?:함수|메서드|코드)는|임시 조치|단계 \d+:)/i,
];

/**
 * 라인이 실제 코드 라인(주석이나 빈 줄 제외)인지 판정합니다.
 */
function isCodeLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.startsWith("//")) return false;
  if (trimmed.startsWith("/*") && trimmed.endsWith("*/")) return false;
  if (trimmed.startsWith("*")) return false;
  return true;
}

/**
 * 소스 코드 전체 또는 지정 범위의 SLOC(Source Lines of Code)를 계산합니다.
 * 빈 줄, 한 줄 주석(//), 여러 줄 주석 블록(/* ... *\/)을 정확히 제외합니다.
 */
export function calculateSloc(source: string, startLine = 1, endLine?: number): number {
  const lines = source.split(/\r?\n/);
  const targetEnd = endLine !== undefined ? Math.min(endLine, lines.length) : lines.length;
  let count = 0;
  let inBlockComment = false;

  for (let i = startLine - 1; i < targetEnd; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    let trimmed = line.trim();
    if (trimmed.length === 0) continue;

    if (inBlockComment) {
      const closeIdx = trimmed.indexOf("*/");
      if (closeIdx !== -1) {
        inBlockComment = false;
        trimmed = trimmed.slice(closeIdx + 2).trim();
        if (trimmed.length === 0) continue;
      } else {
        continue;
      }
    }

    while (trimmed.includes("/*")) {
      const openIdx = trimmed.indexOf("/*");
      const closeIdx = trimmed.indexOf("*/", openIdx + 2);
      if (closeIdx !== -1) {
        trimmed = (trimmed.slice(0, openIdx) + " " + trimmed.slice(closeIdx + 2)).trim();
      } else {
        const before = trimmed.slice(0, openIdx).trim();
        inBlockComment = true;
        trimmed = before;
        break;
      }
    }

    if (trimmed.length === 0) continue;
    if (trimmed.startsWith("//")) continue;
    count++;
  }
  return count;
}

/**
 * 단일 소스 파일(또는 문자열)의 안티패턴 및 정량 지표를 분석합니다.
 */
export function analyzeSourceCode(
  sourceText: string,
  filePath = "unknown.ts",
  customThresholds?: CustomCleanCodeThresholds
): AntiPatternAnalysisResult {
  const thresholds: CleanCodeThresholds = {
    ...DEFAULT_THRESHOLDS,
    ...customThresholds,
    thresholds: {
      ...DEFAULT_THRESHOLDS.thresholds,
      ...(customThresholds?.thresholds ?? {}),
    },
    penalties: {
      ...DEFAULT_THRESHOLDS.penalties,
      ...(customThresholds?.penalties ?? {}),
    },
    weights: {
      ...DEFAULT_THRESHOLDS.weights,
      ...(customThresholds?.weights ?? {}),
    },
  };

  const violations: CleanCodeViolation[] = [];
  const lines = sourceText.split(/\r?\n/);
  const totalLines = lines.length;
  const totalSloc = calculateSloc(sourceText);

  const sourceFile: SourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    filePath.endsWith(".tsx") || filePath.endsWith(".jsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );

  let emptyCatchCount = 0;
  let emptyFinallyCount = 0;
  let anyCount = 0;
  let aiCommentCount = 0;
  let maxGlobalNesting = 0;

  // 1. 설명성 AI 주석 잔재 탐지
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? "";
    for (const pattern of AI_COMMENT_PATTERNS) {
      if (pattern.test(rawLine)) {
        aiCommentCount++;
        violations.push({
          ruleId: "ai-comment-residue",
          ruleName: "AI Explanatory Comment Residue",
          category: RuleCategory.Hygiene,
          severity: RuleSeverity.Warn,
          message: `Explanatory AI comment residue detected: "${rawLine.trim().slice(0, 60)}"`,
          file: filePath,
          line: i + 1,
          column: 1,
          remediation: "에이전트 작업 과정의 장황한 설명이나 사족 주석을 제거하고 자명한(Self-documenting) 코드로 정리하세요.",
          details: { comment: rawLine.trim() },
        });
        break;
      }
    }
  }

  // 2. AST 탐색: 빈 catch/finally, any 키워드, 중첩 깊이, 함수 메트릭
  const functions: FunctionAnalysisMetric[] = [];

  function getPosition(node: Node): { line: number; column: number } {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    return { line: line + 1, column: character + 1 };
  }

  function getFunctionName(node: Node): string {
    if (ts.isFunctionDeclaration(node) && node.name) {
      return node.name.text;
    }
    if (ts.isMethodDeclaration(node) && node.name) {
      return node.name.getText(sourceFile);
    }
    if (node.parent && ts.isVariableDeclaration(node.parent) && node.parent.name) {
      return node.parent.name.getText(sourceFile);
    }
    if (node.parent && ts.isPropertyDeclaration(node.parent) && node.parent.name) {
      return node.parent.name.getText(sourceFile);
    }
    return "<anonymous>";
  }

  // 인지 복잡도(Cognitive Complexity) 계산 알고리즘 (SonarSource whitepaper 기준)
  function computeCognitiveComplexity(funcNode: Node): { score: number; maxNesting: number } {
    let complexity = 0;
    let maxNesting = 0;

    function walkControlFlow(node: Node, nestingLevel: number): void {
      if (nestingLevel > maxNesting) {
        maxNesting = nestingLevel;
      }

      // 1. 흐름 제어 구조별 기본 증분(+1) 및 중첩 가산(+nestingLevel)
      if (ts.isIfStatement(node)) {
        const isElseIf =
          node.parent !== undefined &&
          ts.isIfStatement(node.parent) &&
          node.parent.elseStatement === node;

        if (isElseIf) {
          complexity += 1;
        } else {
          complexity += 1 + nestingLevel;
        }

        walkControlFlow(node.expression, nestingLevel);
        walkControlFlow(node.thenStatement, nestingLevel + 1);

        if (node.elseStatement) {
          if (ts.isIfStatement(node.elseStatement)) {
            walkControlFlow(node.elseStatement, nestingLevel);
          } else {
            complexity += 1;
            walkControlFlow(node.elseStatement, nestingLevel + 1);
          }
        }
        return;
      }

      if (ts.isConditionalExpression(node)) {
        // 삼항 연산자 (? :)
        complexity += 1 + nestingLevel;
        walkControlFlow(node.condition, nestingLevel);
        walkControlFlow(node.whenTrue, nestingLevel + 1);
        walkControlFlow(node.whenFalse, nestingLevel + 1);
        return;
      }

      if (
        ts.isForStatement(node) ||
        ts.isForInStatement(node) ||
        ts.isForOfStatement(node) ||
        ts.isWhileStatement(node) ||
        ts.isDoStatement(node)
      ) {
        complexity += 1 + nestingLevel;
        ts.forEachChild(node, (child) => walkControlFlow(child, nestingLevel + 1));
        return;
      }

      if (ts.isSwitchStatement(node)) {
        complexity += 1 + nestingLevel;
        ts.forEachChild(node.caseBlock, (child) => walkControlFlow(child, nestingLevel + 1));
        return;
      }

      if (ts.isCatchClause(node)) {
        complexity += 1 + nestingLevel;
        walkControlFlow(node.block, nestingLevel + 1);
        return;
      }

      // 2. 논리 연산자 체인(&&, ||, ??) 분기 가산
      if (ts.isBinaryExpression(node)) {
        const op = node.operatorToken.kind;
        if (
          op === ts.SyntaxKind.AmpersandAmpersandToken ||
          op === ts.SyntaxKind.BarBarToken ||
          op === ts.SyntaxKind.QuestionQuestionToken
        ) {
          complexity += 1;
        }
      }

      // 내부 함수/화살표 함수는 별도 스코프로 nestingLevel만 1 증가시켜 탐색
      if (
        (ts.isFunctionDeclaration(node) ||
          ts.isFunctionExpression(node) ||
          ts.isArrowFunction(node)) &&
        node !== funcNode
      ) {
        walkControlFlow(node, nestingLevel + 1);
        return;
      }

      ts.forEachChild(node, (child) => walkControlFlow(child, nestingLevel));
    }

    const body = (funcNode as { body?: Node }).body;
    if (body) {
      walkControlFlow(body, 0);
    }

    return { score: complexity, maxNesting };
  }

  // 전역 AST 순회 (안티패턴 및 중첩 검출)
  function visit(node: Node, currentNesting: number): void {
    if (currentNesting > maxGlobalNesting) {
      maxGlobalNesting = currentNesting;
    }

    // 1. any 키워드 탐지
    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      anyCount++;
      const pos = getPosition(node);
      violations.push({
        ruleId: "type-leak-any",
        ruleName: "Type Leak (any usage)",
        category: RuleCategory.Hygiene,
        severity: RuleSeverity.Warn,
        message: "Explicit 'any' type detected; use specific type, 'unknown', or generic parameter",
        file: filePath,
        line: pos.line,
        column: pos.column,
        remediation: "'any' 대신 구체적 인터페이스/타입, 제네릭 제약 조건 또는 안전한 'unknown' 타입을 사용하세요.",
      });
    }

    // 2. 빈 catch 블록 탐지
    if (ts.isCatchClause(node)) {
      const isBlockEmpty =
        node.block.statements.length === 0 ||
        node.block.statements.every((s) => s.kind === ts.SyntaxKind.EmptyStatement);

      if (isBlockEmpty) {
        emptyCatchCount++;
        const pos = getPosition(node);
        violations.push({
          ruleId: "empty-catch",
          ruleName: "Empty Catch Block",
          category: RuleCategory.Hygiene,
          severity: RuleSeverity.Fatal,
          message: "Empty catch block detected (swallowed error without handling or logging)",
          file: filePath,
          line: pos.line,
          column: pos.column,
          remediation: "예외를 삼키지 말고 최소한 에러 로깅, 폴백 반환, 또는 재던지기(rethrow)를 수행하세요.",
        });
      }
    }

    // 3. 빈 finally 블록 탐지
    if (ts.isTryStatement(node) && node.finallyBlock) {
      const isFinallyEmpty =
        node.finallyBlock.statements.length === 0 ||
        node.finallyBlock.statements.every((s) => s.kind === ts.SyntaxKind.EmptyStatement);

      if (isFinallyEmpty) {
        emptyFinallyCount++;
        const pos = getPosition(node.finallyBlock);
        violations.push({
          ruleId: "empty-finally",
          ruleName: "Empty Finally Block",
          category: RuleCategory.Hygiene,
          severity: RuleSeverity.Warn,
          message: "Empty finally block detected; remove redundant finally clause",
          file: filePath,
          line: pos.line,
          column: pos.column,
          remediation: "내용이 없는 불필요한 finally 블록을 제거하세요.",
        });
      }
    }

    // 4. 최대 중첩 깊이 초과 탐지
    const isNestingConstruct =
      ts.isIfStatement(node) ||
      ts.isForStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isWhileStatement(node) ||
      ts.isDoStatement(node) ||
      ts.isSwitchStatement(node) ||
      ts.isTryStatement(node);

    let nextNesting = currentNesting;
    if (isNestingConstruct) {
      // else if는 중첩 레벨을 추가하지 않음
      const isElseIf =
        Boolean(node.parent &&
        ts.isIfStatement(node.parent) &&
        node.parent.elseStatement === node);

      if (!isElseIf) {
        nextNesting = currentNesting + 1;
        if (nextNesting > thresholds.thresholds.maxNestingDepth) {
          const pos = getPosition(node);
          violations.push({
            ruleId: "max-nesting-depth",
            ruleName: "Max Nesting Depth Exceeded",
            category: RuleCategory.Complexity,
            severity: nextNesting > 6 ? RuleSeverity.Fatal : RuleSeverity.Warn,
            message: `Control flow nesting depth ${nextNesting} exceeds threshold ${thresholds.thresholds.maxNestingDepth}`,
            file: filePath,
            line: pos.line,
            column: pos.column,
            remediation: "조기 반환(Early Return/Guard Clause) 또는 서브 함수 추출로 중첩 깊이를 4 이하로 낮추세요.",
            details: { depth: nextNesting, limit: thresholds.thresholds.maxNestingDepth },
          });
        }
      }
    }

    // 5. 함수 단위 분석 (Cognitive Complexity 및 SLOC)
    const isFunctionNode =
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node);

    if (isFunctionNode) {
      const funcName = getFunctionName(node);
      const startPos = getPosition(node);
      const endPos = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
      const endLine = endPos.line + 1;
      const funcSloc = calculateSloc(sourceText, startPos.line, endLine);
      const { score: cogScore, maxNesting: funcMaxNesting } = computeCognitiveComplexity(node);

      functions.push({
        name: funcName,
        startLine: startPos.line,
        endLine,
        sloc: funcSloc,
        cognitiveComplexity: cogScore,
        maxNesting: funcMaxNesting,
      });

      // 단일 함수 길이 위반
      if (funcSloc > thresholds.thresholds.maxFunctionSloc) {
        violations.push({
          ruleId: "function-sloc",
          ruleName: "Function SLOC Exceeded",
          category: RuleCategory.Complexity,
          severity: RuleSeverity.Warn,
          message: `Function '${funcName}' length (${funcSloc} SLOC) exceeds threshold ${thresholds.thresholds.maxFunctionSloc}`,
          file: filePath,
          line: startPos.line,
          column: startPos.column,
          remediation: `함수 '${funcName}'의 책임을 분리하여 여러 작은 단위 함수(50 SLOC 이하)로 분할하세요.`,
          details: { sloc: funcSloc, limit: thresholds.thresholds.maxFunctionSloc },
        });
      }

      // 인지 복잡도 위반
      if (cogScore > thresholds.thresholds.maxCognitiveComplexity) {
        const isFatal = cogScore > thresholds.thresholds.fatalCognitiveComplexity;
        violations.push({
          ruleId: "cognitive-complexity",
          ruleName: "Cognitive Complexity Exceeded",
          category: RuleCategory.Complexity,
          severity: isFatal ? RuleSeverity.Fatal : RuleSeverity.Warn,
          message: `Function '${funcName}' cognitive complexity (${cogScore}) exceeds threshold ${thresholds.thresholds.maxCognitiveComplexity}`,
          file: filePath,
          line: startPos.line,
          column: startPos.column,
          remediation: `함수 '${funcName}'의 복잡한 조건문과 중첩 루프를 분할하거나 단순화하여 인지 복잡도를 15 이하로 낮추세요.`,
          details: { complexity: cogScore, limit: thresholds.thresholds.maxCognitiveComplexity, fatal: isFatal },
        });
      }
    }

    // 함수 본문으로 진입할 때는 중첩 깊이를 0으로 재설정 (독립 스코프)
    const childNesting = isFunctionNode ? 0 : nextNesting;
    ts.forEachChild(node, (child) => visit(child, childNesting));
  }

  visit(sourceFile, 0);

  // 6. 단일 파일 길이(File SLOC) 검사
  if (totalSloc > thresholds.thresholds.maxFileSloc) {
    violations.push({
      ruleId: "file-sloc",
      ruleName: "File SLOC Exceeded",
      category: RuleCategory.Structural,
      severity: RuleSeverity.Warn,
      message: `File '${filePath}' length (${totalSloc} SLOC) exceeds threshold ${thresholds.thresholds.maxFileSloc}`,
      file: filePath,
      line: 1,
      column: 1,
      remediation: "모듈의 책임을 분리하여 여러 파일로 분할하세요 (권장 400 SLOC 이하).",
      details: { sloc: totalSloc, limit: thresholds.thresholds.maxFileSloc },
    });
  }

  const maxCognitiveComplexity = functions.reduce((max, f) => Math.max(max, f.cognitiveComplexity), 0);
  const maxFunctionSloc = functions.reduce((max, f) => Math.max(max, f.sloc), 0);
  const fatalCount = violations.filter((v) => v.severity === RuleSeverity.Fatal).length;
  const warnCount = violations.filter((v) => v.severity === RuleSeverity.Warn).length;

  return {
    file: filePath,
    sloc: totalSloc,
    totalLines,
    functions,
    violations,
    metrics: {
      maxCognitiveComplexity,
      maxNestingDepth: maxGlobalNesting,
      maxFunctionSloc,
      emptyCatchCount,
      emptyFinallyCount,
      anyCount,
      aiCommentCount,
      fatalCount,
      warnCount,
    },
  };
}
