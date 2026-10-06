// BentoCard.tsx — Modular Bento Card Primitive.
//
// Conforms to:
//   - Anti-Cuticle: Strict symmetric border (border border-zinc-200 dark:border-zinc-800)
//   - Perfect Centering: inline-flex items-center justify-center leading-none
//   - Touch Target: min-h-[44px] min-w-[44px]
//   - Theorem 2: flex-wrap on action button container to prevent row overflow on mobile

import type { BentoElement } from "./BentoGrid.tsx";

export interface BentoCardAction {
  label: string;
  onClick?: () => void;
  variant?: "primary" | "secondary" | "subtle";
  className?: string;
}

export interface BentoCardProps {
  title: string;
  description?: string;
  badge?: string;
  icon?: string;
  colSpan?: {
    mobile?: 1;
    tablet?: 1 | 2;
    desktop?: 1 | 2 | 3 | 4;
  };
  actions?: BentoCardAction[];
  children?: unknown;
  className?: string;
  id?: string;
}

/**
 * Resolves responsive col-span classes for BentoCard:
 * Mobile: always col-span-1
 * Tablet: md:col-span-1 or md:col-span-2
 * Desktop: lg:col-span-1, lg:col-span-2, lg:col-span-3, lg:col-span-4
 */
export function getBentoCardClasses(colSpan?: BentoCardProps["colSpan"], customClass = ""): string {
  const tabletSpan = colSpan?.tablet === 2 ? "md:col-span-2" : "md:col-span-1";
  const desktopSpan =
    colSpan?.desktop === 4
      ? "lg:col-span-4"
      : colSpan?.desktop === 3
        ? "lg:col-span-3"
        : colSpan?.desktop === 2
          ? "lg:col-span-2"
          : "lg:col-span-1";

  // Strict symmetric border & rounded box-sizing
  const baseClasses =
    "col-span-1 " +
    tabletSpan +
    " " +
    desktopSpan +
    " flex flex-col justify-between p-5 md:p-6 rounded-2xl " +
    "border border-zinc-200 dark:border-zinc-800 " +
    "bg-white dark:bg-zinc-900 shadow-sm " +
    "transition-all duration-200 box-border w-full max-w-full overflow-hidden";

  return customClass ? `${baseClasses} ${customClass}`.trim() : baseClasses;
}

/**
 * Calculates card geometric dimensions across device viewports.
 * Enforces Theorem 1 (Card width <= Container inner width).
 */
export function calculateBentoCardDimensions(options: {
  containerWidth: number;
  colSpan: number;
  totalCols: number;
  gap?: number;
  padding?: number;
}): {
  cardWidth: number;
  cardInnerWidth: number;
  cardPadding: number;
} {
  const { containerWidth, colSpan, totalCols, gap = 16, padding = 16 } = options;
  const innerContainerW = Math.max(0, containerWidth - 2 * padding);
  const effectiveCols = Math.max(1, totalCols);
  const singleColW = (innerContainerW - (effectiveCols - 1) * gap) / effectiveCols;

  // Clamped colSpan
  const clampedSpan = Math.min(colSpan, effectiveCols);
  const cardWidth = Math.round((clampedSpan * singleColW + (clampedSpan - 1) * gap) * 100) / 100;
  const cardPadding = 24; // p-6 = 24px
  const cardInnerWidth = Math.max(0, cardWidth - 2 * cardPadding);

  return {
    cardWidth,
    cardInnerWidth,
    cardPadding,
  };
}

/**
 * Standard BentoCard functional component.
 */
export function BentoCard(props: BentoCardProps): BentoElement {
  const { title, description, badge, icon, colSpan, actions = [], children, className = "", id } = props;
  const cardClasses = getBentoCardClasses(colSpan, className);

  return {
    type: "div",
    props: {
      id,
      className: cardClasses,
      "data-bento-card": "true",
      style: {
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        boxSizing: "border-box",
      },
      title,
      description,
      badge,
      icon,
      actions,
      children,
    },
  };
}

/**
 * Renders BentoCard to pure HTML string with perfect button centering and Theorem 2 wrap.
 */
export function renderBentoCardHtml(props: BentoCardProps, innerBodyHtml = ""): string {
  const { title, description, badge, icon, colSpan, actions = [], className = "", id } = props;
  const cardClasses = getBentoCardClasses(colSpan, className);
  const idAttr = id ? ` id="${id}"` : "";

  const badgeHtml = badge
    ? `<span class="inline-flex items-center justify-center leading-none text-xs font-semibold px-2.5 py-1 rounded-full border border-blue-200 dark:border-blue-900 bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300">${badge}</span>`
    : "";

  const iconHtml = icon
    ? `<div class="inline-flex items-center justify-center leading-none w-10 h-10 min-w-[40px] min-h-[40px] rounded-xl bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100">${icon}</div>`
    : "";

  const headerHtml = `
    <div class="flex items-start justify-between gap-3 mb-3">
      <div class="flex items-center gap-3">
        ${iconHtml}
        <div>
          <h3 class="text-base font-semibold text-zinc-900 dark:text-zinc-100 leading-tight">${title}</h3>
          ${description ? `<p class="text-sm text-zinc-500 dark:text-zinc-400 mt-1">${description}</p>` : ""}
        </div>
      </div>
      ${badgeHtml}
    </div>
  `.trim();

  // Theorem 2: flex-wrap items-center gap-2 prevents row overflow on mobile
  const actionsHtml =
    actions.length > 0
      ? `
    <div class="flex flex-wrap items-center gap-2 mt-4 pt-3 border-t border-zinc-100 dark:border-zinc-800/80">
      ${actions
        .map((act) => {
          const isPrimary = act.variant === "primary";
          const btnClasses = isPrimary
            ? "inline-flex items-center justify-center leading-none min-h-[44px] min-w-[44px] px-4 py-2 text-sm font-medium rounded-lg text-white bg-blue-600 hover:bg-blue-700 border border-blue-600 transition-colors"
            : "inline-flex items-center justify-center leading-none min-h-[44px] min-w-[44px] px-4 py-2 text-sm font-medium rounded-lg text-zinc-700 dark:text-zinc-300 bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 border border-zinc-200 dark:border-zinc-700 transition-colors";
          return `<button type="button" class="${btnClasses}${act.className ? ` ${act.className}` : ""}">${act.label}</button>`;
        })
        .join("\n")}
    </div>
  `.trim()
      : "";

  return `
    <div${idAttr} class="${cardClasses}" data-bento-card="true">
      <div>
        ${headerHtml}
        ${innerBodyHtml ? `<div class="mt-2">${innerBodyHtml}</div>` : ""}
      </div>
      ${actionsHtml}
    </div>
  `.trim();
}
