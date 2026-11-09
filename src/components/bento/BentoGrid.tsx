// BentoGrid.tsx — React/TSX Declarative Wrapper & Responsive CSS Grid Container.
//
// Conforms to:
//   - AC-1: 12/4 col desktop -> 2 col tablet -> 1 col mobile automatic fallback
//   - AC-2: Theorem 1 (Bounding Containment) & Theorem 2 (Row Overflow Prevention)
//   - AC-3: Zero external heavy dependencies, pure Tailwind + CSS Grid
//   - Anti-Cuticle: Strict symmetric borders
//   - Perfect Centering: inline-flex items-center justify-center leading-none

import {
  BentoGrid as createBentoGridElement,
  getBentoGridClasses,
  calculateBentoLayout,
  renderBentoGridHtml,
} from "./BentoGrid.ts";
import type {
  BentoGridProps as CoreBentoGridProps,
  BentoElement,
  BentoLayoutCalculation,
} from "./BentoGrid.ts";

export type { BentoElement, BentoLayoutCalculation };
export { getBentoGridClasses, calculateBentoLayout, renderBentoGridHtml };

export interface BentoGridProps extends CoreBentoGridProps {
  /** Alias for cols to support both <BentoGrid cols={4}> and <BentoGrid columns={4}> */
  columns?: 4 | 12;
}

/**
 * Declarative TSX-compatible BentoGrid component wrapper.
 */
export function BentoGrid(props: BentoGridProps): BentoElement {
  const effectiveCols = props.columns ?? props.cols ?? 4;
  return createBentoGridElement({
    ...props,
    cols: effectiveCols,
  });
}

export default BentoGrid;
