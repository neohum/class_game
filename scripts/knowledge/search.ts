/**
 * search.ts — Multi-channel Search Service for the Harness Knowledge Library.
 *
 * Implements SearchPort with:
 * - Channel 1: FTS5 full-text search on `kl_chunks_fts` (heading & text matching, query sanitization, BM25).
 * - Channel 2: Tag & exact name matching on `kl_sources.tags` and `kl_capabilities.capability_name`.
 * - Channel 3: Vector similarity search (Float32Array dot product / cosine similarity, top 30).
 * - Reciprocal Rank Fusion (RRF with k = 60): $RRF = \sum \frac{1}{60 + rank}$.
 * - Diversity limit: at most 2 chunks per `source_id` (configurable).
 * - Graceful lexical fallback (AC-2):
 *   - Falls back to lexical-only mode if embedder is missing, offline, model fingerprint mismatches,
 *     or query embedding times out.
 *   - Never re-embeds document corpus on search requests.
 *   - Never crashes on unhandled embedding errors.
 * - Rich Hit Metadata & Project context integration (AC-3):
 *   - Excerpt, score, rank_source, fetched_at, stale flag, license, and already_used detection.
 * - Strict tombstone exclusion: documents with status='tombstone' and sources with enabled=0 are excluded.
 */

import { DatabaseSync } from "node:sqlite";
import {
  type SearchPort,
  type SearchHit,
  type SearchResult,
  type SearchOptions,
  type ProjectContext,
  type EmbedderPort,
  type ReaderPort,
  type PortOptions,
  type RankSource,
  CancellationError,
  TimeoutError,
  validateSearchHit,
  withPortTimeout,
} from "./contracts.ts";
import {
  openCatalogDatabase,
  getCatalogMeta,
  isVec0Available,
  type CatalogMeta,
} from "./migrations.ts";
import { blobToVector } from "./catalog.ts";
import { type CatalogReaderHandle } from "./reader.ts";

// ============================================================================
// Service Options
// ============================================================================

export interface SearchServiceOptions {
  db?: DatabaseSync;
  dbPath?: string;
  reader?: ReaderPort & { acquireReaderHandle?: () => Promise<CatalogReaderHandle | null> };
  embedder?: EmbedderPort;
  catalogMeta?: CatalogMeta;
  defaultLimit?: number;
  diversityLimitPerSource?: number;
  defaultQueryTimeoutMs?: number;
}

// ============================================================================
// Query Sanitization & Helper Functions
// ============================================================================

/**
 * Sanitizes user search queries for SQLite FTS5 MATCH expressions.
 * Removes FTS5 control characters, extracts alphanumeric and Hangul/CJK tokens,
 * applies prefix matching for tokens with length >= 3, and escapes quotes.
 */
export function sanitizeFtsQuery(query: string): string {
  if (!query || typeof query !== "string") return "";

  // Remove dangerous FTS syntax operators & punctuation: " ' * : ^ ( ) { } [ ] - + ~ ; / \
  const cleaned = query
    .replace(/["'*:\^(){}\[\]\-+~;\\/]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) return "";

  // Split tokens by whitespace
  const rawTokens = cleaned.split(" ").filter((t) => t.length > 0);
  if (rawTokens.length === 0) return "";

  // Format tokens: tokens with >= 3 characters use prefix match `token*`
  const clauses: string[] = [];
  for (const token of rawTokens) {
    // Strip any remaining special characters
    const safe = token.replace(/[^a-zA-Z0-9_\uAC00-\uD7A3\u1100-\u11FF\u3130-\u318F\u4E00-\u9FFF]/g, "");
    if (!safe) continue;

    if (safe.length >= 3) {
      clauses.push(`"${safe}"*`);
    } else {
      clauses.push(`"${safe}"`);
    }
  }

  if (clauses.length === 0) return "";
  return clauses.join(" OR ");
}

/**
 * Computes the Reciprocal Rank Fusion (RRF) score for a set of channel ranks.
 * Formula: RRF = sum(1 / (k + rank)) for each channel hit (rank is 1-indexed).
 */
export function computeRrfScore(ranks: number[], k = 60): number {
  let score = 0;
  for (const rank of ranks) {
    if (rank > 0) {
      score += 1 / (k + rank);
    }
  }
  return score;
}

/**
 * Extracts a concise excerpt from chunk text, centering around query terms if found.
 */
export function generateExcerpt(text: string, query?: string, maxLength = 260): string {
  if (!text) return "";
  const cleaned = text.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxLength) return cleaned;

  if (query) {
    const rawTokens = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 1);

    for (const token of rawTokens) {
      const idx = cleaned.toLowerCase().indexOf(token);
      if (idx !== -1) {
        const start = Math.max(0, idx - Math.floor(maxLength / 3));
        const end = Math.min(cleaned.length, start + maxLength);
        const prefix = start > 0 ? "..." : "";
        const suffix = end < cleaned.length ? "..." : "";
        return `${prefix}${cleaned.slice(start, end).trim()}${suffix}`;
      }
    }
  }

  return `${cleaned.slice(0, maxLength).trim()}...`;
}

/**
 * Checks whether a candidate tool, package, or repository is already present
 * in the project's dependencies (ProjectContext.existing_deps).
 */
export function isToolAlreadyUsed(
  sourceTitle: string | undefined,
  sourceUrl: string,
  tags: string[],
  capabilities: string[],
  existingDeps: string[],
): boolean {
  if (!existingDeps || existingDeps.length === 0) return false;

  const normalizedDeps = new Set(
    existingDeps.map((d) => d.trim().toLowerCase()).filter(Boolean),
  );

  const matchesDep = (name: string | undefined): boolean => {
    if (!name) return false;
    const lower = name.trim().toLowerCase();
    if (!lower) return false;
    if (normalizedDeps.has(lower)) return true;

    // Check unscoped name for scoped packages (e.g. '@octokit/rest' -> 'rest')
    if (lower.startsWith("@")) {
      const slash = lower.indexOf("/");
      if (slash !== -1 && normalizedDeps.has(lower.slice(slash + 1))) return true;
    }

    // Check if any scoped dep in existingDeps matches unscoped candidate
    for (const dep of normalizedDeps) {
      if (dep.startsWith("@")) {
        const slash = dep.indexOf("/");
        if (slash !== -1 && dep.slice(slash + 1) === lower) return true;
      }
    }

    return false;
  };

  if (matchesDep(sourceTitle)) return true;

  // Extract repo name from URL (e.g., https://github.com/owner/my-repo -> 'my-repo')
  try {
    const urlObj = new URL(sourceUrl);
    const parts = urlObj.pathname.split("/").filter(Boolean);
    const repoName = parts[parts.length - 1]?.replace(/\.git$/, "");
    if (matchesDep(repoName)) return true;
  } catch {
    // Ignore invalid URLs
  }

  // Check tags
  for (const tag of tags) {
    if (matchesDep(tag)) return true;
  }

  // Check capability names
  for (const cap of capabilities) {
    if (matchesDep(cap)) return true;
  }

  return false;
}

/**
 * Computes cosine similarity between two Float32Array vectors.
 */
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }

  if (normA <= 0 || normB <= 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Determines whether a document is considered stale based on refresh_hours.
 */
function isDocumentStale(fetchedAt: string, refreshHours = 24): boolean {
  const fetchedMs = Date.parse(fetchedAt);
  if (!Number.isFinite(fetchedMs)) return false;
  const thresholdHours = Number.isFinite(refreshHours) && refreshHours > 0 ? refreshHours : 24;
  return Date.now() - fetchedMs >= thresholdHours * 3600 * 1000;
}

// ============================================================================
// Internal Search Candidate Structure
// ============================================================================

interface RawCandidate {
  chunk_id: string;
  document_id: string;
  source_id: string;
  ftsRank?: number;
  tagRank?: number;
  vecRank?: number;
  similarityScore?: number;
}

// ============================================================================
// SearchService Implementation
// ============================================================================

export class SearchService implements SearchPort {
  private explicitDb?: DatabaseSync;
  private readonly dbPath?: string;
  private readonly reader?: ReaderPort & {
    acquireReaderHandle?: () => Promise<CatalogReaderHandle | null>;
  };
  private readonly embedder?: EmbedderPort;
  private readonly defaultLimit: number;
  private readonly diversityLimitPerSource: number;
  private readonly defaultQueryTimeoutMs: number;
  private cachedMeta?: CatalogMeta | null;

  constructor(options: SearchServiceOptions = {}) {
    this.explicitDb = options.db;
    this.dbPath = options.dbPath;
    this.reader = options.reader;
    this.embedder = options.embedder;
    this.cachedMeta = options.catalogMeta;
    this.defaultLimit = options.defaultLimit ?? 10;
    this.diversityLimitPerSource = options.diversityLimitPerSource ?? 2;
    this.defaultQueryTimeoutMs = options.defaultQueryTimeoutMs ?? 2000;
  }

  // ==========================================================================
  // Public search API (implements SearchPort overloads)
  // ==========================================================================

  async search(
    query: string,
    options?: SearchOptions,
  ): Promise<SearchResult>;
  async search(
    query: string,
    context?: ProjectContext,
    options?: SearchOptions,
  ): Promise<SearchResult>;
  async search(
    query: string,
    arg2?: ProjectContext | SearchOptions,
    arg3?: SearchOptions,
  ): Promise<SearchResult> {
    let context: ProjectContext | undefined;
    let options: SearchOptions | undefined;

    if (arg2 && ("project_name" in arg2 || "existing_deps" in arg2)) {
      context = arg2 as ProjectContext;
      options = arg3;
    } else {
      options = arg2 as SearchOptions | undefined;
      context = options?.projectContext ?? options?.context;
    }

    const timeoutMs = options?.timeoutMs ?? this.defaultQueryTimeoutMs;

    return await withPortTimeout(
      async (signal) => {
        return await this.executeSearch(query, context, options, signal);
      },
      { signal: options?.signal, timeoutMs },
    );
  }

  // ==========================================================================
  // Core Search Pipeline
  // ==========================================================================

  private async executeSearch(
    query: string,
    context: ProjectContext | undefined,
    options: SearchOptions | undefined,
    signal: AbortSignal,
  ): Promise<SearchResult> {
    if (signal.aborted) {
      throw new CancellationError(
        "OPERATION_CANCELLED",
        "Search operation was cancelled before execution",
      );
    }

    const trimmedQuery = (query || "").trim();
    if (!trimmedQuery) {
      return { hits: [], mode: "lexical", totalFound: 0 };
    }

    // 1. Resolve DB connection and handle
    const { db, closeHandle } = await this.resolveDb();

    try {
      // 2. Fetch catalog metadata
      const meta = this.resolveMeta(db);

      // 3. Determine search mode & channel execution
      const requestedMode = options?.mode ?? "all";
      const shouldRunFts = requestedMode === "all" || requestedMode === "hybrid" || requestedMode === "fts" || requestedMode === "lexical";
      const shouldRunTag = requestedMode === "all" || requestedMode === "hybrid" || requestedMode === "lexical";
      const shouldAttemptVector = requestedMode === "all" || requestedMode === "hybrid" || requestedMode === "vec";

      const candidateMap = new Map<string, RawCandidate>();

      const getCandidate = (chunkId: string, docId: string, sourceId: string): RawCandidate => {
        let c = candidateMap.get(chunkId);
        if (!c) {
          c = { chunk_id: chunkId, document_id: docId, source_id: sourceId };
          candidateMap.set(chunkId, c);
        }
        return c;
      };

      // 4. Channel 1: FTS5 Full-Text Search
      if (shouldRunFts) {
        const ftsHits = this.executeFtsChannel(db, trimmedQuery);
        for (let i = 0; i < ftsHits.length; i++) {
          const hit = ftsHits[i]!;
          const c = getCandidate(hit.chunk_id, hit.document_id, hit.source_id);
          c.ftsRank = i + 1; // 1-indexed
        }
      }

      // 5. Channel 2: Tag & Exact Capability Name Search
      if (shouldRunTag) {
        const tagHits = this.executeTagAndCapabilityChannel(db, trimmedQuery);
        for (let i = 0; i < tagHits.length; i++) {
          const hit = tagHits[i]!;
          const c = getCandidate(hit.chunk_id, hit.document_id, hit.source_id);
          c.tagRank = i + 1; // 1-indexed
        }
      }

      // 6. Channel 3: Vector Similarity Search (with graceful fallback)
      let vectorExecuted = false;
      if (shouldAttemptVector) {
        const vecResult = await this.tryExecuteVectorChannel(
          db,
          meta,
          trimmedQuery,
          signal,
          options?.timeoutMs,
        );

        if (vecResult) {
          vectorExecuted = true;
          for (let i = 0; i < vecResult.length; i++) {
            const hit = vecResult[i]!;
            const c = getCandidate(hit.chunk_id, hit.document_id, hit.source_id);
            c.vecRank = i + 1; // 1-indexed
            c.similarityScore = hit.similarity;
          }
        }
      }

      const effectiveMode: "hybrid" | "lexical" = vectorExecuted ? "hybrid" : "lexical";

      if (candidateMap.size === 0) {
        return { hits: [], mode: effectiveMode, totalFound: 0 };
      }

      // 7. Reciprocal Rank Fusion (RRF) Merger (k = 60)
      const scoredCandidates: Array<{
        candidate: RawCandidate;
        score: number;
        rankSource: RankSource;
      }> = [];

      for (const candidate of candidateMap.values()) {
        const ranks: number[] = [];
        const matchingChannels: RankSource[] = [];

        if (candidate.ftsRank !== undefined) {
          ranks.push(candidate.ftsRank);
          matchingChannels.push("fts");
        }
        if (candidate.tagRank !== undefined) {
          ranks.push(candidate.tagRank);
          matchingChannels.push("tag");
        }
        if (candidate.vecRank !== undefined) {
          ranks.push(candidate.vecRank);
          matchingChannels.push("vec");
        }

        const score = computeRrfScore(ranks, 60);

        let rankSource: RankSource = "rrf";
        if (matchingChannels.length === 1) {
          rankSource = matchingChannels[0]!;
        } else if (matchingChannels.length > 1) {
          rankSource = "rrf";
        }

        scoredCandidates.push({ candidate, score, rankSource });
      }

      // Sort descending by RRF score; tie-breaker: chunk_id ascending
      scoredCandidates.sort((a, b) => {
        if (b.score !== a.score) {
          return b.score - a.score;
        }
        return a.candidate.chunk_id.localeCompare(b.candidate.chunk_id);
      });

      // 8. Diversity limit per source (AC-1: at most 2 chunks per source_id)
      const diversityLimit =
        options?.diversityLimitPerSource ?? this.diversityLimitPerSource;
      const sourceCounts = new Map<string, number>();
      const diverseCandidates: typeof scoredCandidates = [];

      for (const item of scoredCandidates) {
        const count = sourceCounts.get(item.candidate.source_id) ?? 0;
        if (count < diversityLimit) {
          sourceCounts.set(item.candidate.source_id, count + 1);
          diverseCandidates.push(item);
        }
      }

      const totalFound = diverseCandidates.length;

      // 9. Limit slice
      const limit = options?.limit ?? this.defaultLimit;
      const topCandidates = diverseCandidates.slice(0, limit);

      // 10. Enrich SearchHit records with complete metadata
      const hits: SearchHit[] = [];
      for (const item of topCandidates) {
        const enriched = this.enrichHit(
          db,
          item.candidate,
          item.score,
          item.rankSource,
          trimmedQuery,
          context,
        );
        if (enriched) {
          hits.push(validateSearchHit(enriched));
        }
      }

      return {
        hits,
        mode: effectiveMode,
        totalFound,
      };
    } finally {
      if (closeHandle) {
        closeHandle();
      }
    }
  }

  // ==========================================================================
  // Channel 1: FTS5 Execution
  // ==========================================================================

  private executeFtsChannel(
    db: DatabaseSync,
    query: string,
  ): Array<{ chunk_id: string; document_id: string; source_id: string; fts_score: number }> {
    const ftsQuery = sanitizeFtsQuery(query);
    if (!ftsQuery) return [];

    try {
      const stmt = db.prepare(`
        SELECT
          fts.chunk_id,
          c.document_id,
          c.source_id,
          bm25(kl_chunks_fts, 5.0, 1.0) AS fts_score
        FROM kl_chunks_fts fts
        JOIN kl_chunks c ON fts.chunk_id = c.chunk_id
        JOIN kl_documents d ON c.document_id = d.document_id
        JOIN kl_sources s ON c.source_id = s.source_id
        WHERE kl_chunks_fts MATCH ?
          AND d.status != 'tombstone'
          AND s.enabled = 1
        ORDER BY fts_score ASC
        LIMIT 30;
      `);

      const rows = stmt.all(ftsQuery) as Array<{
        chunk_id: string;
        document_id: string;
        source_id: string;
        fts_score: number;
      }>;

      return rows;
    } catch {
      // Return empty array on FTS query parse error or missing table
      return [];
    }
  }

  // ==========================================================================
  // Channel 2: Tag & Capability Exact Name Execution
  // ==========================================================================

  private executeTagAndCapabilityChannel(
    db: DatabaseSync,
    query: string,
  ): Array<{ chunk_id: string; document_id: string; source_id: string }> {
    const normalized = query.toLowerCase().trim();
    if (!normalized) return [];

    const hits: Array<{ chunk_id: string; document_id: string; source_id: string }> = [];
    const seenChunkIds = new Set<string>();

    // 1. Exact & Substring Capability match
    try {
      const capStmt = db.prepare(`
        SELECT
          c.chunk_id,
          c.document_id,
          c.source_id,
          cap.capability_name,
          CASE
            WHEN lower(cap.capability_name) = ? THEN 1
            WHEN lower(cap.capability_name) LIKE ? THEN 2
            ELSE 3
          END AS match_priority
        FROM kl_capabilities cap
        JOIN kl_chunks c ON cap.evidence_chunk_id = c.chunk_id
        JOIN kl_documents d ON c.document_id = d.document_id
        JOIN kl_sources s ON c.source_id = s.source_id
        WHERE d.status != 'tombstone'
          AND s.enabled = 1
          AND (lower(cap.capability_name) = ? OR lower(cap.capability_name) LIKE ?)
        ORDER BY match_priority ASC
        LIMIT 30;
      `);

      const capRows = capStmt.all(
        normalized,
        `%${normalized}%`,
        normalized,
        `%${normalized}%`,
      ) as Array<{ chunk_id: string; document_id: string; source_id: string }>;

      for (const row of capRows) {
        if (!seenChunkIds.has(row.chunk_id)) {
          seenChunkIds.add(row.chunk_id);
          hits.push({
            chunk_id: row.chunk_id,
            document_id: row.document_id,
            source_id: row.source_id,
          });
        }
      }
    } catch {
      // kl_capabilities may be empty or unpopulated; proceed to tags
    }

    // 2. Tag match from kl_sources.tags
    try {
      const tagStmt = db.prepare(`
        SELECT
          c.chunk_id,
          c.document_id,
          c.source_id,
          j.value AS tag_val,
          CASE
            WHEN lower(j.value) = ? THEN 1
            WHEN lower(j.value) LIKE ? THEN 2
            ELSE 3
          END AS match_priority
        FROM kl_sources s
        JOIN json_each(s.tags) j
        JOIN kl_chunks c ON c.source_id = s.source_id
        JOIN kl_documents d ON c.document_id = d.document_id
        WHERE s.enabled = 1
          AND d.status != 'tombstone'
          AND (lower(j.value) = ? OR lower(j.value) LIKE ?)
        ORDER BY match_priority ASC, c.byte_offset ASC
        LIMIT 30;
      `);

      const tagRows = tagStmt.all(
        normalized,
        `%${normalized}%`,
        normalized,
        `%${normalized}%`,
      ) as Array<{ chunk_id: string; document_id: string; source_id: string }>;

      for (const row of tagRows) {
        if (!seenChunkIds.has(row.chunk_id) && hits.length < 30) {
          seenChunkIds.add(row.chunk_id);
          hits.push({
            chunk_id: row.chunk_id,
            document_id: row.document_id,
            source_id: row.source_id,
          });
        }
      }
    } catch {
      // Tags query fallback
    }

    return hits;
  }

  // ==========================================================================
  // Channel 3: Vector Similarity Execution (Graceful Fallback)
  // ==========================================================================

  private async tryExecuteVectorChannel(
    db: DatabaseSync,
    meta: CatalogMeta | null,
    query: string,
    signal: AbortSignal,
    timeoutMs?: number,
  ): Promise<
    Array<{
      chunk_id: string;
      document_id: string;
      source_id: string;
      similarity: number;
    }> | null
  > {
    if (!this.embedder) return null;
    if (!meta || !meta.model_fingerprint) return null;

    // Check model fingerprint compatibility
    try {
      const profile = await this.embedder.getProfile({ signal, timeoutMs: 1000 });
      if (
        profile.fingerprint.toLowerCase() !== meta.model_fingerprint.toLowerCase()
      ) {
        // Model fingerprint mismatch -> Graceful fallback to lexical mode!
        return null;
      }
    } catch {
      // Failed to retrieve profile or check fingerprint -> fallback
      return null;
    }

    // Embed query text with bounded timeout (to fall back before overall search timeout)
    const embedTimeoutMs = timeoutMs
      ? Math.max(10, Math.floor(timeoutMs * 0.6))
      : Math.min(this.defaultQueryTimeoutMs, 2000);

    let queryVector: Float32Array;
    try {
      const vecPromise = this.embedder.embedQuery(query, {
        signal,
        timeoutMs: embedTimeoutMs,
      });

      let timer: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new TimeoutError(
              "OPERATION_TIMEOUT",
              `Embedding query timed out after ${embedTimeoutMs}ms`,
            ),
          );
        }, embedTimeoutMs);
      });

      try {
        const vec = await Promise.race([vecPromise, timeoutPromise]);
        queryVector = vec instanceof Float32Array ? vec : new Float32Array(vec);
      } finally {
        if (timer) clearTimeout(timer);
      }
    } catch (err: unknown) {
      if (signal.aborted) {
        throw new CancellationError(
          "OPERATION_CANCELLED",
          "Search aborted by caller",
        );
      }
      // Query embedding timed out, offline, or threw error -> Graceful fallback to lexical!
      return null;
    }

    // Execute vector similarity match
    try {
      // Check if sqlite-vec (vec0) is available and functional
      const hasVec0 = isVec0Available(db);
      if (hasVec0) {
        try {
          const vecStmt = db.prepare(`
            SELECT
              v.chunk_id,
              v.distance,
              c.document_id,
              c.source_id
            FROM kl_chunks_vec v
            JOIN kl_chunks c ON v.chunk_id = c.chunk_id
            JOIN kl_documents d ON c.document_id = d.document_id
            JOIN kl_sources s ON c.source_id = s.source_id
            WHERE d.status != 'tombstone'
              AND s.enabled = 1
              AND v.vector MATCH ?
            ORDER BY v.distance ASC
            LIMIT 30;
          `);

          const vecRows = vecStmt.all(Buffer.from(queryVector.buffer, queryVector.byteOffset, queryVector.byteLength)) as Array<{
            chunk_id: string;
            document_id: string;
            source_id: string;
            distance: number;
          }>;

          if (vecRows && vecRows.length > 0) {
            return vecRows.map((r) => ({
              chunk_id: r.chunk_id,
              document_id: r.document_id,
              source_id: r.source_id,
              similarity: 1 / (1 + Math.max(0, r.distance)),
            }));
          }
        } catch {
          // Fall back to scanning kl_embeddings table in Node.js
        }
      }

      // Fast in-memory dot product / cosine similarity over active chunk embeddings
      const fetchEmbeddingsStmt = db.prepare(`
        SELECT
          e.chunk_id,
          e.vector,
          c.document_id,
          c.source_id
        FROM kl_embeddings e
        JOIN kl_chunks c ON e.chunk_id = c.chunk_id
        JOIN kl_documents d ON c.document_id = d.document_id
        JOIN kl_sources s ON c.source_id = s.source_id
        WHERE e.model_fingerprint = ?
          AND d.status != 'tombstone'
          AND s.enabled = 1;
      `);

      const rows = fetchEmbeddingsStmt.all(meta.model_fingerprint.toLowerCase()) as Array<{
        chunk_id: string;
        vector: Buffer | Uint8Array;
        document_id: string;
        source_id: string;
      }>;

      if (rows.length === 0) return [];

      const scored: Array<{
        chunk_id: string;
        document_id: string;
        source_id: string;
        similarity: number;
      }> = [];

      for (const row of rows) {
        const chunkVec = blobToVector(row.vector);
        const sim = cosineSimilarity(queryVector, chunkVec);
        scored.push({
          chunk_id: row.chunk_id,
          document_id: row.document_id,
          source_id: row.source_id,
          similarity: sim,
        });
      }

      scored.sort((a, b) => b.similarity - a.similarity);
      return scored.slice(0, 30);
    } catch {
      return null;
    }
  }

  // ==========================================================================
  // Metadata Enrichment & Project Context Flagging
  // ==========================================================================

  private enrichHit(
    db: DatabaseSync,
    candidate: RawCandidate,
    score: number,
    rankSource: RankSource,
    query: string,
    context?: ProjectContext,
  ): SearchHit | null {
    try {
      const stmt = db.prepare(`
        SELECT
          c.chunk_id,
          c.document_id,
          c.source_id,
          c.heading,
          c.text,
          d.url AS doc_url,
          d.title AS doc_title,
          d.license,
          d.fetched_at,
          s.url AS source_url,
          s.title AS source_title,
          s.tags AS source_tags,
          s.refresh_hours
        FROM kl_chunks c
        JOIN kl_documents d ON c.document_id = d.document_id
        JOIN kl_sources s ON c.source_id = s.source_id
        WHERE c.chunk_id = ?;
      `);

      const row = stmt.get(candidate.chunk_id) as
        | {
            chunk_id: string;
            document_id: string;
            source_id: string;
            heading?: string;
            text: string;
            doc_url: string;
            doc_title?: string;
            license?: string;
            fetched_at: string;
            source_url: string;
            source_title?: string;
            source_tags: string;
            refresh_hours?: number;
          }
        | undefined;

      if (!row) return null;

      let tags: string[] = [];
      try {
        tags = JSON.parse(row.source_tags);
      } catch {
        // ignore
      }

      // Check capabilities associated with this chunk or document
      let capabilities: string[] = [];
      try {
        const capRows = db
          .prepare(
            "SELECT capability_name FROM kl_capabilities WHERE evidence_chunk_id = ?",
          )
          .all(candidate.chunk_id) as Array<{ capability_name: string }>;
        capabilities = capRows.map((r) => r.capability_name);
      } catch {
        // ignore
      }

      const excerpt = generateExcerpt(row.text, query);
      const stale = isDocumentStale(row.fetched_at, row.refresh_hours ?? 24);
      const license = row.license && row.license.trim() ? row.license.trim() : "unknown";

      let alreadyUsed: boolean | undefined = undefined;
      if (context && Array.isArray(context.existing_deps)) {
        alreadyUsed = isToolAlreadyUsed(
          row.source_title ?? row.doc_title,
          row.source_url || row.doc_url,
          tags,
          capabilities,
          context.existing_deps,
        );
      }

      return {
        chunk_id: row.chunk_id,
        document_id: row.document_id,
        source_id: row.source_id,
        source_url: row.source_url || row.doc_url,
        source_title: row.source_title ?? row.doc_title ?? undefined,
        heading: row.heading ?? undefined,
        excerpt,
        score,
        rank_source: rankSource,
        fetched_at: row.fetched_at,
        stale,
        license,
        ...(alreadyUsed !== undefined ? { already_used: alreadyUsed } : {}),
      };
    } catch {
      return null;
    }
  }

  // ==========================================================================
  // DB & Metadata Resolution Helpers
  // ==========================================================================

  private async resolveDb(): Promise<{
    db: DatabaseSync;
    closeHandle?: () => void;
  }> {
    if (this.explicitDb) {
      return { db: this.explicitDb };
    }

    const readerAny = this.reader as any;
    if (readerAny) {
      if (typeof readerAny.acquireReaderHandle === "function") {
        const handle = await readerAny.acquireReaderHandle();
        if (handle) {
          return {
            db: handle.db,
            closeHandle: () => handle.close(),
          };
        }
      } else if (typeof readerAny.openActiveCatalog === "function") {
        const handle = await readerAny.openActiveCatalog();
        if (handle) {
          return {
            db: handle.db,
            closeHandle: () => handle.close(),
          };
        }
      }
    }

    if (this.dbPath) {
      const db = openCatalogDatabase(this.dbPath, { readonly: true });
      return {
        db,
        closeHandle: () => {
          try {
            db.close();
          } catch {
            // ignore
          }
        },
      };
    }

    throw new Error(
      "SearchService has no database connection: provide db, dbPath, or reader",
    );
  }

  private resolveMeta(db: DatabaseSync): CatalogMeta | null {
    if (this.cachedMeta) return this.cachedMeta;
    const meta = getCatalogMeta(db);
    if (meta) {
      this.cachedMeta = meta;
    }
    return meta;
  }
}
