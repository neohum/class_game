// sketch-bridge.ts — Studio One-Click Skill Action Bar & Sketch Canvas Prompt Bridge
//
// Provides:
// 1. One-click Studio Skill Action Bar model (`DEFAULT_STUDIO_SKILL_BUTTONS`, `getStudioSkillButtons`, `buildSkillInvocationPayload`)
// 2. Sketch Canvas geometry normalization, parent-child layout hierarchy inference, SVG snapshot generation,
//    and structured prompt context serialization (`normalizeSketchShapes`, `inferLayoutHierarchy`, `exportSketchSvg`, `serializeSketchToPrompt`)
// 3. Self-contained interactive HTML Studio Sketch Canvas + Skill Action Bar viewer (`renderSketchStudioHtml`)

export type StudioSkillId =
  | "hallmark"
  | "quality-auditor"
  | "fast-gate"
  | "quick-evidence"
  | "prelaunch-persona-audit"
  | "plan-doc"
  | "tdd-loop"
  | "safe-refactor";

export type StudioAgentLane = "codex" | "claude" | "agy" | "gemini";

export interface StudioSkillButton {
  id: StudioSkillId;
  label: string;
  icon: string;
  shortcut: string;
  lane: StudioAgentLane;
  command: string;
  promptTemplate: string;
  description: string;
  category: "design" | "verification" | "planning" | "implementation";
}

export interface SkillInvocationContext {
  targetFile?: string;
  userGoal?: string;
  sketchSummary?: string;
  selectedComponent?: string;
}

export interface SkillInvocationPayload {
  skillId: StudioSkillId;
  label: string;
  icon: string;
  shortcut: string;
  lane: StudioAgentLane;
  command: string;
  prompt: string;
  context: SkillInvocationContext;
  timestamp: string;
}

export type SketchShapeKind =
  | "rect"
  | "circle"
  | "arrow"
  | "text"
  | "button"
  | "input"
  | "container";

export type InferredLayoutRole =
  | "header"
  | "sidebar"
  | "main-grid"
  | "card"
  | "footer"
  | "control-row"
  | "element";

export interface SketchShapeInput {
  id: string;
  kind: SketchShapeKind;
  x: number;
  y: number;
  width: number;
  height: number;
  label?: string;
  color?: string;
  toX?: number;
  toY?: number;
}

export interface NormalizedSketchShape {
  id: string;
  kind: SketchShapeKind;
  x: number;
  y: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
  centerX: number;
  centerY: number;
  area: number;
  normX: number;
  normY: number;
  normWidth: number;
  normHeight: number;
  label: string;
  color: string;
  toX?: number;
  toY?: number;
}

export interface SketchHierarchyNode {
  id: string;
  kind: SketchShapeKind;
  label: string;
  role: InferredLayoutRole;
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
    normX: number;
    normY: number;
    normWidth: number;
    normHeight: number;
  };
  parentId: string | null;
  childrenIds: string[];
  depth: number;
  gridHint: string;
}

export interface SketchLayoutHierarchy {
  canvasWidth: number;
  canvasHeight: number;
  nodes: SketchHierarchyNode[];
  rootIds: string[];
  detectedRegions: InferredLayoutRole[];
  gridSummary: string;
}

export interface SketchSceneInput {
  canvasWidth?: number;
  canvasHeight?: number;
  shapes: SketchShapeInput[];
  title?: string;
  pngDataUri?: string;
  svgDataUri?: string;
}

export interface SerializeSketchOptions {
  skillId?: StudioSkillId;
  userGoal?: string;
  targetFramework?: "html" | "react" | "nextjs";
  targetFile?: string;
  includeSvgSnapshot?: boolean;
}

export interface SerializedSketchPromptResult {
  prompt: string;
  skillInvocation: SkillInvocationPayload | null;
  hierarchy: SketchLayoutHierarchy;
  svgSnapshot: string;
  svgDataUri: string;
  pngDataUri: string | null;
  specJson: {
    title: string;
    targetFramework: "html" | "react" | "nextjs";
    canvas: { width: number; height: number };
    detectedRegions: InferredLayoutRole[];
    gridSummary: string;
    nodes: SketchHierarchyNode[];
  };
}

export class SketchValidationError extends Error {
  readonly code: string;
  constructor(message: string, code = "SKETCH_VALIDATION_ERROR") {
    super(message);
    this.name = "SketchValidationError";
    this.code = code;
  }
}

export const DEFAULT_STUDIO_SKILL_BUTTONS: readonly StudioSkillButton[] = Object.freeze([
  {
    id: "hallmark",
    label: "Hallmark 디자인",
    icon: "✦",
    shortcut: "Alt+1",
    lane: "codex",
    command: "/hallmark",
    promptTemplate:
      "Hallmark 안티-슬롭 디자인 스킬을 실행하여 스케치 레이아웃과 컴포넌트를 프로덕션급 UI로 구현하세요.",
    description: "그린필드 페이지·리디자인·안티-슬롭 UI 생성",
    category: "design",
  },
  {
    id: "quality-auditor",
    label: "품질·접근성 감사",
    icon: "🛡️",
    shortcut: "Alt+2",
    lane: "claude",
    command: "/quality-auditor",
    promptTemplate:
      "quality-auditor 스킬을 실행하여 WCAG/KWCAG 접근성, 한국어 타이포그래피, 정렬 불변식 및 성능을 감사하세요.",
    description: "웹/앱 품질, 접근성 및 대화형 HTML 보고서 생성",
    category: "verification",
  },
  {
    id: "fast-gate",
    label: "빠른 단위 검증",
    icon: "⚡",
    shortcut: "Alt+3",
    lane: "codex",
    command: "/fast-gate",
    promptTemplate:
      "fast-gate 스킬을 실행하여 변경된 파일에 매핑된 단위 테스트를 1초 내로 선별 실행하고 피드백을 보고하세요.",
    description: "변경 파일 매핑 단위 테스트 고속 실행",
    category: "verification",
  },
  {
    id: "quick-evidence",
    label: "증거 즉시 캡처",
    icon: "📸",
    shortcut: "Alt+4",
    lane: "codex",
    command: "/quick-evidence",
    promptTemplate:
      "quick-evidence 스킬을 실행하여 테스트 산출물과 4대 필수 섹션 증거 문서를 1회 실행으로 캡처하세요.",
    description: "테스트 실행 및 4절 증거 문서 원클릭 완결",
    category: "verification",
  },
  {
    id: "prelaunch-persona-audit",
    label: "출시 전 페르소나 감사",
    icon: "🧭",
    shortcut: "Alt+5",
    lane: "claude",
    command: "/prelaunch-persona-audit",
    promptTemplate:
      "출시 전 페르소나 감사(prelaunch-persona-audit)를 실행하여 사용자 여정과 UI/UX 완성도를 독립 검증하세요.",
    description: "독립 신뢰 도메인 기반 출시 전 페르소나 대조 감사",
    category: "verification",
  },
  {
    id: "plan-doc",
    label: "계획서 컴파일",
    icon: "📋",
    shortcut: "Alt+6",
    lane: "codex",
    command: "/plan-doc",
    promptTemplate:
      "plan-doc 스킬을 실행하여 스케치 요구사항을 구조화된 계획서(plans/<slug>.plan.md)와 병렬 실행 웨이브로 컴파일하세요.",
    description: "기능 계획서 작성·검증 및 HTML 뷰어 생성",
    category: "planning",
  },
  {
    id: "tdd-loop",
    label: "TDD 루프 구현",
    icon: "🔄",
    shortcut: "Alt+7",
    lane: "codex",
    command: "/tdd-loop",
    promptTemplate:
      "tdd-loop 스킬을 실행하여 Red-Green-Refactor 루프로 스케치 컴포넌트의 테스트를 먼저 작성하고 구현하세요.",
    description: "엄격한 Red-Green-Refactor 테스트 주도 개발",
    category: "implementation",
  },
  {
    id: "safe-refactor",
    label: "안전 리팩터링",
    icon: "🧱",
    shortcut: "Alt+8",
    lane: "codex",
    command: "/safe-refactor",
    promptTemplate:
      "safe-refactor 스킬을 실행하여 동작 변경 없이 작은 검증 단계로 컴포넌트 구조를 정리하세요.",
    description: "동작 보존 및 단계별 검증 기반 구조 개선",
    category: "implementation",
  },
]);

const VALID_SHAPE_KINDS = new Set<SketchShapeKind>([
  "rect",
  "circle",
  "arrow",
  "text",
  "button",
  "input",
  "container",
]);

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function escapeXml(raw: string): string {
  return String(raw)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * 스튜디오 액션 바에 표시할 원클릭 스킬 버튼 목록을 반환합니다.
 */
export function getStudioSkillButtons(category?: StudioSkillButton["category"]): StudioSkillButton[] {
  const list = DEFAULT_STUDIO_SKILL_BUTTONS.map((btn) => ({ ...btn }));
  if (!category) return list;
  return list.filter((btn) => btn.category === category);
}

/**
 * 원클릭 스킬 버튼 클릭 시 에이전트에게 전달할 실행 페이로드를 생성합니다.
 * 등록되지 않은 스킬 ID는 Fail-closed로 예외를 발생시킵니다.
 */
export function buildSkillInvocationPayload(
  skillId: string,
  context: SkillInvocationContext = {},
): SkillInvocationPayload {
  const trimmedId = String(skillId ?? "").trim();
  const button = DEFAULT_STUDIO_SKILL_BUTTONS.find((b) => b.id === trimmedId);
  if (!button) {
    throw new SketchValidationError(
      `Unknown studio skill button ID: "${trimmedId}". Allowed IDs: ${DEFAULT_STUDIO_SKILL_BUTTONS.map((b) => b.id).join(", ")}`,
      "UNKNOWN_SKILL_ID",
    );
  }

  const contextParts: string[] = [button.promptTemplate];
  if (context.targetFile) {
    contextParts.push(`대상 파일: \`${context.targetFile}\``);
  }
  if (context.selectedComponent) {
    contextParts.push(`선택 컴포넌트: \`${context.selectedComponent}\``);
  }
  if (context.userGoal) {
    contextParts.push(`사용자 목표: ${context.userGoal}`);
  }
  if (context.sketchSummary) {
    contextParts.push(`스케치 요약: ${context.sketchSummary}`);
  }

  return {
    skillId: button.id,
    label: button.label,
    icon: button.icon,
    shortcut: button.shortcut,
    lane: button.lane,
    command: button.command,
    prompt: contextParts.join("\n"),
    context: { ...context },
    timestamp: new Date().toISOString(),
  };
}

/**
 * 스케치 캔버스의 도형 배열과 캔버스 크기를 검증하고 정규화된 바운딩박스 메타데이터를 계산합니다.
 * 비어 있거나 음수/NaN/무한대 좌표가 포함된 경우 Fail-closed로 `SketchValidationError`를 던집니다.
 */
export function normalizeSketchShapes(
  shapes: SketchShapeInput[],
  canvasWidth = 1280,
  canvasHeight = 800,
): NormalizedSketchShape[] {
  if (!Number.isFinite(canvasWidth) || canvasWidth <= 0 || !Number.isFinite(canvasHeight) || canvasHeight <= 0) {
    throw new SketchValidationError(
      `Invalid canvas dimensions: width=${canvasWidth}, height=${canvasHeight}. Must be finite positive numbers.`,
      "INVALID_CANVAS_DIMENSIONS",
    );
  }

  if (!Array.isArray(shapes) || shapes.length === 0) {
    throw new SketchValidationError(
      "Sketch shapes array must be a non-empty array.",
      "EMPTY_SKETCH_SHAPES",
    );
  }

  const seenIds = new Set<string>();

  return shapes.map((shape, idx) => {
    if (!shape || typeof shape !== "object") {
      throw new SketchValidationError(`Shape at index ${idx} must be an object.`, "INVALID_SHAPE_OBJECT");
    }

    const id = String(shape.id ?? "").trim();
    if (!id) {
      throw new SketchValidationError(`Shape at index ${idx} is missing a valid non-empty id.`, "MISSING_SHAPE_ID");
    }
    if (seenIds.has(id)) {
      throw new SketchValidationError(`Duplicate shape id detected: "${id}".`, "DUPLICATE_SHAPE_ID");
    }
    seenIds.add(id);

    if (!VALID_SHAPE_KINDS.has(shape.kind)) {
      throw new SketchValidationError(
        `Shape "${id}" has unsupported kind "${String(shape.kind)}".`,
        "INVALID_SHAPE_KIND",
      );
    }

    const { x, y, width, height } = shape;
    if (
      typeof x !== "number" ||
      typeof y !== "number" ||
      typeof width !== "number" ||
      typeof height !== "number" ||
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      !Number.isFinite(width) ||
      !Number.isFinite(height)
    ) {
      throw new SketchValidationError(
        `Shape "${id}" has non-finite coordinates (x=${x}, y=${y}, width=${width}, height=${height}).`,
        "NON_FINITE_COORDINATES",
      );
    }

    if (x < 0 || y < 0 || width <= 0 || height <= 0) {
      throw new SketchValidationError(
        `Shape "${id}" must have non-negative x/y and positive width/height (got x=${x}, y=${y}, width=${width}, height=${height}).`,
        "NEGATIVE_OR_ZERO_BOUNDS",
      );
    }

    const right = round2(x + width);
    const bottom = round2(y + height);
    const centerX = round2(x + width / 2);
    const centerY = round2(y + height / 2);
    const area = round2(width * height);

    const normX = round4(Math.min(1, Math.max(0, x / canvasWidth)));
    const normY = round4(Math.min(1, Math.max(0, y / canvasHeight)));
    const normWidth = round4(Math.min(1, Math.max(0, width / canvasWidth)));
    const normHeight = round4(Math.min(1, Math.max(0, height / canvasHeight)));

    const defaultLabels: Record<SketchShapeKind, string> = {
      container: "컨테이너 영역",
      rect: "사각형 블록",
      circle: "원형 요소",
      arrow: "흐름 화살표",
      text: "텍스트 라벨",
      button: "액션 버튼",
      input: "입력 필드",
    };

    return {
      id,
      kind: shape.kind,
      x: round2(x),
      y: round2(y),
      width: round2(width),
      height: round2(height),
      right,
      bottom,
      centerX,
      centerY,
      area,
      normX,
      normY,
      normWidth,
      normHeight,
      label: String(shape.label ?? defaultLabels[shape.kind]).trim() || defaultLabels[shape.kind],
      color: String(shape.color ?? "#58a6ff").trim() || "#58a6ff",
      ...(typeof shape.toX === "number" && Number.isFinite(shape.toX) ? { toX: round2(shape.toX) } : {}),
      ...(typeof shape.toY === "number" && Number.isFinite(shape.toY) ? { toY: round2(shape.toY) } : {}),
    };
  });
}

function containsBounds(parent: NormalizedSketchShape, child: NormalizedSketchShape): boolean {
  if (parent.id === child.id) return false;
  // Containers and rects can act as parent regions
  if (parent.kind !== "container" && parent.kind !== "rect") return false;
  if (parent.area <= child.area) return false;
  const tolerance = 2;
  return (
    child.x >= parent.x - tolerance &&
    child.y >= parent.y - tolerance &&
    child.right <= parent.right + tolerance &&
    child.bottom <= parent.bottom + tolerance
  );
}

function inferRole(
  shape: NormalizedSketchShape,
  parent: NormalizedSketchShape | null,
  childrenCount: number,
): InferredLayoutRole {
  if (shape.kind === "button" || shape.kind === "input" || shape.kind === "text" || shape.kind === "arrow" || shape.kind === "circle") {
    return "element";
  }

  const labelLower = shape.label.toLowerCase();
  if (/control|툴바|액션|버튼바|toolbar/i.test(labelLower)) return "control-row";
  if (/header|헤더|상단|네비|nav|gnb/i.test(labelLower)) return "header";
  if (/sidebar|사이드바|좌측|메뉴|lnb|aside/i.test(labelLower)) return "sidebar";
  if (/footer|푸터|하단/i.test(labelLower)) return "footer";
  if (/card|카드|패널|아이템/i.test(labelLower)) return "card";
  if (/main|메인|그리드|대시보드|콘텐츠|캔버스/i.test(labelLower)) return "main-grid";

  // Geometry heuristics when at root or shallow level
  if (!parent) {
    if (shape.normY <= 0.16 && shape.normWidth >= 0.5 && shape.normHeight <= 0.2) {
      return "header";
    }
    if (shape.normY >= 0.8 && shape.normWidth >= 0.5 && shape.normHeight <= 0.22) {
      return "footer";
    }
    if (shape.normX <= 0.08 && shape.normWidth <= 0.32 && shape.normHeight >= 0.45) {
      return "sidebar";
    }
    if (shape.normWidth >= 0.45 && shape.normHeight >= 0.4) {
      return "main-grid";
    }
    if (shape.normHeight <= 0.14 && shape.normWidth >= 0.35) {
      return "control-row";
    }
  }

  if (parent) {
    if (childrenCount > 0 && shape.normHeight <= 0.15 && shape.normWidth >= 0.4) {
      return "control-row";
    }
    return "card";
  }

  return childrenCount > 0 ? "main-grid" : "card";
}

function computeGridHint(shape: NormalizedSketchShape, children: NormalizedSketchShape[]): string {
  if (children.length === 0) {
    if (shape.kind === "button") {
      return "inline-flex items-center justify-center min-h-[44px] px-4 whitespace-nowrap";
    }
    if (shape.kind === "input") {
      return "flex items-center min-h-[44px] px-3 w-full";
    }
    return "block";
  }

  if (children.length === 1) {
    return "flex flex-col gap-3";
  }

  // Check if children are arranged mostly horizontally (same row) vs vertically vs 2D grid
  const yCenters = children.map((c) => c.centerY);
  const maxY = Math.max(...yCenters);
  const minY = Math.min(...yCenters);
  const avgHeight = children.reduce((acc, c) => acc + c.height, 0) / children.length;

  if (maxY - minY <= avgHeight * 0.6) {
    return `flex flex-row items-center gap-3 (horizontal row, ${children.length} items)`;
  }

  const xCenters = children.map((c) => c.centerX);
  const maxX = Math.max(...xCenters);
  const minX = Math.min(...xCenters);
  const avgWidth = children.reduce((acc, c) => acc + c.width, 0) / children.length;

  if (maxX - minX <= avgWidth * 0.6) {
    return `flex flex-col gap-3 (vertical stack, ${children.length} items)`;
  }

  // Estimate column count by clustering X coordinates
  const sortedX = [...xCenters].sort((a, b) => a - b);
  let cols = 1;
  for (let i = 1; i < sortedX.length; i++) {
    if (sortedX[i]! - sortedX[i - 1]! > avgWidth * 0.5) {
      cols++;
    }
  }
  return `grid grid-cols-${Math.min(cols, 12)} gap-4 (${children.length} items)`;
}

/**
 * 정규화된 도형 배열로부터 부모-자식 포함 관계, 레이아웃 역할(`header`, `sidebar`, `main-grid`, `card`, `footer`, `control-row`)
 * 및 CSS Flex/Grid 정렬 힌트를 추론합니다.
 */
export function inferLayoutHierarchy(
  shapes: SketchShapeInput[],
  canvasWidth = 1280,
  canvasHeight = 800,
): SketchLayoutHierarchy {
  const normalized = normalizeSketchShapes(shapes, canvasWidth, canvasHeight);

  // Find smallest containing parent for each shape
  const parentMap = new Map<string, NormalizedSketchShape | null>();
  const childrenMap = new Map<string, NormalizedSketchShape[]>();

  for (const s of normalized) {
    childrenMap.set(s.id, []);
  }

  for (const child of normalized) {
    const candidates = normalized.filter((candidate) => containsBounds(candidate, child));
    if (candidates.length === 0) {
      parentMap.set(child.id, null);
    } else {
      // Direct parent is the smallest area container that encloses child
      candidates.sort((a, b) => a.area - b.area);
      const directParent = candidates[0]!;
      parentMap.set(child.id, directParent);
      childrenMap.get(directParent.id)!.push(child);
    }
  }

  const depthOf = (id: string): number => {
    let d = 0;
    let curr = parentMap.get(id) ?? null;
    while (curr) {
      d++;
      curr = parentMap.get(curr.id) ?? null;
    }
    return d;
  };

  const nodes: SketchHierarchyNode[] = normalized.map((s) => {
    const parent = parentMap.get(s.id) ?? null;
    const children = childrenMap.get(s.id) ?? [];
    const role = inferRole(s, parent, children.length);
    const gridHint = computeGridHint(s, children);

    return {
      id: s.id,
      kind: s.kind,
      label: s.label,
      role,
      bounds: {
        x: s.x,
        y: s.y,
        width: s.width,
        height: s.height,
        normX: s.normX,
        normY: s.normY,
        normWidth: s.normWidth,
        normHeight: s.normHeight,
      },
      parentId: parent ? parent.id : null,
      childrenIds: children.map((c) => c.id),
      depth: depthOf(s.id),
      gridHint,
    };
  });

  const rootIds = nodes.filter((n) => n.parentId === null).map((n) => n.id);
  const regionOrder: InferredLayoutRole[] = [
    "header",
    "control-row",
    "sidebar",
    "main-grid",
    "card",
    "footer",
  ];
  const detectedSet = new Set<InferredLayoutRole>();
  for (const n of nodes) {
    if (n.role !== "element") {
      detectedSet.add(n.role);
    }
  }
  const detectedRegions = regionOrder.filter((r) => detectedSet.has(r));

  const hasSidebar = detectedRegions.includes("sidebar");
  const hasHeader = detectedRegions.includes("header");
  const hasMain = detectedRegions.includes("main-grid");
  const hasFooter = detectedRegions.includes("footer");

  const gridSummaryParts: string[] = [];
  if (hasHeader) gridSummaryParts.push("상단 고정 헤더(Header)");
  if (hasSidebar && hasMain) {
    gridSummaryParts.push("좌측 사이드바(Sidebar) + 우측 메인 그리드(Main Grid) 2단 레이아웃");
  } else if (hasMain) {
    gridSummaryParts.push("단일 메인 콘텐츠 그리드(Main Grid)");
  }
  if (hasFooter) gridSummaryParts.push("하단 푸터(Footer)");
  if (gridSummaryParts.length === 0) {
    gridSummaryParts.push(`자유 배치 컴포넌트 레이아웃 (${nodes.length}개 요소)`);
  }

  return {
    canvasWidth,
    canvasHeight,
    nodes,
    rootIds,
    detectedRegions,
    gridSummary: gridSummaryParts.join(" ➔ "),
  };
}

/**
 * 스케치 도형 입력을 독립 실행 가능한 SVG 마크업 문자열로 내보냅니다.
 */
export function exportSketchSvg(
  scene: SketchSceneInput,
): string {
  const width = scene.canvasWidth ?? 1280;
  const height = scene.canvasHeight ?? 800;
  const normalized = normalizeSketchShapes(scene.shapes, width, height);

  const elements = normalized.map((s) => {
    const label = escapeXml(s.label);
    const stroke = escapeXml(s.color);
    if (s.kind === "circle") {
      const rx = round2(s.width / 2);
      const ry = round2(s.height / 2);
      return `  <g data-id="${escapeXml(s.id)}" data-kind="circle">
    <ellipse cx="${s.centerX}" cy="${s.centerY}" rx="${rx}" ry="${ry}" fill="rgba(88,166,255,0.12)" stroke="${stroke}" stroke-width="2" />
    <text x="${s.centerX}" y="${s.centerY + 4}" text-anchor="middle" fill="#f0f6fc" font-family="sans-serif" font-size="13">${label}</text>
  </g>`;
    }

    if (s.kind === "arrow") {
      const x2 = s.toX ?? s.right;
      const y2 = s.toY ?? s.bottom;
      return `  <g data-id="${escapeXml(s.id)}" data-kind="arrow">
    <line x1="${s.x}" y1="${s.y}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="2.5" marker-end="url(#arrow-head)" />
    <text x="${round2((s.x + x2) / 2)}" y="${round2((s.y + y2) / 2 - 6)}" text-anchor="middle" fill="#8b949e" font-family="sans-serif" font-size="12">${label}</text>
  </g>`;
    }

    const dash = s.kind === "container" ? ` stroke-dasharray="6 4"` : "";
    const fill =
      s.kind === "button"
        ? "rgba(46,164,79,0.25)"
        : s.kind === "input"
          ? "rgba(255,255,255,0.06)"
          : s.kind === "container"
            ? "rgba(88,166,255,0.05)"
            : "rgba(22,27,34,0.75)";
    const rx = s.kind === "button" ? 8 : s.kind === "container" ? 10 : 6;
    const textY = s.kind === "container" ? s.y + 20 : s.centerY + 4;
    const textAnchor = s.kind === "container" ? "start" : "middle";
    const textX = s.kind === "container" ? s.x + 12 : s.centerX;

    return `  <g data-id="${escapeXml(s.id)}" data-kind="${escapeXml(s.kind)}">
    <rect x="${s.x}" y="${s.y}" width="${s.width}" height="${s.height}" rx="${rx}" fill="${fill}" stroke="${stroke}" stroke-width="2"${dash} />
    <text x="${textX}" y="${textY}" text-anchor="${textAnchor}" fill="#f0f6fc" font-family="sans-serif" font-size="13">${label}</text>
  </g>`;
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" data-studio-sketch="true">
  <defs>
    <marker id="arrow-head" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="#58a6ff" />
    </marker>
  </defs>
  <rect width="${width}" height="${height}" fill="#0d1117" />
${elements.join("\n")}
</svg>`;
}

/**
 * 스케치 캔버스 장면을 에이전트가 즉시 코드로 구현할 수 있는 구조화된 프롬프트 컨텍스트(Markdown + JSON + 스냅샷 URI)로 직렬화합니다.
 */
export function serializeSketchToPrompt(
  scene: SketchSceneInput,
  options: SerializeSketchOptions = {},
): SerializedSketchPromptResult {
  const width = scene.canvasWidth ?? 1280;
  const height = scene.canvasHeight ?? 800;
  const title = String(scene.title ?? "Studio Sketch UI Wireframe").trim() || "Studio Sketch UI Wireframe";
  const targetFramework = options.targetFramework ?? "html";

  const hierarchy = inferLayoutHierarchy(scene.shapes, width, height);
  const svgSnapshot = exportSketchSvg(scene);
  const svgDataUri =
    scene.svgDataUri ??
    `data:image/svg+xml;base64,${Buffer.from(svgSnapshot, "utf8").toString("base64")}`;
  const pngDataUri = scene.pngDataUri ?? null;

  const skillInvocation = options.skillId
    ? buildSkillInvocationPayload(options.skillId, {
        targetFile: options.targetFile,
        userGoal: options.userGoal,
        sketchSummary: `${title} (${hierarchy.nodes.length}개 요소, ${hierarchy.gridSummary})`,
      })
    : null;

  const specJson = {
    title,
    targetFramework,
    canvas: { width, height },
    detectedRegions: hierarchy.detectedRegions,
    gridSummary: hierarchy.gridSummary,
    nodes: hierarchy.nodes,
  };

  const lines: string[] = [];
  lines.push(`# [Studio Sketch Bridge] ${title}`);
  lines.push("");

  if (skillInvocation) {
    lines.push(`## 원클릭 스킬 실행 요청 (${skillInvocation.icon} ${skillInvocation.label})`);
    lines.push(`- **실행 커맨드**: \`${skillInvocation.command}\` (대상 레인: \`${skillInvocation.lane}\`, 단축키: \`${skillInvocation.shortcut}\`)`);
    lines.push(`- **스킬 지시문**: ${skillInvocation.prompt}`);
    lines.push("");
  }

  if (options.userGoal) {
    lines.push(`## 사용자 목표`);
    lines.push(options.userGoal);
    lines.push("");
  }

  lines.push(`## 레이아웃 계층 및 그리드 추론 요약`);
  lines.push(`- **캔버스 해상도**: \`${width}x${height}\``);
  lines.push(`- **감지된 영역(Regions)**: ${hierarchy.detectedRegions.length ? hierarchy.detectedRegions.map((r) => `\`${r}\``).join(", ") : "`none`"}`);
  lines.push(`- **구조 요약**: ${hierarchy.gridSummary}`);
  lines.push(`- **타겟 프레임워크**: \`${targetFramework}\`${options.targetFile ? ` (\`${options.targetFile}\`)` : ""}`);
  lines.push("");

  lines.push(`## 도형 요소 및 바운딩박스 명세 (${hierarchy.nodes.length}개)`);
  for (const node of hierarchy.nodes) {
    const parentInfo = node.parentId ? `parent=\`${node.parentId}\`` : `root`;
    lines.push(
      `- **[${node.id}]** \`${node.kind}\` (role: \`${node.role}\`, ${parentInfo}) — "${node.label}" | bounds: \`x=${node.bounds.x}, y=${node.bounds.y}, w=${node.bounds.width}, h=${node.bounds.height}\` | hint: \`${node.gridHint}\``,
    );
  }
  lines.push("");

  lines.push(`## 하네스 UI 필수 준수 규칙`);
  lines.push(`1. **사이드바 좌측 정렬**: 사이드바 메뉴·트리·네비게이션 아이템은 반드시 좌측 정렬(\`text-align: left\`, \`justify-content: flex-start\`)을 유지하세요.`);
  lines.push(`2. **버튼 및 배지 완벽 중앙 정렬**: 모든 버튼·칩·배지는 \`inline-flex\`, \`align-items: center\`, \`justify-content: center\`, \`white-space: nowrap\`을 적용하고 최소 터치 타겟 \`min-height: 44px\`를 보장하세요.`);
  lines.push(`3. **인접 컨트롤 수평 정렬**: 나란히 배치되는 버튼·입력창은 \`margin: 0\`으로 마진 박스 편향을 차단하고 수평 중심축을 일치시키세요.`);
  lines.push(`4. **한국어 타이포그래피**: \`word-break: keep-all\`을 적용하고 비대칭 손톱 테두리(Anti-Fingernail)를 금지하세요.`);
  lines.push("");

  lines.push(`## 구조화된 스케치 JSON 스펙`);
  lines.push("```json");
  lines.push(JSON.stringify(specJson, null, 2));
  lines.push("```");
  lines.push("");

  lines.push(`## 스냅샷 참조 (Snapshot Data URIs)`);
  lines.push(`- **SVG Data URI**: \`${svgDataUri.slice(0, 96)}...\``);
  if (pngDataUri) {
    lines.push(`- **PNG Data URI**: \`${pngDataUri.slice(0, 96)}...\``);
  }
  if (options.includeSvgSnapshot !== false) {
    lines.push("");
    lines.push("```svg");
    lines.push(svgSnapshot);
    lines.push("```");
  }

  return {
    prompt: lines.join("\n"),
    skillInvocation,
    hierarchy,
    svgSnapshot,
    svgDataUri,
    pngDataUri,
    specJson,
  };
}

/**
 * 브라우저 및 스튜디오 웹뷰에서 즉시 열람·조작 가능한 자립형(Self-contained)
 * 스케치 그림판 + 원클릭 스킬 액션 바 통합 HTML UI를 생성합니다.
 */
export function renderSketchStudioHtml(initialScene?: SketchSceneInput): string {
  const defaultScene: SketchSceneInput = initialScene ?? {
    canvasWidth: 1280,
    canvasHeight: 800,
    title: "Harness Studio — 스킬 액션 바 & 스케치 캔버스 브리지",
    shapes: [
      { id: "region-header", kind: "container", x: 24, y: 20, width: 1232, height: 72, label: "상단 헤더 네비게이션 (Header)" },
      { id: "region-sidebar", kind: "container", x: 24, y: 112, width: 260, height: 640, label: "좌측 사이드바 메뉴 (Sidebar)" },
      { id: "region-main", kind: "container", x: 304, y: 112, width: 952, height: 640, label: "메인 대시보드 그리드 (Main Grid)" },
      { id: "card-metric-1", kind: "rect", x: 328, y: 148, width: 440, height: 220, label: "실시간 에이전트 상태 카드" },
      { id: "card-metric-2", kind: "rect", x: 784, y: 148, width: 440, height: 220, label: "품질 게이트 검증 카드" },
      { id: "btn-primary", kind: "button", x: 1080, y: 34, width: 152, height: 44, label: "원클릭 배포 검증" },
      { id: "input-search", kind: "input", x: 328, y: 396, width: 620, height: 44, label: "컴포넌트 검색 또는 프롬프트 입력..." },
    ],
  };

  const buttons = getStudioSkillButtons();
  const serialized = serializeSketchToPrompt(defaultScene, {
    skillId: "hallmark",
    targetFramework: "react",
  });

  const skillButtonsHtml = buttons
    .map(
      (btn) => `
      <button
        type="button"
        class="skill-action-btn"
        data-skill-id="${escapeXml(btn.id)}"
        data-skill-command="${escapeXml(btn.command)}"
        data-skill-lane="${escapeXml(btn.lane)}"
        title="${escapeXml(btn.description)} (${escapeXml(btn.shortcut)})"
      >
        <i class="icon-box">${escapeXml(btn.icon)}</i>
        <span>${escapeXml(btn.label)}</span>
        <span class="badge skill-shortcut-badge">${escapeXml(btn.shortcut)}</span>
      </button>`,
    )
    .join("\n");

  const initialShapesJson = JSON.stringify(defaultScene.shapes);
  const skillButtonsJson = JSON.stringify(buttons);

  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeXml(defaultScene.title ?? "Harness Studio Sketch Bridge")}</title>
  <style>
    :root {
      --bg: #0d1117;
      --panel-bg: #161b22;
      --border: #30363d;
      --text: #c9d1d9;
      --text-muted: #8b949e;
      --heading: #f0f6fc;
      --accent: #58a6ff;
      --green: #2ea44f;
      --amber: #d29922;
      --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
      --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans KR", sans-serif;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: var(--sans);
      font-size: 14px;
      line-height: 1.5;
      word-break: keep-all;
      overflow-wrap: break-word;
    }
    h1, h2, h3 {
      text-wrap: balance;
      color: var(--heading);
    }
    p {
      text-wrap: pretty;
    }
    .studio-shell {
      display: grid;
      grid-template-columns: 280px 1fr 380px;
      min-height: 100vh;
    }
    /* Sidebar invariant: strict left alignment */
    aside.studio-sidebar {
      background: var(--panel-bg);
      border-right: 1px solid var(--border);
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 16px;
      text-align: left;
      align-items: stretch;
    }
    .sidebar-section-title {
      font-size: 12px;
      font-weight: 700;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      text-align: left;
    }
    .tool-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
      text-align: left;
    }
    .sidebar-tool-item {
      display: flex;
      align-items: center;
      justify-content: flex-start;
      text-align: left;
      gap: 10px;
      min-height: 44px;
      padding: 8px 12px;
      margin: 0;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: rgba(255, 255, 255, 0.03);
      color: var(--text);
      cursor: pointer;
      white-space: nowrap;
    }
    .sidebar-tool-item.active {
      border-color: var(--accent);
      background: rgba(88, 166, 255, 0.14);
      color: var(--heading);
    }
    /* Button, Chip & Badge Perfect Centering + 44px touch target */
    button, .btn, .skill-action-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 44px;
      padding: 8px 14px;
      margin: 0;
      gap: 8px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: var(--panel-bg);
      color: var(--heading);
      font-family: var(--sans);
      font-size: 13px;
      font-weight: 600;
      line-height: 1;
      white-space: nowrap;
      cursor: pointer;
    }
    button:hover, .skill-action-btn:hover {
      border-color: var(--accent);
      background: rgba(88, 166, 255, 0.12);
    }
    i.icon-box {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      line-height: 1;
      font-style: normal;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 3px 8px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 600;
      line-height: 1;
      white-space: nowrap;
      border: 1px solid var(--border);
      background: rgba(255, 255, 255, 0.06);
      color: var(--text-muted);
    }
    /* Adjacent controls horizontal alignment */
    .skill-action-bar, .canvas-toolbar {
      display: flex;
      flex-direction: row;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      padding: 12px 16px;
      background: var(--panel-bg);
      border-bottom: 1px solid var(--border);
    }
    .main-workspace {
      display: flex;
      flex-direction: column;
      min-width: 0;
    }
    .canvas-stage {
      flex: 1;
      padding: 20px;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: auto;
    }
    .canvas-Stage-inner {
      border: 1px solid var(--border);
      border-radius: 12px;
      overflow: hidden;
      background: #090d13;
    }
    aside.inspector-panel {
      background: var(--panel-bg);
      border-left: 1px solid var(--border);
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 14px;
      text-align: left;
    }
    textarea.prompt-output {
      width: 100%;
      min-height: 360px;
      background: #090d13;
      color: var(--heading);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px;
      font-family: var(--mono);
      font-size: 12px;
      line-height: 1.5;
      resize: vertical;
    }
    @media (max-width: 1024px) {
      .studio-shell {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <div class="studio-shell">
    <aside class="studio-sidebar" aria-label="스케치 도형 도구 모음">
      <h2 class="sidebar-section-title">스케치 그림판 도구 (Tools)</h2>
      <div class="tool-list" role="toolbar" aria-label="도형 선택">
        <button type="button" class="sidebar-tool-item active" data-tool="container"><i class="icon-box">▣</i><span>컨테이너 영역 (Container)</span></button>
        <button type="button" class="sidebar-tool-item" data-tool="rect"><i class="icon-box">▢</i><span>사각형 카드 (Rect)</span></button>
        <button type="button" class="sidebar-tool-item" data-tool="button"><i class="icon-box">🔘</i><span>액션 버튼 (Button)</span></button>
        <button type="button" class="sidebar-tool-item" data-tool="input"><i class="icon-box">⌨</i><span>입력 필드 (Input)</span></button>
        <button type="button" class="sidebar-tool-item" data-tool="text"><i class="icon-box">T</i><span>텍스트 라벨 (Text)</span></button>
        <button type="button" class="sidebar-tool-item" data-tool="circle"><i class="icon-box">◯</i><span>원형 요소 (Circle)</span></button>
        <button type="button" class="sidebar-tool-item" data-tool="arrow"><i class="icon-box">➔</i><span>흐름 화살표 (Arrow)</span></button>
      </div>

      <h2 class="sidebar-section-title">캔버스 편집 액션</h2>
      <div class="tool-list">
        <button type="button" id="btn-undo"><i class="icon-box">↶</i><span>실행 취소 (Undo)</span></button>
        <button type="button" id="btn-redo"><i class="icon-box">↷</i><span>다시 실행 (Redo)</span></button>
        <button type="button" id="btn-clear"><i class="icon-box">🗑</i><span>캔버스 초기화 (Clear)</span></button>
      </div>
    </aside>

    <main class="main-workspace">
      <header class="skill-action-bar" role="toolbar" aria-label="원클릭 에이전트 스킬 실행 바">
        ${skillButtonsHtml}
      </header>

      <div class="canvas-toolbar">
        <button type="button" id="btn-export-svg"><i class="icon-box">🖼</i><span>SVG 스냅샷 내보내기</span></button>
        <button type="button" id="btn-export-png"><i class="icon-box">📷</i><span>PNG 스냅샷 생성</span></button>
        <button type="button" id="btn-copy-prompt"><i class="icon-box">📋</i><span>에이전트 프롬프트 복사</span></button>
        <span class="badge" id="active-skill-indicator">활성 스킬: Hallmark 디자인 (/hallmark)</span>
      </div>

      <div class="canvas-stage">
        <div class="canvas-Stage-inner" id="sketch-svg-Host">
          ${serialized.svgSnapshot}
        </div>
      </div>
    </main>

    <aside class="inspector-panel" aria-label="프롬프트 브리지 인스펙터">
      <h2 class="sidebar-section-title">프롬프트 브리지 직렬화 출력 (Prompt Context)</h2>
      <p>그린 도형의 좌표·바운딩박스·계층 구조와 선택된 스킬 실행 페이로드가 자동 결합됩니다.</p>
      <textarea id="prompt-textarea" class="prompt-output" readonly>${escapeXml(serialized.prompt)}</textarea>
    </aside>
  </div>

  <script>
    window.__STUDIO_SKETCH_SHAPES__ = ${initialShapesJson.replace(/</g, "\\u003c")};
    window.__STUDIO_SKILL_BUTTONS__ = ${skillButtonsJson.replace(/</g, "\\u003c")};
  </script>
</body>
</html>`;
}
