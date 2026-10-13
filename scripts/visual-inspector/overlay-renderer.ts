// scripts/visual-inspector/overlay-renderer.ts
// Generates SVG overlay containing alignment guides, bounding boxes, and visual defect callouts.

import type { InspectionResult, BoundingBox } from "./types.ts";

function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Calculates canvas bounds to fit all elements and guides.
 */
function computeCanvasDimensions(result: InspectionResult, customWidth?: number, customHeight?: number) {
  let maxX = 800;
  let maxY = 600;

  for (const el of result.elements) {
    if (el.right > maxX) maxX = Math.ceil(el.right);
    if (el.bottom > maxY) maxY = Math.ceil(el.bottom);
  }

  for (const g of result.guides) {
    if (g.orientation === "vertical" && g.position > maxX) maxX = Math.ceil(g.position);
    if (g.orientation === "horizontal" && g.position > maxY) maxY = Math.ceil(g.position);
  }

  const width = Math.max(customWidth ?? 0, maxX + 40);
  const height = Math.max(customHeight ?? 0, maxY + 40);

  return { width, height };
}

/**
 * Renders an SVG overlay string from an InspectionResult.
 */
export function renderSvgOverlay(
  result: InspectionResult,
  customWidth?: number,
  customHeight?: number
): string {
  const { width, height } = computeCanvasDimensions(result, customWidth, customHeight);
  const elementMap = new Map<string, BoundingBox>();
  for (const el of result.elements) {
    elementMap.set(el.id, el);
  }

  const parts: string[] = [];

  // SVG Header & Defs
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" style="background-color: #0b0f19; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;">`
  );

  parts.push(`  <defs>
    <pattern id="grid-pattern" width="16" height="16" patternUnits="userSpaceOnUse">
      <path d="M 16 0 L 0 0 0 16" fill="none" stroke="rgba(255, 255, 255, 0.04)" stroke-width="1" />
    </pattern>
    <marker id="arrow" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="#e11d48" />
    </marker>
  </defs>`);

  // Background pattern
  parts.push(`  <rect width="100%" height="100%" fill="#0b0f19" />`);
  parts.push(`  <rect width="100%" height="100%" fill="url(#grid-pattern)" />`);

  // 1. Alignment Guides
  parts.push(`  <g id="alignment-guides">`);
  for (const g of result.guides) {
    if (g.orientation === "vertical") {
      const x = g.position;
      parts.push(
        `    <line x1="${x}" y1="0" x2="${x}" y2="${height}" stroke="rgba(56, 189, 248, 0.45)" stroke-width="1" stroke-dasharray="4, 3" />`
      );
      parts.push(
        `    <text x="${x + 2}" y="14" fill="#38bdf8" font-size="9" opacity="0.8">X:${Math.round(x)}</text>`
      );
    } else {
      const y = g.position;
      parts.push(
        `    <line x1="0" y1="${y}" x2="${width}" y2="${y}" stroke="rgba(192, 132, 252, 0.45)" stroke-width="1" stroke-dasharray="4, 3" />`
      );
      parts.push(
        `    <text x="4" y="${y - 3}" fill="#c084fc" font-size="9" opacity="0.8">Y:${Math.round(y)}</text>`
      );
    }
  }
  parts.push(`  </g>`);

  // 2. Element Bounding Boxes
  parts.push(`  <g id="element-boxes">`);
  for (const el of result.elements) {
    parts.push(
      `    <rect x="${el.x}" y="${el.y}" width="${el.width}" height="${el.height}" fill="rgba(30, 41, 59, 0.5)" stroke="rgba(148, 163, 184, 0.5)" stroke-width="1" rx="2" />`
    );
    // Element ID tag
    const label = escapeXml(el.id);
    parts.push(
      `    <text x="${el.x + 4}" y="${Math.min(el.y + 14, el.bottom - 4)}" fill="#cbd5e1" font-size="10" font-weight="600">${label}</text>`
    );
  }
  parts.push(`  </g>`);

  // 3. Collision Highlights
  if (result.collisionViolations.length > 0) {
    parts.push(`  <g id="collision-highlights">`);
    for (const c of result.collisionViolations) {
      const a = elementMap.get(c.elementAId);
      const b = elementMap.get(c.elementBId);
      if (a && b) {
        const overlapX = Math.max(a.left, b.left);
        const overlapY = Math.max(a.top, b.top);
        parts.push(
          `    <rect x="${overlapX}" y="${overlapY}" width="${c.overlapWidth}" height="${c.overlapHeight}" fill="rgba(239, 68, 68, 0.4)" stroke="#ef4444" stroke-width="1.5" stroke-dasharray="2, 2" />`
        );
        parts.push(
          `    <rect x="${overlapX}" y="${overlapY - 14}" width="75" height="14" fill="#ef4444" rx="2" />`
        );
        parts.push(
          `    <text x="${overlapX + 3}" y="${overlapY - 3}" fill="#ffffff" font-size="9" font-weight="bold">COLLISION</text>`
        );
      }
    }
    parts.push(`  </g>`);
  }

  // 4. Touch Target Violations
  if (result.touchTargetViolations.length > 0) {
    parts.push(`  <g id="touch-target-violations">`);
    for (const t of result.touchTargetViolations) {
      const el = elementMap.get(t.elementId);
      if (el) {
        parts.push(
          `    <rect x="${el.x - 2}" y="${el.y - 2}" width="${el.width + 4}" height="${el.height + 4}" fill="none" stroke="#f59e0b" stroke-width="2" stroke-dasharray="4, 2" rx="4" />`
        );
        const tagText = `${Math.round(el.width)}×${Math.round(el.height)} &lt; 44px`;
        const tagWidth = tagText.length * 6 + 10;
        parts.push(
          `    <rect x="${el.x}" y="${el.bottom + 2}" width="${tagWidth}" height="14" fill="#f59e0b" rx="2" />`
        );
        parts.push(
          `    <text x="${el.x + 4}" y="${el.bottom + 12}" fill="#000000" font-size="9" font-weight="bold">${tagText}</text>`
        );
      }
    }
    parts.push(`  </g>`);
  }

  // 5. Alignment Offset Callouts
  if (result.alignmentViolations.length > 0) {
    parts.push(`  <g id="alignment-offsets">`);
    for (const v of result.alignmentViolations) {
      const el = elementMap.get(v.elementId);
      if (el) {
        let lx = el.left;
        let ly = el.top;
        if (v.edge === "right") lx = el.right;
        if (v.edge === "bottom") ly = el.bottom;
        if (v.edge === "center") {
          lx = el.centerX;
          ly = el.centerY;
        }

        parts.push(
          `    <circle cx="${lx}" cy="${ly}" r="3.5" fill="#f43f5e" stroke="#ffffff" stroke-width="1" />`
        );
        parts.push(
          `    <rect x="${lx + 6}" y="${ly - 7}" width="50" height="14" fill="#f43f5e" rx="2" />`
        );
        parts.push(
          `    <text x="${lx + 9}" y="${ly + 3}" fill="#ffffff" font-size="9" font-weight="bold">Δ${v.offset}px</text>`
        );
      }
    }
    parts.push(`  </g>`);
  }

  // 6. Spacing Violations
  if (result.spacingViolations.length > 0) {
    parts.push(`  <g id="spacing-violations">`);
    for (const sp of result.spacingViolations) {
      const a = elementMap.get(sp.elementAId);
      const b = elementMap.get(sp.elementBId);
      if (a && b) {
        if (sp.axis === "horizontal") {
          const midY = (Math.max(a.top, b.top) + Math.min(a.bottom, b.bottom)) / 2;
          parts.push(
            `    <line x1="${a.right}" y1="${midY}" x2="${b.left}" y2="${midY}" stroke="#eab308" stroke-width="2" />`
          );
          parts.push(
            `    <line x1="${a.right}" y1="${midY - 4}" x2="${a.right}" y2="${midY + 4}" stroke="#eab308" stroke-width="2" />`
          );
          parts.push(
            `    <line x1="${b.left}" y1="${midY - 4}" x2="${b.left}" y2="${midY + 4}" stroke="#eab308" stroke-width="2" />`
          );
          const midX = (a.right + b.left) / 2;
          const text = `${sp.distance}px`;
          parts.push(
            `    <text x="${midX - 10}" y="${midY - 6}" fill="#eab308" font-size="9" font-weight="bold">${text}</text>`
          );
        } else {
          const midX = (Math.max(a.left, b.left) + Math.min(a.right, b.right)) / 2;
          parts.push(
            `    <line x1="${midX}" y1="${a.bottom}" x2="${midX}" y2="${b.top}" stroke="#eab308" stroke-width="2" />`
          );
          parts.push(
            `    <line x1="${midX - 4}" y1="${a.bottom}" x2="${midX + 4}" y2="${a.bottom}" stroke="#eab308" stroke-width="2" />`
          );
          parts.push(
            `    <line x1="${midX - 4}" y1="${b.top}" x2="${midX + 4}" y2="${b.top}" stroke="#eab308" stroke-width="2" />`
          );
          const midY = (a.bottom + b.top) / 2;
          const text = `${sp.distance}px`;
          parts.push(
            `    <text x="${midX + 6}" y="${midY + 3}" fill="#eab308" font-size="9" font-weight="bold">${text}</text>`
          );
        }
      }
    }
    parts.push(`  </g>`);
  }

  parts.push(`</svg>`);
  return parts.join("\n");
}
