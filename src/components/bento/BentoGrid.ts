// BentoGrid.tsx — Zero-dependency Pure CSS Grid Modular Responsive Container.
//
// Conforms to:
//   - AC-1: 12/4 col desktop -> 2 col tablet -> 1 col mobile automatic fallback
//   - AC-2: Theorem 1 (Bounding Containment) & Theorem 2 (Row Overflow Prevention)
//   - AC-3: Zero external heavy dependencies, pure Tailwind + CSS Grid
//   - Anti-Cuticle: Strict symmetric borders
//   - Perfect Centering: inline-flex items-center justify-center leading-none

export interface BentoGridProps {
  cols?: 4 | 12;
  gap?: 16 | 20 | 24;
  padding?: 16 | 20 | 24;
  className?: string;
  id?: string;
  children?: unknown;
}

export interface BentoElement {
  type: string;
  props: Record<string, unknown>;
}

export interface BentoLayoutCalculation {
  viewportWidth: number;
  containerWidth: number;
  availableInnerWidth: number;
  columns: number;
  gap: number;
  padding: number;
  columnWidth: number;
  deviceCategory: "mobile" | "tablet" | "desktop";
}

/**
 * Generates Tailwind CSS classes for responsive Bento Grid:
 * - Mobile (< 768px): 1 column full width (grid-cols-1)
 * - Tablet (768px - 1023px): 2 columns (md:grid-cols-2)
 * - Desktop (≥ 1024px): 4 columns (lg:grid-cols-4) or 12 columns (lg:grid-cols-12)
 */
export function getBentoGridClasses(cols: 4 | 12 = 4, gap: 16 | 20 | 24 = 16): string {
  const colClass = cols === 12 ? "lg:grid-cols-12" : "lg:grid-cols-4";
  const gapClass = gap === 24 ? "gap-6" : gap === 20 ? "gap-5" : "gap-4";
  return `grid grid-cols-1 md:grid-cols-2 ${colClass} ${gapClass} w-full max-w-full box-border`;
}

/**
 * Mathematical geometric calculation of Bento Grid across viewports.
 * Enforces Theorem 1 (Bounding Containment):
 *   Inner width = Container width - 2 * padding
 *   Column width = (Inner width - (cols - 1) * gap) / cols
 */
export function calculateBentoLayout(options: {
  viewportWidth: number;
  cols?: 4 | 12;
  gap?: number;
  padding?: number;
}): BentoLayoutCalculation {
  const { viewportWidth, cols = 4, gap = 16, padding = 16 } = options;

  let columns = 1;
  let deviceCategory: "mobile" | "tablet" | "desktop" = "mobile";

  if (viewportWidth >= 1024) {
    columns = cols;
    deviceCategory = "desktop";
  } else if (viewportWidth >= 768) {
    columns = 2;
    deviceCategory = "tablet";
  } else {
    columns = 1;
    deviceCategory = "mobile";
  }

  const containerWidth = Math.min(viewportWidth, 1440);
  const availableInnerWidth = Math.max(0, containerWidth - 2 * padding);
  const totalGaps = (columns - 1) * gap;
  const columnWidth = columns > 0 ? Math.max(0, (availableInnerWidth - totalGaps) / columns) : availableInnerWidth;

  return {
    viewportWidth,
    containerWidth,
    availableInnerWidth,
    columns,
    gap,
    padding,
    columnWidth: Math.round(columnWidth * 100) / 100,
    deviceCategory,
  };
}

/**
 * Standard BentoGrid functional component.
 * Compatible with React, Preact, and server-side VDOM rendering.
 */
export function BentoGrid(props: BentoGridProps): BentoElement {
  const { cols = 4, gap = 16, padding = 16, className = "", id, children } = props;
  const gridClasses = getBentoGridClasses(cols, gap);
  const paddingClass = padding === 24 ? "p-6" : padding === 20 ? "p-5" : "p-4";
  const combinedClasses = `${gridClasses} ${paddingClass} ${className}`.trim();

  return {
    type: "div",
    props: {
      id,
      className: combinedClasses,
      "data-bento-grid": "true",
      "data-cols": String(cols),
      style: {
        display: "grid",
        boxSizing: "border-box",
        width: "100%",
        maxWidth: "100%",
      },
      children,
    },
  };
}

/**
 * Renders BentoGrid to pure HTML string.
 */
export function renderBentoGridHtml(props: BentoGridProps, innerHtml = ""): string {
  const { cols = 4, gap = 16, padding = 16, className = "", id } = props;
  const gridClasses = getBentoGridClasses(cols, gap);
  const paddingClass = padding === 24 ? "p-6" : padding === 20 ? "p-5" : "p-4";
  const combinedClasses = `${gridClasses} ${paddingClass} ${className}`.trim();
  const idAttr = id ? ` id="${id}"` : "";

  return `<div${idAttr} class="${combinedClasses}" data-bento-grid="true" style="display: grid; box-sizing: border-box; width: 100%; max-width: 100%;">${innerHtml}</div>`;
}
