// GenerativeStream.tsx — React/TSX Declarative Wrapper for Vercel AI SDK Compatible Generative UI Runtime.
//
// Conforms to:
//   - AC-1: Safe incomplete JSON chunk parsing with graceful skeleton -> ready transition
//   - AC-2: Whitelist-only widget rendering with script injection prevention
//   - AC-3: Strict node runtime compatibility & Anti-Slop visual invariants

import {
  repairIncompleteJson,
  parseStreamChunk,
  GenerativeStreamRuntime,
  renderGenerativeStreamHtml,
} from "./GenerativeStream.ts";
import type { StreamStatus, StreamChunk } from "./GenerativeStream.ts";
import { WidgetRegistry, defaultWidgetRegistry } from "./widgetRegistry.ts";
import type { BentoElement } from "../bento/BentoGrid.ts";

export type { StreamStatus, StreamChunk };
export {
  repairIncompleteJson,
  parseStreamChunk,
  GenerativeStreamRuntime,
  renderGenerativeStreamHtml,
};

export interface GenerativeStreamProps {
  /** Raw JSON chunk or pre-parsed StreamChunk */
  chunk: string | StreamChunk;
  registry?: WidgetRegistry;
  className?: string;
  id?: string;
}

/**
 * Declarative TSX-compatible GenerativeStream component wrapper.
 */
export function GenerativeStream(props: GenerativeStreamProps): BentoElement {
  const { chunk, registry = defaultWidgetRegistry, className = "", id } = props;
  const runtime = new GenerativeStreamRuntime(registry);
  const resolvedChunk =
    typeof chunk === "string" ? runtime.ingest(chunk) : chunk;
  const html = renderGenerativeStreamHtml(resolvedChunk, registry);

  return {
    type: "div",
    props: {
      id,
      className: `w-full max-w-full box-border ${className}`.trim(),
      "data-generative-stream": "true",
      "data-stream-status": resolvedChunk.status,
      "data-widget": resolvedChunk.widget,
      dangerouslySetInnerHTML: { __html: html },
    },
  };
}

export default GenerativeStream;
