// BentoCard.tsx — React/TSX Declarative Wrapper for Modular Bento Card Primitive.
//
// Conforms to:
//   - Anti-Cuticle: Strict symmetric border (border border-zinc-200 dark:border-zinc-800)
//   - Perfect Centering: inline-flex items-center justify-center leading-none
//   - Touch Target: min-h-[44px] min-w-[44px]
//   - Theorem 2: flex-wrap on action button container to prevent row overflow on mobile

import {
  BentoCard as createBentoCardElement,
  getBentoCardClasses,
  calculateBentoCardDimensions,
  renderBentoCardHtml,
} from "./BentoCard.ts";
import type { BentoCardAction, BentoCardProps as CoreBentoCardProps } from "./BentoCard.ts";
import type { BentoElement } from "./BentoGrid.ts";

export type { BentoCardAction };
export { getBentoCardClasses, calculateBentoCardDimensions, renderBentoCardHtml };

export interface BentoCardProps extends Omit<CoreBentoCardProps, "colSpan"> {
  colSpan?: CoreBentoCardProps["colSpan"] | 1 | 2 | 3 | 4;
  rowSpan?: 1 | 2 | 3 | 4;
  subtitle?: string;
  headerAction?: unknown;
  footer?: unknown;
}

/**
 * Normalizes numeric or responsive object colSpan into CoreBentoCardProps["colSpan"].
 */
export function normalizeBentoColSpan(
  colSpan?: BentoCardProps["colSpan"],
): CoreBentoCardProps["colSpan"] {
  if (typeof colSpan === "number") {
    return {
      mobile: 1,
      tablet: colSpan >= 2 ? 2 : 1,
      desktop: colSpan,
    };
  }
  return colSpan;
}

/**
 * Declarative TSX-compatible BentoCard component wrapper.
 */
export function BentoCard(props: BentoCardProps): BentoElement {
  const { colSpan, subtitle, description, headerAction, footer, ...rest } = props;
  const resolvedSpan = normalizeBentoColSpan(colSpan);
  const element = createBentoCardElement({
    ...rest,
    description: description ?? subtitle,
    colSpan: resolvedSpan,
  });

  if (headerAction !== undefined) {
    element.props["headerAction"] = headerAction;
  }
  if (footer !== undefined) {
    element.props["footer"] = footer;
  }
  if (props.rowSpan !== undefined) {
    element.props["data-row-span"] = String(props.rowSpan);
  }
  return element;
}

export default BentoCard;
