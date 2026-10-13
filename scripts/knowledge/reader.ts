/**
 * reader.ts — Knowledge Library Snapshot Reader Service.
 *
 * Implements ReaderPort and ReaderService:
 * - Atomic staged download and verification (.partial directory, SHA-256, PRAGMA integrity_check, schema & model compatibility).
 * - Atomic active pointer swap (active.json).
 * - Windows file-lock safety (never overwrite open SQLite databases; generation-pinned read handles).
 * - Cross-project caching with sync.lock (prevents concurrent duplicate downloads).
 * - 15-minute TTL skipping redundant syncs unless forced.
 * - Offline fallback using existing cached snapshot, or clear unavailable status if no cache.
 * - Structured status reporting (source commit, published_at, last_successful_sync, generation, mode).
 */

import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { promises as fsPromises } from "node:fs";
import * as path from "node:path";
import {
  type SnapshotManifest,
  type PortOptions,
  type ReaderPort,
  validateSnapshotManifest,
  StorageError,
  ManifestValidationError,
  ModelCompatibilityError,
  CancellationError,
  withPortTimeout,
} from "./contracts.ts";
import { type ObjectStorePort, LocalStorageAdapter } from "./storage.ts";
import { getKnowledgePaths } from "./runtime.ts";
import {
  openCatalogDatabase,
  verifyCatalogIntegrity,
  getCatalogMeta,
  isVec0Available,
} from "./migrations.ts";

// ============================================================================
// Types and Interfaces
// ============================================================================

export interface CatalogReaderHandle {
  readonly generation: string;
  readonly db: DatabaseSync;
  readonly manifest: SnapshotManifest;
  readonly dbPath: string;
  readonly mode: "vector" | "lexical";
  readonly isClosed: boolean;
  close(): void;
}

export interface ReaderStatus {
  status: "available" | "unavailable" | "stale";
  available: boolean;
  catalog_id: string;
  generation: string | null;
  source_commit: string | null;
  published_at: string | null;
  last_successful_sync: string | null;
  last_sync_check: string | null;
  mode: "vector" | "lexical";
  document_count: number;
  chunk_count: number;
  db_path: string | null;
  model_fingerprint: string | null;
  stale: boolean;
  message?: string;
}

export interface ActiveCatalogPointer {
  catalog_id: string;
  generation: string;
  snapshot_dir: string;
  db_path: string;
  manifest_path: string;
  manifest: SnapshotManifest;
  published_at: string;
  last_successful_sync: string;
  updated_at: string;
}

export interface SyncState {
  last_sync_check?: string;
  last_successful_sync?: string;
  last_generation?: string;
}

export interface ReaderServiceOptions {
  catalogId?: string;
  cacheDir?: string;
  objectStore?: ObjectStorePort;
  lockTimeoutMs?: number;
  lockLeaseMs?: number;
  ttlMinutes?: number;
  staleThresholdHours?: number;
  expectedModelFingerprint?: string;
  strictModelCheck?: boolean;
  hasVectorSupport?: boolean;
  forceMode?: "vector" | "lexical";
  readerVersion?: string;
}

export type SyncLatestResult =
  | { updated: boolean; generation: string; manifest: SnapshotManifest }
  | { skipped: boolean; reason: string };

// ============================================================================
// Internal Handle Implementation
// ============================================================================

class CatalogReaderHandleImpl implements CatalogReaderHandle {
  readonly generation: string;
  readonly db: DatabaseSync;
  readonly manifest: SnapshotManifest;
  readonly dbPath: string;
  readonly mode: "vector" | "lexical";
  private _isClosed = false;
  private readonly onClosed: () => void;

  constructor(params: {
    generation: string;
    db: DatabaseSync;
    manifest: SnapshotManifest;
    dbPath: string;
    mode: "vector" | "lexical";
    onClosed: () => void;
  }) {
    this.generation = params.generation;
    this.db = params.db;
    this.manifest = params.manifest;
    this.dbPath = params.dbPath;
    this.mode = params.mode;
    this.onClosed = params.onClosed;
  }

  get isClosed(): boolean {
    return this._isClosed;
  }

  close(): void {
    if (this._isClosed) return;
    this._isClosed = true;
    try {
      this.db.close();
    } finally {
      this.onClosed();
    }
  }
}

// ============================================================================
// Sync File Lock
// ============================================================================

export class SyncLock {
  private readonly lockPath: string;
  private readonly timeoutMs: number;
  private readonly leaseMs: number;
  private fd: number | null = null;

  constructor(lockPath: string, timeoutMs = 5000, leaseMs = 30000) {
    this.lockPath = lockPath;
    this.timeoutMs = timeoutMs;
    this.leaseMs = leaseMs;
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    const start = Date.now();

    while (Date.now() - start < this.timeoutMs) {
      if (signal?.aborted) {
        throw new CancellationError(
          "OPERATION_CANCELLED",
          "Sync lock acquisition cancelled by signal",
        );
      }

      try {
        await fsPromises.mkdir(path.dirname(this.lockPath), { recursive: true });
        const fd = fs.openSync(
          this.lockPath,
          fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
        );
        const payload = JSON.stringify({
          pid: process.pid,
          time: Date.now(),
        });
        fs.writeSync(fd, payload);
        this.fd = fd;
        return;
      } catch (err: any) {
        if (err.code !== "EEXIST") {
          throw new StorageError(
            "STORAGE_ERROR",
            `Failed to open sync lock file '${this.lockPath}': ${err.message}`,
          );
        }

        // Lock file exists — check if stale
        try {
          const stats = fs.statSync(this.lockPath);
          const ageMs = Date.now() - stats.mtimeMs;
          if (ageMs > this.leaseMs) {
            try {
              fs.unlinkSync(this.lockPath);
            } catch {
              // lost race to unlink, retry in next loop
            }
          }
        } catch {
          // stats failed (e.g. unlinked), retry in next loop
        }

        await new Promise((resolve) => setTimeout(resolve, 40));
      }
    }

    throw new StorageError(
      "STORAGE_ERROR",
      `Timed out after ${this.timeoutMs}ms waiting for sync lock at ${this.lockPath}`,
    );
  }

  release(): void {
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        // ignore
      }
      this.fd = null;
    }
    try {
      if (fs.existsSync(this.lockPath)) {
        fs.unlinkSync(this.lockPath);
      }
    } catch {
      // ignore
    }
  }
}

// ============================================================================
// Reader Service
// ============================================================================

export class ReaderService implements ReaderPort {
  readonly catalogId: string;
  readonly cacheDir: string;
  readonly objectStore?: ObjectStorePort;
  readonly lockTimeoutMs: number;
  readonly lockLeaseMs: number;
  readonly ttlMinutes: number;
  readonly staleThresholdHours: number;
  readonly expectedModelFingerprint?: string;
  readonly strictModelCheck: boolean;
  readonly hasVectorSupport: boolean;
  readonly forceMode?: "vector" | "lexical";
  readonly readerVersion: string;

  private readonly syncLock: SyncLock;
  private readonly openHandles = new Set<CatalogReaderHandleImpl>();

  constructor(options: ReaderServiceOptions = {}) {
    this.cacheDir = options.cacheDir
      ? path.resolve(options.cacheDir)
      : getKnowledgePaths().root;

    let catalogId = options.catalogId || process.env.HARNESS_KNOWLEDGE_CATALOG_ID;
    if (!catalogId) {
      const cwdCatalog = path.join(process.cwd(), "knowledge", "catalog.json");
      if (fs.existsSync(cwdCatalog)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(cwdCatalog, "utf-8"));
          if (parsed?.catalog_id) catalogId = parsed.catalog_id;
        } catch {}
      }
    }
    if (!catalogId) {
      const storageDir = path.join(this.cacheDir, "storage", "catalogs");
      if (fs.existsSync(path.join(storageDir, "default", "latest.json"))) {
        catalogId = "default";
      } else if (fs.existsSync(path.join(storageDir, "main", "latest.json"))) {
        catalogId = "main";
      }
    }
    this.catalogId = catalogId || "default";

    this.objectStore = options.objectStore;
    if (!this.objectStore) {
      const storageDir = path.join(this.cacheDir, "storage");
      const latestPath = path.join(storageDir, "catalogs", this.catalogId, "latest.json");
      if (fs.existsSync(latestPath)) {
        this.objectStore = new LocalStorageAdapter(storageDir);
      }
    }
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5000;
    this.lockLeaseMs = options.lockLeaseMs ?? 30000;
    this.ttlMinutes = options.ttlMinutes ?? 15;
    this.staleThresholdHours = options.staleThresholdHours ?? 24;
    this.expectedModelFingerprint = options.expectedModelFingerprint;
    this.strictModelCheck = options.strictModelCheck ?? false;
    this.hasVectorSupport = options.hasVectorSupport ?? true;
    this.forceMode = options.forceMode;
    this.readerVersion = options.readerVersion || "1.0.0";

    const lockPath = path.join(this.cacheDir, "sync.lock");
    this.syncLock = new SyncLock(lockPath, this.lockTimeoutMs, this.lockLeaseMs);
  }

  // ==========================================================================
  // Public API: syncLatest
  // ==========================================================================

  async syncLatest(options?: {
    force?: boolean;
    ttlMinutes?: number;
    portOptions?: PortOptions;
  }): Promise<SyncLatestResult> {
    return withPortTimeout(async (signal) => {
      const force = options?.force ?? false;
      const ttlMinutes = options?.ttlMinutes ?? this.ttlMinutes;

      // 1. Fast path TTL check (without acquiring lock if not forced)
      if (!force) {
        const syncState = await this.readSyncState();
        if (syncState?.last_sync_check) {
          const lastCheck = Date.parse(syncState.last_sync_check);
          if (
            Number.isFinite(lastCheck) &&
            Date.now() - lastCheck < ttlMinutes * 60 * 1000
          ) {
            return {
              skipped: true,
              reason: `Sync TTL not expired (${ttlMinutes}m)`,
            };
          }
        }
      }

      // 2. Offline / no object store check
      if (!this.objectStore) {
        const active = await this.loadActivePointer();
        if (active) {
          return {
            skipped: true,
            reason: "offline: no object store configured, using local cache",
          };
        }
        return {
          skipped: true,
          reason: "unavailable: no object store configured and no local cache",
        };
      }

      // 3. Acquire sync lock across projects
      await this.syncLock.acquire(signal);

      try {
        // Re-check TTL inside lock in case a concurrent worker just completed sync
        if (!force) {
          const syncStateInsideLock = await this.readSyncState();
          if (syncStateInsideLock?.last_sync_check) {
            const lastCheck = Date.parse(syncStateInsideLock.last_sync_check);
            if (
              Number.isFinite(lastCheck) &&
              Date.now() - lastCheck < ttlMinutes * 60 * 1000
            ) {
              const active = await this.loadActivePointer();
              if (active) {
                return {
                  updated: false,
                  generation: active.generation,
                  manifest: active.manifest,
                };
              }
              return {
                skipped: true,
                reason: "coalesced: synced by concurrent request",
              };
            }
          }
        }

        // 4. Fetch latest.json from object store
        const latestKey = `catalogs/${this.catalogId}/latest.json`;
        let latestObj: { data: Buffer } | null = null;
        try {
          latestObj = await this.objectStore.getObject(latestKey, {
            signal,
            timeoutMs: options?.portOptions?.timeoutMs,
          });
        } catch (err: unknown) {
          // Object store network or read error -> offline fallback
          await this.recordSyncCheck();
          const active = await this.loadActivePointer();
          if (active) {
            return {
              skipped: true,
              reason: `offline: object store error (${(err as Error).message}), using local cache`,
            };
          }
          return {
            skipped: true,
            reason: `unavailable: object store error (${(err as Error).message}) and no local cache`,
          };
        }

        if (!latestObj?.data) {
          await this.recordSyncCheck();
          const active = await this.loadActivePointer();
          if (active) {
            return {
              skipped: true,
              reason: "no remote snapshot published, using local cache",
            };
          }
          return {
            skipped: true,
            reason: "unavailable: no remote snapshot published and no local cache",
          };
        }

        // 5. Parse latest.json
        let latestData: any;
        try {
          latestData = JSON.parse(latestObj.data.toString("utf-8"));
        } catch (err: unknown) {
          throw new ManifestValidationError(
            "INVALID_MANIFEST",
            `Failed to parse latest.json: ${(err as Error).message}`,
          );
        }

        const remoteGeneration = String(
          latestData.generation ?? latestData.manifest?.generation ?? "",
        ).trim();

        if (!remoteGeneration) {
          throw new ManifestValidationError(
            "INVALID_MANIFEST",
            "latest.json missing required 'generation' field",
          );
        }

        // 6. Check if current active generation is already up-to-date
        const currentActive = await this.loadActivePointer();
        if (
          currentActive &&
          currentActive.generation === remoteGeneration &&
          fs.existsSync(currentActive.db_path)
        ) {
          await this.recordSyncCheck(true);
          return {
            updated: false,
            generation: currentActive.generation,
            manifest: currentActive.manifest,
          };
        }

        // 7. Resolve and validate snapshot manifest
        let manifestRaw: unknown;
        if (
          latestData.file_sha256 &&
          typeof latestData.file_size_bytes === "number" &&
          typeof latestData.document_count === "number"
        ) {
          manifestRaw = latestData;
        } else if (latestData.manifest && latestData.manifest.file_sha256) {
          manifestRaw = latestData.manifest;
        } else {
          // Fetch snapshots/<remoteGeneration>/manifest.json
          const manifestKey = `catalogs/${this.catalogId}/snapshots/${remoteGeneration}/manifest.json`;
          const manifestObj = await this.objectStore.getObject(manifestKey, {
            signal,
            timeoutMs: options?.portOptions?.timeoutMs,
          });
          if (!manifestObj?.data) {
            throw new StorageError(
              "KEY_NOT_FOUND",
              `Snapshot manifest not found at '${manifestKey}'`,
            );
          }
          try {
            manifestRaw = JSON.parse(manifestObj.data.toString("utf-8"));
          } catch (err: unknown) {
            throw new ManifestValidationError(
              "INVALID_MANIFEST",
              `Failed to parse manifest.json: ${(err as Error).message}`,
            );
          }
        }

        const manifest = validateSnapshotManifest(manifestRaw);

        if (manifest.catalog_id !== this.catalogId) {
          throw new ManifestValidationError(
            "INVALID_MANIFEST",
            `Manifest catalog_id '${manifest.catalog_id}' does not match expected '${this.catalogId}'`,
          );
        }

        if (this.isReaderVersionIncompatible(manifest.min_reader_version)) {
          throw new ModelCompatibilityError(
            "INCOMPATIBLE_VERSION",
            `Reader version ${this.readerVersion} is less than required min_reader_version ${manifest.min_reader_version}`,
          );
        }

        // 8. Staged download (.partial)
        const snapshotsDir = path.join(this.cacheDir, "snapshots");
        await fsPromises.mkdir(snapshotsDir, { recursive: true });
        const partialDir = path.join(snapshotsDir, `${remoteGeneration}.partial`);
        const finalDir = path.join(snapshotsDir, remoteGeneration);

        await fsPromises.rm(partialDir, { recursive: true, force: true }).catch(() => {});
        await fsPromises.mkdir(partialDir, { recursive: true });

        const sqlitePath = path.join(partialDir, "catalog.sqlite");
        const manifestPath = path.join(partialDir, "manifest.json");

        const sqliteKey = `catalogs/${this.catalogId}/snapshots/${remoteGeneration}/catalog.sqlite`;
        const sqliteObj = await this.objectStore.getObject(sqliteKey, {
          signal,
          timeoutMs: options?.portOptions?.timeoutMs,
        });

        if (!sqliteObj?.data) {
          await fsPromises.rm(partialDir, { recursive: true, force: true }).catch(() => {});
          throw new StorageError(
            "KEY_NOT_FOUND",
            `Snapshot catalog database not found at '${sqliteKey}'`,
          );
        }

        await fsPromises.writeFile(sqlitePath, sqliteObj.data);
        await fsPromises.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

        // 9. AC-1 Verification: File Size & SHA-256 Checksum
        const stat = await fsPromises.stat(sqlitePath);
        if (stat.size !== manifest.file_size_bytes) {
          await fsPromises.rm(partialDir, { recursive: true, force: true }).catch(() => {});
          throw new ManifestValidationError(
            "CHECKSUM_MISMATCH",
            `Downloaded catalog file size mismatch: actual=${stat.size}, expected=${manifest.file_size_bytes}`,
          );
        }

        const actualSha = createHash("sha256").update(sqliteObj.data).digest("hex");
        if (actualSha.toLowerCase() !== manifest.file_sha256.toLowerCase()) {
          await fsPromises.rm(partialDir, { recursive: true, force: true }).catch(() => {});
          throw new ManifestValidationError(
            "CHECKSUM_MISMATCH",
            `Downloaded catalog SHA-256 mismatch: actual=${actualSha}, expected=${manifest.file_sha256}`,
          );
        }

        // 10. AC-1 Verification: PRAGMA integrity_check and Schema/Model Compatibility
        let testDb: DatabaseSync | null = null;
        try {
          testDb = openCatalogDatabase(sqlitePath, { readonly: true });
          const integrityRows = testDb.prepare("PRAGMA integrity_check;").all() as Array<{
            integrity_check?: string;
          }>;
          const integrityErrors: string[] = [];
          for (const r of integrityRows) {
            if (r.integrity_check && r.integrity_check.toLowerCase() !== "ok") {
              integrityErrors.push(r.integrity_check);
            }
          }
          if (integrityErrors.length > 0) {
            throw new StorageError(
              "INTEGRITY_CHECK_FAILED",
              `Downloaded catalog integrity check failed: ${integrityErrors.join("; ")}`,
            );
          }

          const fkRows = testDb.prepare("PRAGMA foreign_key_check;").all();
          if (fkRows.length > 0) {
            throw new StorageError(
              "INTEGRITY_CHECK_FAILED",
              `Foreign key violations detected in catalog: ${fkRows.length}`,
            );
          }

          const meta = getCatalogMeta(testDb);
          if (!meta) {
            throw new StorageError(
              "INTEGRITY_CHECK_FAILED",
              "Downloaded catalog missing 'kl_meta' table or records",
            );
          }

          if (meta.schema_version !== manifest.schema_version) {
            throw new ManifestValidationError(
              "INCOMPATIBLE_VERSION",
              `Catalog schema_version mismatch: db=${meta.schema_version}, manifest=${manifest.schema_version}`,
            );
          }

          if (meta.model_fingerprint.toLowerCase() !== manifest.model_fingerprint.toLowerCase()) {
            throw new ModelCompatibilityError(
              "MODEL_FINGERPRINT_MISMATCH",
              `Catalog model_fingerprint mismatch: db=${meta.model_fingerprint}, manifest=${manifest.model_fingerprint}`,
            );
          }

          if (
            this.expectedModelFingerprint &&
            this.strictModelCheck &&
            meta.model_fingerprint.toLowerCase() !== this.expectedModelFingerprint.toLowerCase()
          ) {
            throw new ModelCompatibilityError(
              "MODEL_FINGERPRINT_MISMATCH",
              `Catalog model_fingerprint mismatch with reader profile: db=${meta.model_fingerprint}, expected=${this.expectedModelFingerprint}`,
            );
          }
        } catch (err: unknown) {
          if (testDb) {
            try {
              testDb.close();
            } catch {}
            testDb = null;
          }
          await fsPromises.rm(partialDir, { recursive: true, force: true }).catch(() => {});
          throw err;
        } finally {
          if (testDb) {
            try {
              testDb.close();
            } catch {}
          }
        }

        // 11. Atomic promotion: rename .partial to final generation directory
        if (fs.existsSync(finalDir)) {
          await fsPromises.rm(finalDir, { recursive: true, force: true }).catch(() => {});
        }
        await fsPromises.rename(partialDir, finalDir);

        // 12. Atomically update pointer active.json
        const nowIso = new Date().toISOString();
        const activePointer: ActiveCatalogPointer = {
          catalog_id: this.catalogId,
          generation: remoteGeneration,
          snapshot_dir: finalDir,
          db_path: path.join(finalDir, "catalog.sqlite"),
          manifest_path: path.join(finalDir, "manifest.json"),
          manifest,
          published_at: manifest.created_at,
          last_successful_sync: nowIso,
          updated_at: nowIso,
        };

        const activePath = path.join(this.cacheDir, "active.json");
        const tmpActivePath = `${activePath}.tmp.${process.pid}.${Date.now()}.${randomBytes(3).toString("hex")}`;
        await fsPromises.writeFile(tmpActivePath, JSON.stringify(activePointer, null, 2), "utf-8");
        await fsPromises.rename(tmpActivePath, activePath);

        await this.recordSyncCheck(true);

        // 13. Retention: prune old generations safely
        await this.pruneOldGenerations(remoteGeneration);

        return {
          updated: true,
          generation: remoteGeneration,
          manifest,
        };
      } finally {
        this.syncLock.release();
      }
    }, options?.portOptions);
  }

  // ==========================================================================
  // Public API: openActiveCatalog
  // ==========================================================================

  async openActiveCatalog(options?: PortOptions): Promise<CatalogReaderHandle | null> {
    if (options?.signal?.aborted) {
      throw new CancellationError(
        "OPERATION_CANCELLED",
        "openActiveCatalog aborted by caller",
      );
    }

    const pointer = await this.loadActivePointer();
    if (!pointer) {
      return null;
    }

    if (!fs.existsSync(pointer.db_path)) {
      return null;
    }

    const db = openCatalogDatabase(pointer.db_path, { readonly: true });

    // Determine mode
    let mode: "vector" | "lexical" = "lexical";
    if (this.forceMode) {
      mode = this.forceMode;
    } else {
      const vecAvailable = isVec0Available(db);
      if (vecAvailable && this.hasVectorSupport) {
        if (
          !this.expectedModelFingerprint ||
          this.expectedModelFingerprint.toLowerCase() ===
            pointer.manifest.model_fingerprint.toLowerCase()
        ) {
          mode = "vector";
        }
      }
    }

    const handle = new CatalogReaderHandleImpl({
      generation: pointer.generation,
      db,
      manifest: pointer.manifest,
      dbPath: pointer.db_path,
      mode,
      onClosed: () => {
        this.openHandles.delete(handle);
      },
    });

    this.openHandles.add(handle);
    return handle;
  }

  async acquireReaderHandle(options?: PortOptions): Promise<CatalogReaderHandle | null> {
    return this.openActiveCatalog(options);
  }

  // ==========================================================================
  // Public API: getReaderStatus
  // ==========================================================================

  async getReaderStatus(options?: PortOptions): Promise<ReaderStatus> {
    if (options?.signal?.aborted) {
      throw new CancellationError(
        "OPERATION_CANCELLED",
        "getReaderStatus aborted by caller",
      );
    }

    const pointer = await this.loadActivePointer();
    const syncState = await this.readSyncState();

    if (!pointer || !fs.existsSync(pointer.db_path)) {
      return {
        status: "unavailable",
        available: false,
        catalog_id: this.catalogId,
        generation: null,
        source_commit: null,
        published_at: null,
        last_successful_sync: syncState?.last_successful_sync ?? null,
        last_sync_check: syncState?.last_sync_check ?? null,
        mode: "lexical",
        document_count: 0,
        chunk_count: 0,
        db_path: null,
        model_fingerprint: null,
        stale: false,
        message: "No cached snapshot available",
      };
    }

    const lastSyncMs = Date.parse(pointer.last_successful_sync);
    const isStale =
      Number.isFinite(lastSyncMs) &&
      (this.staleThresholdHours === 0 ||
        Date.now() - lastSyncMs >= this.staleThresholdHours * 3600 * 1000);

    let mode: "vector" | "lexical" = "lexical";
    if (this.forceMode) {
      mode = this.forceMode;
    } else if (this.hasVectorSupport) {
      if (
        !this.expectedModelFingerprint ||
        this.expectedModelFingerprint.toLowerCase() ===
          pointer.manifest.model_fingerprint.toLowerCase()
      ) {
        mode = pointer.manifest.sqlite_vec_version ? "vector" : "lexical";
      }
    }

    return {
      status: isStale ? "stale" : "available",
      available: true,
      catalog_id: pointer.catalog_id,
      generation: pointer.generation,
      source_commit: pointer.manifest.input_commit,
      published_at: pointer.manifest.created_at,
      last_successful_sync: pointer.last_successful_sync,
      last_sync_check: syncState?.last_sync_check ?? pointer.last_successful_sync,
      mode,
      document_count: pointer.manifest.document_count,
      chunk_count: pointer.manifest.chunk_count,
      db_path: pointer.db_path,
      model_fingerprint: pointer.manifest.model_fingerprint,
      stale: isStale,
    };
  }

  // ==========================================================================
  // ReaderPort Implementation
  // ==========================================================================

  async sync(
    options?: PortOptions,
  ): Promise<{ updated: boolean; generation: string; manifest: SnapshotManifest }> {
    const result = await this.syncLatest({ force: true, portOptions: options });
    if ("skipped" in result) {
      const active = await this.loadActivePointer();
      if (active) {
        return {
          updated: false,
          generation: active.generation,
          manifest: active.manifest,
        };
      }
      throw new StorageError(
        "STORAGE_ERROR",
        `Sync skipped: ${result.reason} and no cached snapshot is available`,
      );
    }
    return result;
  }

  async getStatus(
    options?: PortOptions,
  ): Promise<{ generation: string | null; stale: boolean; mode: "vector" | "lexical" }> {
    const status = await this.getReaderStatus(options);
    return {
      generation: status.generation,
      stale: status.stale,
      mode: status.mode,
    };
  }

  async close(options?: PortOptions): Promise<void> {
    const handles = Array.from(this.openHandles);
    for (const h of handles) {
      h.close();
    }
    this.openHandles.clear();
  }

  // ==========================================================================
  // Internal Helpers
  // ==========================================================================

  private async loadActivePointer(): Promise<ActiveCatalogPointer | null> {
    const activePath = path.join(this.cacheDir, "active.json");
    try {
      const raw = await fsPromises.readFile(activePath, "utf-8");
      const parsed = JSON.parse(raw) as ActiveCatalogPointer;
      if (!parsed || typeof parsed !== "object" || !parsed.generation) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  private async readSyncState(): Promise<SyncState | null> {
    const statePath = path.join(this.cacheDir, "sync-state.json");
    try {
      const raw = await fsPromises.readFile(statePath, "utf-8");
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  private async recordSyncCheck(successful = false): Promise<void> {
    const statePath = path.join(this.cacheDir, "sync-state.json");
    const existing = (await this.readSyncState()) || {};
    const nowIso = new Date().toISOString();

    const updated: SyncState = {
      ...existing,
      last_sync_check: nowIso,
      ...(successful ? { last_successful_sync: nowIso } : {}),
    };

    try {
      await fsPromises.mkdir(path.dirname(statePath), { recursive: true });
      await fsPromises.writeFile(statePath, JSON.stringify(updated, null, 2), "utf-8");
    } catch {
      // non-fatal
    }
  }

  private isReaderVersionIncompatible(minVersion: string): boolean {
    const parse = (v: string): [number, number, number] => {
      const parts = v.split(".").map((n) => parseInt(n, 10) || 0);
      return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
    };
    const [cMaj, cMin, cPatch] = parse(this.readerVersion);
    const [rMaj, rMin, rPatch] = parse(minVersion);

    if (cMaj !== rMaj) return cMaj < rMaj;
    if (cMin !== rMin) return cMin < rMin;
    return cPatch < rPatch;
  }

  private async pruneOldGenerations(currentActiveGen: string): Promise<void> {
    const snapshotsDir = path.join(this.cacheDir, "snapshots");
    try {
      const entries = await fsPromises.readdir(snapshotsDir, { withFileTypes: true });

      // Clean up abandoned .partial dirs older than 1 hour
      const now = Date.now();
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.endsWith(".partial")) {
          const fullPath = path.join(snapshotsDir, entry.name);
          try {
            const stat = await fsPromises.stat(fullPath);
            if (now - stat.mtimeMs > 3600 * 1000) {
              await fsPromises.rm(fullPath, { recursive: true, force: true });
            }
          } catch {}
        }
      }

      const genDirs = entries
        .filter((e) => e.isDirectory() && !e.name.endsWith(".partial"))
        .map((e) => e.name);

      if (genDirs.length <= 3) return;

      // Collect in-use generations that must never be deleted
      const inUseGens = new Set<string>();
      inUseGens.add(currentActiveGen);
      for (const h of this.openHandles) {
        inUseGens.add(h.generation);
      }

      const dirStats: Array<{ name: string; mtime: number }> = [];
      for (const name of genDirs) {
        try {
          const st = await fsPromises.stat(path.join(snapshotsDir, name));
          dirStats.push({ name, mtime: st.mtimeMs });
        } catch {
          dirStats.push({ name, mtime: 0 });
        }
      }

      // Sort newest first
      dirStats.sort((a, b) => b.mtime - a.mtime);

      // Protect the top 3 newest generations plus all active in-use generations
      const keepGens = new Set<string>(dirStats.slice(0, 3).map((d) => d.name));
      for (const gen of inUseGens) {
        keepGens.add(gen);
      }

      for (const d of dirStats) {
        if (!keepGens.has(d.name)) {
          try {
            await fsPromises.rm(path.join(snapshotsDir, d.name), {
              recursive: true,
              force: true,
            });
          } catch {
            // Protected if open/locked on Windows
          }
        }
      }
    } catch {
      // Non-fatal cleanup
    }
  }
}

// ============================================================================
// Factory Function
// ============================================================================

export function createReader(options?: ReaderServiceOptions): ReaderService {
  return new ReaderService(options);
}
