/**
 * jobs.ts — State management for producer jobs and queue tracking.
 *
 * Implements persistent job ledger with file locking, crash recovery leases,
 * retry backoff, and idempotency guarantees for Windows knowledge producer.
 */

import { existsSync, promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { nowIsoWithOffset } from "./intake.ts";
import type { SourceKind } from "./contracts.ts";

export type JobStatus = "pending" | "in_progress" | "completed" | "failed" | "skipped";

export type JobAction = "process" | "tombstone";

export interface JobRecord {
  job_id: string;
  source_id: string;
  kind: SourceKind;
  url: string;
  input_commit: string;
  status: JobStatus;
  attempt_count: number;
  max_attempts: number;
  last_attempt_at?: string;
  lease_expires_at?: string;
  worker_id?: string;
  error?: string;
  created_at: string;
  updated_at: string;
  action?: JobAction;
  content_hash?: string;
  model_fingerprint?: string;
}

export interface EnqueueJobInput {
  job_id?: string;
  source_id: string;
  kind: SourceKind;
  url: string;
  input_commit: string;
  status?: JobStatus;
  max_attempts?: number;
  action?: JobAction;
  content_hash?: string;
  model_fingerprint?: string;
}

export interface JobSummary {
  pending: number;
  in_progress: number;
  completed: number;
  failed: number;
  skipped: number;
}

export interface JobLedger {
  version: number;
  updated_at: string;
  jobs: JobRecord[];
}

export interface JobQueueManagerOptions {
  ledgerPath: string;
  defaultMaxAttempts?: number;
  defaultLeaseTimeoutMs?: number;
  lockTimeoutMs?: number;
  staleLockTimeoutMs?: number;
}

export type JobQueueErrorCode =
  | "LOCK_TIMEOUT"
  | "LEDGER_READ_FAILED"
  | "LEDGER_WRITE_FAILED"
  | "JOB_NOT_FOUND"
  | "INVALID_JOB";

export class JobQueueError extends Error {
  readonly code: JobQueueErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: JobQueueErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "JobQueueError";
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Generates a deterministic job ID based on commit, source ID, and action.
 */
export function generateDeterministicJobId(
  inputCommit: string,
  sourceId: string,
  action: JobAction = "process",
): string {
  const hash = createHash("sha256")
    .update(`${inputCommit}:${sourceId}:${action}`)
    .digest("hex")
    .slice(0, 24);
  return `job_${hash}`;
}

/**
 * Manages atomic persistent producer job queues with worker leases, crash recovery,
 * retry backoff, and idempotency.
 */
export class JobQueueManager {
  readonly ledgerPath: string;
  readonly defaultMaxAttempts: number;
  readonly defaultLeaseTimeoutMs: number;
  readonly lockTimeoutMs: number;
  readonly staleLockTimeoutMs: number;

  private inProcessLock: Promise<void> = Promise.resolve();

  constructor(optionsOrPath: JobQueueManagerOptions | string) {
    if (typeof optionsOrPath === "string") {
      this.ledgerPath = optionsOrPath;
      this.defaultMaxAttempts = 3;
      this.defaultLeaseTimeoutMs = 5 * 60 * 1000; // 5 minutes
      this.lockTimeoutMs = 10 * 1000; // 10 seconds
      this.staleLockTimeoutMs = 30 * 1000; // 30 seconds
    } else {
      this.ledgerPath = optionsOrPath.ledgerPath;
      this.defaultMaxAttempts = optionsOrPath.defaultMaxAttempts ?? 3;
      this.defaultLeaseTimeoutMs = optionsOrPath.defaultLeaseTimeoutMs ?? 5 * 60 * 1000;
      this.lockTimeoutMs = optionsOrPath.lockTimeoutMs ?? 10 * 1000;
      this.staleLockTimeoutMs = optionsOrPath.staleLockTimeoutMs ?? 30 * 1000;
    }
  }

  /**
   * Acquires file lock with in-process queueing and executes the given action.
   */
  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const lockPath = `${this.ledgerPath}.lock`;
    const lockDir = dirname(this.ledgerPath);

    // Chain in-process lock to prevent contention across promises in the same process
    let releaseInProcess: () => void = () => {};
    const nextInProcess = new Promise<void>((resolve) => {
      releaseInProcess = resolve;
    });
    const prevInProcess = this.inProcessLock;
    this.inProcessLock = this.inProcessLock.then(() => nextInProcess);

    await prevInProcess;

    try {
      await fs.mkdir(lockDir, { recursive: true });

      const startTime = Date.now();
      let acquired = false;

      while (Date.now() - startTime < this.lockTimeoutMs) {
        try {
          const handle = await fs.open(lockPath, "wx");
          await handle.writeFile(
            JSON.stringify({ pid: process.pid, createdAt: Date.now() }),
            "utf8",
          );
          await handle.close();
          acquired = true;
          break;
        } catch (err: any) {
          if (err.code === "EEXIST") {
            try {
              const stat = await fs.stat(lockPath);
              if (Date.now() - stat.mtimeMs > this.staleLockTimeoutMs) {
                // Break stale lock
                await fs.unlink(lockPath).catch(() => {});
                continue;
              }
            } catch {
              // Lock file was unlinked by owner; retry immediately
              continue;
            }
            await new Promise((r) => setTimeout(r, 25));
          } else {
            throw err;
          }
        }
      }

      if (!acquired) {
        throw new JobQueueError(
          "LOCK_TIMEOUT",
          `Timed out acquiring lock on '${lockPath}' after ${this.lockTimeoutMs}ms`,
        );
      }

      try {
        return await fn();
      } finally {
        await fs.unlink(lockPath).catch(() => {});
      }
    } finally {
      releaseInProcess();
    }
  }

  /**
   * Reads the ledger file without acquiring lock (must be called inside withLock).
   */
  private async readLedgerUnlocked(): Promise<JobLedger> {
    if (!existsSync(this.ledgerPath)) {
      return {
        version: 1,
        updated_at: nowIsoWithOffset(),
        jobs: [],
      };
    }

    try {
      const raw = await fs.readFile(this.ledgerPath, "utf8");
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.jobs)) {
        return {
          version: 1,
          updated_at: nowIsoWithOffset(),
          jobs: [],
        };
      }
      return parsed as JobLedger;
    } catch (err: any) {
      throw new JobQueueError(
        "LEDGER_READ_FAILED",
        `Failed to parse job ledger at '${this.ledgerPath}': ${err.message}`,
      );
    }
  }

  /**
   * Writes the ledger file atomically using temp file and rename (inside withLock).
   */
  private async writeLedgerUnlocked(ledger: JobLedger): Promise<void> {
    const dir = dirname(this.ledgerPath);
    await fs.mkdir(dir, { recursive: true });

    ledger.updated_at = nowIsoWithOffset();
    const tmpPath = `${this.ledgerPath}.tmp.${randomUUID()}`;

    try {
      await fs.writeFile(tmpPath, JSON.stringify(ledger, null, 2), "utf8");
      await fs.rename(tmpPath, this.ledgerPath);
    } catch (err: any) {
      await fs.unlink(tmpPath).catch(() => {});
      throw new JobQueueError(
        "LEDGER_WRITE_FAILED",
        `Failed to write job ledger at '${this.ledgerPath}': ${err.message}`,
      );
    }
  }

  /**
   * Enqueues job records. Deduplicates against currently pending or in-progress jobs,
   * as well as completed jobs with matching commit and content hash.
   */
  async enqueueJobs(items: EnqueueJobInput[]): Promise<JobRecord[]> {
    return await this.withLock(async () => {
      const ledger = await this.readLedgerUnlocked();
      const added: JobRecord[] = [];
      const now = nowIsoWithOffset();

      for (const item of items) {
        const action = item.action ?? "process";

        // Check if an active job already exists for the same source, commit, and action
        const existingActive = ledger.jobs.find(
          (j) =>
            j.source_id === item.source_id &&
            j.input_commit === item.input_commit &&
            (j.action ?? "process") === action &&
            (j.status === "pending" || j.status === "in_progress"),
        );

        if (existingActive) {
          continue;
        }

        // If completed for this commit, check content hash and fingerprint
        if (item.content_hash) {
          const existingCompleted = ledger.jobs.find(
            (j) =>
              j.source_id === item.source_id &&
              j.input_commit === item.input_commit &&
              (j.action ?? "process") === action &&
              j.content_hash === item.content_hash &&
              (!item.model_fingerprint || j.model_fingerprint === item.model_fingerprint) &&
              j.status === "completed",
          );
          if (existingCompleted) {
            continue;
          }
        }

        const jobId =
          item.job_id || generateDeterministicJobId(item.input_commit, item.source_id, action);

        // Check by job_id
        const existingById = ledger.jobs.find((j) => j.job_id === jobId);
        if (existingById) {
          if (existingById.status === "pending" || existingById.status === "in_progress") {
            continue;
          }
          if (existingById.status === "completed") {
            continue;
          }
        }

        const record: JobRecord = {
          job_id: jobId,
          source_id: item.source_id,
          kind: item.kind,
          url: item.url,
          input_commit: item.input_commit,
          status: item.status ?? "pending",
          attempt_count: 0,
          max_attempts: item.max_attempts ?? this.defaultMaxAttempts,
          action,
          content_hash: item.content_hash,
          model_fingerprint: item.model_fingerprint,
          created_at: now,
          updated_at: now,
        };

        ledger.jobs.push(record);
        added.push(record);
      }

      if (added.length > 0) {
        await this.writeLedgerUnlocked(ledger);
      }

      return added;
    });
  }

  /**
   * Claims the next runnable pending job, setting worker ID, lease expiration,
   * and incrementing attempt count. Also recovers any expired leases.
   */
  async claimNextJob(workerId: string, leaseTimeoutMs?: number): Promise<JobRecord | null> {
    return await this.withLock(async () => {
      const ledger = await this.readLedgerUnlocked();
      const nowMs = Date.now();
      const leaseDuration = leaseTimeoutMs ?? this.defaultLeaseTimeoutMs;
      let stateChanged = false;

      // First, recover any in_progress jobs whose lease expired
      for (const job of ledger.jobs) {
        if (job.status === "in_progress" && job.lease_expires_at) {
          const expiresMs = new Date(job.lease_expires_at).getTime();
          if (expiresMs <= nowMs) {
            if (job.attempt_count < job.max_attempts) {
              job.status = "pending";
              job.worker_id = undefined;
              job.lease_expires_at = undefined;
              job.updated_at = nowIsoWithOffset();
              stateChanged = true;
            } else {
              job.status = "failed";
              job.error = job.error
                ? `${job.error} (lease expired)`
                : "Worker lease expired and max attempts reached";
              job.worker_id = undefined;
              job.lease_expires_at = undefined;
              job.updated_at = nowIsoWithOffset();
              stateChanged = true;
            }
          }
        }
      }

      // Find first pending job
      const candidate = ledger.jobs.find((j) => j.status === "pending");
      if (!candidate) {
        if (stateChanged) {
          await this.writeLedgerUnlocked(ledger);
        }
        return null;
      }

      candidate.status = "in_progress";
      candidate.worker_id = workerId;
      candidate.attempt_count += 1;
      candidate.last_attempt_at = nowIsoWithOffset();
      candidate.lease_expires_at = nowIsoWithOffset(new Date(nowMs + leaseDuration));
      candidate.updated_at = nowIsoWithOffset();

      await this.writeLedgerUnlocked(ledger);
      return { ...candidate };
    });
  }

  /**
   * Marks a job as completed and clears lease.
   */
  async completeJob(jobId: string): Promise<void> {
    await this.withLock(async () => {
      const ledger = await this.readLedgerUnlocked();
      const job = ledger.jobs.find((j) => j.job_id === jobId);
      if (!job) {
        throw new JobQueueError("JOB_NOT_FOUND", `Job '${jobId}' not found in queue ledger`);
      }

      job.status = "completed";
      job.worker_id = undefined;
      job.lease_expires_at = undefined;
      job.error = undefined;
      job.updated_at = nowIsoWithOffset();

      await this.writeLedgerUnlocked(ledger);
    });
  }

  /**
   * Marks a job as failed. If retryable and attempt_count < max_attempts,
   * resets status to 'pending' for retry backoff. Otherwise marks as 'failed'.
   */
  async failJob(jobId: string, error: string, retryable = true): Promise<void> {
    await this.withLock(async () => {
      const ledger = await this.readLedgerUnlocked();
      const job = ledger.jobs.find((j) => j.job_id === jobId);
      if (!job) {
        throw new JobQueueError("JOB_NOT_FOUND", `Job '${jobId}' not found in queue ledger`);
      }

      job.error = error;
      job.worker_id = undefined;
      job.lease_expires_at = undefined;
      job.updated_at = nowIsoWithOffset();

      if (retryable && job.attempt_count < job.max_attempts) {
        job.status = "pending";
      } else {
        job.status = "failed";
      }

      await this.writeLedgerUnlocked(ledger);
    });
  }

  /**
   * Crash recovery: scans for jobs with expired leases and either resets them
   * to pending or marks them failed if max attempts was exceeded.
   */
  async recoverExpiredLeases(): Promise<number> {
    return await this.withLock(async () => {
      const ledger = await this.readLedgerUnlocked();
      const nowMs = Date.now();
      let recovered = 0;

      for (const job of ledger.jobs) {
        if (job.status === "in_progress" && job.lease_expires_at) {
          const expiresMs = new Date(job.lease_expires_at).getTime();
          if (expiresMs <= nowMs) {
            if (job.attempt_count < job.max_attempts) {
              job.status = "pending";
              job.worker_id = undefined;
              job.lease_expires_at = undefined;
              job.updated_at = nowIsoWithOffset();
            } else {
              job.status = "failed";
              job.error = job.error
                ? `${job.error} (lease expired)`
                : "Worker lease expired and max attempts reached";
              job.worker_id = undefined;
              job.lease_expires_at = undefined;
              job.updated_at = nowIsoWithOffset();
            }
            recovered++;
          }
        }
      }

      if (recovered > 0) {
        await this.writeLedgerUnlocked(ledger);
      }

      return recovered;
    });
  }

  /**
   * Retrieves summary counts of all jobs in the ledger.
   */
  async getJobSummary(): Promise<JobSummary> {
    return await this.withLock(async () => {
      const ledger = await this.readLedgerUnlocked();
      const summary: JobSummary = {
        pending: 0,
        in_progress: 0,
        completed: 0,
        failed: 0,
        skipped: 0,
      };

      for (const job of ledger.jobs) {
        if (job.status in summary) {
          summary[job.status]++;
        }
      }

      return summary;
    });
  }

  /**
   * Retrieves a specific job by ID.
   */
  async getJob(jobId: string): Promise<JobRecord | null> {
    return await this.withLock(async () => {
      const ledger = await this.readLedgerUnlocked();
      const job = ledger.jobs.find((j) => j.job_id === jobId);
      return job ? { ...job } : null;
    });
  }

  /**
   * Lists jobs matching optional filters.
   */
  async listJobs(filter?: { status?: JobStatus; source_id?: string }): Promise<JobRecord[]> {
    return await this.withLock(async () => {
      const ledger = await this.readLedgerUnlocked();
      let filtered = ledger.jobs;

      if (filter?.status) {
        filtered = filtered.filter((j) => j.status === filter.status);
      }
      if (filter?.source_id) {
        filtered = filtered.filter((j) => j.source_id === filter.source_id);
      }

      return filtered.map((j) => ({ ...j }));
    });
  }

  /**
   * Resets a failed or completed job back to pending with 0 attempts.
   */
  async resetJob(jobId: string): Promise<void> {
    await this.withLock(async () => {
      const ledger = await this.readLedgerUnlocked();
      const job = ledger.jobs.find((j) => j.job_id === jobId);
      if (!job) {
        throw new JobQueueError("JOB_NOT_FOUND", `Job '${jobId}' not found in queue ledger`);
      }

      job.status = "pending";
      job.attempt_count = 0;
      job.worker_id = undefined;
      job.lease_expires_at = undefined;
      job.error = undefined;
      job.updated_at = nowIsoWithOffset();

      await this.writeLedgerUnlocked(ledger);
    });
  }
}
