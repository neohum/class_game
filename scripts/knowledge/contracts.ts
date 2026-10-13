/**
 * contracts.ts — Core data contracts, ports, validation, and error hierarchy
 * for the harness knowledge library.
 *
 * All modules (intake, fetch, embedding, catalog, storage, publish, reader,
 * search, ideas) share these types and validation boundaries.
 */

import { createHash } from "node:crypto";

// ============================================================================
// Basic Enums and Value Types
// ============================================================================

export type SourceKind = "github-repo" | "github-stars" | "web";

export type SourceProvenance = "manual" | "github-stars" | "bookmarks-import";

export type DocumentStatus =
  | "success"
  | "unchanged"
  | "retry"
  | "failed"
  | "unsupported"
  | "tombstone";

export type RankSource = "fts" | "vec" | "tag" | "rrf";

export type IntegrationType = "api" | "mcp" | "cli" | "sdk" | "library";

export type Confidence = "high" | "medium" | "low" | "unknown";

// ============================================================================
// Core Data Entities
// ============================================================================

/**
 * Git-tracked source specification (schema_version = 1).
 * Exactly one JSON file per source in knowledge/sources/<source_id>.json.
 */
export interface SourceSpec {
  source_id: string;
  kind: SourceKind;
  url: string;
  title?: string;
  tags: string[];
  note?: string;
  enabled: boolean;
  refresh_hours: number;
  provenance: SourceProvenance;
  created_at: string;
  updated_at: string;
}

export interface SourceSpecInput {
  kind: SourceKind;
  url: string;
  title?: string;
  tags?: string[];
  note?: string;
  enabled?: boolean;
  refresh_hours?: number;
  provenance?: SourceProvenance;
}

/**
 * Standardized document revision fetched from an external source.
 */
export interface DocumentRevision {
  document_id: string;
  source_id: string;
  url: string;
  revision: string;
  content_hash: string;
  title?: string;
  text: string;
  license?: string;
  fetched_at: string;
  status: DocumentStatus;
  error?: string;
}

/**
 * Chunked section of a document revision used for indexing and vector embedding.
 */
export interface Chunk {
  chunk_id: string;
  document_id: string;
  source_id: string;
  text: string;
  heading?: string;
  byte_offset: number;
  token_estimate: number;
  hash: string;
}

/**
 * Complete immutable embedding profile specification.
 * Any change in these fields requires a new index generation.
 */
export interface EmbeddingProfile {
  model_id: string;
  revision: string;
  sha256: string;
  dimensions: number;
  pooling: "mean" | "cls" | "last" | string;
  normalization: boolean;
  tokenizer: string;
  query_instruction: string;
  chunker_version: string;
  fingerprint: string;
}

export interface SourceSummary {
  total: number;
  active: number;
  failed: number;
}

/**
 * Published snapshot manifest (schema_version = 1, format_version = 1).
 */
export interface SnapshotManifest {
  schema_version: number;
  format_version: number;
  catalog_id: string;
  generation: string;
  parent_generation?: string;
  input_commit: string;
  created_at: string;
  source_summary: SourceSummary;
  document_count: number;
  chunk_count: number;
  model_fingerprint: string;
  sqlite_vec_version?: string;
  file_size_bytes: number;
  file_sha256: string;
  min_reader_version: string;
}

/**
 * Unified search result hit combining keyword, tag, and vector ranks.
 */
export interface SearchHit {
  chunk_id: string;
  document_id: string;
  source_id: string;
  source_url: string;
  source_title?: string;
  heading?: string;
  excerpt: string;
  score: number;
  rank_source: RankSource;
  fetched_at: string;
  stale: boolean;
  license: string | "unknown";
  already_used?: boolean;
}

export interface SearchResult {
  hits: SearchHit[];
  mode: "hybrid" | "lexical";
  totalFound: number;
}

export interface SearchOptions extends PortOptions {
  limit?: number;
  mode?: "all" | "hybrid" | "fts" | "vec" | "lexical";
  projectContext?: ProjectContext;
  context?: ProjectContext;
  diversityLimitPerSource?: number;
}

/**
 * Extracted context of the active local project.
 */
export interface ProjectContext {
  project_name: string;
  stack: string[];
  goals: string[];
  existing_deps: string[];
  related_files: string[];
}

/**
 * Evidence-based capability candidate extracted from documentation.
 */
export interface CapabilityCandidate {
  capability_name: string;
  integration_type: IntegrationType;
  description?: string;
  evidence_quote?: string;
  evidence_chunk_id?: string;
}

/**
 * Evidence-backed capability and implementation proposal.
 */
export interface IdeaEvidence {
  capability_name: string;
  problem_to_solve: string;
  project_anchor: string;
  tool_anchor: string;
  integration_type: IntegrationType;
  candidate_files: string[];
  minimum_experiment: string;
  acceptance_criteria: string[];
  cost_license: string;
  confidence: Confidence;
}

export interface IdeaEvidenceBundle {
  ideas: IdeaEvidence[];
  generated_at: string;
  context_summary?: string;
}

export interface IdeaFeedback {
  capability_name: string;
  decision: "adopt" | "hold" | "reject";
  reason: string;
  timestamp: string;
  project_name?: string;
}

// ============================================================================
// Error Hierarchy
// ============================================================================

export type KnowledgeErrorCode =
  // Intake errors
  | "INVALID_URL"
  | "UNSUPPORTED_SCHEME"
  | "CREDENTIALS_DISALLOWED"
  | "INVALID_SOURCE_SPEC"
  | "DUPLICATE_SOURCE"
  // Fetch errors
  | "FETCH_TIMEOUT"
  | "FETCH_FAILED"
  | "RATE_LIMITED"
  | "PRIVATE_NETWORK_DENIED"
  | "CONTENT_TOO_LARGE"
  | "UNSUPPORTED_CONTENT"
  | "INVALID_DOCUMENT_REVISION"
  // Storage errors
  | "STORAGE_ERROR"
  | "KEY_NOT_FOUND"
  | "INTEGRITY_CHECK_FAILED"
  | "ETAG_MISMATCH"
  | "QUOTA_EXCEEDED"
  // Model & Compatibility errors
  | "MODEL_FINGERPRINT_MISMATCH"
  | "DIMENSION_MISMATCH"
  | "MODEL_UNAVAILABLE"
  | "INCOMPATIBLE_VERSION"
  // Manifest errors
  | "INVALID_MANIFEST"
  | "CHECKSUM_MISMATCH"
  // Runtime control errors
  | "OPERATION_TIMEOUT"
  | "OPERATION_CANCELLED"
  | "UNKNOWN_ERROR";

export class KnowledgeError extends Error {
  readonly code: KnowledgeErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: KnowledgeErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "KnowledgeError";
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class IntakeError extends KnowledgeError {
  constructor(code: KnowledgeErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);
    this.name = "IntakeError";
  }
}

export class FetchError extends KnowledgeError {
  constructor(code: KnowledgeErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);
    this.name = "FetchError";
  }
}

export class StorageError extends KnowledgeError {
  constructor(code: KnowledgeErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);
    this.name = "StorageError";
  }
}

export class ModelCompatibilityError extends KnowledgeError {
  constructor(code: KnowledgeErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);
    this.name = "ModelCompatibilityError";
  }
}

export class ManifestValidationError extends KnowledgeError {
  constructor(code: KnowledgeErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);
    this.name = "ManifestValidationError";
  }
}

export class TimeoutError extends KnowledgeError {
  constructor(
    code: KnowledgeErrorCode = "OPERATION_TIMEOUT",
    message = "Operation timed out",
    details?: Record<string, unknown>,
  ) {
    super(code, message, details);
    this.name = "TimeoutError";
  }
}

export class CancellationError extends KnowledgeError {
  constructor(
    code: KnowledgeErrorCode = "OPERATION_CANCELLED",
    message = "Operation was cancelled",
    details?: Record<string, unknown>,
  ) {
    super(code, message, details);
    this.name = "CancellationError";
  }
}

// ============================================================================
// Port Interfaces & Options
// ============================================================================

export interface PortOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface IntakePort {
  addSource(input: SourceSpecInput, options?: PortOptions): Promise<SourceSpec>;
  updateSource(sourceId: string, patch: Partial<SourceSpecInput>, options?: PortOptions): Promise<SourceSpec>;
  disableSource(sourceId: string, options?: PortOptions): Promise<SourceSpec>;
  listSources(options?: PortOptions): Promise<SourceSpec[]>;
  getSource(sourceId: string, options?: PortOptions): Promise<SourceSpec | null>;
  importBookmarks(htmlContent: string, folderName?: string, options?: PortOptions): Promise<SourceSpec[]>;
  validateSource(spec: unknown, options?: PortOptions): Promise<SourceSpec>;
}

export interface FetcherPort {
  fetch(spec: SourceSpec, options?: PortOptions): Promise<DocumentRevision>;
}

export interface ProfilerPort {
  profileDocument(doc: DocumentRevision, options?: PortOptions): Promise<CapabilityCandidate[]>;
}

export interface EmbedderPort {
  embedQuery(query: string, options?: PortOptions): Promise<Float32Array | number[]>;
  embedBatch(texts: string[], options?: PortOptions): Promise<Array<Float32Array | number[]>>;
  getProfile(options?: PortOptions): Promise<EmbeddingProfile>;
}

export interface CatalogPort {
  upsertDocument(
    doc: DocumentRevision,
    chunks: Chunk[],
    vectors?: Array<Float32Array | number[]>,
    options?: PortOptions,
  ): Promise<{ documentId: string; chunksUpserted: number }>;
  tombstoneDocument(documentId: string, options?: PortOptions): Promise<void>;
  getGeneration(options?: PortOptions): Promise<string>;
}

export interface ObjectStorePort {
  getObject(key: string, options?: PortOptions): Promise<Buffer | Uint8Array | null>;
  headObject(key: string, options?: PortOptions): Promise<{ size: number; etag?: string } | null>;
  putObject(key: string, data: Buffer | Uint8Array, options?: PortOptions): Promise<{ etag?: string }>;
  deleteObject(key: string, options?: PortOptions): Promise<void>;
}

export interface PublisherPort {
  exportSnapshot(options?: PortOptions): Promise<{ snapshotPath: string; manifest: SnapshotManifest }>;
  publish(options?: PortOptions): Promise<SnapshotManifest>;
}

export interface ReaderPort {
  sync(options?: PortOptions): Promise<{ updated: boolean; generation: string; manifest: SnapshotManifest }>;
  getStatus(options?: PortOptions): Promise<{ generation: string | null; stale: boolean; mode: "vector" | "lexical" }>;
  close(options?: PortOptions): Promise<void>;
}

export interface ContextPort {
  extractProjectContext(projectRoot: string, taskOrCardId?: string, options?: PortOptions): Promise<ProjectContext>;
}

export interface SearchPort {
  search(
    query: string,
    options?: SearchOptions,
  ): Promise<SearchResult | SearchHit[]>;
  search(
    query: string,
    context?: ProjectContext,
    options?: SearchOptions,
  ): Promise<SearchResult | SearchHit[]>;
}

export interface IdeasPort {
  generateIdeas(hits: SearchHit[], context: ProjectContext, options?: PortOptions): Promise<IdeaEvidenceBundle>;
}

export interface FeedbackPort {
  recordFeedback(feedback: IdeaFeedback, options?: PortOptions): Promise<void>;
  getFeedback(options?: PortOptions): Promise<IdeaFeedback[]>;
}

// ============================================================================
// URL Canonicalization and Source ID
// ============================================================================

const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "utm_source_platform",
  "utm_creative_format",
  "utm_marketing_tactic",
  "fbclid",
  "gclid",
  "gclsrc",
  "dclid",
  "msclkid",
  "mc_eid",
  "_ga",
  "_gl",
  "ref",
  "ref_src",
  "ref_url",
  "source",
  "spm",
  "igshid",
]);

/**
 * Normalizes an external URL and derives its immutable SHA-256 sourceId.
 *
 * Rules:
 * - Scheme must be http: or https:. Credentials are prohibited.
 * - github-repo: normalized to `https://github.com/owner/repo` (lowercase).
 * - github-stars: normalized to `https://github.com/stars/owner` (lowercase).
 * - web: path casing is preserved; functional query params preserved & sorted;
 *   tracking params stripped; fragments stripped; trailing slashes stripped (except /).
 */
export function canonicalizeUrl(
  rawUrl: string,
  kind: SourceKind,
): { canonicalUrl: string; sourceId: string } {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) {
    throw new IntakeError("INVALID_URL", "URL must be a non-empty string", { rawUrl });
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch (err) {
    throw new IntakeError("INVALID_URL", `Malformed URL: ${rawUrl}`, { rawUrl, cause: String(err) });
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new IntakeError(
      "UNSUPPORTED_SCHEME",
      `Unsupported protocol '${parsed.protocol}'. Only http: and https: are allowed.`,
      { rawUrl, protocol: parsed.protocol },
    );
  }

  if (parsed.username || parsed.password) {
    throw new IntakeError(
      "CREDENTIALS_DISALLOWED",
      "Credentials (username/password) are not permitted in source URLs.",
      { rawUrl },
    );
  }

  let canonicalUrl = "";

  if (kind === "github-repo") {
    const host = parsed.hostname.toLowerCase();
    if (host !== "github.com" && host !== "www.github.com") {
      throw new IntakeError("INVALID_URL", `github-repo source must be on github.com, got ${host}`, { rawUrl, host });
    }
    const segments = parsed.pathname.split("/").filter(Boolean);
    const first = segments[0];
    const second = segments[1];
    if (!first || !second) {
      throw new IntakeError("INVALID_URL", "GitHub repository URL must include both owner and repo name", { rawUrl });
    }
    const owner = first.toLowerCase();
    let repo = second.toLowerCase();
    if (repo.endsWith(".git")) {
      repo = repo.slice(0, -4);
    }
    if (!owner || !repo) {
      throw new IntakeError("INVALID_URL", "Invalid owner or repository name in GitHub URL", { rawUrl });
    }
    canonicalUrl = `https://github.com/${owner}/${repo}`;
  } else if (kind === "github-stars") {
    const host = parsed.hostname.toLowerCase();
    if (host !== "github.com" && host !== "www.github.com") {
      throw new IntakeError("INVALID_URL", `github-stars source must be on github.com, got ${host}`, { rawUrl, host });
    }
    const segments = parsed.pathname.split("/").filter(Boolean);
    const seg0 = segments[0]?.toLowerCase();
    const seg1 = segments[1]?.toLowerCase();
    let owner = "";
    if (seg0 === "stars" && seg1) {
      owner = seg1;
    } else if (seg1 === "stars" && seg0) {
      owner = seg0;
    } else if (seg0) {
      owner = seg0;
    }
    if (!owner) {
      throw new IntakeError("INVALID_URL", "Could not identify star owner in GitHub URL", { rawUrl });
    }
    canonicalUrl = `https://github.com/stars/${owner}`;
  } else if (kind === "web") {
    const protocol = parsed.protocol.toLowerCase();
    const host = parsed.hostname.toLowerCase();
    let portPart = "";
    if (parsed.port && !((protocol === "http:" && parsed.port === "80") || (protocol === "https:" && parsed.port === "443"))) {
      portPart = `:${parsed.port}`;
    }

    // Preserve path casing, strip trailing slash unless pathname is "/"
    let pathname = parsed.pathname || "/";
    if (pathname.length > 1 && pathname.endsWith("/")) {
      pathname = pathname.slice(0, -1);
    }

    // Filter query parameters: strip tracking params, sort remaining keys
    const filteredParams = new URLSearchParams();
    const sortedKeys = Array.from(parsed.searchParams.keys()).sort();
    for (const key of sortedKeys) {
      if (!TRACKING_PARAMS.has(key.toLowerCase())) {
        const values = parsed.searchParams.getAll(key);
        for (const val of values) {
          filteredParams.append(key, val);
        }
      }
    }

    const queryString = filteredParams.toString();
    canonicalUrl = `${protocol}//${host}${portPart}${pathname}${queryString ? `?${queryString}` : ""}`;
  } else {
    throw new IntakeError("INVALID_SOURCE_SPEC", `Unknown source kind '${kind as string}'`, { kind, rawUrl });
  }

  const sourceId = createHash("sha256").update(`${kind}:${canonicalUrl}`).digest("hex");
  return { canonicalUrl, sourceId };
}

// ============================================================================
// Model Fingerprint
// ============================================================================

/**
 * Computes a deterministic SHA-256 fingerprint for an embedding profile.
 */
export function computeModelFingerprint(profile: Omit<EmbeddingProfile, "fingerprint">): string {
  if (!profile || typeof profile !== "object") {
    throw new ModelCompatibilityError("MODEL_UNAVAILABLE", "EmbeddingProfile must be a non-null object");
  }

  const normalized = {
    chunker_version: String(profile.chunker_version ?? "").trim(),
    dimensions: Number(profile.dimensions),
    model_id: String(profile.model_id ?? "").trim(),
    normalization: Boolean(profile.normalization),
    pooling: String(profile.pooling ?? "").trim().toLowerCase(),
    query_instruction: String(profile.query_instruction ?? ""),
    revision: String(profile.revision ?? "").trim(),
    sha256: String(profile.sha256 ?? "").trim().toLowerCase(),
    tokenizer: String(profile.tokenizer ?? "").trim(),
  };

  const payload = JSON.stringify(normalized);
  return createHash("sha256").update(payload).digest("hex");
}

// ============================================================================
// Boundary Validation Functions
// ============================================================================

function isValidIsoTimestamp(val: unknown): boolean {
  if (typeof val !== "string") return false;
  // Must have date, time, and timezone offset or Z
  const isoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
  return isoPattern.test(val) && !Number.isNaN(Date.parse(val));
}

function isHexSha256(val: unknown): boolean {
  return typeof val === "string" && /^[0-9a-fA-F]{64}$/.test(val);
}

/**
 * Validates a SourceSpec record against schema v1 invariants.
 */
export function validateSourceSpec(spec: unknown): SourceSpec {
  if (!spec || typeof spec !== "object") {
    throw new IntakeError("INVALID_SOURCE_SPEC", "SourceSpec must be an object", { spec });
  }

  const record = spec as Record<string, unknown>;

  const validKinds: SourceKind[] = ["github-repo", "github-stars", "web"];
  if (typeof record.kind !== "string" || !validKinds.includes(record.kind as SourceKind)) {
    throw new IntakeError("INVALID_SOURCE_SPEC", `Invalid or missing 'kind': ${String(record.kind)}`, { spec });
  }
  const kind = record.kind as SourceKind;

  if (typeof record.url !== "string" || !record.url) {
    throw new IntakeError("INVALID_SOURCE_SPEC", "Missing or empty 'url'", { spec });
  }

  const { canonicalUrl, sourceId } = canonicalizeUrl(record.url, kind);

  if (typeof record.source_id !== "string" || !isHexSha256(record.source_id)) {
    throw new IntakeError("INVALID_SOURCE_SPEC", "Missing or invalid 'source_id' (must be 64-char hex SHA-256)", { spec });
  }

  if (record.source_id !== sourceId) {
    throw new IntakeError(
      "INVALID_SOURCE_SPEC",
      `source_id '${record.source_id}' does not match computed hash '${sourceId}' for canonical URL '${canonicalUrl}'`,
      { provided: record.source_id, computed: sourceId, canonicalUrl },
    );
  }

  if (!Array.isArray(record.tags) || record.tags.some((t) => typeof t !== "string")) {
    throw new IntakeError("INVALID_SOURCE_SPEC", "'tags' must be an array of strings", { spec });
  }

  if (typeof record.enabled !== "boolean") {
    throw new IntakeError("INVALID_SOURCE_SPEC", "'enabled' must be a boolean", { spec });
  }

  if (typeof record.refresh_hours !== "number" || record.refresh_hours <= 0 || !Number.isFinite(record.refresh_hours)) {
    throw new IntakeError("INVALID_SOURCE_SPEC", "'refresh_hours' must be a positive number", { spec });
  }

  const validProvenances: SourceProvenance[] = ["manual", "github-stars", "bookmarks-import"];
  if (typeof record.provenance !== "string" || !validProvenances.includes(record.provenance as SourceProvenance)) {
    throw new IntakeError("INVALID_SOURCE_SPEC", `Invalid 'provenance': ${String(record.provenance)}`, { spec });
  }

  if (!isValidIsoTimestamp(record.created_at)) {
    throw new IntakeError("INVALID_SOURCE_SPEC", "'created_at' must be a valid ISO 8601 string with timezone", { spec });
  }

  if (!isValidIsoTimestamp(record.updated_at)) {
    throw new IntakeError("INVALID_SOURCE_SPEC", "'updated_at' must be a valid ISO 8601 string with timezone", { spec });
  }

  if (record.title !== undefined && typeof record.title !== "string") {
    throw new IntakeError("INVALID_SOURCE_SPEC", "'title' must be a string if provided", { spec });
  }

  if (record.note !== undefined && typeof record.note !== "string") {
    throw new IntakeError("INVALID_SOURCE_SPEC", "'note' must be a string if provided", { spec });
  }

  return {
    source_id: record.source_id,
    kind,
    url: canonicalUrl,
    title: record.title as string | undefined,
    tags: record.tags as string[],
    note: record.note as string | undefined,
    enabled: record.enabled,
    refresh_hours: record.refresh_hours,
    provenance: record.provenance as SourceProvenance,
    created_at: record.created_at as string,
    updated_at: record.updated_at as string,
  };
}

/**
 * Validates a DocumentRevision record.
 */
export function validateDocumentRevision(rev: unknown): DocumentRevision {
  if (!rev || typeof rev !== "object") {
    throw new KnowledgeError("INVALID_DOCUMENT_REVISION", "DocumentRevision must be an object", { rev });
  }

  const record = rev as Record<string, unknown>;

  if (typeof record.document_id !== "string" || !record.document_id.trim()) {
    throw new KnowledgeError("INVALID_DOCUMENT_REVISION", "Missing or empty 'document_id'", { rev });
  }

  if (typeof record.source_id !== "string" || !isHexSha256(record.source_id)) {
    throw new KnowledgeError("INVALID_DOCUMENT_REVISION", "Missing or invalid 'source_id'", { rev });
  }

  if (typeof record.url !== "string" || !record.url.trim()) {
    throw new KnowledgeError("INVALID_DOCUMENT_REVISION", "Missing or empty 'url'", { rev });
  }

  if (typeof record.revision !== "string" || !record.revision.trim()) {
    throw new KnowledgeError("INVALID_DOCUMENT_REVISION", "Missing or empty 'revision'", { rev });
  }

  if (typeof record.content_hash !== "string" || !record.content_hash.trim()) {
    throw new KnowledgeError("INVALID_DOCUMENT_REVISION", "Missing or empty 'content_hash'", { rev });
  }

  if (typeof record.text !== "string") {
    throw new KnowledgeError("INVALID_DOCUMENT_REVISION", "'text' must be a string", { rev });
  }

  if (!isValidIsoTimestamp(record.fetched_at)) {
    throw new KnowledgeError("INVALID_DOCUMENT_REVISION", "'fetched_at' must be a valid ISO 8601 string", { rev });
  }

  const validStatuses: DocumentStatus[] = [
    "success",
    "unchanged",
    "retry",
    "failed",
    "unsupported",
    "tombstone",
  ];
  if (typeof record.status !== "string" || !validStatuses.includes(record.status as DocumentStatus)) {
    throw new KnowledgeError("INVALID_DOCUMENT_REVISION", `Invalid 'status': ${String(record.status)}`, { rev });
  }

  if (record.title !== undefined && typeof record.title !== "string") {
    throw new KnowledgeError("INVALID_DOCUMENT_REVISION", "'title' must be a string if provided", { rev });
  }

  if (record.license !== undefined && typeof record.license !== "string") {
    throw new KnowledgeError("INVALID_DOCUMENT_REVISION", "'license' must be a string if provided", { rev });
  }

  if (record.error !== undefined && typeof record.error !== "string") {
    throw new KnowledgeError("INVALID_DOCUMENT_REVISION", "'error' must be a string if provided", { rev });
  }

  return {
    document_id: record.document_id,
    source_id: record.source_id,
    url: record.url,
    revision: record.revision,
    content_hash: record.content_hash,
    title: record.title as string | undefined,
    text: record.text,
    license: record.license as string | undefined,
    fetched_at: record.fetched_at as string,
    status: record.status as DocumentStatus,
    error: record.error as string | undefined,
  };
}

/**
 * Validates a SnapshotManifest record.
 */
export function validateSnapshotManifest(manifest: unknown): SnapshotManifest {
  if (!manifest || typeof manifest !== "object") {
    throw new ManifestValidationError("INVALID_MANIFEST", "SnapshotManifest must be an object", { manifest });
  }

  const record = manifest as Record<string, unknown>;

  if (record.schema_version !== 1) {
    throw new ManifestValidationError("INVALID_MANIFEST", `Expected schema_version 1, got ${String(record.schema_version)}`, { manifest });
  }

  if (record.format_version !== 1) {
    throw new ManifestValidationError("INVALID_MANIFEST", `Expected format_version 1, got ${String(record.format_version)}`, { manifest });
  }

  if (typeof record.catalog_id !== "string" || !record.catalog_id.trim()) {
    throw new ManifestValidationError("INVALID_MANIFEST", "Missing or empty 'catalog_id'", { manifest });
  }

  if (typeof record.generation !== "string" || !record.generation.trim()) {
    throw new ManifestValidationError("INVALID_MANIFEST", "Missing or empty 'generation'", { manifest });
  }

  if (record.parent_generation !== undefined && (typeof record.parent_generation !== "string" || !record.parent_generation.trim())) {
    throw new ManifestValidationError("INVALID_MANIFEST", "'parent_generation' must be a non-empty string if provided", { manifest });
  }

  if (typeof record.input_commit !== "string" || !record.input_commit.trim()) {
    throw new ManifestValidationError("INVALID_MANIFEST", "Missing or empty 'input_commit'", { manifest });
  }

  if (!isValidIsoTimestamp(record.created_at)) {
    throw new ManifestValidationError("INVALID_MANIFEST", "'created_at' must be a valid ISO 8601 string", { manifest });
  }

  if (!record.source_summary || typeof record.source_summary !== "object") {
    throw new ManifestValidationError("INVALID_MANIFEST", "Missing or invalid 'source_summary'", { manifest });
  }

  const summary = record.source_summary as Record<string, unknown>;
  if (
    typeof summary.total !== "number" || summary.total < 0 ||
    typeof summary.active !== "number" || summary.active < 0 ||
    typeof summary.failed !== "number" || summary.failed < 0
  ) {
    throw new ManifestValidationError("INVALID_MANIFEST", "'source_summary' counts must be non-negative numbers", { manifest });
  }

  if (typeof record.document_count !== "number" || record.document_count < 0) {
    throw new ManifestValidationError("INVALID_MANIFEST", "'document_count' must be a non-negative number", { manifest });
  }

  if (typeof record.chunk_count !== "number" || record.chunk_count < 0) {
    throw new ManifestValidationError("INVALID_MANIFEST", "'chunk_count' must be a non-negative number", { manifest });
  }

  if (typeof record.model_fingerprint !== "string" || !isHexSha256(record.model_fingerprint)) {
    throw new ManifestValidationError("INVALID_MANIFEST", "'model_fingerprint' must be a 64-char hex SHA-256", { manifest });
  }

  if (record.sqlite_vec_version !== undefined && typeof record.sqlite_vec_version !== "string") {
    throw new ManifestValidationError("INVALID_MANIFEST", "'sqlite_vec_version' must be a string if provided", { manifest });
  }

  if (typeof record.file_size_bytes !== "number" || record.file_size_bytes <= 0) {
    throw new ManifestValidationError("INVALID_MANIFEST", "'file_size_bytes' must be a positive number", { manifest });
  }

  if (typeof record.file_sha256 !== "string" || !isHexSha256(record.file_sha256)) {
    throw new ManifestValidationError("INVALID_MANIFEST", "'file_sha256' must be a 64-char hex SHA-256", { manifest });
  }

  if (typeof record.min_reader_version !== "string" || !record.min_reader_version.trim()) {
    throw new ManifestValidationError("INVALID_MANIFEST", "Missing or empty 'min_reader_version'", { manifest });
  }

  return {
    schema_version: 1,
    format_version: 1,
    catalog_id: record.catalog_id,
    generation: record.generation,
    parent_generation: record.parent_generation as string | undefined,
    input_commit: record.input_commit,
    created_at: record.created_at as string,
    source_summary: {
      total: summary.total,
      active: summary.active,
      failed: summary.failed,
    },
    document_count: record.document_count,
    chunk_count: record.chunk_count,
    model_fingerprint: record.model_fingerprint.toLowerCase(),
    sqlite_vec_version: record.sqlite_vec_version as string | undefined,
    file_size_bytes: record.file_size_bytes,
    file_sha256: record.file_sha256.toLowerCase(),
    min_reader_version: record.min_reader_version,
  };
}

/**
 * Validates an EmbeddingProfile and checks that the fingerprint matches.
 */
export function validateEmbeddingProfile(profile: unknown): EmbeddingProfile {
  if (!profile || typeof profile !== "object") {
    throw new ModelCompatibilityError("MODEL_UNAVAILABLE", "EmbeddingProfile must be an object");
  }

  const record = profile as Record<string, unknown>;

  if (typeof record.model_id !== "string" || !record.model_id.trim()) {
    throw new ModelCompatibilityError("MODEL_UNAVAILABLE", "Missing or empty 'model_id'");
  }

  if (typeof record.revision !== "string" || !record.revision.trim()) {
    throw new ModelCompatibilityError("MODEL_UNAVAILABLE", "Missing or empty 'revision'");
  }

  if (typeof record.sha256 !== "string" || !isHexSha256(record.sha256)) {
    throw new ModelCompatibilityError("MODEL_UNAVAILABLE", "'sha256' must be a 64-char hex SHA-256");
  }

  if (typeof record.dimensions !== "number" || record.dimensions <= 0) {
    throw new ModelCompatibilityError("DIMENSION_MISMATCH", "'dimensions' must be a positive integer");
  }

  if (typeof record.pooling !== "string" || !record.pooling.trim()) {
    throw new ModelCompatibilityError("MODEL_UNAVAILABLE", "Missing or empty 'pooling'");
  }

  let norm = record.normalization;
  if (typeof norm === "string") {
    const lower = norm.toLowerCase();
    if (lower === "l2" || lower === "true") norm = true;
    else if (lower === "none" || lower === "false") norm = false;
  }
  if (typeof norm !== "boolean") {
    throw new ModelCompatibilityError("MODEL_UNAVAILABLE", "'normalization' must be a boolean or 'l2'");
  }

  if (typeof record.tokenizer !== "string" || !record.tokenizer.trim()) {
    throw new ModelCompatibilityError("MODEL_UNAVAILABLE", "Missing or empty 'tokenizer'");
  }

  if (typeof record.query_instruction !== "string") {
    throw new ModelCompatibilityError("MODEL_UNAVAILABLE", "'query_instruction' must be a string");
  }

  if (typeof record.chunker_version !== "string" || !record.chunker_version.trim()) {
    throw new ModelCompatibilityError("MODEL_UNAVAILABLE", "Missing or empty 'chunker_version'");
  }

  const computed = computeModelFingerprint({
    model_id: record.model_id,
    revision: record.revision,
    sha256: record.sha256,
    dimensions: record.dimensions,
    pooling: record.pooling,
    normalization: norm,
    tokenizer: record.tokenizer,
    query_instruction: record.query_instruction,
    chunker_version: record.chunker_version,
  });

  if (typeof record.fingerprint !== "string" || record.fingerprint.toLowerCase() !== computed) {
    throw new ModelCompatibilityError(
      "MODEL_FINGERPRINT_MISMATCH",
      `Profile fingerprint mismatch. Provided: ${String(record.fingerprint)}, Computed: ${computed}`,
      { provided: record.fingerprint, computed },
    );
  }

  return {
    model_id: record.model_id,
    revision: record.revision,
    sha256: record.sha256.toLowerCase(),
    dimensions: record.dimensions,
    pooling: record.pooling,
    normalization: norm,
    tokenizer: record.tokenizer,
    query_instruction: record.query_instruction,
    chunker_version: record.chunker_version,
    fingerprint: computed,
  };
}

/**
 * Validates SearchHit invariants.
 */
export function validateSearchHit(hit: unknown): SearchHit {
  if (!hit || typeof hit !== "object") {
    throw new KnowledgeError("UNKNOWN_ERROR", "SearchHit must be an object");
  }
  const r = hit as Record<string, unknown>;

  if (typeof r.chunk_id !== "string" || !r.chunk_id) throw new KnowledgeError("UNKNOWN_ERROR", "Missing chunk_id");
  if (typeof r.document_id !== "string" || !r.document_id) throw new KnowledgeError("UNKNOWN_ERROR", "Missing document_id");
  if (typeof r.source_id !== "string" || !r.source_id) throw new KnowledgeError("UNKNOWN_ERROR", "Missing source_id");
  if (typeof r.source_url !== "string" || !r.source_url) throw new KnowledgeError("UNKNOWN_ERROR", "Missing source_url");
  if (typeof r.excerpt !== "string") throw new KnowledgeError("UNKNOWN_ERROR", "Missing excerpt");
  if (typeof r.score !== "number" || !Number.isFinite(r.score)) throw new KnowledgeError("UNKNOWN_ERROR", "Invalid score");

  const validRanks: RankSource[] = ["fts", "vec", "tag", "rrf"];
  if (typeof r.rank_source !== "string" || !validRanks.includes(r.rank_source as RankSource)) {
    throw new KnowledgeError("UNKNOWN_ERROR", "Invalid rank_source");
  }

  if (!isValidIsoTimestamp(r.fetched_at)) throw new KnowledgeError("UNKNOWN_ERROR", "Invalid fetched_at");
  if (typeof r.stale !== "boolean") throw new KnowledgeError("UNKNOWN_ERROR", "Invalid stale flag");
  if (typeof r.license !== "string" || !r.license) throw new KnowledgeError("UNKNOWN_ERROR", "Invalid license");

  return {
    chunk_id: r.chunk_id,
    document_id: r.document_id,
    source_id: r.source_id,
    source_url: r.source_url,
    source_title: r.source_title as string | undefined,
    heading: r.heading as string | undefined,
    excerpt: r.excerpt,
    score: r.score,
    rank_source: r.rank_source as RankSource,
    fetched_at: r.fetched_at as string,
    stale: r.stale,
    license: r.license as string | "unknown",
    ...(r.already_used !== undefined ? { already_used: Boolean(r.already_used) } : {}),
  };
}

/**
 * Validates ProjectContext invariants.
 */
export function validateProjectContext(ctx: unknown): ProjectContext {
  if (!ctx || typeof ctx !== "object") {
    throw new KnowledgeError("UNKNOWN_ERROR", "ProjectContext must be an object");
  }
  const r = ctx as Record<string, unknown>;
  if (typeof r.project_name !== "string" || !r.project_name) throw new KnowledgeError("UNKNOWN_ERROR", "Missing project_name");
  if (!Array.isArray(r.stack)) throw new KnowledgeError("UNKNOWN_ERROR", "stack must be array");
  if (!Array.isArray(r.goals)) throw new KnowledgeError("UNKNOWN_ERROR", "goals must be array");
  if (!Array.isArray(r.existing_deps)) throw new KnowledgeError("UNKNOWN_ERROR", "existing_deps must be array");
  if (!Array.isArray(r.related_files)) throw new KnowledgeError("UNKNOWN_ERROR", "related_files must be array");

  return {
    project_name: r.project_name,
    stack: r.stack.map(String),
    goals: r.goals.map(String),
    existing_deps: r.existing_deps.map(String),
    related_files: r.related_files.map(String),
  };
}

/**
 * Validates IdeaEvidence invariants.
 */
export function validateIdeaEvidence(idea: unknown): IdeaEvidence {
  if (!idea || typeof idea !== "object") {
    throw new KnowledgeError("UNKNOWN_ERROR", "IdeaEvidence must be an object");
  }
  const r = idea as Record<string, unknown>;

  if (typeof r.capability_name !== "string" || !r.capability_name) throw new KnowledgeError("UNKNOWN_ERROR", "Missing capability_name");
  if (typeof r.problem_to_solve !== "string" || !r.problem_to_solve) throw new KnowledgeError("UNKNOWN_ERROR", "Missing problem_to_solve");
  if (typeof r.project_anchor !== "string" || !r.project_anchor) throw new KnowledgeError("UNKNOWN_ERROR", "Missing project_anchor");
  if (typeof r.tool_anchor !== "string" || !r.tool_anchor) throw new KnowledgeError("UNKNOWN_ERROR", "Missing tool_anchor");

  const validTypes: IntegrationType[] = ["api", "mcp", "cli", "sdk", "library"];
  if (typeof r.integration_type !== "string" || !validTypes.includes(r.integration_type as IntegrationType)) {
    throw new KnowledgeError("UNKNOWN_ERROR", "Invalid integration_type");
  }

  if (!Array.isArray(r.candidate_files)) throw new KnowledgeError("UNKNOWN_ERROR", "candidate_files must be array");
  if (typeof r.minimum_experiment !== "string" || !r.minimum_experiment) throw new KnowledgeError("UNKNOWN_ERROR", "Missing minimum_experiment");
  if (!Array.isArray(r.acceptance_criteria)) throw new KnowledgeError("UNKNOWN_ERROR", "acceptance_criteria must be array");
  if (typeof r.cost_license !== "string" || !r.cost_license) throw new KnowledgeError("UNKNOWN_ERROR", "Missing cost_license");

  const validConfidences: Confidence[] = ["high", "medium", "low", "unknown"];
  if (typeof r.confidence !== "string" || !validConfidences.includes(r.confidence as Confidence)) {
    throw new KnowledgeError("UNKNOWN_ERROR", "Invalid confidence");
  }

  return {
    capability_name: r.capability_name,
    problem_to_solve: r.problem_to_solve,
    project_anchor: r.project_anchor,
    tool_anchor: r.tool_anchor,
    integration_type: r.integration_type as IntegrationType,
    candidate_files: r.candidate_files.map(String),
    minimum_experiment: r.minimum_experiment,
    acceptance_criteria: r.acceptance_criteria.map(String),
    cost_license: r.cost_license,
    confidence: r.confidence as Confidence,
  };
}

// ============================================================================
// Timeout and Signal Handling Wrapper
// ============================================================================

/**
 * Executes an async action with optional timeout and cancellation handling.
 */
export async function withPortTimeout<T>(
  action: (signal: AbortSignal) => Promise<T>,
  options?: PortOptions,
): Promise<T> {
  const externalSignal = options?.signal;
  if (externalSignal?.aborted) {
    throw new CancellationError(
      "OPERATION_CANCELLED",
      `Operation cancelled: ${externalSignal.reason ? String(externalSignal.reason) : "signal already aborted"}`,
    );
  }

  const timeoutMs = options?.timeoutMs;
  const controller = new AbortController();

  let timer: NodeJS.Timeout | undefined;

  const onExternalAbort = () => {
    controller.abort(externalSignal?.reason ?? new Error("Aborted by caller"));
  };

  if (externalSignal) {
    externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }

  const actionPromise = action(controller.signal);

  const racePromises: Array<Promise<any>> = [actionPromise];

  if (typeof timeoutMs === "number" && timeoutMs > 0) {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort(new Error(`Operation timed out after ${timeoutMs}ms`));
        reject(new TimeoutError("OPERATION_TIMEOUT", `Operation timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    racePromises.push(timeoutPromise);
  }

  if (externalSignal) {
    const cancelPromise = new Promise<never>((_, reject) => {
      externalSignal.addEventListener("abort", () => {
        reject(new CancellationError("OPERATION_CANCELLED", "Operation cancelled by caller"));
      }, { once: true });
    });
    racePromises.push(cancelPromise);
  }

  try {
    return await Promise.race(racePromises);
  } finally {
    if (timer) clearTimeout(timer);
    if (externalSignal) {
      externalSignal.removeEventListener("abort", onExternalAbort);
    }
  }
}
