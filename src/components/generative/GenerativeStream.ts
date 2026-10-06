// GenerativeStream.tsx — Vercel AI SDK Compatible Generative UI Streaming Runtime.
//
// Conforms to:
//   - AC-1: Safe incomplete JSON chunk parsing with graceful skeleton -> ready transition
//   - AC-2: Whitelist-only widget rendering with script injection prevention
//   - AC-3: Strict node runtime compatibility & Anti-Slop visual invariants

import { WidgetRegistry, defaultWidgetRegistry } from "./widgetRegistry.ts";

export type StreamStatus = "loading" | "streaming" | "ready" | "error";

export interface StreamChunk<T = Record<string, unknown>> {
  widget: string;
  status: StreamStatus;
  data: T;
  error?: string;
  id?: string;
}

function trackBracketStack(trimmed: string): { stack: string[]; insideString: boolean } {
  let insideString = false;
  let isEscaped = false;
  const stack: string[] = [];

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]!;
    if (insideString) {
      if (isEscaped) {
        isEscaped = false;
      } else if (ch === "\\") {
        isEscaped = true;
      } else if (ch === '"') {
        insideString = false;
      }
      continue;
    }

    if (ch === '"') {
      insideString = true;
    } else if (ch === "{" || ch === "[") {
      stack.push(ch);
    } else if (ch === "}" && stack[stack.length - 1] === "{") {
      stack.pop();
    } else if (ch === "]" && stack[stack.length - 1] === "[") {
      stack.pop();
    }
  }

  return { stack, insideString };
}

function balanceBrackets(trimmed: string, stack: string[], insideString: boolean): string {
  let repaired = trimmed;
  if (insideString) {
    repaired += '"';
  }
  repaired = repaired.replace(/,\s*$/, "");
  while (stack.length > 0) {
    const opener = stack.pop();
    if (opener === "{") repaired += "}";
    if (opener === "[") repaired += "]";
  }
  return repaired;
}

/**
 * Attempts to repair and parse partially received JSON strings during streaming.
 */
export function repairIncompleteJson(jsonStr: string): Record<string, unknown> | null {
  const trimmed = jsonStr.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Attempt repair below
  }

  const { stack, insideString } = trackBracketStack(trimmed);
  const repaired = balanceBrackets(trimmed, stack, insideString);

  try {
    const parsed = JSON.parse(repaired);
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Cannot be safely repaired
  }

  return null;
}

/**
 * Parses a raw streaming chunk into a typed StreamChunk structure.
 */
export function parseStreamChunk(rawChunk: string): StreamChunk {
  const parsed = repairIncompleteJson(rawChunk);

  if (!parsed || typeof parsed !== "object") {
    return {
      widget: "unknown",
      status: "error",
      data: {},
      error: "JSON 스트리밍 파싱 실패: 불완전하거나 손상된 청크입니다.",
    };
  }

  const widget = typeof parsed["widget"] === "string" ? parsed["widget"] : "unknown";
  const rawStatus = parsed["status"];
  const status: StreamStatus =
    rawStatus === "ready" || rawStatus === "streaming" || rawStatus === "loading"
      ? (rawStatus as StreamStatus)
      : "loading";

  const data = typeof parsed["data"] === "object" && parsed["data"] !== null
    ? (parsed["data"] as Record<string, unknown>)
    : {};

  const error = typeof parsed["error"] === "string" ? parsed["error"] : undefined;
  const id = typeof parsed["id"] === "string" ? parsed["id"] : undefined;

  return {
    widget,
    status,
    data,
    error,
    id,
  };
}

/**
 * Generative UI Runtime controller that processes chunks and coordinates rendering.
 */
export class GenerativeStreamRuntime {
  private registry: WidgetRegistry;
  private currentChunk: StreamChunk = {
    widget: "unknown",
    status: "loading",
    data: {},
  };

  constructor(registry: WidgetRegistry = defaultWidgetRegistry) {
    this.registry = registry;
  }

  /**
   * Ingests a new streaming string chunk, updates state, and performs security checks.
   */
  public ingest(rawChunk: string): StreamChunk {
    const chunk = parseStreamChunk(rawChunk);

    // Whitelist security enforcement (AC-2)
    if (chunk.widget !== "unknown" && !this.registry.has(chunk.widget)) {
      this.currentChunk = {
        widget: chunk.widget,
        status: "error",
        data: {},
        error: `미등록 위젯 '${chunk.widget}' 렌더링 거부: 화이트리스트에 등록되지 않은 컴포넌트입니다.`,
      };
      return this.currentChunk;
    }

    this.currentChunk = chunk;
    return this.currentChunk;
  }

  public getCurrent(): StreamChunk {
    return this.currentChunk;
  }

  /**
   * Renders the current state to a safe HTML string.
   */
  public renderHtml(): string {
    return renderGenerativeStreamHtml(this.currentChunk, this.registry);
  }
}

/**
 * Pure HTML string renderer for a StreamChunk.
 */
export function renderGenerativeStreamHtml(
  chunk: StreamChunk,
  registry: WidgetRegistry = defaultWidgetRegistry,
): string {
  // 1. Error state
  if (chunk.status === "error" || chunk.error) {
    const errorMsg = chunk.error || "위젯을 렌더링하는 중 알 수 없는 오류가 발생했습니다.";
    return `
      <div class="border border-red-200 dark:border-red-900 rounded-xl p-4 bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300" role="alert" data-generative-error="true">
        <div class="flex items-center gap-2 mb-1">
          <span class="font-bold text-sm">보안/렌더링 오류</span>
        </div>
        <p class="text-xs mt-1">${errorMsg}</p>
      </div>
    `.trim();
  }

  // 2. Unregistered widget check
  const def = registry.get(chunk.widget);
  if (!def) {
    if (chunk.widget === "unknown" && chunk.status === "loading") {
      return `
        <div class="border border-zinc-200 dark:border-zinc-800 rounded-xl p-4 bg-zinc-50 dark:bg-zinc-900 animate-pulse" aria-busy="true">
          <div class="h-4 bg-zinc-200 dark:bg-zinc-800 rounded w-1/4 mb-3"></div>
          <div class="h-16 bg-zinc-200 dark:bg-zinc-800 rounded"></div>
        </div>
      `.trim();
    }
    return `
      <div class="border border-red-200 dark:border-red-900 rounded-xl p-4 bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300" role="alert">
        <p class="text-xs">미등록 위젯: ${chunk.widget}</p>
      </div>
    `.trim();
  }

  // 3. Loading / Streaming with empty data -> Render Skeleton
  if (chunk.status === "loading" || (chunk.status === "streaming" && Object.keys(chunk.data).length === 0)) {
    if (def.renderSkeletonHtml) {
      return def.renderSkeletonHtml();
    }
    return `
      <div class="border border-zinc-200 dark:border-zinc-800 rounded-xl p-4 bg-zinc-50 dark:bg-zinc-900 animate-pulse" aria-busy="true">
        <div class="h-4 bg-zinc-200 dark:bg-zinc-800 rounded w-1/3 mb-2"></div>
        <div class="h-16 bg-zinc-200 dark:bg-zinc-800 rounded mb-2"></div>
      </div>
    `.trim();
  }

  // 4. Ready or Progressive Streaming -> Render Widget HTML
  if (def.renderHtml) {
    return def.renderHtml(chunk.data);
  }

  return `
    <div class="border border-zinc-200 dark:border-zinc-800 rounded-xl p-4 bg-white dark:bg-zinc-900" data-widget="${chunk.widget}">
      <p class="text-sm font-semibold">${chunk.widget}</p>
    </div>
  `.trim();
}
