/**
 * profiles.ts — Capability candidate profiling and integration surface extraction.
 *
 * Implements ProfilerPort: analyzes document revisions to extract candidate capabilities
 * (CLI, MCP, API, SDK, Library) with citation evidence quotes and license detection.
 *
 * SAFETY INVARIANT: Never executes any commands found in document text.
 */

import {
  type CapabilityCandidate,
  type DocumentRevision,
  type IntegrationType,
  type PortOptions,
  type ProfilerPort,
  withPortTimeout,
} from "./contracts.ts";

/**
 * Standard SPDX license identifiers recognized during profile extraction.
 */
const KNOWN_LICENSES: Array<{ pattern: RegExp; id: string }> = [
  { pattern: /\b(apache[\s-]?(?:license[\s-]?)?2\.0|apache[\s-]2\.0)\b/i, id: "Apache-2.0" },
  { pattern: /\b(mit[\s-]?license|mit)\b/i, id: "MIT" },
  { pattern: /\b(bsd[\s-]3[\s-]clause)\b/i, id: "BSD-3-Clause" },
  { pattern: /\b(bsd[\s-]2[\s-]clause)\b/i, id: "BSD-2-Clause" },
  { pattern: /\b(isc[\s-]?license|isc)\b/i, id: "ISC" },
  { pattern: /\b(gpl[\s-]?3\.0|gplv3)\b/i, id: "GPL-3.0" },
  { pattern: /\b(gpl[\s-]?2\.0|gplv2)\b/i, id: "GPL-2.0" },
  { pattern: /\b(lgpl[\s-]?3\.0|lgplv3)\b/i, id: "LGPL-3.0" },
  { pattern: /\b(mpl[\s-]?2\.0|mozilla public license 2\.0)\b/i, id: "MPL-2.0" },
  { pattern: /\b(unlicense)\b/i, id: "Unlicense" },
  { pattern: /\b(proprietary|commercial)\b/i, id: "Proprietary" },
];

/**
 * Detects license identifier from document text and previous license metadata.
 * Returns normalized SPDX id or "unknown".
 */
export function detectLicense(text: string, existingLicense?: string): string {
  if (existingLicense && existingLicense !== "unknown") {
    // If it's already a well-formatted string, verify against known patterns
    for (const entry of KNOWN_LICENSES) {
      if (entry.pattern.test(existingLicense)) {
        // Handle dual license like Apache-2.0 OR MIT
        if (/apache/i.test(existingLicense) && /mit/i.test(existingLicense)) {
          return "Apache-2.0 OR MIT";
        }
        return entry.id;
      }
    }
    return existingLicense;
  }

  if (!text || typeof text !== "string") {
    return "unknown";
  }

  // Look for license headings or declarations in text
  const licenseSectionMatch = text.match(/(?:##?\s*license|licensed under|라이선스)[\s\S]{0,300}/i);
  const targetSnippet = licenseSectionMatch ? licenseSectionMatch[0] : text;

  // Check for dual licensing
  if (/apache/i.test(targetSnippet) && /mit/i.test(targetSnippet)) {
    return "Apache-2.0 OR MIT";
  }

  for (const entry of KNOWN_LICENSES) {
    if (entry.pattern.test(targetSnippet)) {
      return entry.id;
    }
  }

  return "unknown";
}

/**
 * Surface patterns and keywords for integration classification.
 */
interface SurfaceRule {
  type: IntegrationType;
  regex: RegExp;
  nameSuffix: string;
  defaultDescription: string;
}

const SURFACE_RULES: SurfaceRule[] = [
  {
    type: "mcp",
    regex: /\b(model context protocol|mcp servers?|mcp tools?|mcp resources?|mcp\.json|@modelcontextprotocol)\b/i,
    nameSuffix: "MCP Server",
    defaultDescription: "Model Context Protocol (MCP) server providing tools or resources for agents.",
  },
  {
    type: "cli",
    regex: /\b(cli\b|command[\s-]line|terminal|npx\s+[a-z0-9_-]+|npm run\b|pip install\b|cargo install\b|brew install\b|터미널|명령줄|CLI 도구)\b/i,
    nameSuffix: "CLI",
    defaultDescription: "Command line interface executable from terminal or automation scripts.",
  },
  {
    type: "api",
    regex: /\b(rest api|http api|api endpoints?|graphql|webhooks?|POST\s+\/[a-z0-9_\-\/]+|GET\s+\/[a-z0-9_\-\/]+|API 엔드포인트|REST 호출)\b/i,
    nameSuffix: "API",
    defaultDescription: "HTTP/REST API service endpoint for programmatic integration.",
  },
  {
    type: "sdk",
    regex: /\b(sdk\b|client library|python sdk|typescript sdk|node sdk|go sdk|소프트웨어 개발 키트|SDK 클라이언트)\b/i,
    nameSuffix: "SDK",
    defaultDescription: "Client SDK library providing high-level typed bindings.",
  },
  {
    type: "library",
    regex: /\b(library|import\s+.*\s+from\b|require\(["'][a-z0-9_@\/-]+["']\)|package|라이브러리|모듈|패키지)\b/i,
    nameSuffix: "Library",
    defaultDescription: "Reusable software package or module importable into codebase.",
  },
];

/**
 * Trims and sanitizes an evidence quote to a readable snippet.
 */
function cleanEvidenceQuote(quote: string, maxLength = 240): string {
  const singleLine = quote
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (singleLine.length <= maxLength) {
    return singleLine;
  }
  return singleLine.slice(0, maxLength - 3) + "...";
}

/**
 * Extracts capability candidates from a document revision.
 * Strictly performs static text analysis; never executes any commands.
 */
export async function extractProfile(
  doc: DocumentRevision,
  options?: PortOptions,
): Promise<CapabilityCandidate[]> {
  return withPortTimeout(async () => {
    if (!doc || typeof doc.text !== "string" || !doc.text.trim()) {
      return [];
    }

    const titleBase = (doc.title?.trim() || "Tool").replace(/[:\-–—].*$/, "").trim();
    const paragraphs = doc.text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);

    const candidates: CapabilityCandidate[] = [];
    const seenKeys = new Set<string>();

    for (const paragraph of paragraphs) {
      // Check each surface rule against the paragraph
      for (const rule of SURFACE_RULES) {
        if (rule.regex.test(paragraph)) {
          const key = `${rule.type}:${titleBase}`;
          if (!seenKeys.has(key)) {
            seenKeys.add(key);

            // Find matching sentence or use paragraph snippet as quote
            const sentences = paragraph.split(/(?<=[.?!])\s+/);
            const matchingSentence = sentences.find((s) => rule.regex.test(s)) || paragraph;
            const evidenceQuote = cleanEvidenceQuote(matchingSentence);

            candidates.push({
              capability_name: `${titleBase} ${rule.nameSuffix}`,
              integration_type: rule.type,
              description: rule.defaultDescription,
              evidence_quote: evidenceQuote,
            });
          }
        }
      }
    }

    return candidates;
  }, options);
}

/**
 * ProfilerService implementing ProfilerPort.
 */
export class ProfilerService implements ProfilerPort {
  async profileDocument(
    doc: DocumentRevision,
    options?: PortOptions,
  ): Promise<CapabilityCandidate[]> {
    return extractProfile(doc, options);
  }
}
