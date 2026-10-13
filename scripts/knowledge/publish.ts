/**
 * publish.ts — SQLite snapshot export, verification, and staged immutable publishing
 * for the harness knowledge library.
 *
 * Implements PublisherPort and PublisherService:
 * - AC-1: Safe SQLite export:
 *   - Outside write transactions: acquires CatalogLock, executes `VACUUM INTO '<tempDir>/catalog.sqlite'`.
 *   - Read-only verification: PRAGMA integrity_check, foreign keys, row counts, kl_meta values, FTS queries.
 *   - Standalone single-file SQLite database without WAL/SHM artifacts.
 * - AC-2: Stepwise immutable publishing:
 *   - Upload snapshot -> Upload manifest -> Verify both objects -> CAS update latest.json.
 *   - Exact SHA-256 and byte size computed from exported file.
 *   - If any step fails before latest pointer update, previous latest generation remains untouched.
 * - AC-3: Generation retention and pruning:
 *   - Keep at least 3 recent generations.
 *   - Never prune current latest generation or immediately preceding generation.
 *   - Manifest records summary of active and failed/tombstone sources.
 */

import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import { promises as fsPromises } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  type SnapshotManifest,
  type SourceSummary,
  type PortOptions,
  type PublisherPort,
  validateSnapshotManifest,
  StorageError,
  ManifestValidationError,
  CancellationError,
  TimeoutError,
  withPortTimeout,
} from "./contracts.ts";
import {
  type ObjectStorePort,
  validateStorageKey,
  computeEtag,
  normalizeEtag,
} from "./storage.ts";
import {
  type CatalogMeta,
  openCatalogDatabase,
  getCatalogMeta,
  isVec0Available,
  createGenerationId,
} from "./migrations.ts";
import { CatalogService, CatalogLock } from "./catalog.ts";

// ============================================================================
// Types and Interfaces
// ============================================================================

export interface LatestPointer {
  catalog_id: string;
  generation: string;
  manifest_key: string;
  snapshot_key: string;
  file_sha256: string;
  file_size_bytes: number;
  model_fingerprint: string;
  updated_at: string;
}

export interface PublisherServiceOptions {
  catalogDbPath?: string;
  catalogDb?: DatabaseSync;
  catalogService?: CatalogService;
  objectStore?: ObjectStorePort;
  catalogId?: string;
  generation?: string;
  parentGeneration?: string;
  inputCommit?: string;
  minReaderVersion?: string;
  sqliteVecVersion?: string;
  tempDir?: string;
  retentionGenerations?: number; // default: 3
  lockPath?: string;
  lockTimeoutMs?: number;
  lockLeaseMs?: number;
}

export interface PublishSnapshotOptions {
  catalogDbPath?: string;
  catalogDb?: DatabaseSync;
  catalogService?: CatalogService;
  generation?: string;
  parentGeneration?: string;
  inputCommit?: string;
  objectStore?: ObjectStorePort;
  portOptions?: PortOptions;
  tempDir?: string;
  retentionGenerations?: number;
}

export interface ExportSnapshotOptions extends PortOptions {
  tempDir?: string;
  snapshotPath?: string;
  generation?: string;
}

export interface ExportSnapshotResult {
  snapshotPath: string;
  manifest: SnapshotManifest;
}

export interface SnapshotVerificationResult {
  ok: boolean;
  meta: CatalogMeta;
  documentCount: number;
  chunkCount: number;
  sourceSummary: SourceSummary;
  fileSizeBytes: number;
  fileSha256: string;
}

// ============================================================================
// Validation and Helper Functions
// ============================================================================

/**
 * Validates a LatestPointer object.
 */
export function validateLatestPointer(raw: unknown): LatestPointer {
  if (!raw || typeof raw !== "object") {
    throw new ManifestValidationError(
      "INVALID_MANIFEST",
      "Latest pointer must be a non-null object",
    );
  }
  const r = raw as Record<string, unknown>;

  if (typeof r.catalog_id !== "string" || !r.catalog_id.trim()) {
    throw new ManifestValidationError(
      "INVALID_MANIFEST",
      "Latest pointer missing or empty 'catalog_id'",
    );
  }
  if (typeof r.generation !== "string" || !r.generation.trim()) {
    throw new ManifestValidationError(
      "INVALID_MANIFEST",
      "Latest pointer missing or empty 'generation'",
    );
  }
  if (typeof r.manifest_key !== "string" || !r.manifest_key.trim()) {
    throw new ManifestValidationError(
      "INVALID_MANIFEST",
      "Latest pointer missing or empty 'manifest_key'",
    );
  }
  if (typeof r.snapshot_key !== "string" || !r.snapshot_key.trim()) {
    throw new ManifestValidationError(
      "INVALID_MANIFEST",
      "Latest pointer missing or empty 'snapshot_key'",
    );
  }
  if (typeof r.file_sha256 !== "string" || !/^[0-9a-fA-F]{64}$/.test(r.file_sha256)) {
    throw new ManifestValidationError(
      "INVALID_MANIFEST",
      "Latest pointer missing or invalid 'file_sha256'",
    );
  }
  if (typeof r.file_size_bytes !== "number" || r.file_size_bytes <= 0) {
    throw new ManifestValidationError(
      "INVALID_MANIFEST",
      "Latest pointer missing or invalid 'file_size_bytes'",
    );
  }
  if (typeof r.model_fingerprint !== "string" || !/^[0-9a-fA-F]{64}$/.test(r.model_fingerprint)) {
    throw new ManifestValidationError(
      "INVALID_MANIFEST",
      "Latest pointer missing or invalid 'model_fingerprint'",
    );
  }
  if (typeof r.updated_at !== "string" || Number.isNaN(Date.parse(r.updated_at))) {
    throw new ManifestValidationError(
      "INVALID_MANIFEST",
      "Latest pointer missing or invalid 'updated_at'",
    );
  }

  return {
    catalog_id: r.catalog_id,
    generation: r.generation,
    manifest_key: r.manifest_key,
    snapshot_key: r.snapshot_key,
    file_sha256: r.file_sha256.toLowerCase(),
    file_size_bytes: r.file_size_bytes,
    model_fingerprint: r.model_fingerprint.toLowerCase(),
    updated_at: r.updated_at,
  };
}

/**
 * Resolves current Git HEAD commit SHA, falling back to a default zero hash if unavailable.
 */
export function getGitCommitSha(): string {
  try {
    const sha = execSync("git rev-parse HEAD", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (sha && /^[0-9a-fA-F]{40}$/.test(sha)) {
      return sha;
    }
  } catch {
    // Git not available or not inside a repo
  }
  return "0000000000000000000000000000000000000000";
}

/**
 * Opens an exported snapshot database file in read-only mode and executes comprehensive
 * integrity, schema, row-count, and FTS verification checks.
 *
 * Satisfies AC-1.
 */
export async function verifyExportedSnapshot(
  snapshotPath: string,
  options?: {
    expectedMeta?: Partial<CatalogMeta>;
    sourceDb?: DatabaseSync;
    signal?: AbortSignal;
  },
): Promise<SnapshotVerificationResult> {
  if (options?.signal?.aborted) {
    throw new CancellationError("OPERATION_CANCELLED", "Verification cancelled by signal");
  }

  if (!fs.existsSync(snapshotPath)) {
    throw new StorageError(
      "INTEGRITY_CHECK_FAILED",
      `Exported snapshot file does not exist at '${snapshotPath}'`,
    );
  }

  const stat = await fsPromises.stat(snapshotPath);
  if (stat.size <= 0) {
    throw new StorageError(
      "INTEGRITY_CHECK_FAILED",
      `Exported snapshot file is empty (0 bytes) at '${snapshotPath}'`,
    );
  }

  let snapDb: DatabaseSync;
  try {
    snapDb = new DatabaseSync(snapshotPath, { readOnly: true });
  } catch (err: unknown) {
    throw new StorageError(
      "INTEGRITY_CHECK_FAILED",
      `Failed to open exported snapshot database in read-only mode: ${(err as Error).message}`,
    );
  }

  try {
    if (options?.signal?.aborted) {
      throw new CancellationError("OPERATION_CANCELLED", "Verification cancelled by signal");
    }

    // 1. PRAGMA integrity_check
    let integrityRows: Array<{ integrity_check?: string }>;
    try {
      integrityRows = snapDb.prepare("PRAGMA integrity_check;").all() as Array<{
        integrity_check?: string;
      }>;
    } catch (err: unknown) {
      throw new StorageError(
        "INTEGRITY_CHECK_FAILED",
        `PRAGMA integrity_check error: ${(err as Error).message}`,
      );
    }

    for (const row of integrityRows) {
      if (!row.integrity_check || row.integrity_check.toLowerCase() !== "ok") {
        throw new StorageError(
          "INTEGRITY_CHECK_FAILED",
          `Snapshot integrity check failed: ${row.integrity_check}`,
        );
      }
    }

    // 2. PRAGMA foreign_key_check
    try {
      const fkRows = snapDb.prepare("PRAGMA foreign_key_check;").all();
      if (fkRows.length > 0) {
        throw new StorageError(
          "INTEGRITY_CHECK_FAILED",
          `Snapshot foreign key check failed with ${fkRows.length} violations`,
        );
      }
    } catch (err: unknown) {
      if (err instanceof StorageError) throw err;
      throw new StorageError(
        "INTEGRITY_CHECK_FAILED",
        `PRAGMA foreign_key_check error: ${(err as Error).message}`,
      );
    }

    // 3. Verify kl_meta values
    const meta = getCatalogMeta(snapDb);
    if (!meta) {
      throw new StorageError(
        "INTEGRITY_CHECK_FAILED",
        "Snapshot kl_meta table is missing, uninitialized, or empty",
      );
    }

    if (meta.schema_version !== 1) {
      throw new StorageError(
        "INTEGRITY_CHECK_FAILED",
        `Snapshot schema_version expected 1, got ${meta.schema_version}`,
      );
    }

    if (options?.expectedMeta) {
      const exp = options.expectedMeta;
      if (exp.catalog_id && meta.catalog_id !== exp.catalog_id) {
        throw new StorageError(
          "INTEGRITY_CHECK_FAILED",
          `Snapshot catalog_id mismatch: expected '${exp.catalog_id}', got '${meta.catalog_id}'`,
        );
      }
      if (exp.generation && meta.generation !== exp.generation) {
        throw new StorageError(
          "INTEGRITY_CHECK_FAILED",
          `Snapshot generation mismatch: expected '${exp.generation}', got '${meta.generation}'`,
        );
      }
      if (
        exp.model_fingerprint &&
        meta.model_fingerprint.toLowerCase() !== exp.model_fingerprint.toLowerCase()
      ) {
        throw new StorageError(
          "INTEGRITY_CHECK_FAILED",
          `Snapshot model_fingerprint mismatch: expected '${exp.model_fingerprint}', got '${meta.model_fingerprint}'`,
        );
      }
    }

    // 4. Verify document and chunk row counts
    const snapDocCount =
      (snapDb.prepare("SELECT COUNT(*) as c FROM kl_documents").get() as any)?.c ?? 0;
    const snapChunkCount =
      (snapDb.prepare("SELECT COUNT(*) as c FROM kl_chunks").get() as any)?.c ?? 0;

    if (options?.sourceDb) {
      const origDocCount =
        (options.sourceDb.prepare("SELECT COUNT(*) as c FROM kl_documents").get() as any)?.c ?? 0;
      const origChunkCount =
        (options.sourceDb.prepare("SELECT COUNT(*) as c FROM kl_chunks").get() as any)?.c ?? 0;

      if (snapDocCount !== origDocCount) {
        throw new StorageError(
          "INTEGRITY_CHECK_FAILED",
          `Snapshot document count mismatch: source has ${origDocCount}, snapshot has ${snapDocCount}`,
        );
      }
      if (snapChunkCount !== origChunkCount) {
        throw new StorageError(
          "INTEGRITY_CHECK_FAILED",
          `Snapshot chunk count mismatch: source has ${origChunkCount}, snapshot has ${snapChunkCount}`,
        );
      }
    }

    // 5. Verify FTS and vector table queries
    try {
      snapDb.prepare("SELECT COUNT(*) as c FROM kl_chunks_fts").get();
      if (snapChunkCount > 0) {
        snapDb.prepare("SELECT chunk_id FROM kl_chunks_fts LIMIT 1").all();
      }
    } catch (err: unknown) {
      throw new StorageError(
        "INTEGRITY_CHECK_FAILED",
        `Snapshot FTS query validation failed: ${(err as Error).message}`,
      );
    }

    if (isVec0Available(snapDb)) {
      try {
        snapDb.prepare("SELECT COUNT(*) as c FROM kl_chunks_vec").get();
      } catch {
        // vec0 optional if not populated
      }
    }

    // 6. Source summary and active document counts
    const totalSources =
      (snapDb.prepare("SELECT COUNT(*) as c FROM kl_sources").get() as any)?.c ?? 0;
    const disabledSources =
      (snapDb.prepare("SELECT COUNT(*) as c FROM kl_sources WHERE enabled = 0").get() as any)?.c ??
      0;
    const failedDocSources =
      (
        snapDb
          .prepare(
            `
          SELECT COUNT(DISTINCT s.source_id) as c
          FROM kl_sources s
          JOIN kl_documents d ON s.source_id = d.source_id
          WHERE s.enabled = 1 AND d.status IN ('failed', 'tombstone')
        `,
          )
          .get() as any
      )?.c ?? 0;

    const failedCount = disabledSources + failedDocSources;
    const activeCount = Math.max(0, totalSources - failedCount);

    const activeDocCount =
      (
        snapDb
          .prepare("SELECT COUNT(*) as c FROM kl_documents WHERE status != 'tombstone'")
          .get() as any
      )?.c ?? 0;

    // 7. Compute exact file SHA-256 and byte size
    const fileBuffer = await fsPromises.readFile(snapshotPath);
    const fileSizeBytes = fileBuffer.length;
    const fileSha256 = createHash("sha256").update(fileBuffer).digest("hex");

    return {
      ok: true,
      meta,
      documentCount: activeDocCount,
      chunkCount: snapChunkCount,
      sourceSummary: {
        total: totalSources,
        active: activeCount,
        failed: failedCount,
      },
      fileSizeBytes,
      fileSha256,
    };
  } finally {
    try {
      snapDb.close();
    } catch {
      // ignore close errors
    }
  }
}

/**
 * Prunes generations older than the recent retention limit while strictly preserving:
 * 1. The current latest generation (never pruned).
 * 2. The immediately preceding parent generation (never pruned).
 * 3. At least `keepCount` (default: 3) most recent generations.
 *
 * Satisfies AC-3.
 */
export async function pruneOldGenerations(
  objectStore: ObjectStorePort,
  catalogId: string,
  currentGeneration: string,
  parentGeneration?: string,
  keepCount = 3,
  portOptions?: PortOptions,
): Promise<string[]> {
  const effectiveKeep = Math.max(3, keepCount);
  const prefix = `catalogs/${catalogId}/snapshots/`;
  const objects = await objectStore.listObjects(prefix, portOptions);

  if (objects.length === 0) return [];

  // Group objects by generation: catalogs/<catalogId>/snapshots/<gen>/...
  const genMap = new Map<string, Array<{ key: string; size: number; lastModified?: string }>>();
  const regex = new RegExp(`^catalogs\\/${catalogId}\\/snapshots\\/([^\\/]+)\\/(.*)$`);

  for (const obj of objects) {
    const match = regex.exec(obj.key);
    if (!match || !match[1]) continue;
    const gen = match[1];
    const list = genMap.get(gen) || [];
    list.push(obj);
    genMap.set(gen, list);
  }

  if (genMap.size <= effectiveKeep) {
    return [];
  }

  // Determine chronological timestamps for each generation
  const genDetails: Array<{ gen: string; timestamp: number; keys: string[] }> = [];

  for (const [gen, items] of genMap.entries()) {
    let timestamp = 0;
    const manifestItem = items.find((it) => it.key.endsWith("/manifest.json"));

    if (manifestItem) {
      try {
        const manObj = await objectStore.getObject(manifestItem.key, portOptions);
        if (manObj?.data) {
          const parsed = JSON.parse(manObj.data.toString("utf-8"));
          if (parsed.created_at) {
            const parsedTime = Date.parse(parsed.created_at);
            if (Number.isFinite(parsedTime)) {
              timestamp = parsedTime;
            }
          }
        }
      } catch {
        // fallback to lastModified or name
      }
    }

    if (!timestamp && manifestItem?.lastModified) {
      const parsedMod = Date.parse(manifestItem.lastModified);
      if (Number.isFinite(parsedMod)) {
        timestamp = parsedMod;
      }
    }

    if (!timestamp) {
      // Try to parse gen_YYYYMMDDHHmmss_... format
      const m = /^gen_(\d{14})_/.exec(gen);
      if (m && m[1]) {
        const s = m[1];
        const dt = new Date(
          `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}Z`,
        );
        timestamp = dt.getTime();
      }
    }

    genDetails.push({
      gen,
      timestamp: Number.isFinite(timestamp) ? timestamp : 0,
      keys: items.map((it) => it.key),
    });
  }

  // Sort from newest to oldest
  genDetails.sort((a, b) => {
    if (b.timestamp !== a.timestamp) {
      return b.timestamp - a.timestamp;
    }
    return b.gen.localeCompare(a.gen);
  });

  // AC-3: Protect current, immediately preceding, and at least effectiveKeep recent generations
  const protectedGens = new Set<string>();
  protectedGens.add(currentGeneration);
  if (parentGeneration) {
    protectedGens.add(parentGeneration);
  }

  for (let i = 0; i < Math.min(effectiveKeep, genDetails.length); i++) {
    protectedGens.add(genDetails[i]!.gen);
  }

  const pruned: string[] = [];

  for (const item of genDetails) {
    if (!protectedGens.has(item.gen)) {
      for (const key of item.keys) {
        await objectStore.deleteObject(key, portOptions);
      }
      pruned.push(item.gen);
    }
  }

  return pruned;
}

// ============================================================================
// PublisherService Implementation
// ============================================================================

export class PublisherService implements PublisherPort {
  readonly catalogDbPath?: string;
  readonly catalogDb?: DatabaseSync;
  readonly catalogService?: CatalogService;
  readonly objectStore?: ObjectStorePort;
  readonly catalogId: string;
  readonly generation?: string;
  readonly parentGeneration?: string;
  readonly inputCommit?: string;
  readonly minReaderVersion: string;
  readonly sqliteVecVersion?: string;
  readonly tempDir?: string;
  readonly retentionGenerations: number;
  readonly lockPath?: string;
  readonly lockTimeoutMs: number;
  readonly lockLeaseMs: number;

  private ownsDb = false;
  private internalDb?: DatabaseSync;

  constructor(options: PublisherServiceOptions = {}) {
    this.catalogDbPath = options.catalogDbPath;
    this.catalogDb = options.catalogDb;
    this.catalogService = options.catalogService;
    this.objectStore = options.objectStore;
    this.catalogId = options.catalogId ?? "default_catalog";
    this.generation = options.generation;
    this.parentGeneration = options.parentGeneration;
    this.inputCommit = options.inputCommit;
    this.minReaderVersion = options.minReaderVersion ?? "1.0.0";
    this.sqliteVecVersion = options.sqliteVecVersion;
    this.tempDir = options.tempDir;
    this.retentionGenerations = Math.max(3, options.retentionGenerations ?? 3);
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5000;
    this.lockLeaseMs = options.lockLeaseMs ?? 30000;

    if (options.lockPath) {
      this.lockPath = options.lockPath;
    } else if (this.catalogDbPath && this.catalogDbPath !== ":memory:") {
      this.lockPath = path.join(path.dirname(this.catalogDbPath), "catalog.lock");
    }
  }

  /**
   * Resolves the active SQLite database connection.
   */
  private resolveDatabase(options?: {
    catalogDb?: DatabaseSync;
    catalogDbPath?: string;
    catalogService?: CatalogService;
  }): { db: DatabaseSync; owns: boolean } {
    if (options?.catalogService) {
      return { db: options.catalogService.getDatabase(), owns: false };
    }
    if (options?.catalogDb) {
      return { db: options.catalogDb, owns: false };
    }
    if (options?.catalogDbPath) {
      const db = openCatalogDatabase(options.catalogDbPath, { readonly: false });
      return { db, owns: true };
    }
    if (this.catalogService) {
      return { db: this.catalogService.getDatabase(), owns: false };
    }
    if (this.catalogDb) {
      return { db: this.catalogDb, owns: false };
    }
    if (this.catalogDbPath) {
      const db = openCatalogDatabase(this.catalogDbPath, { readonly: false });
      return { db, owns: true };
    }

    throw new StorageError(
      "STORAGE_ERROR",
      "No catalog database provided to PublisherService (catalogDb, catalogService, or catalogDbPath required)",
    );
  }

  /**
   * Exports catalog database to a verified SQLite snapshot file outside write transactions.
   *
   * Satisfies AC-1.
   */
  async exportSnapshot(
    options?: ExportSnapshotOptions,
  ): Promise<ExportSnapshotResult> {
    return await withPortTimeout(
      async (signal) => {
        const { db, owns } = this.resolveDatabase();

        let lock: CatalogLock | undefined;
        if (this.lockPath) {
          lock = new CatalogLock(this.lockPath, this.lockTimeoutMs, this.lockLeaseMs);
          await lock.acquire(signal);
        }

        try {
          if (signal?.aborted) {
            throw new CancellationError("OPERATION_CANCELLED", "Export cancelled by signal");
          }

          const meta = getCatalogMeta(db);
          if (!meta) {
            throw new StorageError(
              "INTEGRITY_CHECK_FAILED",
              "Source catalog database has uninitialized or missing kl_meta table",
            );
          }

          const catalogId = this.catalogId || meta.catalog_id;
          const generation = options?.generation || this.generation || meta.generation;

          const tempDir =
            options?.tempDir ||
            this.tempDir ||
            (await fsPromises.mkdtemp(path.join(os.tmpdir(), "kl-snapshot-export-")));

          await fsPromises.mkdir(tempDir, { recursive: true });

          const snapshotPath =
            options?.snapshotPath || path.join(tempDir, "catalog.sqlite");

          if (fs.existsSync(snapshotPath)) {
            await fsPromises.unlink(snapshotPath).catch(() => {});
          }

          // SQLite VACUUM INTO outside write transactions
          const escapedPath = snapshotPath.replace(/'/g, "''");
          try {
            db.exec(`VACUUM INTO '${escapedPath}';`);
          } catch (err: unknown) {
            throw new StorageError(
              "STORAGE_ERROR",
              `SQLite VACUUM INTO failed: ${(err as Error).message}`,
            );
          }

          // Verify exported snapshot in separate read-only connection
          const verification = await verifyExportedSnapshot(snapshotPath, {
            expectedMeta: {
              catalog_id: catalogId,
              generation,
              model_fingerprint: meta.model_fingerprint,
            },
            sourceDb: db,
            signal,
          });

          const inputCommit = this.inputCommit || getGitCommitSha();

          const manifest: SnapshotManifest = {
            schema_version: 1,
            format_version: 1,
            catalog_id: catalogId,
            generation,
            parent_generation: this.parentGeneration,
            input_commit: inputCommit,
            created_at: new Date().toISOString(),
            source_summary: verification.sourceSummary,
            document_count: verification.documentCount,
            chunk_count: verification.chunkCount,
            model_fingerprint: meta.model_fingerprint.toLowerCase(),
            sqlite_vec_version: this.sqliteVecVersion,
            file_size_bytes: verification.fileSizeBytes,
            file_sha256: verification.fileSha256,
            min_reader_version: this.minReaderVersion,
          };

          const validatedManifest = validateSnapshotManifest(manifest);
          return { snapshotPath, manifest: validatedManifest };
        } finally {
          if (lock) {
            lock.release();
          }
          if (owns) {
            try {
              db.close();
            } catch {
              // ignore
            }
          }
        }
      },
      options,
    );
  }

  /**
   * Publishes snapshot using default configured options. Implements PublisherPort.publish.
   */
  async publish(options?: PortOptions): Promise<SnapshotManifest> {
    return await this.publishSnapshot({ portOptions: options });
  }

  /**
   * Fully exports, validates, and publishes a catalog snapshot to object store
   * following stepwise immutable order and updating latest pointer via CAS.
   *
   * Satisfies AC-1, AC-2, AC-3.
   */
  async publishSnapshot(
    options: PublishSnapshotOptions = {},
  ): Promise<SnapshotManifest> {
    const portOptions = options.portOptions;

    return await withPortTimeout(
      async (signal) => {
        const objectStore = options.objectStore || this.objectStore;
        if (!objectStore) {
          throw new StorageError(
            "STORAGE_ERROR",
            "ObjectStorePort is required for publishing a snapshot",
          );
        }

        const { db, owns } = this.resolveDatabase({
          catalogDb: options.catalogDb,
          catalogDbPath: options.catalogDbPath,
          catalogService: options.catalogService,
        });

        let lock: CatalogLock | undefined;
        if (this.lockPath) {
          lock = new CatalogLock(this.lockPath, this.lockTimeoutMs, this.lockLeaseMs);
          await lock.acquire(signal);
        }

        let tempDirCreated: string | null = null;
        let exportedSnapshotPath: string | null = null;

        try {
          if (signal?.aborted) {
            throw new CancellationError("OPERATION_CANCELLED", "Publish cancelled by signal");
          }

          const meta = getCatalogMeta(db);
          if (!meta) {
            throw new StorageError(
              "INTEGRITY_CHECK_FAILED",
              "Source catalog database has uninitialized or missing kl_meta table",
            );
          }

          const catalogId = this.catalogId || meta.catalog_id;
          const generation = options.generation || this.generation || meta.generation;

          // 1. Export snapshot (AC-1)
          const tempDir =
            options.tempDir ||
            this.tempDir ||
            (await fsPromises.mkdtemp(path.join(os.tmpdir(), "kl-publish-snap-")));
          tempDirCreated = tempDir;

          await fsPromises.mkdir(tempDir, { recursive: true });
          const snapshotPath = path.join(tempDir, "catalog.sqlite");
          exportedSnapshotPath = snapshotPath;

          if (fs.existsSync(snapshotPath)) {
            await fsPromises.unlink(snapshotPath).catch(() => {});
          }

          const escapedPath = snapshotPath.replace(/'/g, "''");
          try {
            db.exec(`VACUUM INTO '${escapedPath}';`);
          } catch (err: unknown) {
            throw new StorageError(
              "STORAGE_ERROR",
              `SQLite VACUUM INTO export failed: ${(err as Error).message}`,
            );
          }

          // 2. Verify exported snapshot file in read-only mode (AC-1)
          const verification = await verifyExportedSnapshot(snapshotPath, {
            expectedMeta: {
              catalog_id: catalogId,
              generation,
              model_fingerprint: meta.model_fingerprint,
            },
            sourceDb: db,
            signal,
          });

          // 3. Inspect existing latest pointer to obtain parentGeneration and expected ETag
          const latestKey = `catalogs/${catalogId}/latest.json`;
          validateStorageKey(latestKey);

          let parentGen = options.parentGeneration || this.parentGeneration;
          let expectedEtag: string | null = null;

          const currentLatestHead = await objectStore.headObject(latestKey, {
            signal,
            timeoutMs: portOptions?.timeoutMs,
          });

          if (currentLatestHead) {
            expectedEtag = currentLatestHead.etag;

            if (!parentGen) {
              const currentLatestObj = await objectStore.getObject(latestKey, {
                signal,
                timeoutMs: portOptions?.timeoutMs,
              });
              if (currentLatestObj?.data) {
                try {
                  const currentLatestData = JSON.parse(
                    currentLatestObj.data.toString("utf-8"),
                  );
                  if (currentLatestData?.generation) {
                    parentGen = String(currentLatestData.generation).trim();
                  }
                } catch {
                  // ignore parse error on previous pointer
                }
              }
            }
          }

          const inputCommit =
            options.inputCommit || this.inputCommit || getGitCommitSha();

          // 4. Construct SnapshotManifest
          const manifest: SnapshotManifest = {
            schema_version: 1,
            format_version: 1,
            catalog_id: catalogId,
            generation,
            parent_generation: parentGen,
            input_commit: inputCommit,
            created_at: new Date().toISOString(),
            source_summary: verification.sourceSummary,
            document_count: verification.documentCount,
            chunk_count: verification.chunkCount,
            model_fingerprint: meta.model_fingerprint.toLowerCase(),
            sqlite_vec_version: this.sqliteVecVersion,
            file_size_bytes: verification.fileSizeBytes,
            file_sha256: verification.fileSha256,
            min_reader_version: this.minReaderVersion,
          };

          const validatedManifest = validateSnapshotManifest(manifest);

          // 5. Stepwise immutable publishing (AC-2)
          // Step A: Upload catalog.sqlite
          const snapshotKey = `catalogs/${catalogId}/snapshots/${generation}/catalog.sqlite`;
          validateStorageKey(snapshotKey);

          const snapshotBuffer = await fsPromises.readFile(snapshotPath);
          await objectStore.putObject(snapshotKey, snapshotBuffer, {
            contentType: "application/vnd.sqlite3",
            portOptions,
          });

          // Step B: Upload manifest.json
          const manifestKey = `catalogs/${catalogId}/snapshots/${generation}/manifest.json`;
          validateStorageKey(manifestKey);

          const manifestJson = JSON.stringify(validatedManifest, null, 2);
          await objectStore.putObject(manifestKey, manifestJson, {
            contentType: "application/json",
            portOptions,
          });

          // Step C: Verify both uploaded objects before touching latest pointer
          const uploadedSnapHead = await objectStore.headObject(snapshotKey, {
            signal,
            timeoutMs: portOptions?.timeoutMs,
          });
          if (!uploadedSnapHead) {
            throw new StorageError(
              "INTEGRITY_CHECK_FAILED",
              `Verification failed: uploaded snapshot '${snapshotKey}' not found in storage`,
            );
          }
          if (uploadedSnapHead.size !== verification.fileSizeBytes) {
            throw new StorageError(
              "INTEGRITY_CHECK_FAILED",
              `Verification failed: uploaded snapshot size mismatch (expected ${verification.fileSizeBytes}, got ${uploadedSnapHead.size})`,
            );
          }

          const uploadedManifestObj = await objectStore.getObject(manifestKey, {
            signal,
            timeoutMs: portOptions?.timeoutMs,
          });
          if (!uploadedManifestObj?.data) {
            throw new StorageError(
              "INTEGRITY_CHECK_FAILED",
              `Verification failed: uploaded manifest '${manifestKey}' not found in storage`,
            );
          }

          let uploadedManifestParsed: unknown;
          try {
            uploadedManifestParsed = JSON.parse(
              uploadedManifestObj.data.toString("utf-8"),
            );
          } catch (err: unknown) {
            throw new ManifestValidationError(
              "INVALID_MANIFEST",
              `Verification failed: uploaded manifest JSON is malformed: ${(err as Error).message}`,
            );
          }

          const verifiedManifest = validateSnapshotManifest(uploadedManifestParsed);
          if (
            verifiedManifest.generation !== generation ||
            verifiedManifest.file_sha256 !== verification.fileSha256
          ) {
            throw new StorageError(
              "INTEGRITY_CHECK_FAILED",
              "Verification failed: uploaded manifest attributes do not match exported values",
            );
          }

          // Step D: Update latest.json using CAS (compareAndSwapPointer)
          const pointerPayload: LatestPointer = {
            catalog_id: catalogId,
            generation,
            manifest_key: manifestKey,
            snapshot_key: snapshotKey,
            file_sha256: verification.fileSha256,
            file_size_bytes: verification.fileSizeBytes,
            model_fingerprint: meta.model_fingerprint.toLowerCase(),
            updated_at: new Date().toISOString(),
          };

          const pointerContent = JSON.stringify(pointerPayload, null, 2);

          const casResult = await objectStore.compareAndSwapPointer(
            latestKey,
            expectedEtag,
            pointerContent,
            portOptions,
          );

          if (!casResult.success) {
            throw new StorageError(
              "ETAG_MISMATCH",
              `Pointer update conflict for '${latestKey}': expected ETag ${expectedEtag} but storage has ${casResult.currentEtag}`,
              { expectedEtag, currentEtag: casResult.currentEtag },
            );
          }

          // 6. AC-3: Generation retention and pruning after successful pointer update
          try {
            const retentionCount =
              options.retentionGenerations ?? this.retentionGenerations;
            await pruneOldGenerations(
              objectStore,
              catalogId,
              generation,
              parentGen,
              retentionCount,
              portOptions,
            );
          } catch {
            // Pruning failure does not invalidate successful publication
          }

          return validatedManifest;
        } finally {
          if (lock) {
            lock.release();
          }
          if (owns) {
            try {
              db.close();
            } catch {
              // ignore
            }
          }
          if (exportedSnapshotPath) {
            await fsPromises.unlink(exportedSnapshotPath).catch(() => {});
          }
          if (tempDirCreated) {
            await fsPromises.rm(tempDirCreated, { recursive: true, force: true }).catch(() => {});
          }
        }
      },
      portOptions,
    );
  }

  /**
   * Closes database connection if owned by this service instance.
   */
  close(): void {
    if (this.ownsDb && this.internalDb) {
      try {
        this.internalDb.close();
      } catch {
        // ignore
      }
    }
  }
}
