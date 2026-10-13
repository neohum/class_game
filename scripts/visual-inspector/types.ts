// scripts/visual-inspector/types.ts
// Data structures and interfaces for the visual grid inspector.

export type GuideOrientation = "horizontal" | "vertical";
export type GuideEdge = "top" | "center" | "bottom" | "left" | "right";

export interface RawBoundingBoxInput {
  id?: string;
  selector?: string;
  tag?: string;
  role?: string;
  interactive?: boolean;
  x?: number | string;
  y?: number | string;
  width?: number | string;
  height?: number | string;
  left?: number | string;
  top?: number | string;
  right?: number | string;
  bottom?: number | string;
  centerX?: number | string;
  centerY?: number | string;
  parentId?: string;
  visible?: boolean;
  opacity?: number | string;
  display?: string;
  visibility?: string;
  metadata?: Record<string, unknown>;
}

export interface BoundingBox {
  id: string;
  selector?: string;
  tag?: string;
  role?: string;
  interactive: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
  centerX: number;
  centerY: number;
  parentId?: string;
  visible: boolean;
  opacity: number;
  display: string;
  visibility: string;
  metadata?: Record<string, unknown>;
}

export interface AlignmentGuide {
  id: string;
  orientation: GuideOrientation;
  edge: GuideEdge;
  position: number;
  elementIds: string[];
  clusterCount: number;
}

export interface AlignmentViolation {
  id: string;
  elementId: string;
  siblingId?: string;
  edge: GuideEdge;
  expected: number;
  actual: number;
  offset: number;
  message: string;
}

export interface SpacingViolation {
  id: string;
  elementAId: string;
  elementBId: string;
  axis: "horizontal" | "vertical";
  distance: number;
  gridBase: 4 | 8;
  nearestLower: number;
  nearestUpper: number;
  message: string;
}

export interface TouchTargetViolation {
  id: string;
  elementId: string;
  tag?: string;
  role?: string;
  width: number;
  height: number;
  minRequired: number;
  message: string;
}

export interface CollisionViolation {
  id: string;
  elementAId: string;
  elementBId: string;
  overlapWidth: number;
  overlapHeight: number;
  overlapArea: number;
  message: string;
}

export interface InspectionSummary {
  totalElements: number;
  visibleElements: number;
  filteredElements: number;
  score: number; // 0 to 100
  alignmentViolationsCount: number;
  spacingViolationsCount: number;
  touchTargetViolationsCount: number;
  collisionViolationsCount: number;
  totalViolations: number;
  passed: boolean;
}

export interface InspectionResult {
  summary: InspectionSummary;
  guides: AlignmentGuide[];
  alignmentViolations: AlignmentViolation[];
  spacingViolations: SpacingViolation[];
  touchTargetViolations: TouchTargetViolation[];
  collisionViolations: CollisionViolation[];
  elements: BoundingBox[];
  timestamp: string;
}

export interface InspectorOptions {
  tolerance?: number; // default: 2
  gridBase?: 4 | 8; // default: 4
  minTouchTarget?: number; // default: 44
  maxErrors?: number; // default: 0
  ignoreSelfOrParentOverlap?: boolean; // default: true
  canvasWidth?: number;
  canvasHeight?: number;
}
