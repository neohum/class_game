// scripts/visual-inspector/bounds-extractor.ts
// Parses, normalizes, and filters raw DOM/JSON element bounding boxes.

import type { BoundingBox, RawBoundingBoxInput } from "./types.ts";

/**
 * Normalizes numeric coordinates, stripping 'px' or parsing strings safely.
 */
export function normalizeCoordinate(value: unknown, fallback = 0): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.round(value * 100) / 100 : fallback;
  }
  if (typeof value === "string") {
    const cleaned = value.replace(/px$/i, "").trim();
    const parsed = parseFloat(cleaned);
    return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : fallback;
  }
  return fallback;
}

/**
 * Determines whether a raw element is interactive (button, link, form control).
 */
export function isInteractiveElement(raw: RawBoundingBoxInput): boolean {
  if (raw.interactive === true) return true;
  if (raw.interactive === false) return false;

  const tag = (raw.tag || "").toLowerCase();
  const interactiveTags = new Set(["button", "a", "input", "select", "textarea"]);
  if (interactiveTags.has(tag)) return true;

  const role = (raw.role || "").toLowerCase();
  const interactiveRoles = new Set(["button", "link", "checkbox", "radio", "switch", "tab", "menuitem"]);
  if (interactiveRoles.has(role)) return true;

  const selector = (raw.selector || "").toLowerCase();
  if (/\b(btn|button|cta)\b/i.test(selector)) return true;

  return false;
}

/**
 * Evaluates visibility of a raw bounding box.
 * Returns false if display:none, visibility:hidden/collapse, opacity=0, or 0x0 size.
 */
export function isVisibleElement(raw: RawBoundingBoxInput): boolean {
  if (raw.visible === false) return false;

  const display = (raw.display || "").toLowerCase().trim();
  if (display === "none") return false;

  const visibility = (raw.visibility || "").toLowerCase().trim();
  if (visibility === "hidden" || visibility === "collapse") return false;

  if (raw.opacity !== undefined) {
    const op = normalizeCoordinate(raw.opacity, 1);
    if (op <= 0.001) return false;
  }

  // Parse width and height
  let width = normalizeCoordinate(raw.width, 0);
  let height = normalizeCoordinate(raw.height, 0);

  // If width/height are not set but right/bottom are available
  if (width === 0 && raw.right !== undefined && (raw.x !== undefined || raw.left !== undefined)) {
    const left = normalizeCoordinate(raw.x ?? raw.left, 0);
    const right = normalizeCoordinate(raw.right, 0);
    width = Math.abs(right - left);
  }

  if (height === 0 && raw.bottom !== undefined && (raw.y !== undefined || raw.top !== undefined)) {
    const top = normalizeCoordinate(raw.y ?? raw.top, 0);
    const bottom = normalizeCoordinate(raw.bottom, 0);
    height = Math.abs(bottom - top);
  }

  // Filter 0x0 or collapsed elements
  if (width <= 0 || height <= 0) return false;

  return true;
}

/**
 * Normalizes a single raw input into a complete BoundingBox.
 */
export function normalizeBounds(
  raw: RawBoundingBoxInput,
  index = 0,
  parentLookup?: Map<string, BoundingBox>
): BoundingBox | null {
  // Determine X (Left)
  let x = raw.x !== undefined ? normalizeCoordinate(raw.x) : normalizeCoordinate(raw.left, 0);
  // Determine Y (Top)
  let y = raw.y !== undefined ? normalizeCoordinate(raw.y) : normalizeCoordinate(raw.top, 0);

  // Determine Width
  let width = 0;
  if (raw.width !== undefined) {
    width = normalizeCoordinate(raw.width);
  } else if (raw.right !== undefined) {
    width = normalizeCoordinate(raw.right) - x;
  }

  // Determine Height
  let height = 0;
  if (raw.height !== undefined) {
    height = normalizeCoordinate(raw.height);
  } else if (raw.bottom !== undefined) {
    height = normalizeCoordinate(raw.bottom) - y;
  }

  // Invert negative dimensions if any
  if (width < 0) {
    x += width;
    width = Math.abs(width);
  }
  if (height < 0) {
    y += height;
    height = Math.abs(height);
  }

  // Relative coordinate adjustment if flagged and parent exists
  if (raw.parentId && parentLookup?.has(raw.parentId)) {
    const parent = parentLookup.get(raw.parentId);
    if (parent && raw.metadata?.["isRelative"] === true) {
      x += parent.x;
      y += parent.y;
    }
  }

  const id = raw.id || raw.selector || `elem-${index + 1}`;
  const interactive = isInteractiveElement(raw);
  const visible = isVisibleElement(raw);
  const opacity = raw.opacity !== undefined ? normalizeCoordinate(raw.opacity, 1) : 1;
  const display = (raw.display || "block").toLowerCase().trim();
  const visibility = (raw.visibility || "visible").toLowerCase().trim();

  const left = x;
  const top = y;
  const right = Math.round((x + width) * 100) / 100;
  const bottom = Math.round((y + height) * 100) / 100;
  const centerX = Math.round((x + width / 2) * 100) / 100;
  const centerY = Math.round((y + height / 2) * 100) / 100;

  return {
    id,
    selector: raw.selector,
    tag: raw.tag,
    role: raw.role,
    interactive,
    x,
    y,
    width,
    height,
    left,
    top,
    right,
    bottom,
    centerX,
    centerY,
    parentId: raw.parentId,
    visible,
    opacity,
    display,
    visibility,
    metadata: raw.metadata,
  };
}

/**
 * Extracts and normalizes bounding boxes from an array of raw elements or container object.
 */
export function extractBounds(
  rawInput: unknown,
  options: { filterHidden?: boolean } = { filterHidden: true }
): BoundingBox[] {
  let list: RawBoundingBoxInput[] = [];

  if (Array.isArray(rawInput)) {
    list = rawInput as RawBoundingBoxInput[];
  } else if (rawInput && typeof rawInput === "object") {
    const obj = rawInput as Record<string, unknown>;
    if (Array.isArray(obj["elements"])) {
      list = obj["elements"] as RawBoundingBoxInput[];
    } else if (Array.isArray(obj["boxes"])) {
      list = obj["boxes"] as RawBoundingBoxInput[];
    } else if (Array.isArray(obj["nodes"])) {
      list = obj["nodes"] as RawBoundingBoxInput[];
    }
  }

  const results: BoundingBox[] = [];
  const parentLookup = new Map<string, BoundingBox>();

  for (let i = 0; i < list.length; i++) {
    const raw = list[i];
    if (!raw || typeof raw !== "object") continue;

    if (options.filterHidden !== false && !isVisibleElement(raw)) {
      continue;
    }

    const box = normalizeBounds(raw, i, parentLookup);
    if (!box) continue;

    if (options.filterHidden !== false && (box.width <= 0 || box.height <= 0 || !box.visible)) {
      continue;
    }

    results.push(box);
    parentLookup.set(box.id, box);
  }

  return results;
}
