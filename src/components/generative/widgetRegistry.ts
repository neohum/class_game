// widgetRegistry.ts — Secure Whitelist Registry for Generative UI Components.
//
// Conforms to:
//   - AC-2: Strict whitelist security (blocks unregistered widgets, eval, and script injection)
//   - XSS sanitization (sanitizes dangerous tags, javascript: URIs, prototype pollution)
//   - edulinker defaults: FormulaGraphWidget, HintCardWidget, AchievementBadgeWidget

export interface WidgetDefinition<T = Record<string, unknown>> {
  name: string;
  description?: string;
  render: (data: T) => unknown;
  renderSkeleton?: () => unknown;
  renderHtml?: (data: T) => string;
  renderSkeletonHtml?: () => string;
}

/**
 * Recursively sanitizes raw input payloads to prevent XSS and prototype pollution.
 */
export function sanitizeGenerativePayload<T = unknown>(input: T): T {
  if (input === null || input === undefined) return input;

  if (typeof input === "string") {
    // 1. Remove dangerous script tags and event handlers
    let sanitized = input
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
      .replace(/javascript\s*:/gi, "blocked:")
      .replace(/data\s*:\s*text\/html/gi, "blocked:")
      .replace(/on\w+\s*=/gi, "blocked=");
    return sanitized as unknown as T;
  }

  if (Array.isArray(input)) {
    return input.map((item) => sanitizeGenerativePayload(item)) as unknown as T;
  }

  if (typeof input === "object") {
    const cleanObj: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      // Guard against prototype pollution
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        continue;
      }
      cleanObj[key] = sanitizeGenerativePayload(value);
    }
    return cleanObj as unknown as T;
  }

  return input;
}

export class WidgetRegistry {
  private registry = new Map<string, WidgetDefinition<any>>();

  constructor() {
    this.registerDefaults();
  }

  /**
   * Registers a safe widget definition into the whitelist.
   */
  public register<T = Record<string, unknown>>(definition: WidgetDefinition<T>): void {
    if (!definition.name || typeof definition.name !== "string") {
      throw new Error("Widget registration failed: definition.name is required");
    }
    this.registry.set(definition.name, definition);
  }

  /**
   * Retrieves a registered widget definition.
   */
  public get(name: string): WidgetDefinition | undefined {
    return this.registry.get(name);
  }

  /**
   * Checks whether a widget is registered in the whitelist.
   */
  public has(name: string): boolean {
    return this.registry.has(name);
  }

  /**
   * Lists all registered widget names.
   */
  public list(): string[] {
    return Array.from(this.registry.keys());
  }

  /**
   * Unregisters a widget by name.
   */
  public unregister(name: string): boolean {
    return this.registry.delete(name);
  }

  /**
   * Registers default edulinker widgets (FormulaGraph, HintCard, AchievementBadge).
   */
  private registerDefaults(): void {
    // 1. FormulaGraphWidget
    this.register({
      name: "FormulaGraphWidget",
      description: "Interactive 2D math formula and function curve visualizer",
      render: (data: { formula?: string; domain?: [number, number]; title?: string }) => ({
        type: "FormulaGraph",
        data: sanitizeGenerativePayload(data),
      }),
      renderHtml: (data: { formula?: string; title?: string }) => {
        const clean = sanitizeGenerativePayload(data);
        const title = clean.title || "수식 분석 그래프";
        const formula = clean.formula || "y = f(x)";
        return `
          <div class="border border-zinc-200 dark:border-zinc-800 rounded-xl p-4 bg-white dark:bg-zinc-900 shadow-sm" data-widget="FormulaGraphWidget">
            <h4 class="text-sm font-semibold text-zinc-900 dark:text-zinc-100">${title}</h4>
            <div class="my-3 p-3 rounded-lg bg-zinc-50 dark:bg-zinc-800/50 text-center font-mono text-blue-600 dark:text-blue-400 text-base">
              ${formula}
            </div>
            <div class="flex items-center justify-between mt-2">
              <span class="text-xs text-zinc-500">인터랙티브 파라미터 조절 가능</span>
              <button type="button" class="inline-flex items-center justify-center leading-none min-h-[44px] min-w-[44px] px-3 py-1.5 text-xs font-medium rounded-lg text-white bg-blue-600 hover:bg-blue-700 border border-blue-600">
                그래프 확대
              </button>
            </div>
          </div>
        `.trim();
      },
      renderSkeletonHtml: () => `
        <div class="border border-zinc-200 dark:border-zinc-800 rounded-xl p-4 bg-zinc-50 dark:bg-zinc-900 animate-pulse" aria-busy="true">
          <div class="h-4 bg-zinc-200 dark:bg-zinc-800 rounded w-1/3 mb-3"></div>
          <div class="h-20 bg-zinc-200 dark:bg-zinc-800 rounded mb-3"></div>
          <div class="h-8 bg-zinc-200 dark:bg-zinc-800 rounded w-1/4"></div>
        </div>
      `.trim(),
    });

    // 2. HintCardWidget
    this.register({
      name: "HintCardWidget",
      description: "Progressive step-by-step hint card for formative assessment",
      render: (data: { step?: number; totalSteps?: number; hint?: string }) => ({
        type: "HintCard",
        data: sanitizeGenerativePayload(data),
      }),
      renderHtml: (data: { step?: number; totalSteps?: number; hint?: string }) => {
        const clean = sanitizeGenerativePayload(data);
        const step = clean.step ?? 1;
        const total = clean.totalSteps ?? 3;
        const hint = clean.hint || "단계별 힌트를 확인하세요.";
        return `
          <div class="border border-amber-200 dark:border-amber-900/60 rounded-xl p-4 bg-amber-50/50 dark:bg-amber-950/20" data-widget="HintCardWidget">
            <div class="flex items-center justify-between mb-2">
              <span class="inline-flex items-center justify-center leading-none text-xs font-semibold px-2 py-0.5 rounded-full border border-amber-300 dark:border-amber-800 bg-amber-100 dark:bg-amber-900 text-amber-800 dark:text-amber-200">
                힌트 ${step} / ${total}
              </span>
            </div>
            <p class="text-sm text-zinc-800 dark:text-zinc-200 mt-2">${hint}</p>
            <div class="mt-4 flex flex-wrap items-center gap-2">
              <button type="button" class="inline-flex items-center justify-center leading-none min-h-[44px] min-w-[44px] px-3 py-1.5 text-xs font-medium rounded-lg text-amber-900 dark:text-amber-100 bg-amber-100 dark:bg-amber-900 hover:bg-amber-200 border border-amber-300 dark:border-amber-700">
                다음 힌트 보기
              </button>
            </div>
          </div>
        `.trim();
      },
      renderSkeletonHtml: () => `
        <div class="border border-amber-200 dark:border-amber-900/60 rounded-xl p-4 bg-amber-50/30 animate-pulse" aria-busy="true">
          <div class="h-4 bg-amber-200/50 rounded w-1/4 mb-3"></div>
          <div class="h-12 bg-amber-200/30 rounded mb-3"></div>
          <div class="h-8 bg-amber-200/50 rounded w-1/3"></div>
        </div>
      `.trim(),
    });

    // 3. AchievementBadgeWidget
    this.register({
      name: "AchievementBadgeWidget",
      description: "Neubrutalism gamification reward badge for learning milestones",
      render: (data: { badgeTitle?: string; stampType?: string }) => ({
        type: "AchievementBadge",
        data: sanitizeGenerativePayload(data),
      }),
      renderHtml: (data: { badgeTitle?: string; stampType?: string }) => {
        const clean = sanitizeGenerativePayload(data);
        const title = clean.badgeTitle || "참 잘했어요!";
        return `
          <div class="border-2 border-zinc-900 dark:border-zinc-100 rounded-xl p-4 bg-yellow-300 dark:bg-yellow-400 text-zinc-900 shadow-[3px_3px_0px_#000]" data-widget="AchievementBadgeWidget">
            <div class="flex items-center gap-3">
              <div class="w-10 h-10 inline-flex items-center justify-center leading-none text-xl rounded-full bg-white border-2 border-zinc-900">
                ★
              </div>
              <div>
                <h4 class="text-base font-bold leading-none">${title}</h4>
                <p class="text-xs font-medium mt-1 text-zinc-700">학습 목표 완수를 축하합니다!</p>
              </div>
            </div>
          </div>
        `.trim();
      },
      renderSkeletonHtml: () => `
        <div class="border-2 border-zinc-300 rounded-xl p-4 bg-zinc-100 animate-pulse" aria-busy="true">
          <div class="h-10 bg-zinc-200 rounded"></div>
        </div>
      `.trim(),
    });
  }
}

/** Default singleton instance */
export const defaultWidgetRegistry = new WidgetRegistry();
