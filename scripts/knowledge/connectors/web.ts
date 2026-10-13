/**
 * web.ts — Web connector for HTML and Markdown pages.
 *
 * Implements HTTP GET retrieval with custom User-Agent, SSRF validation on every redirect hop,
 * size & timeout enforcement, and text extraction stripping scripts/styles/navigation.
 * Unsupported pages (JS-rendering or login required) are marked with 'unsupported' status.
 */

import { createHash } from "node:crypto";
import {
  type DocumentRevision,
  FetchError,
  type SourceSpec,
  validateDocumentRevision,
  withPortTimeout,
} from "../contracts.ts";
import { assertSafeUrl } from "../fetch.ts";
import { detectLicense } from "../profiles.ts";

export interface WebConnectorOptions {
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxSizeBytes?: number;
  allowPrivateNetwork?: boolean;
  confirmTombstone?: boolean;
  dnsLookup?: (hostname: string) => Promise<string[]>;
}

export interface ExtractedWebContent {
  title?: string;
  text: string;
  canonicalUrl?: string;
  isUnsupported?: boolean;
  unsupportedReason?: string;
}

/**
 * Decodes common HTML entities into characters.
 */
export function decodeHtmlEntities(raw: string): string {
  return raw
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * Extracts clean readable text, title, and canonical URL from raw HTML.
 * Strips script, style, noscript, svg, nav, header, and footer tags.
 */
export function extractHtmlContent(html: string, baseUrl?: string): ExtractedWebContent {
  if (!html || typeof html !== "string") {
    return { text: "" };
  }

  // Extract <title> or <meta property="og:title">
  let title: string | undefined;
  const ogTitleMatch = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  const tagTitleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);

  if (ogTitleMatch && ogTitleMatch[1]) {
    title = decodeHtmlEntities(ogTitleMatch[1].trim());
  } else if (tagTitleMatch && tagTitleMatch[1]) {
    title = decodeHtmlEntities(tagTitleMatch[1].trim());
  }

  // Extract <link rel="canonical">
  let canonicalUrl: string | undefined;
  const canonicalMatch = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i);
  if (canonicalMatch && canonicalMatch[1]) {
    canonicalUrl = canonicalMatch[1].trim();
  }

  // Check for SPA requiring JS
  const isSpa =
    /<div[^>]+id=["'](root|app)["'][^>]*>\s*<\/div>/i.test(html) &&
    !/<article|<main|<section/i.test(html);
  const requiresJs =
    /please enable javascript|need to enable javascript|javascript is required|turn on javascript/i.test(
      html,
    );

  // Check for login requirement
  const requiresLogin =
    /please sign in|please log in|login required|authentication required|sign in to view/i.test(
      html,
    );

  // Strip non-content blocks
  let cleaned = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")
    .replace(/<nav\b[\s\S]*?<\/nav>/gi, " ")
    .replace(/<header\b[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer\b[\s\S]*?<\/footer>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");

  // Transform Markdown-like structure
  cleaned = cleaned
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n\n# $1\n\n")
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n\n## $1\n\n")
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n\n### $1\n\n")
    .replace(/<h[4-6][^>]*>([\s\S]*?)<\/h[4-6]>/gi, "\n\n#### $1\n\n")
    .replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, "\n\n```\n$1\n```\n\n")
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, " `$1` ")
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "\n- $1")
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, "\n\n$1\n\n")
    .replace(/<br\s*\/?>/gi, "\n");

  // Strip remaining HTML tags
  cleaned = cleaned.replace(/<[^>]+>/g, " ");

  // Decode entities
  cleaned = decodeHtmlEntities(cleaned);

  // Collapse whitespace
  const lines = cleaned
    .split("\n")
    .map((line) => line.trim())
    .filter((line, idx, arr) => line.length > 0 || (idx > 0 && (arr[idx - 1]?.length ?? 0) > 0));

  const text = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();

  // If text is effectively empty and page requires JS or login
  if (text.length < 120 && (isSpa || requiresJs)) {
    return {
      title,
      text,
      canonicalUrl,
      isUnsupported: true,
      unsupportedReason: "JavaScript rendering required",
    };
  }

  if (text.length < 120 && requiresLogin) {
    return {
      title,
      text,
      canonicalUrl,
      isUnsupported: true,
      unsupportedReason: "Authentication required",
    };
  }

  return {
    title,
    text,
    canonicalUrl,
  };
}

export class WebConnector {
  static readonly USER_AGENT = "create-agent-harness-knowledge/1.0";
  static readonly DEFAULT_MAX_SIZE = 5 * 1024 * 1024; // 5MB

  /**
   * Fetches a web page with manual redirect handling, SSRF validation, and content parsing.
   */
  static async fetchPage(
    source: SourceSpec,
    previousRevision?: DocumentRevision,
    options?: WebConnectorOptions,
  ): Promise<DocumentRevision> {
    return withPortTimeout(async (signal) => {
      const fetchImpl = options?.fetchFn || globalThis.fetch;
      const maxSizeBytes = options?.maxSizeBytes || WebConnector.DEFAULT_MAX_SIZE;

      let currentUrl = source.url;
      const visited = new Set<string>([currentUrl]);
      let hops = 0;
      let finalRes: Response | null = null;

      while (hops < 6) {
        await assertSafeUrl(currentUrl, options);

        const headers: Record<string, string> = {
          "User-Agent": WebConnector.USER_AGENT,
          Accept: "text/html,application/xhtml+xml,text/markdown,text/plain;q=0.9,*/*;q=0.8",
        };

        if (previousRevision?.status === "success" && previousRevision.revision) {
          if (
            previousRevision.revision.startsWith('"') ||
            previousRevision.revision.startsWith("W/")
          ) {
            headers["If-None-Match"] = previousRevision.revision;
          } else {
            headers["If-Modified-Since"] = previousRevision.revision;
          }
        }

        let res: Response;
        try {
          res = await fetchImpl(currentUrl, {
            method: "GET",
            headers,
            redirect: "manual",
            signal,
          });
        } catch (err) {
          if (previousRevision) {
            return validateDocumentRevision({
              ...previousRevision,
              fetched_at: new Date().toISOString(),
              status: "retry",
              error: `Fetch network failure: ${String(err)}`,
            });
          }
          return validateDocumentRevision({
            document_id: `doc-${source.source_id.slice(0, 16)}`,
            source_id: source.source_id,
            url: source.url,
            revision: "network-error",
            content_hash: createHash("sha256").update("").digest("hex"),
            text: "",
            fetched_at: new Date().toISOString(),
            status: "retry",
            error: `Fetch network failure: ${String(err)}`,
          });
        }

        // Handle Redirects
        if ([301, 302, 303, 307, 308].includes(res.status)) {
          const locationHeader = res.headers.get("location");
          if (!locationHeader) {
            throw new FetchError("FETCH_FAILED", `Redirect status ${res.status} missing Location header`, {
              url: currentUrl,
            });
          }

          const nextUrl = new URL(locationHeader, currentUrl).toString();

          if (visited.has(nextUrl)) {
            throw new FetchError("FETCH_FAILED", `Redirect loop detected at ${nextUrl}`, {
              url: currentUrl,
              nextUrl,
            });
          }

          hops++;
          if (hops > 5) {
            throw new FetchError("FETCH_FAILED", "Too many redirects (exceeded 5)", {
              url: source.url,
              hops,
            });
          }

          // Validate target URL against SSRF
          await assertSafeUrl(nextUrl, options);

          visited.add(nextUrl);
          currentUrl = nextUrl;
          continue;
        }

        finalRes = res;
        break;
      }

      if (!finalRes) {
        throw new FetchError("FETCH_FAILED", "Failed to retrieve web response after redirect processing");
      }

      // Handle 304 Not Modified
      if (finalRes.status === 304 && previousRevision) {
        return validateDocumentRevision({
          ...previousRevision,
          fetched_at: new Date().toISOString(),
          status: "unchanged",
        });
      }

      // Handle 429 Rate Limited
      if (finalRes.status === 429) {
        const retryAfter = finalRes.headers.get("retry-after") || "60";
        const errMsg = `HTTP 429 Rate limited. Retry-After: ${retryAfter}`;
        if (previousRevision) {
          return validateDocumentRevision({
            ...previousRevision,
            fetched_at: new Date().toISOString(),
            status: "retry",
            error: errMsg,
          });
        }
        return validateDocumentRevision({
          document_id: `doc-${source.source_id.slice(0, 16)}`,
          source_id: source.source_id,
          url: source.url,
          revision: "rate-limited",
          content_hash: createHash("sha256").update("").digest("hex"),
          text: "",
          fetched_at: new Date().toISOString(),
          status: "retry",
          error: errMsg,
        });
      }

      // Handle 404 Not Found (Transient vs Confirmed Tombstone)
      if (finalRes.status === 404) {
        if (previousRevision) {
          const isConfirmed =
            options?.confirmTombstone ||
            (previousRevision.status === "retry" && previousRevision.error?.includes("404"));
          if (isConfirmed) {
            return validateDocumentRevision({
              ...previousRevision,
              fetched_at: new Date().toISOString(),
              status: "tombstone",
              text: "",
              revision: `tombstone-${Date.now()}`,
              error: "Resource confirmed deleted (HTTP 404)",
            });
          }
          return validateDocumentRevision({
            ...previousRevision,
            fetched_at: new Date().toISOString(),
            status: "retry",
            error: "HTTP 404 Not Found (transient: 1st observation)",
          });
        }
        return validateDocumentRevision({
          document_id: `doc-${source.source_id.slice(0, 16)}`,
          source_id: source.source_id,
          url: source.url,
          revision: "not-found",
          content_hash: createHash("sha256").update("").digest("hex"),
          text: "",
          fetched_at: new Date().toISOString(),
          status: "failed",
          error: "HTTP 404 Not Found",
        });
      }

      // Handle 5xx Server Errors
      if (finalRes.status >= 500) {
        const errMsg = `HTTP ${finalRes.status} Server error`;
        if (previousRevision) {
          return validateDocumentRevision({
            ...previousRevision,
            fetched_at: new Date().toISOString(),
            status: "retry",
            error: errMsg,
          });
        }
        return validateDocumentRevision({
          document_id: `doc-${source.source_id.slice(0, 16)}`,
          source_id: source.source_id,
          url: source.url,
          revision: "server-error",
          content_hash: createHash("sha256").update("").digest("hex"),
          text: "",
          fetched_at: new Date().toISOString(),
          status: "retry",
          error: errMsg,
        });
      }

      if (!finalRes.ok) {
        throw new FetchError("FETCH_FAILED", `HTTP error ${finalRes.status}`, {
          url: currentUrl,
          status: finalRes.status,
        });
      }

      // Check Content-Length if present
      const contentLengthHeader = finalRes.headers.get("content-length");
      if (contentLengthHeader) {
        const length = parseInt(contentLengthHeader, 10);
        if (length > maxSizeBytes) {
          throw new FetchError(
            "CONTENT_TOO_LARGE",
            `Content length ${length} exceeds maximum allowed size ${maxSizeBytes}`,
            { length, maxSizeBytes },
          );
        }
      }

      const contentType = (finalRes.headers.get("content-type") || "").toLowerCase();

      // Check for binary content
      if (
        contentType.includes("application/pdf") ||
        contentType.includes("application/zip") ||
        contentType.includes("application/octet-stream") ||
        contentType.startsWith("image/") ||
        contentType.startsWith("audio/") ||
        contentType.startsWith("video/")
      ) {
        return validateDocumentRevision({
          document_id: previousRevision?.document_id || `doc-${source.source_id.slice(0, 16)}`,
          source_id: source.source_id,
          url: source.url,
          revision: "unsupported-binary",
          content_hash: createHash("sha256").update("").digest("hex"),
          text: "",
          fetched_at: new Date().toISOString(),
          status: "unsupported",
          error: `Unsupported binary content type: ${contentType}`,
        });
      }

      const rawBody = await finalRes.text();
      if (Buffer.byteLength(rawBody, "utf8") > maxSizeBytes) {
        throw new FetchError(
          "CONTENT_TOO_LARGE",
          `Response body size exceeds maximum allowed size ${maxSizeBytes}`,
          { maxSizeBytes },
        );
      }

      let parsedTitle: string | undefined;
      let parsedText = "";

      if (contentType.includes("text/markdown") || source.url.endsWith(".md")) {
        parsedText = rawBody.trim();
        const mdTitleMatch = parsedText.match(/^#\s+(.+)$/m);
        if (mdTitleMatch?.[1]) {
          parsedTitle = mdTitleMatch[1].trim();
        }
      } else {
        // Parse HTML
        const extracted = extractHtmlContent(rawBody, currentUrl);
        if (extracted.isUnsupported) {
          return validateDocumentRevision({
            document_id: previousRevision?.document_id || `doc-${source.source_id.slice(0, 16)}`,
            source_id: source.source_id,
            url: source.url,
            revision: "unsupported-page",
            content_hash: createHash("sha256").update("").digest("hex"),
            text: extracted.text || "",
            fetched_at: new Date().toISOString(),
            status: "unsupported",
            error: extracted.unsupportedReason || "Page unsupported",
          });
        }
        parsedTitle = extracted.title;
        parsedText = extracted.text;
      }

      const contentHash = createHash("sha256").update(parsedText).digest("hex");

      // Check unchanged by content hash
      if (previousRevision && previousRevision.content_hash === contentHash) {
        return validateDocumentRevision({
          ...previousRevision,
          fetched_at: new Date().toISOString(),
          status: "unchanged",
        });
      }

      const revisionId =
        finalRes.headers.get("etag") ||
        finalRes.headers.get("last-modified") ||
        contentHash.slice(0, 16);

      const title = source.title || parsedTitle || "Untitled Page";
      const license = detectLicense(parsedText, previousRevision?.license);

      return validateDocumentRevision({
        document_id: previousRevision?.document_id || `doc-${source.source_id.slice(0, 16)}`,
        source_id: source.source_id,
        url: source.url,
        revision: revisionId,
        content_hash: contentHash,
        title,
        text: parsedText,
        license,
        fetched_at: new Date().toISOString(),
        status: "success",
      });
    }, options);
  }
}
