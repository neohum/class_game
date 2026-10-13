/**
 * intake.ts — Knowledge library URL registry intake service.
 *
 * Implements source registration, metadata update, disabling, registry listing,
 * validation, and Netscape bookmark HTML import into the Git-tracked URL registry.
 *
 * Invariants:
 * - Atomic writes via .tmp file and rename.
 * - Idempotency: re-adding existing source updates metadata without duplicate files.
 * - Git and network isolation: never performs git commit/push or network fetches.
 * - Strict URL validation: rejects credentials and unsupported schemes.
 */

import { existsSync, readFileSync, writeFileSync, renameSync, readdirSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  canonicalizeUrl,
  validateSourceSpec,
  withPortTimeout,
  IntakeError,
  type SourceSpec,
  type SourceSpecInput,
  type SourceKind,
  type SourceProvenance,
  type PortOptions,
  type IntakePort,
} from "./contracts.ts";
import {
  extractChromeBookmarks,
  listChromeBookmarkFolders,
  resolveChromeBookmarksPath,
  type ExtractedChromeBookmark,
  type ChromeBookmarkFolder,
} from "./importers/chrome.ts";
import {
  fetchGitHubStarredRepos,
  fetchGitHubUserRepos,
  detectGitHubUser,
  type ExtractedGitHubRepo,
} from "./importers/github.ts";

// ============================================================================
// Types & Options
// ============================================================================

export interface IntakeServiceOptions {
  baseDir?: string;
  sourcesDir?: string;
  catalogPath?: string;
  defaultRefreshHours?: Record<SourceKind, number>;
}

export interface ListSourcesFilter {
  kind?: SourceKind;
  enabled?: boolean;
  tag?: string;
}

export interface BookmarkImportOptions {
  folderName?: string;
  tags?: string[];
  portOptions?: PortOptions;
}

export interface BookmarkImportResult {
  imported: SourceSpec[];
  skipped: number;
}

export interface RegistryValidationResult {
  valid: boolean;
  errors: string[];
  count: number;
}

export interface ExtractedBookmark {
  url: string;
  title?: string;
  tags?: string[];
}

// ============================================================================
// Helper Utilities
// ============================================================================

/**
 * Formats a Date into an ISO 8601 string with a fixed timezone offset.
 * Default is Asia/Seoul (+09:00, 540 minutes).
 */
export function nowIsoWithOffset(date: Date = new Date(), offsetMinutes = 540): string {
  const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const offsetHours = Math.floor(Math.abs(offsetMinutes) / 60);
  const offsetMins = Math.abs(offsetMinutes) % 60;
  const offsetStr = `${sign}${pad(offsetHours)}:${pad(offsetMins)}`;

  const localTime = new Date(date.getTime() + offsetMinutes * 60000);
  const year = localTime.getUTCFullYear();
  const month = pad(localTime.getUTCMonth() + 1);
  const day = pad(localTime.getUTCDate());
  const hours = pad(localTime.getUTCHours());
  const minutes = pad(localTime.getUTCMinutes());
  const seconds = pad(localTime.getUTCSeconds());

  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}${offsetStr}`;
}

/**
 * Decodes basic HTML entities commonly found in browser bookmark exports.
 */
export function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&nbsp;/g, " ");
}

/**
 * Infers SourceKind from a raw URL.
 */
export function inferSourceKind(url: string): SourceKind {
  try {
    const parsed = new URL(url.trim());
    const host = parsed.hostname.toLowerCase();
    if (host === "github.com" || host === "www.github.com") {
      const parts = parsed.pathname.split("/").filter(Boolean);
      if (parts[0]?.toLowerCase() === "stars" || parsed.searchParams.get("tab") === "stars") {
        return "github-stars";
      }
      const p0 = parts[0];
      if (
        p0 &&
        parts.length >= 2 &&
        !["features", "pricing", "explore", "topics", "trending", "stars"].includes(p0.toLowerCase())
      ) {
        return "github-repo";
      }
    }
  } catch {
    // If malformed, fallback to web so canonicalizeUrl throws structured IntakeError
  }
  return "web";
}

/**
 * Atomically writes data to a file by writing to a temporary file in the same
 * directory and performing an atomic rename.
 */
function atomicWriteJson(filePath: string, data: unknown): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const content = JSON.stringify(data, null, 2) + "\n";
  const tempPath = `${filePath}.${Date.now()}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    writeFileSync(tempPath, content, "utf8");
    renameSync(tempPath, filePath);
  } catch (err) {
    try {
      if (existsSync(tempPath)) {
        // cleanup temp file if rename failed
        renameSync(tempPath, tempPath + ".failed");
      }
    } catch {
      // ignore secondary failure
    }
    throw err;
  }
}

/**
 * Extracts bookmarks from Netscape Bookmark HTML format.
 * If folderName is supplied, extracts only bookmarks nested under that folder.
 */
export function extractBookmarks(
  htmlContent: string,
  folderName?: string,
): ExtractedBookmark[] {
  let contentToParse = htmlContent;

  if (folderName && folderName.trim()) {
    const target = folderName.trim().toLowerCase();
    const h3Regex = /<h3\b[^>]*>([\s\S]*?)<\/h3>/gi;
    let match: RegExpExecArray | null;
    let foundStart = -1;

    while ((match = h3Regex.exec(htmlContent)) !== null) {
      const rawText = match[1] ?? "";
      const headingText = decodeHtmlEntities(rawText.replace(/<[^>]+>/g, "")).trim().toLowerCase();
      if (headingText === target) {
        foundStart = match.index + match[0].length;
        break;
      }
    }

    if (foundStart === -1) {
      return [];
    }

    // Find opening <dl> for this folder
    const dlOpenRegex = /<dl\b/gi;
    dlOpenRegex.lastIndex = foundStart;
    const dlMatch = dlOpenRegex.exec(htmlContent);

    if (dlMatch) {
      let depth = 1;
      const pos = dlMatch.index + dlMatch[0].length;
      const tagRegex = /<\/?dl\b/gi;
      tagRegex.lastIndex = pos;

      let nextTag: RegExpExecArray | null;
      let foundEnd = -1;
      while ((nextTag = tagRegex.exec(htmlContent)) !== null) {
        if (nextTag[0].toLowerCase().startsWith("</dl")) {
          depth--;
          if (depth === 0) {
            foundEnd = nextTag.index;
            break;
          }
        } else {
          depth++;
        }
      }

      contentToParse = foundEnd !== -1 ? htmlContent.slice(pos, foundEnd) : htmlContent.slice(pos);
    } else {
      contentToParse = htmlContent.slice(foundStart);
    }
  }

  const bookmarks: ExtractedBookmark[] = [];
  const aRegex = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let aMatch: RegExpExecArray | null;

  while ((aMatch = aRegex.exec(contentToParse)) !== null) {
    const attrs = aMatch[1] ?? "";
    const rawTitle = aMatch[2] ?? "";

    const hrefMatch = attrs.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const rawUrl = hrefMatch ? (hrefMatch[1] ?? hrefMatch[2] ?? hrefMatch[3]) : "";
    if (!rawUrl) continue;

    const trimmedUrl = rawUrl.trim();

    const tagsMatch = attrs.match(/\btags\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const rawTags = tagsMatch ? (tagsMatch[1] ?? tagsMatch[2] ?? tagsMatch[3]) : undefined;
    const tags = rawTags
      ? rawTags.split(",").map((t) => t.trim()).filter(Boolean)
      : [];

    const cleanTitle = decodeHtmlEntities(rawTitle.replace(/<[^>]+>/g, "")).trim();

    bookmarks.push({
      url: trimmedUrl,
      title: cleanTitle || undefined,
      tags: tags.length > 0 ? tags : undefined,
    });
  }

  return bookmarks;
}

// ============================================================================
// IntakeService
// ============================================================================

export class IntakeService implements IntakePort {
  readonly baseDir: string;
  readonly sourcesDir: string;
  readonly catalogPath: string;
  readonly defaultRefreshHours: Record<SourceKind, number>;

  constructor(options: IntakeServiceOptions = {}) {
    const defaultBase = options.baseDir
      ? resolve(options.baseDir)
      : resolve(process.cwd(), "knowledge");

    this.baseDir = defaultBase;
    this.sourcesDir = options.sourcesDir ? resolve(options.sourcesDir) : join(defaultBase, "sources");
    this.catalogPath = options.catalogPath ? resolve(options.catalogPath) : join(defaultBase, "catalog.json");

    const fallbackHours: Record<SourceKind, number> = {
      "github-repo": 24,
      "github-stars": 24,
      "web": 168,
    };

    if (options.defaultRefreshHours) {
      this.defaultRefreshHours = { ...fallbackHours, ...options.defaultRefreshHours };
    } else {
      this.defaultRefreshHours = this.loadCatalogRefreshHours(this.catalogPath, fallbackHours);
    }
  }

  private loadCatalogRefreshHours(
    catalogPath: string,
    fallback: Record<SourceKind, number>,
  ): Record<SourceKind, number> {
    try {
      if (existsSync(catalogPath)) {
        const raw = JSON.parse(readFileSync(catalogPath, "utf8"));
        if (raw?.default_refresh_hours && typeof raw.default_refresh_hours === "object") {
          return {
            "github-repo": Number(raw.default_refresh_hours["github-repo"]) || fallback["github-repo"],
            "github-stars": Number(raw.default_refresh_hours["github-stars"]) || fallback["github-stars"],
            "web": Number(raw.default_refresh_hours["web"]) || fallback["web"],
          };
        }
      }
    } catch {
      // fallback
    }
    return fallback;
  }

  /**
   * Adds a new source or idempotently updates an existing source in place.
   */
  async addSource(
    input: SourceSpecInput | Omit<SourceSpec, "source_id" | "created_at" | "updated_at">,
    options?: PortOptions,
  ): Promise<SourceSpec> {
    return await withPortTimeout(async () => {
      const { canonicalUrl, sourceId } = canonicalizeUrl(input.url, input.kind);
      const targetFile = join(this.sourcesDir, `${sourceId}.json`);

      let spec: SourceSpec;
      const now = nowIsoWithOffset();

      if (existsSync(targetFile)) {
        // Existing source — update metadata idempotently while preserving created_at
        let existing: SourceSpec;
        try {
          const raw = JSON.parse(readFileSync(targetFile, "utf8"));
          existing = validateSourceSpec(raw);
        } catch (err) {
          throw new IntakeError("INVALID_SOURCE_SPEC", `Corrupt existing source file for '${sourceId}'`, {
            targetFile,
            cause: String(err),
          });
        }

        const mergedTags = input.tags !== undefined
          ? Array.from(new Set([...existing.tags, ...input.tags]))
          : existing.tags;

        spec = {
          source_id: sourceId,
          kind: input.kind,
          url: canonicalUrl,
          title: input.title !== undefined ? input.title : existing.title,
          tags: mergedTags,
          note: input.note !== undefined ? input.note : existing.note,
          enabled: input.enabled !== undefined ? input.enabled : existing.enabled,
          refresh_hours: input.refresh_hours !== undefined ? input.refresh_hours : existing.refresh_hours,
          provenance: input.provenance !== undefined ? input.provenance : existing.provenance,
          created_at: existing.created_at,
          updated_at: now,
        };
      } else {
        // New source
        const defaultHours = this.defaultRefreshHours[input.kind] ?? (input.kind === "web" ? 168 : 24);
        const tags = Array.isArray(input.tags) ? Array.from(new Set(input.tags)) : [];

        spec = {
          source_id: sourceId,
          kind: input.kind,
          url: canonicalUrl,
          title: input.title,
          tags,
          note: input.note,
          enabled: input.enabled !== undefined ? input.enabled : true,
          refresh_hours: input.refresh_hours !== undefined ? input.refresh_hours : defaultHours,
          provenance: input.provenance ?? "manual",
          created_at: now,
          updated_at: now,
        };
      }

      const validated = validateSourceSpec(spec);
      atomicWriteJson(targetFile, validated);
      return validated;
    }, options);
  }

  /**
   * Updates an existing source's metadata.
   */
  async updateSource(
    sourceId: string,
    patch: Partial<SourceSpecInput> | Partial<SourceSpec>,
    options?: PortOptions,
  ): Promise<SourceSpec> {
    return await withPortTimeout(async () => {
      const targetFile = join(this.sourcesDir, `${sourceId}.json`);
      if (!existsSync(targetFile)) {
        throw new IntakeError("KEY_NOT_FOUND", `Source '${sourceId}' not found in registry`, { sourceId });
      }

      let existing: SourceSpec;
      try {
        const raw = JSON.parse(readFileSync(targetFile, "utf8"));
        existing = validateSourceSpec(raw);
      } catch (err) {
        throw new IntakeError("INVALID_SOURCE_SPEC", `Corrupt source file for '${sourceId}'`, { targetFile, cause: String(err) });
      }

      if (patch.url !== undefined || patch.kind !== undefined) {
        const checkKind = patch.kind ?? existing.kind;
        const checkUrl = patch.url ?? existing.url;
        const { sourceId: newSourceId } = canonicalizeUrl(checkUrl, checkKind);
        if (newSourceId !== existing.source_id) {
          throw new IntakeError(
            "INVALID_SOURCE_SPEC",
            "Cannot modify url or kind in a manner that changes source_id in updateSource. Use addSource instead.",
            { existingId: existing.source_id, newId: newSourceId },
          );
        }
      }

      const now = nowIsoWithOffset();
      const updated: SourceSpec = {
        source_id: existing.source_id,
        kind: existing.kind,
        url: existing.url,
        title: patch.title !== undefined ? patch.title : existing.title,
        tags: patch.tags !== undefined ? Array.from(new Set(patch.tags)) : existing.tags,
        note: patch.note !== undefined ? patch.note : existing.note,
        enabled: patch.enabled !== undefined ? patch.enabled : existing.enabled,
        refresh_hours: patch.refresh_hours !== undefined ? patch.refresh_hours : existing.refresh_hours,
        provenance: patch.provenance !== undefined ? patch.provenance : existing.provenance,
        created_at: existing.created_at,
        updated_at: now,
      };

      const validated = validateSourceSpec(updated);
      atomicWriteJson(targetFile, validated);
      return validated;
    }, options);
  }

  /**
   * Disables a source, setting enabled to false.
   */
  async disableSource(sourceId: string, options?: PortOptions): Promise<SourceSpec> {
    return await this.updateSource(sourceId, { enabled: false }, options);
  }

  /**
   * Retrieves a source by its 64-char hex sourceId, or null if not found.
   */
  async getSource(sourceId: string, options?: PortOptions): Promise<SourceSpec | null> {
    return await withPortTimeout(async () => {
      const targetFile = join(this.sourcesDir, `${sourceId}.json`);
      if (!existsSync(targetFile)) {
        return null;
      }
      const raw = JSON.parse(readFileSync(targetFile, "utf8"));
      return validateSourceSpec(raw);
    }, options);
  }

  /**
   * Lists sources from the registry, optionally filtered by kind, enabled, or tag.
   */
  async listSources(
    filterOrOptions?: ListSourcesFilter | PortOptions,
    options?: PortOptions,
  ): Promise<SourceSpec[]> {
    return await withPortTimeout(async () => {
      let filter: ListSourcesFilter | undefined;
      if (filterOrOptions) {
        if ("signal" in filterOrOptions || "timeoutMs" in filterOrOptions) {
          // Treated as PortOptions if filter properties are not set
          if (!("kind" in filterOrOptions || "enabled" in filterOrOptions || "tag" in filterOrOptions)) {
            filter = undefined;
          } else {
            filter = filterOrOptions as ListSourcesFilter;
          }
        } else {
          filter = filterOrOptions as ListSourcesFilter;
        }
      }

      if (!existsSync(this.sourcesDir)) {
        return [];
      }

      const files = readdirSync(this.sourcesDir);
      const results: SourceSpec[] = [];

      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const filePath = join(this.sourcesDir, file);
        try {
          const raw = JSON.parse(readFileSync(filePath, "utf8"));
          const spec = validateSourceSpec(raw);

          if (filter?.kind && spec.kind !== filter.kind) continue;
          if (filter?.enabled !== undefined && spec.enabled !== filter.enabled) continue;
          if (filter?.tag && !spec.tags.includes(filter.tag)) continue;

          results.push(spec);
        } catch {
          // Corrupt files will be caught by validateRegistry
        }
      }

      results.sort((a, b) => a.source_id.localeCompare(b.source_id));
      return results;
    }, options ?? (filterOrOptions && ("signal" in filterOrOptions || "timeoutMs" in filterOrOptions) ? (filterOrOptions as PortOptions) : undefined));
  }

  /**
   * Imports bookmarks from Netscape bookmark HTML format.
   * Returns an array of imported SourceSpec that also has { imported, skipped } properties.
   */
  async importBookmarks(
    htmlContent: string,
    optionsOrFolderName?: BookmarkImportOptions | string,
    portOptions?: PortOptions,
  ): Promise<SourceSpec[] & BookmarkImportResult> {
    let folderName: string | undefined;
    let extraTags: string[] = [];
    let actualPortOptions: PortOptions | undefined = portOptions;

    if (typeof optionsOrFolderName === "string") {
      folderName = optionsOrFolderName;
    } else if (optionsOrFolderName && typeof optionsOrFolderName === "object") {
      folderName = optionsOrFolderName.folderName;
      extraTags = optionsOrFolderName.tags ?? [];
      actualPortOptions = optionsOrFolderName.portOptions ?? portOptions;
    }

    return await withPortTimeout(async () => {
      const extracted = extractBookmarks(htmlContent, folderName);
      const imported: SourceSpec[] = [];
      let skipped = 0;

      for (const item of extracted) {
        try {
          const kind = inferSourceKind(item.url);
          const combinedTags = Array.from(new Set([...extraTags, ...(item.tags ?? [])]));

          const spec = await this.addSource(
            {
              kind,
              url: item.url,
              title: item.title,
              tags: combinedTags,
              provenance: "bookmarks-import",
            },
            actualPortOptions,
          );
          imported.push(spec);
        } catch {
          skipped++;
        }
      }

      const result = Object.assign([...imported], {
        imported,
        skipped,
      });

      return result;
    }, actualPortOptions);
  }

  /**
   * Lists folders in the local Chrome/Chromium installation.
   */
  getChromeFolders(bookmarksPath?: string): ChromeBookmarkFolder[] {
    return listChromeBookmarkFolders(bookmarksPath);
  }

  /**
   * Imports bookmarks directly from the local Chrome/Chromium installation.
   */
  async importChromeBookmarks(
    options: {
      bookmarksPath?: string;
      folderName?: string;
      days?: number;
      tags?: string[];
      portOptions?: PortOptions;
    } = {},
  ): Promise<{ imported: SourceSpec[]; skipped: number; totalFound: number; bookmarksPath: string }> {
    return await withPortTimeout(async () => {
      const resolvedPath = resolveChromeBookmarksPath(options.bookmarksPath);
      const extracted = extractChromeBookmarks({
        bookmarksPath: resolvedPath,
        folderName: options.folderName,
        days: options.days,
      });

      const userTags = options.tags ?? [];
      const imported: SourceSpec[] = [];
      let skipped = 0;

      for (const item of extracted) {
        try {
          const kind = inferSourceKind(item.url);
          const combinedTags = Array.from(new Set([...userTags, ...item.tags]));
          const spec = await this.addSource(
            {
              kind,
              url: item.url,
              title: item.title,
              tags: combinedTags,
              provenance: "bookmarks-import",
            },
            options.portOptions,
          );
          imported.push(spec);
        } catch {
          skipped++;
        }
      }

      return {
        imported,
        skipped,
        totalFound: extracted.length,
        bookmarksPath: resolvedPath,
      };
    }, options.portOptions);
  }

  /**
   * Imports repositories or stars directly from GitHub.
   */
  async importGitHubRepos(
    options: {
      username?: string;
      mode?: "stars" | "repos";
      limit?: number;
      tags?: string[];
      token?: string;
      portOptions?: PortOptions;
    } = {},
  ): Promise<{ imported: SourceSpec[]; skipped: number; totalFound: number; user: string }> {
    return await withPortTimeout(async () => {
      const mode = options.mode ?? "stars";
      const repos = mode === "stars"
        ? await fetchGitHubStarredRepos({
            username: options.username,
            limit: options.limit,
            token: options.token,
          })
        : await fetchGitHubUserRepos({
            username: options.username,
            limit: options.limit,
            token: options.token,
          });

      const userTags = options.tags ?? [];
      const imported: SourceSpec[] = [];
      let skipped = 0;

      for (const repo of repos) {
        try {
          const tags = Array.from(
            new Set([
              ...userTags,
              ...(repo.language ? [repo.language.toLowerCase()] : []),
              ...repo.topics.slice(0, 5),
            ]),
          );

          const spec = await this.addSource(
            {
              kind: "github-repo",
              url: repo.url,
              title: `${repo.fullName}: ${repo.description || repo.name}`,
              note: repo.description || undefined,
              tags,
              provenance: "github-stars",
            },
            options.portOptions,
          );
          imported.push(spec);
        } catch {
          skipped++;
        }
      }

      const detected = detectGitHubUser();
      const finalUser = options.username || detected.username || "unknown";

      return {
        imported,
        skipped,
        totalFound: repos.length,
        user: finalUser,
      };
    }, options.portOptions);
  }

  /**
   * Validates a candidate SourceSpec record.
   */
  async validateSource(spec: unknown, options?: PortOptions): Promise<SourceSpec> {
    return await withPortTimeout(async () => {
      return validateSourceSpec(spec);
    }, options);
  }

  /**
   * Validates the integrity of all source JSON files and catalog.json in the registry.
   */
  async validateRegistry(options?: PortOptions): Promise<RegistryValidationResult> {
    return await withPortTimeout(async () => {
      const errors: string[] = [];
      let count = 0;

      // Validate catalog.json if it exists
      if (existsSync(this.catalogPath)) {
        try {
          const rawCatalog = JSON.parse(readFileSync(this.catalogPath, "utf8"));
          if (rawCatalog.schema_version !== 1) {
            errors.push(`catalog.json schema_version must be 1, got ${String(rawCatalog.schema_version)}`);
          }
          if (typeof rawCatalog.catalog_id !== "string" || !rawCatalog.catalog_id.trim()) {
            errors.push("catalog.json missing or invalid 'catalog_id'");
          }
          if (typeof rawCatalog.name !== "string" || !rawCatalog.name.trim()) {
            errors.push("catalog.json missing or invalid 'name'");
          }
          if (!rawCatalog.default_refresh_hours || typeof rawCatalog.default_refresh_hours !== "object") {
            errors.push("catalog.json missing or invalid 'default_refresh_hours'");
          }
        } catch (err: any) {
          errors.push(`catalog.json failed to parse: ${err.message}`);
        }
      }

      if (!existsSync(this.sourcesDir)) {
        return { valid: errors.length === 0, errors, count: 0 };
      }

      const files = readdirSync(this.sourcesDir);

      for (const file of files) {
        if (file === ".gitkeep" || file.endsWith(".tmp")) {
          continue;
        }

        if (!file.endsWith(".json")) {
          errors.push(`Unexpected non-JSON file in sources directory: ${file}`);
          continue;
        }

        const baseName = file.slice(0, -5);
        if (!/^[0-9a-fA-F]{64}$/.test(baseName)) {
          errors.push(`Filename '${file}' is not a valid 64-character SHA-256 hex string`);
          continue;
        }

        const filePath = join(this.sourcesDir, file);
        let parsed: unknown;
        try {
          parsed = JSON.parse(readFileSync(filePath, "utf8"));
        } catch (err: any) {
          errors.push(`Invalid JSON syntax in '${file}': ${err.message}`);
          continue;
        }

        try {
          const spec = validateSourceSpec(parsed);
          if (spec.source_id.toLowerCase() !== baseName.toLowerCase()) {
            errors.push(`source_id '${spec.source_id}' does not match file name '${file}'`);
          }
          count++;
        } catch (err: any) {
          errors.push(`Validation failed for '${file}': ${err.message}`);
        }
      }

      return {
        valid: errors.length === 0,
        errors,
        count,
      };
    }, options);
  }
}

// ============================================================================
// CLI Entry Point
// ============================================================================

async function runCli(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  const service = new IntakeService();

  function getArgValue(flag: string): string | undefined {
    const idx = args.indexOf(flag);
    if (idx !== -1 && idx + 1 < args.length) {
      return args[idx + 1];
    }
    return undefined;
  }

  try {
    if (command === "add") {
      const url = getArgValue("--url") || args[1];
      const kind = (getArgValue("--kind") as SourceKind) || (url ? inferSourceKind(url) : "web");
      const title = getArgValue("--title");
      const tagsRaw = getArgValue("--tags");
      const tags = tagsRaw ? tagsRaw.split(",").map((t) => t.trim()).filter(Boolean) : [];
      const note = getArgValue("--note");
      const refreshHoursStr = getArgValue("--refresh-hours");
      const refresh_hours = refreshHoursStr ? Number(refreshHoursStr) : undefined;

      if (!url) {
        console.error("Usage: intake add --url <URL> [--kind github-repo|web|github-stars] [--title <title>] [--tags <t1,t2>]");
        process.exit(1);
      }

      const spec = await service.addSource({ kind, url, title, tags, note, refresh_hours });
      console.log(`Registered source: ${spec.source_id} (${spec.kind}) ${spec.url}`);
    } else if (command === "update") {
      const sourceId = args[1];
      if (!sourceId) {
        console.error("Usage: intake update <source_id> [--title <title>] [--tags <t1,t2>] [--enabled true|false]");
        process.exit(1);
      }
      const title = getArgValue("--title");
      const note = getArgValue("--note");
      const tagsRaw = getArgValue("--tags");
      const tags = tagsRaw ? tagsRaw.split(",").map((t) => t.trim()).filter(Boolean) : undefined;
      const enabledStr = getArgValue("--enabled");
      const enabled = enabledStr ? enabledStr === "true" : undefined;

      const spec = await service.updateSource(sourceId, { title, note, tags, enabled });
      console.log(`Updated source: ${spec.source_id} (${spec.kind})`);
    } else if (command === "disable") {
      const sourceId = args[1];
      if (!sourceId) {
        console.error("Usage: intake disable <source_id>");
        process.exit(1);
      }
      const spec = await service.disableSource(sourceId);
      console.log(`Disabled source: ${spec.source_id}`);
    } else if (command === "get") {
      const sourceId = args[1];
      if (!sourceId) {
        console.error("Usage: intake get <source_id>");
        process.exit(1);
      }
      const spec = await service.getSource(sourceId);
      if (!spec) {
        console.error(`Source not found: ${sourceId}`);
        process.exit(1);
      }
      console.log(JSON.stringify(spec, null, 2));
    } else if (command === "list") {
      const kind = getArgValue("--kind") as SourceKind | undefined;
      const tag = getArgValue("--tag");
      const enabledStr = getArgValue("--enabled");
      const enabled = enabledStr !== undefined ? enabledStr === "true" : undefined;

      const list = await service.listSources({ kind, tag, enabled });
      console.log(`Found ${list.length} sources:`);
      for (const s of list) {
        console.log(`- [${s.enabled ? "x" : " "}] ${s.source_id.slice(0, 12)} (${s.kind}) ${s.url}${s.title ? ` - ${s.title}` : ""}`);
      }
    } else if (command === "import-bookmarks") {
      const file = getArgValue("--file") || args[1];
      const folderName = getArgValue("--folder") || "도구들";
      const tagsRaw = getArgValue("--tags");
      const tags = tagsRaw ? tagsRaw.split(",").map((t) => t.trim()).filter(Boolean) : [];

      if (!file || !existsSync(file)) {
        console.error(`Usage: intake import-bookmarks --file <path.html> [--folder "도구들"] [--tags <t1,t2>]`);
        process.exit(1);
      }

      const content = readFileSync(file, "utf8");
      const res = await service.importBookmarks(content, { folderName, tags });
      console.log(`Imported ${res.imported.length} bookmarks from folder '${folderName}' (skipped: ${res.skipped})`);
    } else if (command === "validate") {
      const res = await service.validateRegistry();
      if (res.valid) {
        console.log(`Registry valid: ${res.count} source(s) checked successfully.`);
      } else {
        console.error(`Registry validation failed with ${res.errors.length} error(s):`);
        for (const err of res.errors) {
          console.error(`- ${err}`);
        }
        process.exit(1);
      }
    } else {
      console.log("Usage: intake <add|update|disable|get|list|import-bookmarks|validate> [options]");
    }
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

// Check if run directly
if (process.argv[1]) {
  try {
    const currentScript = fileURLToPath(import.meta.url);
    const invokedScript = resolve(process.argv[1]);
    if (currentScript === invokedScript) {
      void runCli();
    }
  } catch {
    // ignore
  }
}
