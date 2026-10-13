/**
 * github.ts — GitHub REST connector for repositories, READMEs, and starred subscriptions.
 *
 * Implements repository metadata & README retrieval and starred repository pagination.
 * Preserves previous revisions on rate limits (429/403) and transient failures.
 * Fully static; never executes repository code or install scripts.
 */

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  type DocumentRevision,
  type SourceSpec,
  validateDocumentRevision,
  withPortTimeout,
} from "../contracts.ts";
import { assertSafeUrl } from "../fetch.ts";
import { detectLicense } from "../profiles.ts";

export interface GitHubConnectorOptions {
  githubToken?: string;
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxSizeBytes?: number;
  allowPrivateNetwork?: boolean;
  confirmTombstone?: boolean;
  dnsLookup?: (hostname: string) => Promise<string[]>;
}

interface GitHubRepoMetadata {
  name: string;
  full_name: string;
  description?: string;
  html_url: string;
  default_branch: string;
  stargazers_count: number;
  pushed_at?: string;
  license?: {
    key?: string;
    name?: string;
    spdx_id?: string;
  };
}

interface GitHubStarredRepo {
  name: string;
  full_name: string;
  description?: string;
  html_url: string;
  stargazers_count?: number;
  license?: {
    spdx_id?: string;
    name?: string;
  };
}

/**
 * Extracts owner and repo name from github-repo URL.
 * Expected URL format: https://github.com/owner/repo
 */
export function parseGitHubRepoUrl(url: string): { owner: string; repo: string } {
  const parsed = new URL(url);
  const segments = parsed.pathname.split("/").filter(Boolean);
  const owner = segments[0];
  const repo = segments[1];
  if (!owner || !repo) {
    throw new Error(`Invalid GitHub repository URL: ${url}`);
  }
  return {
    owner,
    repo: repo.replace(/\.git$/i, ""),
  };
}

/**
 * Extracts username from github-stars URL.
 * Supported URL formats: https://github.com/stars/owner or https://github.com/owner/stars
 */
export function parseGitHubStarsUrl(url: string): string {
  const parsed = new URL(url);
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments[0]?.toLowerCase() === "stars" && segments[1]) {
    return segments[1];
  }
  if (segments[1]?.toLowerCase() === "stars" && segments[0]) {
    return segments[0];
  }
  if (segments[0]) {
    return segments[0];
  }
  throw new Error(`Invalid GitHub stars URL: ${url}`);
}

let cachedGitHubToken: string | null = null;

function resolveGitHubToken(token?: string): string | undefined {
  if (token) return token;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  if (cachedGitHubToken !== null) return cachedGitHubToken || undefined;
  try {
    const out = execSync("gh auth token", {
      encoding: "utf-8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (out && !out.includes(" ")) {
      cachedGitHubToken = out;
      return out;
    }
  } catch {
    cachedGitHubToken = "";
  }
  return undefined;
}

/**
 * Creates standard HTTP headers for GitHub REST API calls.
 */
function createGitHubHeaders(token?: string, etag?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": "create-agent-harness-knowledge/1.0",
    Accept: "application/vnd.github.v3+json",
  };
  const activeToken = resolveGitHubToken(token);
  if (activeToken) {
    headers.Authorization = `Bearer ${activeToken}`;
  }
  if (etag) {
    headers["If-None-Match"] = etag;
  }
  return headers;
}

export class GitHubConnector {
  /**
   * Fetches GitHub repository metadata and README without cloning.
   */
  static async fetchRepo(
    source: SourceSpec,
    previousRevision?: DocumentRevision,
    options?: GitHubConnectorOptions,
  ): Promise<DocumentRevision> {
    return withPortTimeout(async (signal) => {
      const fetchImpl = options?.fetchFn || globalThis.fetch;
      const { owner, repo } = parseGitHubRepoUrl(source.url);

      const repoApiUrl = `https://api.github.com/repos/${owner}/${repo}`;
      await assertSafeUrl(repoApiUrl, options);

      const headers = createGitHubHeaders(
        options?.githubToken,
        previousRevision?.status === "success" ? previousRevision.revision : undefined,
      );

      let repoRes: Response;
      try {
        repoRes = await fetchImpl(repoApiUrl, {
          method: "GET",
          headers,
          signal,
        });
      } catch (err) {
        if (previousRevision) {
          return validateDocumentRevision({
            ...previousRevision,
            fetched_at: new Date().toISOString(),
            status: "retry",
            error: `Network failure fetching GitHub repo: ${String(err)}`,
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
          error: `Network failure fetching GitHub repo: ${String(err)}`,
        });
      }

      // Handle 304 Not Modified
      if (repoRes.status === 304 && previousRevision) {
        return validateDocumentRevision({
          ...previousRevision,
          fetched_at: new Date().toISOString(),
          status: "unchanged",
        });
      }

      // Handle Rate Limiting (429 or 403 with rate limit indication)
      if (
        repoRes.status === 429 ||
        (repoRes.status === 403 &&
          (repoRes.headers.get("x-ratelimit-remaining") === "0" ||
            repoRes.headers.get("retry-after")))
      ) {
        const retryAfter =
          repoRes.headers.get("retry-after") ||
          repoRes.headers.get("x-ratelimit-reset") ||
          "60";
        const errMsg = `HTTP ${repoRes.status}: GitHub rate limit exceeded. Retry-After: ${retryAfter}`;
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

      // Handle 404 Not Found (Transient vs Tombstone)
      if (repoRes.status === 404) {
        if (previousRevision) {
          const isConfirmed =
            options?.confirmTombstone ||
            (previousRevision.status === "retry" &&
              previousRevision.error?.includes("404"));
          if (isConfirmed) {
            return validateDocumentRevision({
              ...previousRevision,
              fetched_at: new Date().toISOString(),
              status: "tombstone",
              text: "",
              revision: `tombstone-${Date.now()}`,
              error: "Repository deleted or not found (confirmed tombstone)",
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
          error: "HTTP 404 Repository not found",
        });
      }

      // Handle 5xx Server Errors
      if (repoRes.status >= 500) {
        const errMsg = `HTTP ${repoRes.status} GitHub upstream server error`;
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

      if (!repoRes.ok) {
        throw new Error(`GitHub API request failed with status ${repoRes.status}`);
      }

      const repoData = (await repoRes.json()) as GitHubRepoMetadata;
      const repoEtag = repoRes.headers.get("etag") || "";

      // Fetch README
      const readmeApiUrl = `https://api.github.com/repos/${owner}/${repo}/readme`;
      await assertSafeUrl(readmeApiUrl, options);

      let readmeText = "";
      let readmeSha = "";

      try {
        const readmeRes = await fetchImpl(readmeApiUrl, {
          method: "GET",
          headers: createGitHubHeaders(options?.githubToken),
          signal,
        });

        if (readmeRes.ok) {
          const readmeJson = (await readmeRes.json()) as { content?: string; sha?: string };
          readmeSha = readmeJson.sha || "";
          if (readmeJson.content) {
            readmeText = Buffer.from(readmeJson.content, "base64").toString("utf8");
          }
        }
      } catch {
        // Fallback gracefully to description if README fails to fetch
      }

      const fullText = readmeText.trim()
        ? readmeText.trim()
        : `# ${repoData.name}\n\n${repoData.description || ""}\n\nURL: ${repoData.html_url}`;

      const contentHash = createHash("sha256").update(fullText).digest("hex");

      // Check unchanged by content hash
      if (previousRevision && previousRevision.content_hash === contentHash) {
        return validateDocumentRevision({
          ...previousRevision,
          fetched_at: new Date().toISOString(),
          status: "unchanged",
        });
      }

      const revisionId = readmeSha || repoEtag || repoData.pushed_at || contentHash.slice(0, 16);
      const title =
        source.title ||
        (repoData.description ? `${repoData.name}: ${repoData.description}` : repoData.name);

      const rawLicense = repoData.license?.spdx_id || repoData.license?.name || "unknown";
      const license = detectLicense(fullText, rawLicense);

      return validateDocumentRevision({
        document_id: previousRevision?.document_id || `doc-${source.source_id.slice(0, 16)}`,
        source_id: source.source_id,
        url: source.url,
        revision: revisionId,
        content_hash: contentHash,
        title,
        text: fullText,
        license,
        fetched_at: new Date().toISOString(),
        status: "success",
      });
    }, options);
  }

  /**
   * Fetches starred repositories for a user with pagination.
   * Membership removal is confirmed only when all pages succeed.
   */
  static async fetchStars(
    source: SourceSpec,
    previousRevision?: DocumentRevision,
    options?: GitHubConnectorOptions,
  ): Promise<DocumentRevision> {
    return withPortTimeout(async (signal) => {
      const fetchImpl = options?.fetchFn || globalThis.fetch;
      const username = parseGitHubStarsUrl(source.url);

      const allStarred: GitHubStarredRepo[] = [];
      let page = 1;
      let hasMore = true;

      while (hasMore) {
        const pageUrl = `https://api.github.com/users/${username}/starred?per_page=100&page=${page}`;
        await assertSafeUrl(pageUrl, options);

        let res: Response;
        try {
          res = await fetchImpl(pageUrl, {
            method: "GET",
            headers: createGitHubHeaders(options?.githubToken),
            signal,
          });
        } catch (err) {
          // On network failure mid-pagination, preserve previous revision!
          if (previousRevision) {
            return validateDocumentRevision({
              ...previousRevision,
              fetched_at: new Date().toISOString(),
              status: "retry",
              error: `Network failure fetching starred repos on page ${page}: ${String(err)}`,
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
            error: `Network failure fetching starred repos: ${String(err)}`,
          });
        }

        // Handle rate limiting mid-pagination
        if (
          res.status === 429 ||
          (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0")
        ) {
          const retryAfter = res.headers.get("retry-after") || "60";
          const errMsg = `HTTP ${res.status} Rate limited while paginating stars page ${page}. Retry-After: ${retryAfter}`;
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

        if (!res.ok) {
          if (previousRevision) {
            return validateDocumentRevision({
              ...previousRevision,
              fetched_at: new Date().toISOString(),
              status: "retry",
              error: `HTTP ${res.status} failure fetching starred page ${page}`,
            });
          }
          throw new Error(`Failed to fetch stars: HTTP ${res.status}`);
        }

        const pageItems = (await res.json()) as GitHubStarredRepo[];
        if (!Array.isArray(pageItems) || pageItems.length === 0) {
          hasMore = false;
          break;
        }

        allStarred.push(...pageItems);

        // Check Link header for next page
        const linkHeader = res.headers.get("link") || "";
        if (!linkHeader.includes('rel="next"') || pageItems.length < 100) {
          hasMore = false;
        } else {
          page++;
          // Safety guard against infinite pagination
          if (page > 50) {
            hasMore = false;
          }
        }
      }

      // Sort deterministically by full_name
      allStarred.sort((a, b) => (a.full_name || "").localeCompare(b.full_name || ""));

      const lines: string[] = [
        `# Starred Repositories: ${username}`,
        `Total: ${allStarred.length}`,
        "",
      ];

      for (const item of allStarred) {
        const desc = item.description ? ` - ${item.description}` : "";
        const stars = item.stargazers_count !== undefined ? ` (⭐ ${item.stargazers_count})` : "";
        const lic = item.license?.spdx_id ? ` [License: ${item.license.spdx_id}]` : "";
        lines.push(`- [${item.full_name}](${item.html_url})${desc}${stars}${lic}`);
      }

      const fullText = lines.join("\n");
      const contentHash = createHash("sha256").update(fullText).digest("hex");

      if (previousRevision && previousRevision.content_hash === contentHash) {
        return validateDocumentRevision({
          ...previousRevision,
          fetched_at: new Date().toISOString(),
          status: "unchanged",
        });
      }

      const revisionId = createHash("sha256")
        .update(`${username}:${allStarred.length}:${contentHash}`)
        .digest("hex")
        .slice(0, 16);

      return validateDocumentRevision({
        document_id: previousRevision?.document_id || `doc-${source.source_id.slice(0, 16)}`,
        source_id: source.source_id,
        url: source.url,
        revision: revisionId,
        content_hash: contentHash,
        title: source.title || `${username} Starred Repositories (${allStarred.length})`,
        text: fullText,
        license: "unknown",
        fetched_at: new Date().toISOString(),
        status: "success",
      });
    }, options);
  }
}
