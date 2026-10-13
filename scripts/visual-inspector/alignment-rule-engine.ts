// scripts/visual-inspector/alignment-rule-engine.ts
// Mathematical rule engine for alignment offsets, spacing, touch targets, and collisions.

import type {
  BoundingBox,
  AlignmentGuide,
  AlignmentViolation,
  SpacingViolation,
  TouchTargetViolation,
  CollisionViolation,
  InspectionResult,
  InspectorOptions,
} from "./types.ts";
import { extractBounds } from "./bounds-extractor.ts";
import { detectAlignmentGuides } from "./grid-detector.ts";

/**
 * Checks if two bounding boxes have an overlapping vertical span.
 */
function hasVerticalOverlap(a: BoundingBox, b: BoundingBox): boolean {
  return Math.max(a.top, b.top) < Math.min(a.bottom, b.bottom);
}

/**
 * Checks if two bounding boxes have an overlapping horizontal span.
 */
function hasHorizontalOverlap(a: BoundingBox, b: BoundingBox): boolean {
  return Math.max(a.left, b.left) < Math.min(a.right, b.right);
}

/**
 * Detects alignment offsets between adjacent components and against alignment guides.
 */
export function detectAlignmentOffsets(
  elements: BoundingBox[],
  guides: AlignmentGuide[],
  tolerance = 2,
  proximityThreshold = 12
): AlignmentViolation[] {
  const violations: AlignmentViolation[] = [];
  const seenKeys = new Set<string>();

  // 1. Check against cluster alignment guides
  for (const el of elements) {
    for (const g of guides) {
      let actual = 0;
      if (g.edge === "left") actual = el.left;
      else if (g.edge === "center") actual = g.orientation === "vertical" ? el.centerX : el.centerY;
      else if (g.edge === "right") actual = el.right;
      else if (g.edge === "top") actual = el.top;
      else if (g.edge === "bottom") actual = el.bottom;

      const diff = Math.abs(actual - g.position);
      // If within proximity range but exceeds tolerance
      if (diff > tolerance && diff <= proximityThreshold) {
        const offset = Math.round(diff * 100) / 100;
        const key = `${el.id}-${g.edge}-${Math.round(g.position)}`;
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          violations.push({
            id: `align-${g.edge}-${el.id}-${violations.length + 1}`,
            elementId: el.id,
            edge: g.edge,
            expected: g.position,
            actual,
            offset,
            message: `요소 '${el.id}'의 ${g.edge} 위치(${actual}px)가 기준선(${g.position}px)에서 ${offset}px 어긋났습니다 (허용 오차: ${tolerance}px).`,
          });
        }
      }
    }
  }

  // 2. Check adjacent sibling pairs on horizontal row
  for (let i = 0; i < elements.length; i++) {
    for (let j = i + 1; j < elements.length; j++) {
      const a = elements[i]!;
      const b = elements[j]!;

      // Horizontally adjacent (within row)
      if (hasVerticalOverlap(a, b)) {
        // Top alignment check
        const topDiff = Math.abs(a.top - b.top);
        if (topDiff > tolerance && topDiff <= proximityThreshold) {
          const key = `pair-top-${a.id}-${b.id}`;
          if (!seenKeys.has(key)) {
            seenKeys.add(key);
            violations.push({
              id: `align-pair-top-${violations.length + 1}`,
              elementId: a.id,
              siblingId: b.id,
              edge: "top",
              expected: b.top,
              actual: a.top,
              offset: Math.round(topDiff * 100) / 100,
              message: `인접 요소 '${a.id}'(top: ${a.top}px)와 '${b.id}'(top: ${b.top}px) 간 상단 정렬 오차가 ${topDiff}px 발생했습니다.`,
            });
          }
        }

        // CenterY alignment check (for similar heights)
        if (Math.abs(a.height - b.height) <= 8) {
          const centerYDiff = Math.abs(a.centerY - b.centerY);
          if (centerYDiff > tolerance && centerYDiff <= proximityThreshold) {
            const key = `pair-center-${a.id}-${b.id}`;
            if (!seenKeys.has(key)) {
              seenKeys.add(key);
              violations.push({
                id: `align-pair-center-${violations.length + 1}`,
                elementId: a.id,
                siblingId: b.id,
                edge: "center",
                expected: b.centerY,
                actual: a.centerY,
                offset: Math.round(centerYDiff * 100) / 100,
                message: `인접 요소 '${a.id}'(centerY: ${a.centerY}px)와 '${b.id}'(centerY: ${b.centerY}px) 간 수평 중심축 오차가 ${centerYDiff}px 발생했습니다.`,
              });
            }
          }
        }
      }

      // Vertically adjacent (within column)
      if (hasHorizontalOverlap(a, b)) {
        // Left alignment check
        const leftDiff = Math.abs(a.left - b.left);
        if (leftDiff > tolerance && leftDiff <= proximityThreshold) {
          const key = `pair-left-${a.id}-${b.id}`;
          if (!seenKeys.has(key)) {
            seenKeys.add(key);
            violations.push({
              id: `align-pair-left-${violations.length + 1}`,
              elementId: a.id,
              siblingId: b.id,
              edge: "left",
              expected: b.left,
              actual: a.left,
              offset: Math.round(leftDiff * 100) / 100,
              message: `인접 요소 '${a.id}'(left: ${a.left}px)와 '${b.id}'(left: ${b.left}px) 간 좌측 정렬 오차가 ${leftDiff}px 발생했습니다.`,
            });
          }
        }
      }
    }
  }

  return violations;
}

/**
 * Checks if there is an intervening element between A and B horizontally.
 */
function hasInterveningHorizontal(a: BoundingBox, b: BoundingBox, all: BoundingBox[]): boolean {
  const minX = a.right;
  const maxX = b.left;
  for (const c of all) {
    if (c.id === a.id || c.id === b.id) continue;
    if (c.left >= minX && c.right <= maxX && hasVerticalOverlap(c, a)) {
      return true;
    }
  }
  return false;
}

/**
 * Checks if there is an intervening element between A and B vertically.
 */
function hasInterveningVertical(a: BoundingBox, b: BoundingBox, all: BoundingBox[]): boolean {
  const minY = a.bottom;
  const maxY = b.top;
  for (const c of all) {
    if (c.id === a.id || c.id === b.id) continue;
    if (c.top >= minY && c.bottom <= maxY && hasHorizontalOverlap(c, a)) {
      return true;
    }
  }
  return false;
}

/**
 * Detects 4pt / 8pt spacing violations between adjacent components.
 */
export function detectSpacingViolations(
  elements: BoundingBox[],
  gridBase: 4 | 8 = 4
): SpacingViolation[] {
  const violations: SpacingViolation[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < elements.length; i++) {
    for (let j = 0; j < elements.length; j++) {
      if (i === j) continue;
      const a = elements[i]!;
      const b = elements[j]!;

      // 1. Horizontal spacing: a is left of b
      if (hasVerticalOverlap(a, b) && a.right <= b.left) {
        const gap = Math.round((b.left - a.right) * 100) / 100;
        // Exclude far-away or non-adjacent elements
        if (gap >= 0 && gap <= 120 && !hasInterveningHorizontal(a, b, elements)) {
          // Exempt 0px (touching) and 1px (hairline)
          if (gap !== 0 && gap !== 1 && gap % gridBase !== 0) {
            const key = `h-${a.id}-${b.id}`;
            if (!seen.has(key)) {
              seen.add(key);
              const nearestLower = Math.floor(gap / gridBase) * gridBase;
              const nearestUpper = Math.ceil(gap / gridBase) * gridBase;
              violations.push({
                id: `spacing-h-${violations.length + 1}`,
                elementAId: a.id,
                elementBId: b.id,
                axis: "horizontal",
                distance: gap,
                gridBase,
                nearestLower,
                nearestUpper,
                message: `'${a.id}'와 '${b.id}' 사이의 수평 간격(${gap}px)이 ${gridBase}pt 배수 규칙에 어긋납니다. 권장: ${nearestLower}px 또는 ${nearestUpper}px`,
              });
            }
          }
        }
      }

      // 2. Vertical spacing: a is above b
      if (hasHorizontalOverlap(a, b) && a.bottom <= b.top) {
        const gap = Math.round((b.top - a.bottom) * 100) / 100;
        if (gap >= 0 && gap <= 120 && !hasInterveningVertical(a, b, elements)) {
          if (gap !== 0 && gap !== 1 && gap % gridBase !== 0) {
            const key = `v-${a.id}-${b.id}`;
            if (!seen.has(key)) {
              seen.add(key);
              const nearestLower = Math.floor(gap / gridBase) * gridBase;
              const nearestUpper = Math.ceil(gap / gridBase) * gridBase;
              violations.push({
                id: `spacing-v-${violations.length + 1}`,
                elementAId: a.id,
                elementBId: b.id,
                axis: "vertical",
                distance: gap,
                gridBase,
                nearestLower,
                nearestUpper,
                message: `'${a.id}'와 '${b.id}' 사이의 수직 간격(${gap}px)이 ${gridBase}pt 배수 규칙에 어긋납니다. 권장: ${nearestLower}px 또는 ${nearestUpper}px`,
              });
            }
          }
        }
      }
    }
  }

  return violations;
}

/**
 * Detects interactive touch targets under the minimum size (default: 44x44px).
 */
export function detectTouchTargetViolations(
  elements: BoundingBox[],
  minRequired = 44
): TouchTargetViolation[] {
  const violations: TouchTargetViolation[] = [];

  for (const el of elements) {
    if (!el.interactive) continue;

    if (el.width < minRequired || el.height < minRequired) {
      violations.push({
        id: `touch-${el.id}`,
        elementId: el.id,
        tag: el.tag,
        role: el.role,
        width: el.width,
        height: el.height,
        minRequired,
        message: `인터랙티브 요소 '${el.id}'의 크기(${el.width}×${el.height}px)가 최소 터치 타깃(${minRequired}×${minRequired}px)에 미달합니다.`,
      });
    }
  }

  return violations;
}

/**
 * Detects unintentional partial element collision or overlap.
 */
export function detectCollisionViolations(
  elements: BoundingBox[],
  ignoreSelfOrParentOverlap = true
): CollisionViolation[] {
  const violations: CollisionViolation[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < elements.length; i++) {
    for (let j = i + 1; j < elements.length; j++) {
      const a = elements[i]!;
      const b = elements[j]!;

      // Exclude explicit parent-child relationship
      if (ignoreSelfOrParentOverlap) {
        if (a.id === b.parentId || b.id === a.parentId) continue;
      }

      // Check full containment (container enclosing child is legitimate)
      const aContainsB = a.left <= b.left && a.top <= b.top && a.right >= b.right && a.bottom >= b.bottom;
      const bContainsA = b.left <= a.left && b.top <= a.top && b.right >= a.right && b.bottom >= a.bottom;
      if (aContainsB || bContainsA) continue;

      // Calculate intersection
      const overlapW = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const overlapH = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);

      // Overlap must be strictly positive on both dimensions
      if (overlapW > 0 && overlapH > 0) {
        const key = [a.id, b.id].sort().join("::");
        if (!seen.has(key)) {
          seen.add(key);
          const overlapArea = Math.round(overlapW * overlapH);
          violations.push({
            id: `collision-${a.id}-${b.id}`,
            elementAId: a.id,
            elementBId: b.id,
            overlapWidth: Math.round(overlapW * 100) / 100,
            overlapHeight: Math.round(overlapH * 100) / 100,
            overlapArea,
            message: `요소 '${a.id}'와 '${b.id}' 간에 비의도적 겹침(${overlapW}×${overlapH}px, 면적: ${overlapArea}px²)이 감지되었습니다.`,
          });
        }
      }
    }
  }

  return violations;
}

/**
 * Calculates overall alignment quality score (0 to 100).
 */
export function calculateAlignmentScore(
  collisionsCount: number,
  touchTargetsCount: number,
  alignmentsCount: number,
  spacingsCount: number,
  totalElements: number
): number {
  if (totalElements === 0) return 100;

  const penalty =
    collisionsCount * 15 +
    touchTargetsCount * 10 +
    alignmentsCount * 5 +
    spacingsCount * 3;

  const rawScore = 100 - penalty;
  return Math.max(0, Math.min(100, rawScore));
}

/**
 * Performs complete layout inspection on raw or normalized elements.
 */
export function inspectLayout(
  rawInput: unknown,
  options: InspectorOptions = {}
): InspectionResult {
  const tolerance = options.tolerance ?? 2;
  const gridBase = options.gridBase ?? 4;
  const minTouchTarget = options.minTouchTarget ?? 44;
  const maxErrors = options.maxErrors ?? 0;
  const ignoreSelfOrParentOverlap = options.ignoreSelfOrParentOverlap ?? true;

  const elements = extractBounds(rawInput, { filterHidden: true });
  let rawListLength = elements.length;
  if (Array.isArray(rawInput)) {
    rawListLength = rawInput.length;
  } else if (rawInput && typeof rawInput === "object") {
    const obj = rawInput as Record<string, unknown>;
    if (Array.isArray(obj["elements"])) rawListLength = obj["elements"].length;
    else if (Array.isArray(obj["boxes"])) rawListLength = obj["boxes"].length;
    else if (Array.isArray(obj["nodes"])) rawListLength = obj["nodes"].length;
  }

  const guides = detectAlignmentGuides(elements, { tolerance, minClusterCount: 1 });
  const alignmentViolations = detectAlignmentOffsets(elements, guides, tolerance);
  const spacingViolations = detectSpacingViolations(elements, gridBase);
  const touchTargetViolations = detectTouchTargetViolations(elements, minTouchTarget);
  const collisionViolations = detectCollisionViolations(elements, ignoreSelfOrParentOverlap);

  const totalViolations =
    alignmentViolations.length +
    spacingViolations.length +
    touchTargetViolations.length +
    collisionViolations.length;

  const score = calculateAlignmentScore(
    collisionViolations.length,
    touchTargetViolations.length,
    alignmentViolations.length,
    spacingViolations.length,
    elements.length
  );

  const passed = totalViolations <= maxErrors;

  return {
    summary: {
      totalElements: rawListLength,
      visibleElements: elements.length,
      filteredElements: Math.max(0, rawListLength - elements.length),
      score,
      alignmentViolationsCount: alignmentViolations.length,
      spacingViolationsCount: spacingViolations.length,
      touchTargetViolationsCount: touchTargetViolations.length,
      collisionViolationsCount: collisionViolations.length,
      totalViolations,
      passed,
    },
    guides,
    alignmentViolations,
    spacingViolations,
    touchTargetViolations,
    collisionViolations,
    elements,
    timestamp: new Date().toISOString(),
  };
}
