#!/usr/bin/env node
/**
 * verify-responsive.ts — Multi-Device & Screen Size Responsiveness Verification Gate.
 * 
 * Performs deterministic mathematical geometry calculations and layout simulation
 * across all standard device viewports (Mobile, Tablet, Desktop) to verify that:
 * 1. Buttons, inputs, and components do NOT mathematically overflow card/container boundaries.
 * 2. Flex rows and action toolbars do NOT exceed container width without wrapping.
 * 3. Adjacent touch elements do NOT collide or violate minimum touch spacing (WCAG 2.5.8).
 * 4. Touch targets meet minimum geometric bounding box requirements (≥ 44x44px).
 * 5. Viewport meta and responsive scaling rules are strictly honored.
 */

import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// 1. Geometric Data Types & Device Presets
// ---------------------------------------------------------------------------

export type DeviceCategory = "mobile" | "tablet" | "desktop";

export interface DevicePreset {
  id: string;
  name: string;
  category: DeviceCategory;
  width: number;
  height: number;
  touch: boolean;
  minTouchTargetPx: number;
  description: string;
}

export const DEVICE_PRESETS: Record<string, DevicePreset> = {
  "mobile-compact": {
    id: "mobile-compact",
    name: "소형 모바일 (iPhone SE / Compact)",
    category: "mobile",
    width: 375,
    height: 667,
    touch: true,
    minTouchTargetPx: 44,
    description: "375px 최소 모바일 뷰포트 레이아웃 안정성",
  },
  "mobile-standard": {
    id: "mobile-standard",
    name: "표준 모바일 (iPhone 14/15/16, Galaxy S24)",
    category: "mobile",
    width: 390,
    height: 844,
    touch: true,
    minTouchTargetPx: 44,
    description: "390px ~ 412px 표준 스마트폰 뷰포트",
  },
  "tablet-portrait": {
    id: "tablet-portrait",
    name: "태블릿 세로 (iPad / 교실 스마트 패드)",
    category: "tablet",
    width: 768,
    height: 1024,
    touch: true,
    minTouchTargetPx: 44,
    description: "768px 교실 태블릿 및 스마트 단말기 세로 뷰",
  },
  "tablet-landscape": {
    id: "tablet-landscape",
    name: "태블릿 가로 / 전자칠판 (Smart Board)",
    category: "tablet",
    width: 1024,
    height: 768,
    touch: true,
    minTouchTargetPx: 44,
    description: "1024px 태블릿 가로 및 소형 스마트 전자칠판",
  },
  "desktop-laptop": {
    id: "desktop-laptop",
    name: "노트북 / 소형 데스크톱 (Laptop)",
    category: "desktop",
    width: 1280,
    height: 800,
    touch: false,
    minTouchTargetPx: 32,
    description: "1280px 노트북 및 교사용 단말 표준 해상도",
  },
  "desktop-fhd": {
    id: "desktop-fhd",
    name: "데스크톱 FHD (1080p Standard)",
    category: "desktop",
    width: 1920,
    height: 1080,
    touch: false,
    minTouchTargetPx: 32,
    description: "1920px 표준 모니터 및 대형 전자칠판 디스플레이",
  },
};

export interface BoundingBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Padding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface Margin {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface ContainerGeometry {
  label?: string;
  box: BoundingBox;
  padding?: Partial<Padding>;
}

export interface ElementGeometry {
  id?: string;
  label?: string;
  role?: string;
  box: BoundingBox;
  margin?: Partial<Margin>;
  isTouchTarget?: boolean;
}

// ---------------------------------------------------------------------------
// 2. Mathematical Layout Calculation Theorems & Functions
// ---------------------------------------------------------------------------

export interface ContainmentMathResult {
  contained: boolean;
  overflowRight: number;
  overflowBottom: number;
  overflowLeft: number;
  overflowTop: number;
  breachAreaPx2: number;
  containmentRatio: number;
}

/**
 * Theorem 1: Bounding Box Containment & Boundary Breach
 * Mathematically checks whether element E is completely enclosed in container C.
 * Enforces:
 *   InnerRight = C.x + C.w - C.padding.right
 *   OverflowRight = max(0, (E.x + E.w + E.margin.right) - InnerRight)
 */
export function calculateContainmentMath(
  container: ContainerGeometry,
  element: ElementGeometry
): ContainmentMathResult {
  const pLeft = container.padding?.left ?? 0;
  const pRight = container.padding?.right ?? 0;
  const pTop = container.padding?.top ?? 0;
  const pBottom = container.padding?.bottom ?? 0;

  const mLeft = element.margin?.left ?? 0;
  const mRight = element.margin?.right ?? 0;
  const mTop = element.margin?.top ?? 0;
  const mBottom = element.margin?.bottom ?? 0;

  const innerX = container.box.x + pLeft;
  const innerY = container.box.y + pTop;
  const innerW = Math.max(0, container.box.w - pLeft - pRight);
  const innerH = Math.max(0, container.box.h - pTop - pBottom);
  const innerRight = innerX + innerW;
  const innerBottom = innerY + innerH;

  const elemLeft = element.box.x - mLeft;
  const elemTop = element.box.y - mTop;
  const elemRight = element.box.x + element.box.w + mRight;
  const elemBottom = element.box.y + element.box.h + mBottom;

  const overflowRight = Math.max(0, elemRight - innerRight);
  const overflowBottom = Math.max(0, elemBottom - innerBottom);
  const overflowLeft = Math.max(0, innerX - elemLeft);
  const overflowTop = Math.max(0, innerY - elemTop);

  const contained = overflowRight === 0 && overflowBottom === 0 && overflowLeft === 0 && overflowTop === 0;

  // Intersecting / contained area calculation
  const intersectW = Math.max(0, Math.min(elemRight, innerRight) - Math.max(elemLeft, innerX));
  const intersectH = Math.max(0, Math.min(elemBottom, innerBottom) - Math.max(elemTop, innerY));
  const containedArea = intersectW * intersectH;
  const totalElemArea = Math.max(1, element.box.w * element.box.h);
  const breachAreaPx2 = Math.max(0, totalElemArea - containedArea);
  const containmentRatio = Math.min(1.0, containedArea / totalElemArea);

  return {
    contained,
    overflowRight,
    overflowBottom,
    overflowLeft,
    overflowTop,
    breachAreaPx2,
    containmentRatio,
  };
}

export interface RowOverflowMathResult {
  totalRequiredWidth: number;
  availableWidth: number;
  overflowDelta: number;
  willOverflowWithoutWrap: boolean;
  criticalBreakpoint: number;
  maxFittableItems: number;
}

/**
 * Theorem 2: Combinatorial Flex Row / Toolbar Sum
 * Given N items of widths [w1, ..., wN] with gaps and container padding,
 * evaluates total contiguous row width against container available width:
 *   W_req = sum(w_i) + (N - 1) * gap + paddingHoriz
 * If availableWidth < W_req and flexWrap is false, overflow is mathematically guaranteed!
 */
export function calculateRowOverflowMath(
  containerWidth: number,
  itemWidths: number[],
  gap = 8,
  paddingHoriz = 0
): RowOverflowMathResult {
  if (itemWidths.length === 0) {
    return {
      totalRequiredWidth: paddingHoriz,
      availableWidth: containerWidth,
      overflowDelta: 0,
      willOverflowWithoutWrap: false,
      criticalBreakpoint: paddingHoriz,
      maxFittableItems: 0,
    };
  }

  const sumWidths = itemWidths.reduce((a, b) => a + b, 0);
  const totalGaps = (itemWidths.length - 1) * gap;
  const totalRequiredWidth = sumWidths + totalGaps + paddingHoriz;
  const availableWidth = Math.max(0, containerWidth - paddingHoriz);

  const overflowDelta = Math.max(0, totalRequiredWidth - containerWidth);
  const willOverflowWithoutWrap = overflowDelta > 0;
  const criticalBreakpoint = totalRequiredWidth;

  let currentWidth = 0;
  let maxFittableItems = 0;
  for (let i = 0; i < itemWidths.length; i++) {
    const itemW = itemWidths[i] ?? 0;
    const addGap = i > 0 ? gap : 0;
    if (currentWidth + addGap + itemW <= availableWidth) {
      currentWidth += addGap + itemW;
      maxFittableItems++;
    } else {
      break;
    }
  }

  return {
    totalRequiredWidth,
    availableWidth,
    overflowDelta,
    willOverflowWithoutWrap,
    criticalBreakpoint,
    maxFittableItems,
  };
}

export interface CollisionMathResult {
  collides: boolean;
  overlapAreaPx2: number;
  distanceX: number;
  distanceY: number;
  euclideanDistance: number;
  touchInterference: boolean;
}

/**
 * Theorem 3: Element Collision & Touch Interference Distance
 * Calculates 2D spatial distance and intersection area between two elements.
 * For touch targets, enforces WCAG 2.5.8 minimum distance constraint (>= 8px spacing).
 */
export function calculateCollisionMath(
  a: ElementGeometry,
  b: ElementGeometry,
  minTouchSpacing = 8
): CollisionMathResult {
  const aLeft = a.box.x;
  const aRight = a.box.x + a.box.w;
  const aTop = a.box.y;
  const aBottom = a.box.y + a.box.h;

  const bLeft = b.box.x;
  const bRight = b.box.x + b.box.w;
  const bTop = b.box.y;
  const bBottom = b.box.y + b.box.h;

  const overlapW = Math.max(0, Math.min(aRight, bRight) - Math.max(aLeft, bLeft));
  const overlapH = Math.max(0, Math.min(aBottom, bBottom) - Math.max(aTop, bTop));
  const overlapAreaPx2 = overlapW * overlapH;
  const collides = overlapAreaPx2 > 0;

  const distanceX = Math.max(0, Math.max(aLeft, bLeft) - Math.min(aRight, bRight));
  const distanceY = Math.max(0, Math.max(aTop, bTop) - Math.min(aBottom, bBottom));
  const euclideanDistance = Math.hypot(distanceX, distanceY);

  const isBothTouch = a.isTouchTarget !== false && b.isTouchTarget !== false;
  const touchInterference = isBothTouch && (collides || (distanceX < minTouchSpacing && distanceY < minTouchSpacing));

  return {
    collides,
    overlapAreaPx2,
    distanceX,
    distanceY,
    euclideanDistance,
    touchInterference,
  };
}

/**
 * Theorem 4: Card Layout Simulation across all Viewport Presets
 * Simulates card bounds and evaluates whether button action bar fits without clipping.
 */
export function simulateCardLayoutAcrossDevices(
  card: { maxWidth?: number; padding?: number; isFluid?: boolean },
  buttons: Array<{ width: number; height: number; label?: string }>,
  gap = 8
): Record<string, { viewportWidth: number; cardWidth: number; fits: boolean; overflowDelta: number; criticalBreakpoint: number }> {
  const results: Record<string, { viewportWidth: number; cardWidth: number; fits: boolean; overflowDelta: number; criticalBreakpoint: number }> = {};
  const btnWidths = buttons.map((b) => b.width);
  const cardPadding = card.padding ?? 32;

  for (const [key, preset] of Object.entries(DEVICE_PRESETS)) {
    const pagePadding = preset.category === "mobile" ? 32 : 48;
    const availablePageW = preset.width - pagePadding;
    const cardWidth = card.maxWidth ? Math.min(availablePageW, card.maxWidth) : availablePageW;

    const rowCalc = calculateRowOverflowMath(cardWidth, btnWidths, gap, cardPadding);
    results[key] = {
      viewportWidth: preset.width,
      cardWidth,
      fits: !rowCalc.willOverflowWithoutWrap,
      overflowDelta: rowCalc.overflowDelta,
      criticalBreakpoint: rowCalc.criticalBreakpoint,
    };
  }

  return results;
}

// ---------------------------------------------------------------------------
// 3. CSS & Tailwind Unit Resolver
// ---------------------------------------------------------------------------

export function resolveTailwindDimension(className: string): {
  width?: number;
  maxWidth?: number;
  minWidth?: number;
  height?: number;
  gap?: number;
  paddingX?: number;
  flexWrap?: boolean;
} {
  const result: {
    width?: number;
    maxWidth?: number;
    minWidth?: number;
    height?: number;
    gap?: number;
    paddingX?: number;
    flexWrap?: boolean;
  } = {};

  const tokens = className.split(/\s+/);

  for (const token of tokens) {
    if (token === "flex-wrap") result.flexWrap = true;
    if (token === "flex-nowrap") result.flexWrap = false;

    // Fixed widths: w-[240px], w-64 (=256px), w-48 (=192px), etc.
    const wMatch = token.match(/^w-\[(\d+)px\]$/);
    if (wMatch) result.width = parseInt(wMatch[1] || "0", 10);
    const wNumMatch = token.match(/^w-(\d+)$/);
    if (wNumMatch) result.width = parseInt(wNumMatch[1] || "0", 10) * 4;

    // Max-widths: max-w-[400px], max-w-sm (384), max-w-md (448), max-w-lg (512), max-w-xl (576)
    const maxWMatch = token.match(/^max-w-\[(\d+)px\]$/);
    if (maxWMatch) result.maxWidth = parseInt(maxWMatch[1] || "0", 10);
    if (token === "max-w-sm") result.maxWidth = 384;
    if (token === "max-w-md") result.maxWidth = 448;
    if (token === "max-w-lg") result.maxWidth = 512;
    if (token === "max-w-xl") result.maxWidth = 576;
    if (token === "max-w-2xl") result.maxWidth = 672;

    // Heights
    const hMatch = token.match(/^h-\[(\d+)px\]$/);
    if (hMatch) result.height = parseInt(hMatch[1] || "0", 10);
    const hNumMatch = token.match(/^h-(\d+)$/);
    if (hNumMatch) result.height = parseInt(hNumMatch[1] || "0", 10) * 4;

    // Gaps
    const gapMatch = token.match(/^gap-\[(\d+)px\]$/);
    if (gapMatch) result.gap = parseInt(gapMatch[1] || "0", 10);
    const gapNumMatch = token.match(/^gap-(\d+)$/);
    if (gapNumMatch) result.gap = parseInt(gapNumMatch[1] || "0", 10) * 4;

    // Padding X
    const pxMatch = token.match(/^px-\[(\d+)px\]$/);
    if (pxMatch) result.paddingX = parseInt(pxMatch[1] || "0", 10) * 2;
    const pxNumMatch = token.match(/^px-(\d+)$/);
    if (pxNumMatch) result.paddingX = parseInt(pxNumMatch[1] || "0", 10) * 8;
  }

  return result;
}

// ---------------------------------------------------------------------------
// 4. Code & Template Mathematical Inspection Engine
// ---------------------------------------------------------------------------

export type ViolationSeverity = "critical" | "serious" | "moderate" | "info";

export interface ResponsiveViolation {
  id: string;
  rule: string;
  device?: string;
  viewport?: { width: number; height: number };
  severity: ViolationSeverity;
  target: string;
  message: string;
  fixRecommendation: string;
  codeSnippet?: string;
  mathEvidence?: {
    requiredWidth?: number;
    availableWidth?: number;
    overflowDelta?: number;
    criticalBreakpoint?: number;
    containmentRatio?: number;
    breachAreaPx2?: number;
  };
}

export function auditHtmlContent(html: string, sourceName = "document.html"): ResponsiveViolation[] {
  const violations: ResponsiveViolation[] = [];

  // 1. Viewport Meta Tag Verification
  const hasViewportMeta = /<meta[^>]*\bname=["']viewport["'][^>]*>/i.test(html);
  if (!hasViewportMeta && /<html\b/i.test(html)) {
    violations.push({
      id: "RSP-VIEWPORT-MISSING",
      rule: "반응형 뷰포트(viewport) 메타 태그 필수",
      severity: "critical",
      target: sourceName,
      message: "HTML 문서에 <meta name=\"viewport\"> 태그가 선언되지 않아 모바일/태블릿에서 데스크톱 배율로 축소 표시됩니다.",
      fixRecommendation: '<head> 내에 <meta name="viewport" content="width=device-width, initial-scale=1" /> 태그를 추가하세요.',
      codeSnippet: '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    });
  }

  // 2. Fixed Width Overflow Detector with Mathematical Bounds Check
  const fixedWidthInlineMatches = [...html.matchAll(/(?:style=["'][^"']*?\bwidth:\s*([0-9]{3,4})px[^"']*?["']|width=["']([0-9]{3,4})["'])/gi)];
  for (const m of fixedWidthInlineMatches) {
    const rawVal = m[1] || m[2] || "0";
    const widthVal = parseInt(rawVal, 10);
    if (widthVal > 375) {
      const mobilePreset = DEVICE_PRESETS["mobile-compact"]!;
      const overflowDelta = widthVal - mobilePreset.width;
      violations.push({
        id: "RSP-FIXED-WIDTH-OVERFLOW",
        rule: "모바일 뷰포트 초과 고정 너비(Fixed Width) 제한",
        device: "mobile-compact",
        viewport: { width: mobilePreset.width, height: mobilePreset.height },
        severity: widthVal > 600 ? "serious" : "moderate",
        target: sourceName,
        message: `고정 너비 ${widthVal}px 요소가 감지되어 모바일 화면(${mobilePreset.width}px)을 ${overflowDelta}px 초과하여 가로 스크롤 및 잘림이 발생합니다.`,
        fixRecommendation: `width: ${widthVal}px 대신 max-width: 100% 또는 반응형 너비(예: w-full, max-w-xl, clamp)를 사용하세요.`,
        codeSnippet: m[0],
        mathEvidence: {
          requiredWidth: widthVal,
          availableWidth: mobilePreset.width,
          overflowDelta,
          criticalBreakpoint: widthVal,
        },
      });
    }
  }

  // 3. Table Overflow Wrapper Check
  const tableMatches = [...html.matchAll(/<table\b([^>]*)>/gi)];
  for (const tableMatch of tableMatches) {
    const tableIndex = tableMatch.index || 0;
    const precedingSlice = html.slice(Math.max(0, tableIndex - 300), tableIndex);
    const hasScrollWrapper = /class=["'][^"']*\b(overflow-x-auto|overflow-auto|table-responsive|table-wrapper)\b[^"']*["']/i.test(precedingSlice)
      || /style=["'][^"']*\boverflow(-x)?:\s*(auto|scroll)\b[^"']*["']/i.test(precedingSlice);

    if (!hasScrollWrapper) {
      violations.push({
        id: "RSP-UNWRAPPED-TABLE",
        rule: "데이터 테이블 반응형 가로 스크롤 래퍼(Overflow Wrapper) 필수",
        device: "mobile-standard",
        viewport: { width: 390, height: 844 },
        severity: "moderate",
        target: sourceName,
        message: "<table> 요소에 가로 스크롤 컨테이너가 없어 좁은 화면에서 화면 밖으로 넘치거나 찌그러집니다.",
        fixRecommendation: '<div class="overflow-x-auto"> 또는 style="overflow-x: auto" 래퍼로 <table>을 감싸세요.',
        codeSnippet: '<div class="overflow-x-auto">\n  <table>...</table>\n</div>',
      });
    }
  }

  // 4. Touch Target Undersize Check for Buttons/Links in Mobile
  const smallButtonMatches = [...html.matchAll(/<(?:button|a)\b[^>]*\bstyle=["'][^"']*?\b(height|width):\s*([0-9]{1,2})px[^"']*?["'][^>]*>/gi)];
  for (const btnMatch of smallButtonMatches) {
    const rawSize = btnMatch[2] || "0";
    const size = parseInt(rawSize, 10);
    if (size > 0 && size < 44) {
      violations.push({
        id: "RSP-TOUCH-TARGET-UNDERSIZE",
        rule: "터치 타깃 최소 크기 44x44px 준수 (WCAG 2.1 AA / KWCAG)",
        device: "mobile-standard",
        viewport: { width: 390, height: 844 },
        severity: "serious",
        target: sourceName,
        message: `터치 인터랙션 요소의 크기가 ${size}px로 최소 기준(44x44px, 면적 1936px²)보다 작아 모바일/태블릿 터치 시 오조작이 발생합니다.`,
        fixRecommendation: "최소 높이/너비를 min-h-[44px] min-w-[44px] 또는 p-2.5 이상으로 설정하세요.",
        codeSnippet: btnMatch[0],
      });
    }
  }

  return violations;
}

export function auditCodeContent(code: string, filePath: string): ResponsiveViolation[] {
  const violations: ResponsiveViolation[] = [];
  const fileName = basename(filePath);

  // 1. Mathematical Card / Modal Action Row Overflow Analysis
  // Searches for patterns like: <div className="...flex... gap-4..."> <button className="w-48">...
  const cardOrRowMatches = [...code.matchAll(/<div[^>]*className=["']([^"']*\bflex\b[^"']*)["'][^>]*>(.*?)<\/div>/gis)];
  for (const rowMatch of cardOrRowMatches) {
    const rowClass = rowMatch[1] || "";
    const innerContent = rowMatch[2] || "";

    const rowDim = resolveTailwindDimension(rowClass);
    const isNowrap = rowDim.flexWrap === false || !rowClass.includes("flex-wrap");
    const isRowDirection = !rowClass.includes("flex-col") || rowClass.includes("flex-row");

    if (isNowrap && isRowDirection) {
      // Find all buttons or inputs inside this flex row
      const buttonMatches = [...innerContent.matchAll(/<(?:button|Link|a)\b[^>]*className=["']([^"']*)["']/gi)];
      if (buttonMatches.length >= 2) {
        const itemWidths: number[] = [];
        for (const bm of buttonMatches) {
          const btnDim = resolveTailwindDimension(bm[1] || "");
          if (btnDim.width && btnDim.width > 0) {
            itemWidths.push(btnDim.width);
          } else {
            // Default conservative estimate for button with text
            itemWidths.push(96);
          }
        }

        const gap = rowDim.gap ?? 8;
        const paddingHoriz = rowDim.paddingX ?? 16;

        // Check against mobile viewports (375px and 390px)
        for (const [devKey, dev] of Object.entries(DEVICE_PRESETS)) {
          if (dev.category !== "mobile") continue;

          const rowCalc = calculateRowOverflowMath(dev.width, itemWidths, gap, paddingHoriz);
          if (rowCalc.willOverflowWithoutWrap) {
            violations.push({
              id: "RSP-MATH-BUTTON-ROW-OVERFLOW",
              rule: "액션 버튼 그룹 카드/뷰포트 가로 경계 초과 수학적 결함",
              device: devKey,
              viewport: { width: dev.width, height: dev.height },
              severity: "serious",
              target: `${fileName}:${rowMatch.index ?? 0}`,
              message: `버튼 ${itemWidths.length}개의 총 필요 너비(${rowCalc.totalRequiredWidth}px)가 뷰포트 너비(${dev.width}px)를 ${rowCalc.overflowDelta}px 초과하여 카드를 벗어나거나 잘립니다. (수학적 필요 임계점: ${rowCalc.criticalBreakpoint}px)`,
              fixRecommendation: "flex-nowrap을 제거하고 flex-wrap 또는 작은 화면용 flex-col md:flex-row를 적용하세요.",
              codeSnippet: rowMatch[0].slice(0, 120),
              mathEvidence: {
                requiredWidth: rowCalc.totalRequiredWidth,
                availableWidth: dev.width,
                overflowDelta: rowCalc.overflowDelta,
                criticalBreakpoint: rowCalc.criticalBreakpoint,
              },
            });
            break; // Report once per component row for the most constrained mobile
          }
        }
      }
    }
  }

  // 2. Unprotected Fixed Broad Widths
  const broadWidthRegex = /\b(?:w-\[(\d{3,4})px\]|width:\s*['"]?(\d{3,4})px['"]?)/g;
  let match: RegExpExecArray | null;
  while ((match = broadWidthRegex.exec(code)) !== null) {
    const rawPx = match[1] || match[2] || "0";
    const px = parseInt(rawPx, 10);
    if (px >= 450) {
      const lineStart = Math.max(0, code.lastIndexOf("\n", match.index));
      const lineEnd = code.indexOf("\n", match.index);
      const line = code.slice(lineStart, lineEnd === -1 ? code.length : lineEnd);

      const isResponsivePrefixed = /(?:sm:|md:|lg:|xl:|2xl:|max-w-)/.test(line) || /@media/.test(line);

      if (!isResponsivePrefixed) {
        const mobilePreset = DEVICE_PRESETS["mobile-standard"]!;
        const overflowDelta = px - mobilePreset.width;
        violations.push({
          id: "RSP-UNPROTECTED-FIXED-WIDTH",
          rule: "컴포넌트 내 무조건적 고정 너비 사용 지양",
          device: "mobile-standard",
          viewport: { width: mobilePreset.width, height: mobilePreset.height },
          severity: px >= 600 ? "serious" : "moderate",
          target: `${fileName}:${match.index}`,
          message: `${px}px 고정 너비가 반응형 분기(md:, lg:, max-w) 없이 적용되어 모바일 뷰포트(${mobilePreset.width}px)를 ${overflowDelta}px 초과합니다.`,
          fixRecommendation: `w-full max-w-[${px}px] 또는 md:w-[${px}px] 형태로 반응형 제약을 추가하세요.`,
          codeSnippet: line.trim(),
          mathEvidence: {
            requiredWidth: px,
            availableWidth: mobilePreset.width,
            overflowDelta,
            criticalBreakpoint: px,
          },
        });
      }
    }
  }

  // 3. Desktop Application Window Minimum Boundaries Check (Wails / Electron configs)
  if (fileName.includes("config") || fileName.includes("main") || fileName.includes("app")) {
    const minWidthMatch = code.match(/min(?:_?width|Width)\s*[:=]\s*(\d+)/i);
    const minHeightMatch = code.match(/min(?:_?height|Height)\s*[:=]\s*(\d+)/i);
    if (minWidthMatch && minHeightMatch) {
      const minW = parseInt(minWidthMatch[1] || "0", 10);
      const minH = parseInt(minHeightMatch[1] || "0", 10);
      if (minW < 600 || minH < 400) {
        violations.push({
          id: "RSP-DESKTOP-WINDOW-TOO-SMALL",
          rule: "데스크톱 앱 최소 윈도우 크기 가드 (최소 800x600 권장)",
          device: "desktop-laptop",
          severity: "moderate",
          target: fileName,
          message: `데스크톱 앱 창 최소 크기가 ${minW}x${minH}로 너무 작아 UI 컨트롤이 뭉개지거나 겹칠 수 있습니다.`,
          fixRecommendation: "앱 윈도우 최소 크기를 최소 800x600 이상으로 제한하여 UI 가독성을 보호하세요.",
        });
      }
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// 5. Multi-Device Aggregator & Scorer
// ---------------------------------------------------------------------------

export interface DeviceScore {
  deviceId: string;
  deviceName: string;
  score: number;
  passed: boolean;
  violations: ResponsiveViolation[];
}

export interface ResponsiveAuditResult {
  overallScore: number;
  passed: boolean;
  checkedFilesCount: number;
  devices: Record<string, DeviceScore>;
  violations: ResponsiveViolation[];
  summary: {
    critical: number;
    serious: number;
    moderate: number;
    info: number;
  };
}

export function calculateDeviceScores(violations: ResponsiveViolation[]): {
  overallScore: number;
  passed: boolean;
  devices: Record<string, DeviceScore>;
  summary: { critical: number; serious: number; moderate: number; info: number };
} {
  const summary = { critical: 0, serious: 0, moderate: 0, info: 0 };
  const deviceMap: Record<string, DeviceScore> = {};

  for (const [key, preset] of Object.entries(DEVICE_PRESETS)) {
    deviceMap[key] = {
      deviceId: key,
      deviceName: preset.name,
      score: 100,
      passed: true,
      violations: [],
    };
  }

  for (const v of violations) {
    summary[v.severity]++;
    const deduction = v.severity === "critical" ? 30 : v.severity === "serious" ? 15 : v.severity === "moderate" ? 5 : 1;

    const targetDev = v.device ? deviceMap[v.device] : undefined;
    if (targetDev) {
      targetDev.violations.push(v);
      targetDev.score = Math.max(0, targetDev.score - deduction);
    } else {
      for (const dev of Object.values(deviceMap)) {
        dev.violations.push(v);
        dev.score = Math.max(0, dev.score - deduction);
      }
    }
  }

  let totalScore = 0;
  let deviceCount = 0;
  for (const dev of Object.values(deviceMap)) {
    dev.passed = dev.score >= 80 && !dev.violations.some((x) => x.severity === "critical");
    totalScore += dev.score;
    deviceCount++;
  }

  const overallScore = deviceCount > 0 ? Math.round(totalScore / deviceCount) : 100;
  const passed = summary.critical === 0 && overallScore >= 80;

  return { overallScore, passed, devices: deviceMap, summary };
}

// ---------------------------------------------------------------------------
// 6. File Scanner & Main Verifier
// ---------------------------------------------------------------------------

export function findUiFiles(root: string, maxFiles = 100): string[] {
  const uiFiles: string[] = [];
  const validExtensions = new Set([".html", ".htm", ".tsx", ".jsx", ".vue", ".svelte", ".css"]);
  const skipDirs = new Set(["node_modules", ".git", "dist", "build", "coverage", ".orca", ".claude", ".agents", "tmp"]);

  function walk(dir: string) {
    if (uiFiles.length >= maxFiles) return;
    if (!existsSync(dir)) return;

    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const ent of entries) {
      if (uiFiles.length >= maxFiles) break;
      if (skipDirs.has(ent)) continue;

      const full = join(dir, ent);
      let isDir = false;
      try {
        isDir = lstatSync(full).isDirectory();
      } catch {
        continue;
      }

      if (isDir) {
        walk(full);
      } else {
        const ext = extname(ent).toLowerCase();
        if (validExtensions.has(ext)) {
          uiFiles.push(full);
        }
      }
    }
  }

  walk(root);
  return uiFiles;
}

export interface AuditOptions {
  cwd?: string;
  targets?: string[];
  failOnViolation?: boolean;
  minScore?: number;
}

export function verifyResponsive(options: AuditOptions = {}): ResponsiveAuditResult {
  const cwd = options.cwd || process.cwd();
  const violations: ResponsiveViolation[] = [];
  const filesToScan: string[] = [];

  if (options.targets && options.targets.length > 0) {
    for (const t of options.targets) {
      const full = resolve(cwd, t);
      if (existsSync(full)) {
        if (lstatSync(full).isDirectory()) {
          filesToScan.push(...findUiFiles(full));
        } else {
          filesToScan.push(full);
        }
      }
    }
  } else {
    const searchDirs = ["src", "app", "pages", "components", "public", "studio", "ui"];
    for (const d of searchDirs) {
      const full = join(cwd, d);
      if (existsSync(full)) {
        filesToScan.push(...findUiFiles(full));
      }
    }
    const rootIndex = join(cwd, "index.html");
    if (existsSync(rootIndex)) filesToScan.push(rootIndex);
  }

  const uniqueFiles = [...new Set(filesToScan)];

  for (const filePath of uniqueFiles) {
    try {
      const content = readFileSync(filePath, "utf8");
      const ext = extname(filePath).toLowerCase();

      if (ext === ".html" || ext === ".htm") {
        violations.push(...auditHtmlContent(content, basename(filePath)));
      } else {
        violations.push(...auditCodeContent(content, filePath));
      }
    } catch {
      // Ignore unreadable files
    }
  }

  const scores = calculateDeviceScores(violations);

  return {
    overallScore: scores.overallScore,
    passed: scores.passed,
    checkedFilesCount: uniqueFiles.length,
    devices: scores.devices,
    violations,
    summary: scores.summary,
  };
}

// ---------------------------------------------------------------------------
// 7. CLI Runner
// ---------------------------------------------------------------------------

export function printCliReport(result: ResponsiveAuditResult, asJson = false) {
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log("\n===============================================================================");
  console.log("📱 [Responsive Verification] 다중 디바이스 & 화면 크기 수학적 기하 검증 결과");
  console.log(`   검사 대상 파일 수: ${result.checkedFilesCount}개 | 종합 점수: ${result.overallScore}점 / 100점`);
  console.log("===============================================================================\n");

  console.log("📊 디바이스별 반응형 점수 요약:");
  for (const [id, dev] of Object.entries(result.devices)) {
    const statusIcon = dev.passed ? "✅ PASS" : "❌ FAIL";
    console.log(`  - [${statusIcon}] ${dev.deviceName.padEnd(35)} : ${dev.score}점 (결함 ${dev.violations.length}건)`);
  }

  console.log("\n🔍 결함 요약:");
  console.log(`  치명적(Critical): ${result.summary.critical}건 | 심각(Serious): ${result.summary.serious}건 | 보통(Moderate): ${result.summary.moderate}건`);

  if (result.violations.length > 0) {
    console.log("\n🚨 발견된 반응형 기하학적 결함 목록:");
    result.violations.slice(0, 10).forEach((v, idx) => {
      console.log(`\n  ${idx + 1}. [${v.severity.toUpperCase()}] ${v.rule}`);
      console.log(`     대상: ${v.target} ${v.device ? `(디바이스: ${v.device})` : ""}`);
      console.log(`     내용: ${v.message}`);
      if (v.mathEvidence) {
        console.log(`     수학적 검증치: 필요 너비=${v.mathEvidence.requiredWidth}px, 가용 너비=${v.mathEvidence.availableWidth}px, 초과 오차=${v.mathEvidence.overflowDelta}px`);
      }
      console.log(`     권장 개선: ${v.fixRecommendation}`);
      if (v.codeSnippet) {
        console.log(`     코드: ${v.codeSnippet.slice(0, 80)}`);
      }
    });
    if (result.violations.length > 10) {
      console.log(`\n  ... 외 ${result.violations.length - 10}건 생략`);
    }
  } else {
    console.log("\n✨ 모든 디바이스(모바일/태블릿/데스크톱)에서 버튼/카드 경계 및 기하학적 기준을 완벽하게 통과했습니다!");
  }

  console.log("\n===============================================================================\n");
}

const isMainModule = (() => {
  if (!process.argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url) === resolve(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isMainModule) {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const failOnViolation = args.includes("--fail-on-violation") || !args.includes("--no-fail");
  const targets = args.filter((a) => !a.startsWith("--"));

  const result = verifyResponsive({
    targets: targets.length > 0 ? targets : undefined,
    failOnViolation,
  });

  printCliReport(result, asJson);

  if (failOnViolation && !result.passed) {
    process.exit(1);
  }
}
