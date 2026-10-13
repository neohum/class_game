/**
 * producer.ts — Single-writer producer pipeline, pre-flight validation,
 * worker loop, and staged snapshot publishing for the harness knowledge library.
 *
 * Implements ProducerPipeline:
 * - Pre-flight validation:
 *   - AC-3: Validates disk space at target data dir (E:\harness-knowledge on Windows
 *     or HARNESS_KNOWLEDGE_HOME). Aborts if space is below required threshold.
 *     NEVER silently redirects to C: drive!
 *   - Verifies runtime dependencies via checkRuntimeDoctor.
 * - Single writer lock (AC-2):
 *   - Exclusive producer.lock prevents concurrent scheduled and manual runs.
 * - Step 1: Safe Git pull and classification:
 *   - Pulls registry using fast-forward only (--ff-only).
 *   - Aborts on dirty worktree or diverged branch without data destruction.
 *   - Pins commit SHA and classifies new, modified, TTL-expired, deleted sources.
 * - Step 2: Persistent Job Queue:
 *   - Recovers expired leases from previous interrupted cycles.
 *   - Enqueues job records into JobQueueManager.
 * - Step 3: Resilient Worker Loop:
 *   - Claims jobs, fetches via FetcherService, extracts capabilities via ProfilerService.
 *   - Ingests chunks and embeddings into CatalogService.
 *   - Handles partial source failures gracefully while completing others.
 * - Step 4: Snapshot & Publish:
 *   - Verifies DB integrity and exports snapshot via PublisherService.
 *   - Publishes snapshot and manifest to ObjectStore, updates latest.json pointer.
 *   - Resilience: Skips publishing if all fetches fail or no new data/expired TTL.
 */

import * as fs from "node:fs";
import { promises as fsPromises } from "node:fs";
import * as path from "node:path";
import {
  type DocumentRevision,
  type EmbedderPort,
  type FetcherPort,
  type ProfilerPort,
  type SnapshotManifest,
  type SourceSpec,
  KnowledgeError,
  type KnowledgeErrorCode,
} from "./contracts.ts";
import {
  type ObjectStorePort,
  LocalStorageAdapter,
  createObjectStore,
} from "./storage.ts";
import {
  getKnowledgeHome,
  getKnowledgePaths,
  checkDiskSpace,
  checkRuntimeDoctor,
  type DiskSpaceReport,
  type KnowledgePaths,
} from "./runtime.ts";
import {
  GitSyncService,
  classifySources,
  generateJobRecords,
  computeSourceHash,
  type SyncLedger,
} from "./git-sync.ts";
import {
  JobQueueManager,
  type JobRecord,
} from "./jobs.ts";
import { FetcherService } from "./fetch.ts";
import { ProfilerService } from "./profiles.ts";
import { CatalogService } from "./catalog.ts";
import { PublisherService } from "./publish.ts";
import { createGenerationId } from "./migrations.ts";

// ============================================================================
// Errors & Codes
// ============================================================================

export type ProducerErrorCode =
  | "PRODUCER_LOCKED"
  | "INSUFFICIENT_DISK_SPACE"
  | "RUNTIME_DOCTOR_FAILED"
  | "GIT_SYNC_FAILED"
  | "FETCH_FAILED"
  | "PUBLISH_FAILED"
  | "INTEGRITY_CHECK_FAILED"
  | "OPERATION_CANCELLED"
  | "OPERATION_TIMEOUT";

export class ProducerError extends KnowledgeError {
  constructor(
    code: ProducerErrorCode | KnowledgeErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(code as KnowledgeErrorCode, message, details);
    this.name = "ProducerError";
  }
}

// ============================================================================
// Types and Interfaces
// ============================================================================

export interface ProducerOptions {
  repoDir: string;
  allowDirty?: boolean;
  local?: boolean;
  remote?: string;
  branch?: string;
  knowledgeHome?: string;
  dataDir?: string;
  catalogId?: string;
  generation?: string;
  modelFingerprint?: string;
  objectStore?: ObjectStorePort;
  embedder?: EmbedderPort;
  fetcher?: FetcherPort;
  profiler?: ProfilerPort;
  catalogService?: CatalogService;
  jobQueue?: JobQueueManager;
  publisher?: PublisherService;
  gitSync?: GitSyncService;
  lockPath?: string;
  lockTimeoutMs?: number;
  lockLeaseMs?: number;
  requiredDiskBytes?: number;
  skipDoctor?: boolean;
  skipDiskCheck?: boolean;
  diskCheckFn?: (dir: string, requiredBytes: number) => Promise<DiskSpaceReport>;
  workerId?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  now?: Date;
  maxJobsPerCycle?: number;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
}

export interface ProducerCycleResult {
  success: boolean;
  commitSha: string;
  jobsEnqueued: number;
  jobsProcessed: number;
  jobsCompleted: number;
  jobsFailed: number;
  published: boolean;
  skippedReason?: string;
  manifest?: SnapshotManifest;
  snapshotPath?: string;
  errors: string[];
}

// ============================================================================
// Pre-flight Disk Space Calculation (AC-3)
// ============================================================================

/**
 * Pre-calculates the required disk space for the producer cycle:
 * Embedding model (~639MB) + 1 temp snapshot (~100MB) + 3 recent retention generations (~300MB)
 * + 1GB safety buffer ≈ 2.16GB.
 */
export function calculateRequiredDiskSpace(options?: {
  modelSizeBytes?: number;
  snapshotSizeBytes?: number;
  retentionGenerations?: number;
  safetyBufferBytes?: number;
}): number {
  const modelSize = options?.modelSizeBytes ?? 669_963_008; // ~639MB Qwen3 0.6B Q8_0
  const snapshotSize = options?.snapshotSizeBytes ?? 100 * 1024 * 1024; // 100MB
  const retention = options?.retentionGenerations ?? 3;
  const snapshotsTotal = snapshotSize * (retention + 1); // temp snapshot + 3 retained generations
  const safetyBuffer = options?.safetyBufferBytes ?? 1024 * 1024 * 1024; // 1GB safety buffer
  return modelSize + snapshotsTotal + safetyBuffer;
}

/**
 * Resolves the target data directory for knowledge producer.
 * On Windows, defaults to E:\harness-knowledge unless explicitly configured.
 * Guarantees that low space on E: will NEVER silently redirect to C: drive.
 */
export function resolveProducerDataDir(options?: {
  dataDir?: string;
  knowledgeHome?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): string {
  const env = options?.env ?? process.env;
  const platform = options?.platform ?? process.platform;
  const pathMod = platform === "win32" ? path.win32 : path;

  if (options?.dataDir) {
    return pathMod.isAbsolute(options.dataDir)
      ? options.dataDir
      : pathMod.resolve(options.dataDir);
  }
  if (options?.knowledgeHome) {
    return pathMod.isAbsolute(options.knowledgeHome)
      ? options.knowledgeHome
      : pathMod.resolve(options.knowledgeHome);
  }
  if (env.HARNESS_KNOWLEDGE_HOME) {
    return pathMod.isAbsolute(env.HARNESS_KNOWLEDGE_HOME)
      ? env.HARNESS_KNOWLEDGE_HOME
      : pathMod.resolve(env.HARNESS_KNOWLEDGE_HOME);
  }
  if (platform === "win32") {
    const producerDir = env.HARNESS_KNOWLEDGE_PRODUCER_DIR?.trim() || "E:\\harness-knowledge";
    return producerDir;
  }
  return getKnowledgeHome(env, platform);
}

// ============================================================================
// Single Writer Producer Lock (AC-2)
// ============================================================================

export class ProducerLock {
  readonly lockPath: string;
  readonly timeoutMs: number;
  readonly leaseMs: number;
  private isHeld = false;

  constructor(lockPath: string, timeoutMs = 5000, leaseMs = 300000) {
    this.lockPath = lockPath;
    this.timeoutMs = timeoutMs;
    this.leaseMs = leaseMs;
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    const start = Date.now();
    const dir = path.dirname(this.lockPath);
    await fsPromises.mkdir(dir, { recursive: true });

    while (Date.now() - start <= this.timeoutMs) {
      if (signal?.aborted) {
        throw new ProducerError(
          "OPERATION_CANCELLED",
          "Producer lock acquisition cancelled by signal",
        );
      }

      try {
        const handle = await fsPromises.open(this.lockPath, "wx");
        const payload = JSON.stringify({
          pid: process.pid,
          time: Date.now(),
        });
        await handle.writeFile(payload, "utf-8");
        await handle.close();
        this.isHeld = true;
        return;
      } catch (err: any) {
        if (err.code !== "EEXIST") {
          throw new ProducerError(
            "PRODUCER_LOCKED",
            `Failed to open producer lock file at '${this.lockPath}': ${err.message}`,
          );
        }

        // Lock file exists: inspect whether it is stale
        try {
          const stats = await fsPromises.stat(this.lockPath);
          const age = Date.now() - stats.mtimeMs;
          if (age > this.leaseMs) {
            await fsPromises.unlink(this.lockPath).catch(() => {});
            continue;
          }
        } catch {
          // stats failed (e.g. unlinked), retry immediately
          continue;
        }

        if (this.timeoutMs === 0) {
          break;
        }

        await new Promise((r) => setTimeout(r, 40));
      }
    }

    throw new ProducerError(
      "PRODUCER_LOCKED",
      `Single writer lock '${path.basename(this.lockPath)}' is held by another process (timed out after ${this.timeoutMs}ms)`,
      { lockPath: this.lockPath },
    );
  }

  async release(): Promise<void> {
    this.isHeld = false;
    try {
      if (fs.existsSync(this.lockPath)) {
        await fsPromises.unlink(this.lockPath);
      }
    } catch {
      // ignore unlink errors
    }
  }
}

// ============================================================================
// Producer Pipeline Implementation
// ============================================================================

export class ProducerPipeline {
  private defaultOptions: Partial<ProducerOptions>;

  constructor(defaultOptions: Partial<ProducerOptions> = {}) {
    this.defaultOptions = defaultOptions;
  }

  /**
   * Executes a full producer cycle:
   * 1. Pre-flight validation (disk space check & runtime doctor)
   * 2. Single writer lock acquisition
   * 3. Git pull (--ff-only), commit pinning, change classification
   * 4. Job queue lease recovery and enqueuing
   * 5. Worker loop (fetch, profile capabilities, catalog upsert)
   * 6. Snapshot export, verification, and atomic publish
   */
  async runProducerCycle(cycleOptions: ProducerOptions): Promise<ProducerCycleResult> {
    const options: ProducerOptions = {
      ...this.defaultOptions,
      ...cycleOptions,
    };

    const env = options.env ?? process.env;
    const platform = options.platform ?? process.platform;
    const arch = options.arch ?? process.arch;

    // ------------------------------------------------------------------------
    // Pre-flight Validation: Data Dir & Disk Space (AC-3)
    // ------------------------------------------------------------------------
    const dataDir = resolveProducerDataDir({
      dataDir: options.dataDir,
      knowledgeHome: options.knowledgeHome,
      env,
      platform,
    });

    const paths = getKnowledgePaths(dataDir, env, platform);
    await fsPromises.mkdir(paths.producer, { recursive: true });
    await fsPromises.mkdir(paths.producerJobs, { recursive: true });

    const requiredDiskBytes = options.requiredDiskBytes ?? calculateRequiredDiskSpace();

    let diskReport: DiskSpaceReport;
    if (options.diskCheckFn) {
      diskReport = await options.diskCheckFn(paths.root, requiredDiskBytes);
    } else if (!options.skipDiskCheck) {
      diskReport = await checkDiskSpace(paths.root, requiredDiskBytes);
    } else {
      diskReport = { ok: true, free_bytes: requiredDiskBytes * 2, required_bytes: requiredDiskBytes };
    }

    if (!diskReport.ok) {
      throw new ProducerError(
        "INSUFFICIENT_DISK_SPACE",
        `Insufficient disk space at '${paths.root}': ${diskReport.message || "Required threshold not met"}. Producer aborted safely; will not silently redirect to C: drive.`,
        {
          targetDir: paths.root,
          requiredBytes: requiredDiskBytes,
          freeBytes: diskReport.free_bytes,
        },
      );
    }

    // Pre-flight Runtime Doctor Check
    if (!options.skipDoctor) {
      const doctorReport = await checkRuntimeDoctor({
        knowledgeHome: paths.root,
        env,
        platform,
        arch,
      });

      if (!doctorReport.ok) {
        throw new ProducerError(
          "RUNTIME_DOCTOR_FAILED",
          `Runtime doctor check failed: ${doctorReport.actionable_instructions.join("; ")}`,
          { doctorReport },
        );
      }
    }

    // ------------------------------------------------------------------------
    // Single Writer Lock Acquisition (AC-2)
    // ------------------------------------------------------------------------
    const lockPath = options.lockPath ?? path.join(paths.producer, "producer.lock");
    const producerLock = new ProducerLock(
      lockPath,
      options.lockTimeoutMs ?? 5000,
      options.lockLeaseMs ?? 300000,
    );

    await producerLock.acquire(options.signal);

    try {
      return await this.executeCycle(paths, options);
    } finally {
      await producerLock.release();
    }
  }

  /**
   * Internal execution holding the producer.lock.
   */
  private async executeCycle(
    paths: KnowledgePaths,
    options: ProducerOptions,
  ): Promise<ProducerCycleResult> {
    const env = options.env ?? process.env;
    const gitSync = options.gitSync ?? new GitSyncService();

    // ------------------------------------------------------------------------
    // Step 1: Git Pull & Registry Ingestion
    // ------------------------------------------------------------------------
    let pullResult: {
      commitSha: string;
      changedFiles: string[];
      diverged: boolean;
      dirty: boolean;
      error?: string;
    };

    if (options.allowDirty || options.local) {
      const sha =
        (await gitSync.getCommitSha(options.repoDir, "HEAD").catch(() => "local-worktree")) ||
        "local-worktree";
      pullResult = {
        commitSha: sha,
        changedFiles: [],
        diverged: false,
        dirty: false,
      };
    } else {
      pullResult = await gitSync.pullRegistry(options.repoDir, {
        remote: options.remote,
        branch: options.branch,
        signal: options.signal,
        throwOnError: false,
      });

      if (pullResult.dirty) {
        throw new ProducerError(
          "GIT_SYNC_FAILED",
          `Refusing to process: working tree at '${options.repoDir}' is dirty: ${pullResult.error}`,
        );
      }
      if (pullResult.diverged) {
        throw new ProducerError(
          "GIT_SYNC_FAILED",
          `Refusing to process: branch at '${options.repoDir}' has diverged: ${pullResult.error}`,
        );
      }
      if (pullResult.error) {
        throw new ProducerError(
          "GIT_SYNC_FAILED",
          `Git pull failed at '${options.repoDir}': ${pullResult.error}`,
        );
      }
    }

    const registry =
      options.allowDirty || options.local
        ? await gitSync.readRegistryFromDisk(options.repoDir, { signal: options.signal })
        : await gitSync.readRegistryAtCommit(options.repoDir, pullResult.commitSha, {
            signal: options.signal,
          });

    if (!registry.valid) {
      throw new ProducerError(
        "GIT_SYNC_FAILED",
        `Registry validation failed at commit ${pullResult.commitSha.slice(0, 8)}: ${registry.errors.join("; ")}`,
      );
    }

    // Load or initialize persistent SyncLedger
    const syncLedgerPath = path.join(paths.producer, "sync-ledger.json");
    let syncLedger: SyncLedger = { sources: {} };
    if (fs.existsSync(syncLedgerPath)) {
      try {
        const rawLedger = await fsPromises.readFile(syncLedgerPath, "utf-8");
        syncLedger = JSON.parse(rawLedger);
        if (!syncLedger.sources) syncLedger.sources = {};
      } catch {
        syncLedger = { sources: {} };
      }
    }

    // Classify source changes
    const classified = classifySources(registry.sources, syncLedger, {
      now: options.now,
    });

    // ------------------------------------------------------------------------
    // Step 2: Enqueue Jobs into JobQueueManager
    // ------------------------------------------------------------------------
    const jobQueue =
      options.jobQueue ??
      new JobQueueManager({
        ledgerPath: path.join(paths.producerJobs, "jobs.json"),
        defaultMaxAttempts: 3,
        defaultLeaseTimeoutMs: 5 * 60 * 1000,
      });

    // Recover expired leases from prior interrupted runs
    await jobQueue.recoverExpiredLeases();

    const activeModelFingerprint =
      options.modelFingerprint ||
      "0000000000000000000000000000000000000000000000000000000000000000";

    const jobInputs = generateJobRecords(classified, pullResult.commitSha, {
      modelFingerprint: activeModelFingerprint,
    });

    const enqueued = await jobQueue.enqueueJobs(jobInputs);

    // ------------------------------------------------------------------------
    // Step 3: Worker Loop
    // ------------------------------------------------------------------------
    const catalogId =
      options.catalogId || registry.catalog?.catalog_id || "default_catalog";

    const catalogService =
      options.catalogService ??
      new CatalogService({
        dbPath: paths.producerDb,
        catalogId,
        generation: options.generation,
        modelFingerprint: activeModelFingerprint,
        embedder: options.embedder,
        lockPath: path.join(paths.producer, "catalog.lock"),
      });

    const fetcher = options.fetcher ?? new FetcherService();
    const profiler = options.profiler ?? new ProfilerService();
    const workerId =
      options.workerId ??
      `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

    let jobsProcessed = 0;
    let jobsCompleted = 0;
    let jobsFailed = 0;
    const errors: string[] = [];

    while (!options.signal?.aborted) {
      if (options.maxJobsPerCycle && jobsProcessed >= options.maxJobsPerCycle) {
        break;
      }

      const job = await jobQueue.claimNextJob(workerId);
      if (!job) {
        break;
      }

      jobsProcessed++;
      const nowIso = (options.now ?? new Date()).toISOString();

      try {
        if (job.action === "tombstone") {
          await catalogService.tombstoneDocument(job.source_id, {
            signal: options.signal,
          });
          delete syncLedger.sources[job.source_id];
          await jobQueue.completeJob(job.job_id);
          jobsCompleted++;
        } else {
          const spec = registry.sources.find((s) => s.source_id === job.source_id);
          if (!spec || !spec.enabled) {
            await catalogService.tombstoneDocument(job.source_id, {
              signal: options.signal,
            });
            if (spec) {
              syncLedger.sources[job.source_id] = {
                source_id: spec.source_id,
                kind: spec.kind,
                url: spec.url,
                source_hash: computeSourceHash(spec),
                last_seen_commit: pullResult.commitSha,
                last_attempt_at: nowIso,
                status: "disabled",
              };
            }
            await jobQueue.completeJob(job.job_id);
            jobsCompleted++;
          } else {
            const doc = await fetcher.fetch(spec, { signal: options.signal });

            if (doc.status === "failed" || doc.status === "retry") {
              const errMsg = doc.error || "Fetch failed";
              const retryable = doc.status === "retry";
              await jobQueue.failJob(job.job_id, errMsg, retryable);
              jobsFailed++;
              errors.push(`Fetch failed for '${spec.url}': ${errMsg}`);

              // Record failed status in catalog so published manifest tracks failed sources
              try {
                const safeDoc: DocumentRevision = {
                  ...doc,
                  content_hash: doc.content_hash?.trim() || "0000000000000000000000000000000000000000000000000000000000000000",
                };
                await catalogService.ingestSource(spec, { signal: options.signal });
                await catalogService.upsertDocument(safeDoc, [], [], { signal: options.signal });
              } catch {
                // ignore catalog upsert error for failed fetch
              }

              const existing = syncLedger.sources[spec.source_id];
              syncLedger.sources[spec.source_id] = {
                source_id: spec.source_id,
                kind: spec.kind,
                url: spec.url,
                source_hash: existing?.source_hash || computeSourceHash(spec),
                last_seen_commit: pullResult.commitSha,
                last_success_at: existing?.last_success_at,
                last_attempt_at: nowIso,
                status: "failed",
              };
            } else if (doc.status === "unchanged") {
              await jobQueue.completeJob(job.job_id);
              jobsCompleted++;
              syncLedger.sources[spec.source_id] = {
                source_id: spec.source_id,
                kind: spec.kind,
                url: spec.url,
                source_hash: computeSourceHash(spec),
                last_seen_commit: pullResult.commitSha,
                last_success_at: nowIso,
                last_attempt_at: nowIso,
                status: "success",
              };
            } else if (doc.status === "success") {
              const capabilities = await profiler.profileDocument(doc, {
                signal: options.signal,
              });
              await catalogService.ingestSource(spec, { signal: options.signal });
              await catalogService.upsertDocument(doc, undefined, undefined, {
                capabilities,
                signal: options.signal,
              });
              await jobQueue.completeJob(job.job_id);
              jobsCompleted++;
              syncLedger.sources[spec.source_id] = {
                source_id: spec.source_id,
                kind: spec.kind,
                url: spec.url,
                source_hash: computeSourceHash(spec),
                last_seen_commit: pullResult.commitSha,
                last_success_at: nowIso,
                last_attempt_at: nowIso,
                status: "success",
              };
            } else if (doc.status === "tombstone") {
              await catalogService.tombstoneDocument(doc.document_id, {
                signal: options.signal,
              });
              await jobQueue.completeJob(job.job_id);
              jobsCompleted++;
            } else {
              // unsupported or other
              await catalogService.upsertDocument(doc, [], [], {
                signal: options.signal,
              });
              await jobQueue.completeJob(job.job_id);
              jobsCompleted++;
            }
          }
        }
      } catch (err: any) {
        jobsFailed++;
        const errMsg = err?.message || String(err);
        errors.push(`Error processing job '${job.job_id}': ${errMsg}`);
        await jobQueue.failJob(job.job_id, errMsg, true).catch(() => {});
      }
    }

    // Save updated SyncLedger atomically
    await this.saveSyncLedger(syncLedgerPath, syncLedger);

    // ------------------------------------------------------------------------
    // Step 4: Snapshot & Publish Decision
    // ------------------------------------------------------------------------
    let published = false;
    let skippedReason: string | undefined;
    let publishedManifest: SnapshotManifest | undefined;
    let snapshotPath: string | undefined;

    // Resilience rule 1: If no jobs were enqueued and no jobs processed, skip publish
    if (jobsProcessed === 0 && enqueued.length === 0) {
      return {
        success: true,
        commitSha: pullResult.commitSha,
        jobsEnqueued: 0,
        jobsProcessed: 0,
        jobsCompleted: 0,
        jobsFailed: 0,
        published: false,
        skippedReason: "No new data or expired TTL",
        errors: [],
      };
    }

    // Resilience rule 2: If all fetches failed (0 completed, >0 failed), skip publish
    if (jobsProcessed > 0 && jobsCompleted === 0) {
      return {
        success: false,
        commitSha: pullResult.commitSha,
        jobsEnqueued: enqueued.length,
        jobsProcessed,
        jobsCompleted: 0,
        jobsFailed,
        published: false,
        skippedReason: "All source fetches failed",
        errors,
      };
    }

    // Publishing when completed updates exist
    const previousGen = await catalogService.getGeneration();
    let targetGeneration = options.generation;
    let parentGeneration: string | undefined;

    if (syncLedger.last_published_commit) {
      parentGeneration = previousGen;
      targetGeneration = options.generation ?? createGenerationId();
      catalogService.rotateGeneration(targetGeneration);
    } else if (options.generation && previousGen !== options.generation) {
      catalogService.rotateGeneration(options.generation);
      targetGeneration = options.generation;
    }

    let objectStore = options.objectStore;
    if (!objectStore) {
      const r2Bucket = env.R2_BUCKET || env.HARNESS_KNOWLEDGE_R2_BUCKET;
      const r2Key = env.R2_ACCESS_KEY_ID || env.HARNESS_KNOWLEDGE_R2_ACCESS_KEY_ID;
      if (r2Bucket && r2Key) {
        try {
          objectStore = createObjectStore({
            type: "r2",
            r2: {
              bucket: r2Bucket,
              accountId: env.R2_ACCOUNT_ID,
              accessKeyId: r2Key,
              secretAccessKey:
                env.R2_SECRET_ACCESS_KEY || env.HARNESS_KNOWLEDGE_R2_SECRET_ACCESS_KEY,
              endpoint: env.R2_ENDPOINT,
            },
          });
        } catch {
          // fallback to local storage
        }
      }
    }
    if (!objectStore) {
      const storageDir = path.join(paths.root, "storage");
      objectStore = new LocalStorageAdapter(storageDir);
    }

    const publisher =
      options.publisher ??
      new PublisherService({
        catalogDbPath: paths.producerDb,
        catalogService,
        objectStore,
        catalogId,
        generation: targetGeneration,
        parentGeneration,
        inputCommit: pullResult.commitSha,
        tempDir: path.join(paths.root, "temp"),
        retentionGenerations: 3,
      });

    if (objectStore) {
      const manifest = await publisher.publishSnapshot({
        portOptions: { signal: options.signal },
      });
      published = true;
      publishedManifest = manifest;

      syncLedger.last_published_commit = pullResult.commitSha;
      syncLedger.last_seen_commit = pullResult.commitSha;
      await this.saveSyncLedger(syncLedgerPath, syncLedger);
    } else {
      // Offline local snapshot export verification
      const exportRes = await publisher.exportSnapshot({
        signal: options.signal,
      });
      published = false;
      publishedManifest = exportRes.manifest;
      snapshotPath = exportRes.snapshotPath;
      skippedReason = "No ObjectStorePort provided (snapshot exported locally)";
    }

    return {
      success: jobsCompleted > 0,
      commitSha: pullResult.commitSha,
      jobsEnqueued: enqueued.length,
      jobsProcessed,
      jobsCompleted,
      jobsFailed,
      published,
      skippedReason,
      manifest: publishedManifest,
      snapshotPath,
      errors,
    };
  }

  private async saveSyncLedger(ledgerPath: string, ledger: SyncLedger): Promise<void> {
    const dir = path.dirname(ledgerPath);
    await fsPromises.mkdir(dir, { recursive: true });
    const tmp = `${ledgerPath}.tmp.${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await fsPromises.writeFile(tmp, JSON.stringify(ledger, null, 2), "utf-8");
    await fsPromises.rename(tmp, ledgerPath);
  }
}

/**
 * Convenience entrypoint for running a single producer cycle.
 */
export async function runProducerCycle(
  options: ProducerOptions,
): Promise<ProducerCycleResult> {
  const pipeline = new ProducerPipeline();
  return pipeline.runProducerCycle(options);
}
