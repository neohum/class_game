// anti-slop-gate.ts — Deterministic Anti-Slop Design Gate for 5 Core UI Styles.
//
// Enforces non-negotiable harness visual invariants:
//   1. Anti-Cuticle / Anti-Fingernail: Rejects asymmetric borders (border-l-4, border-t-2, etc.)
//   2. Perfect Centering: Requires `inline-flex items-center justify-center leading-none` on buttons & badges
//   3. Liquid Glass Contrast: Enforces WCAG 2.1 AA (≥ 4.5:1) text contrast on glassmorphic elements
//   4. Touch Target Safety: Detects interactive touch targets under 44px (WCAG 2.5.8 & Apple HIG)
//
// Zero external dependencies: pure Node.js standard library.

import { existsSync, readFileSync, statSync, realpathSync } from "node:fs";
import { resolve, relative, extname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export type SlopSeverity = "critical" | "serious" | "warning";

export interface AntiSlopViolation {
  id: string;
  severity: SlopSeverity;
  rule: string;
  file?: string;
  line?: number;
  snippet: string;
  message: string;
  fixRecommendation: string;
}

export interface AntiSlopReport {
  passed: boolean;
  totalViolations: number;
  criticalCount: number;
  seriousCount: number;
  warningCount: number;
  violations: AntiSlopViolation[];
  summary: string;
}

// ---------------------------------------------------------------------------
// 1. Color Luminance & Contrast Math (WCAG 2.1 AA Standard)
// ---------------------------------------------------------------------------

function parseHexToRgb(hex: string): [number, number, number] | null {
  const clean = hex.replace(/^#/, "").trim();
  if (clean.length === 3) {
    const r = parseInt(clean[0]! + clean[0]!, 16);
    const g = parseInt(clean[1]! + clean[1]!, 16);
    const b = parseInt(clean[2]! + clean[2]!, 16);
    return [r, g, b];
  }
  if (clean.length === 6) {
    const r = parseInt(clean.slice(0, 2), 16);
    const g = parseInt(clean.slice(2, 4), 16);
    const b = parseInt(clean.slice(4, 6), 16);
    return [r, g, b];
  }
  return null;
}

function parseRgbString(rgbStr: string): [number, number, number] | null {
  const match = rgbStr.match(/rgba?\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (!match) return null;
  return [parseInt(match[1]!, 10), parseInt(match[2]!, 10), parseInt(match[3]!, 10)];
}

function colorToRgb(color: string): [number, number, number] | null {
  if (color.startsWith("#")) return parseHexToRgb(color);
  if (color.startsWith("rgb")) return parseRgbString(color);
  const NAMED: Record<string, [number, number, number]> = {
    white: [255, 255, 255],
    black: [0, 0, 0],
    zinc900: [24, 24, 27],
    zinc800: [39, 39, 42],
    zinc700: [63, 63, 70],
    zinc400: [161, 161, 170],
    zinc200: [228, 228, 231],
    zinc100: [244, 244, 245],
    gray400: [156, 163, 175],
    gray300: [209, 213, 219],
  };
  return NAMED[color.toLowerCase()] ?? null;
}

/**
 * Calculates WCAG 2.1 relative luminance for an sRGB triplet (0..255).
 */
export function calculateRelativeLuminance(r: number, g: number, b: number): number {
  const [rs, gs, bs] = [r / 255, g / 255, b / 255].map((val) => {
    return val <= 0.03928 ? val / 12.92 : Math.pow((val + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * (rs ?? 0) + 0.7152 * (gs ?? 0) + 0.0722 * (bs ?? 0);
}

/**
 * Computes contrast ratio between two colors (hex, rgb, or named). Returns value between 1.0 and 21.0.
 */
export function calculateContrastRatio(foreground: string, background: string): number {
  const fgRgb = colorToRgb(foreground) || [0, 0, 0];
  const bgRgb = colorToRgb(background) || [255, 255, 255];

  const l1 = calculateRelativeLuminance(fgRgb[0], fgRgb[1], fgRgb[2]);
  const l2 = calculateRelativeLuminance(bgRgb[0], bgRgb[1], bgRgb[2]);

  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  const ratio = (lighter + 0.05) / (darker + 0.05);

  return Math.round(ratio * 100) / 100;
}

// ---------------------------------------------------------------------------
// 2. Individual Slop Checkers
// ---------------------------------------------------------------------------

/**
 * Check 1: Asymmetric borders (Anti-Cuticle / Anti-Fingernail)
 */
export function checkAsymmetricBorders(code: string, filePath?: string): AntiSlopViolation[] {
  const violations: AntiSlopViolation[] = [];
  const lines = code.split(/\r?\n/);

  const classRegex = /\b(border-[lrteb]-(?:[2-9]|\d{2,}|\[[2-9]px\]|\[\d{2,}px\]))\b/g;
  const inlineCssRegex = /border-(?:left|right|top|bottom)\s*:\s*([2-9]|\d{2,})px/i;
  const inlineWidthRegex = /border-(?:left|right|top|bottom)-width\s*:\s*([2-9]|\d{2,})px/i;

  for (let idx = 0; idx < lines.length; idx++) {
    const rawLine = lines[idx] ?? "";
    const trimmed = rawLine.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;

    let match: RegExpExecArray | null;
    while ((match = classRegex.exec(rawLine)) !== null) {
      violations.push({
        id: "SLOP-ASYMMETRIC-BORDER",
        severity: "critical",
        rule: "Anti-Cuticle Symmetric Border Rule",
        file: filePath,
        line: idx + 1,
        snippet: match[0],
        message: `비대칭 굵은 테두리 '${match[0]}' 감지: 손톱(cuticle) 모양 왜곡 디자인은 엄격히 금지됩니다.`,
        fixRecommendation: "전면 대칭 테두리 'border' 또는 단색 배경 및 내부 인디케이터 배지를 사용하세요.",
      });
    }

    if (inlineCssRegex.test(rawLine) || inlineWidthRegex.test(rawLine)) {
      violations.push({
        id: "SLOP-ASYMMETRIC-BORDER",
        severity: "critical",
        rule: "Anti-Cuticle Symmetric Border Rule",
        file: filePath,
        line: idx + 1,
        snippet: trimmed,
        message: "인라인 스타일에서 비대칭 굵은 테두리(2px 이상) 감지: 대칭 테두리 규칙 위반입니다.",
        fixRecommendation: "사방 균일한 'border: 1px solid' 또는 'border: 2px solid' 대칭 테두리를 사용하세요.",
      });
    }
  }

  return violations;
}

/**
 * Checks whether an element attributes string satisfies button centering rules.
 */
function evaluateCenteringClasses(attrs: string): { ok: boolean; missing: string[] } {
  const classMatch = /(?:class|className)\s*=\s*["']([^"']*)["']/.exec(attrs);
  const classNames = classMatch ? classMatch[1]! : "";

  const hasFlex = /\b(inline-flex|flex)\b/.test(classNames);
  const hasItemsCenter = /\bitems-center\b/.test(classNames);
  const hasJustifyCenter = /\bjustify-center\b/.test(classNames);
  const hasLeadingNone = /\bleading-none\b/.test(classNames);

  const styleMatch = /style\s*=\s*["']([^"']*)["']/.exec(attrs);
  const styleStr = styleMatch ? styleMatch[1]! : "";
  const styleHasFlex = /display\s*:\s*(?:inline-)?flex/i.test(styleStr);
  const styleHasItemsCenter = /align-items\s*:\s*center/i.test(styleStr);
  const styleHasJustifyCenter = /justify-content\s*:\s*center/i.test(styleStr);
  const styleHasLeadingNone = /line-height\s*:\s*1\b/i.test(styleStr);

  const okFlex = hasFlex || styleHasFlex;
  const okItemsCenter = hasItemsCenter || styleHasItemsCenter;
  const okJustifyCenter = hasJustifyCenter || styleHasJustifyCenter;
  const okLeadingNone = hasLeadingNone || styleHasLeadingNone;

  const missing: string[] = [];
  if (!okFlex) missing.push("inline-flex");
  if (!okItemsCenter) missing.push("items-center");
  if (!okJustifyCenter) missing.push("justify-center");
  if (!okLeadingNone) missing.push("leading-none");

  return { ok: missing.length === 0, missing };
}

/**
 * Check 2: Button and Badge Perfect Centering
 */
export function checkButtonCentering(code: string, filePath?: string): AntiSlopViolation[] {
  const violations: AntiSlopViolation[] = [];
  const lines = code.split(/\r?\n/);
  const tagRegex = /<((?:button|Badge|Chip|a|span|div))\b([^>]*?)>/g;

  for (let idx = 0; idx < lines.length; idx++) {
    const rawLine = lines[idx] ?? "";
    const trimmed = rawLine.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;

    let match: RegExpExecArray | null;
    while ((match = tagRegex.exec(rawLine)) !== null) {
      const tag = match[1]!;
      const attrs = match[2]!;

      const isButtonTag = tag.toLowerCase() === "button" || tag === "Badge" || tag === "Chip";
      const hasRoleButton = /role\s*=\s*["']button["']/i.test(attrs);
      const hasBtnOrBadgeClass = /(?:class|className)\s*=\s*["'][^"']*\b(btn|badge|chip)\b[^"']*["']/i.test(attrs);

      if (isButtonTag || hasRoleButton || hasBtnOrBadgeClass) {
        if (/type\s*=\s*["']hidden["']/i.test(attrs)) continue;

        const { ok, missing } = evaluateCenteringClasses(attrs);
        if (!ok) {
          violations.push({
            id: "SLOP-BUTTON-CENTERING",
            severity: "serious",
            rule: "Button & Badge Perfect Centering Rule",
            file: filePath,
            line: idx + 1,
            snippet: match[0],
            message: `버튼/배지 요소에서 완벽 중앙 정렬 누락 (${missing.join(", ")}): 텍스트/아이콘 편차가 발생합니다.`,
            fixRecommendation: "요소의 클래스에 'inline-flex items-center justify-center leading-none'를 필수 적용하세요.",
          });
        }
      }
    }
  }

  return violations;
}

/**
 * Check 3: Liquid Glass Contrast Check
 */
export function checkGlassContrast(code: string, filePath?: string): AntiSlopViolation[] {
  const violations: AntiSlopViolation[] = [];
  const lines = code.split(/\r?\n/);
  const bodyGlassRegex = /<(?:body|main|html)\b[^>]*\bbackdrop-blur/i;

  const lowContrastKeywords = [
    /\btext-(?:zinc|gray|neutral|slate)-400\b/,
    /\btext-(?:zinc|gray|neutral|slate)-300\b/,
    /\btext-white\/(?:30|40|50|60)\b/,
    /\btext-black\/(?:30|40|50|60)\b/,
  ];

  for (let idx = 0; idx < lines.length; idx++) {
    const rawLine = lines[idx] ?? "";
    if (bodyGlassRegex.test(rawLine)) {
      violations.push({
        id: "SLOP-GLASS-ABUSE",
        severity: "critical",
        rule: "Liquid Glass Scope Invariant",
        file: filePath,
        line: idx + 1,
        snippet: rawLine.trim(),
        message: "전체 페이지/메인 컨테이너에 글래스모피즘(backdrop-blur) 적용 감지: 가독성 훼손 및 성능 저하 유발.",
        fixRecommendation: "글래스 효과는 플로팅 툴바, 모달, 캡슐 컨트롤러에만 한정 적용하세요.",
      });
    }

    if (/backdrop-blur/.test(rawLine)) {
      for (const kw of lowContrastKeywords) {
        if (kw.test(rawLine)) {
          violations.push({
            id: "SLOP-GLASS-CONTRAST",
            severity: "serious",
            rule: "WCAG 2.1 AA Glass Contrast Rule",
            file: filePath,
            line: idx + 1,
            snippet: rawLine.trim(),
            message: "글래스모피즘 요소 내 저대비 텍스트 색상 감지 (명도 대비 4.5:1 미달 우려).",
            fixRecommendation: "명도 대비 4.5:1 이상을 보장하는 고대비 텍스트 토큰을 사용하세요.",
          });
          break;
        }
      }
    }
  }

  return violations;
}

/**
 * Check 4: Touch Target Size (≥ 44px)
 */
export function checkTouchTargetSize(code: string, filePath?: string): AntiSlopViolation[] {
  const violations: AntiSlopViolation[] = [];
  const lines = code.split(/\r?\n/);

  const smallClassRegex = /\b(?:h|w)-(?:[4-9]|10)\b|\b(?:h|w)-\[(?:[1-3]?[0-9]|4[0-3])px\]/;
  const smallInlineRegex = /(?:height|width)\s*:\s*(?:[1-3]?[0-9]|4[0-3])px/i;
  const interactiveTagRegex = /<(?:button|a)\b([^>]*?)>/g;

  for (let idx = 0; idx < lines.length; idx++) {
    const rawLine = lines[idx] ?? "";
    const trimmed = rawLine.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;

    let match: RegExpExecArray | null;
    while ((match = interactiveTagRegex.exec(rawLine)) !== null) {
      const attrs = match[1]!;
      const hasSmallClass = smallClassRegex.test(attrs);
      const hasSmallInline = smallInlineRegex.test(attrs);
      const hasMin44 = /\bmin-(?:h|w)-\[44px\]/.test(attrs) || /\bmin-(?:h|w)-(?:11|12)\b/.test(attrs);

      if ((hasSmallClass || hasSmallInline) && !hasMin44) {
        violations.push({
          id: "SLOP-TOUCH-TARGET-UNDERSIZE",
          severity: "serious",
          rule: "Touch Target Size Safety (≥ 44px)",
          file: filePath,
          line: idx + 1,
          snippet: match[0],
          message: "인터랙티브 터치 요소의 크기가 44px 미만으로 감지되었습니다 (모바일 오터치 유발).",
          fixRecommendation: "최소 터치 타깃 'min-h-[44px] min-w-[44px]' 또는 패딩 확장을 적용하세요.",
        });
      }
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// 3. Composite Code & File Audit
// ---------------------------------------------------------------------------

export function auditAntiSlopCode(code: string, filePath?: string): AntiSlopReport {
  const violations: AntiSlopViolation[] = [
    ...checkAsymmetricBorders(code, filePath),
    ...checkButtonCentering(code, filePath),
    ...checkGlassContrast(code, filePath),
    ...checkTouchTargetSize(code, filePath),
  ];

  const criticalCount = violations.filter((v) => v.severity === "critical").length;
  const seriousCount = violations.filter((v) => v.severity === "serious").length;
  const warningCount = violations.filter((v) => v.severity === "warning").length;
  const passed = criticalCount === 0 && seriousCount === 0;

  const summary = passed
    ? `✓ Anti-Slop Gate 통과 (위반 사항 없음, 경고: ${warningCount}개)`
    : `❌ Anti-Slop Gate 실패: ${criticalCount + seriousCount}개 필수 규칙 위반 (Critical: ${criticalCount}, Serious: ${seriousCount})`;

  return {
    passed,
    totalViolations: violations.length,
    criticalCount,
    seriousCount,
    warningCount,
    violations,
    summary,
  };
}

export function auditAntiSlopFiles(filePaths: string[], cwd = process.cwd()): AntiSlopReport {
  const allViolations: AntiSlopViolation[] = [];

  for (const fp of filePaths) {
    const full = resolve(cwd, fp);
    if (!existsSync(full)) continue;
    const stat = statSync(full);
    if (!stat.isFile()) continue;

    const ext = extname(full).toLowerCase();
    if (![".tsx", ".jsx", ".ts", ".js", ".html", ".vue", ".svelte"].includes(ext)) continue;

    try {
      const content = readFileSync(full, "utf8");
      const report = auditAntiSlopCode(content, relative(cwd, full).replace(/\\/g, "/"));
      allViolations.push(...report.violations);
    } catch {
      // ignore
    }
  }

  const criticalCount = allViolations.filter((v) => v.severity === "critical").length;
  const seriousCount = allViolations.filter((v) => v.severity === "serious").length;
  const warningCount = allViolations.filter((v) => v.severity === "warning").length;
  const passed = criticalCount === 0 && seriousCount === 0;

  return {
    passed,
    totalViolations: allViolations.length,
    criticalCount,
    seriousCount,
    warningCount,
    violations: allViolations,
    summary: passed
      ? `✓ 검사 완료: ${filePaths.length}개 파일 Anti-Slop 규약 완벽 통과`
      : `❌ 검사 실패: ${allViolations.length}개 Anti-Slop 위반 검출`,
  };
}

// ---------------------------------------------------------------------------
// 4. CLI Runner
// ---------------------------------------------------------------------------

export function runAntiSlopCli(argv = process.argv.slice(2)): number {
  const jsonOutput = argv.includes("--json");
  const target = argv.find((a) => !a.startsWith("--"));

  let report: AntiSlopReport;
  if (target) {
    report = auditAntiSlopFiles([target]);
  } else {
    const gitFiles: string[] = [];
    try {
      const out = execFileSync("git", ["status", "--porcelain", "-uall"], { encoding: "utf8" });
      for (const line of out.split("\n")) {
        const file = line.slice(3).trim();
        if (file) gitFiles.push(file);
      }
    } catch {
      // fallback
    }
    report = gitFiles.length > 0 ? auditAntiSlopFiles(gitFiles) : auditAntiSlopFiles(["template/src", "studio/frontend"]);
  }

  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`\n[ANTI-SLOP DESIGN GATE]`);
    console.log(report.summary);
    if (report.violations.length > 0) {
      console.log("\n위반 상세 내역:");
      for (const v of report.violations) {
        console.log(`  [${v.severity.toUpperCase()}] ${v.id} (${v.file || "inline"}:${v.line || "?"})`);
        console.log(`    설명: ${v.message}`);
        console.log(`    코드: ${v.snippet}`);
        console.log(`    수정: ${v.fixRecommendation}`);
      }
    }
  }

  return report.passed ? 0 : 1;
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
  process.exitCode = runAntiSlopCli();
}
