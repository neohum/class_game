/**
 * status.ts — Knowledge Library Inspector & Status Reporting Service.
 *
 * Implements read-only inspection of the knowledge library:
 * - Producer status: last pull commit, last fetch, last embed, last publish timestamp,
 *   pending/in_progress/failed jobs count, failed source IDs and error reasons.
 * - Reader status: active generation, cached generations count, last sync timestamp,
 *   stale threshold indicator, search mode (vector vs lexical).
 * - Registry status: total sources count, enabled count, disabled count, by kind.
 * - Freshness diagnosis: clearly distinguishing snapshot publishing from individual source freshness.
 * - Timestamp formatting: local Asia/Seoul time (+09:00).
 * - Security: strict redaction of tokens, secrets, credentials, and sensitive endpoints.
 * - Invariant: STRICTLY read-only; never mutates SQLite database, queues, or overlays.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  type SourceKind,
  type SourceSpec,
  type ReaderPort,
} from "./contracts.ts";
import { type JobQueueManager, type JobRecord, type JobSummary } from "./jobs.ts";
import { type ReaderService, type ReaderStatus } from "./reader.ts";
import { getKnowledgePaths } from "./runtime.ts";
import { nowIsoWithOffset } from "./intake.ts";

// ============================================================================
// Types and Interfaces
// ============================================================================

export interface ProducerFailedSource {
  source_id: string;
  url: string;
  kind?: SourceKind;
  error: string;
  error_type: string;
  attempt_count: number;
  max_attempts: number;
  next_retry_at: string | null;
}

export interface ProducerJobsSummary {
  pending: number;
  in_progress: number;
  completed: number;
  failed: number;
  skipped: number;
}

export interface ProducerStatus {
  available: boolean;
  last_pull_commit: string | null;
  last_pull_at: string | null;
  last_fetch_at: string | null;
  last_embed_at: string | null;
  last_publish_at: string | null;
  jobs_summary: ProducerJobsSummary;
  failed_sources: ProducerFailedSource[];
  active_worker_id: string | null;
  producer_dir: string | null;
}

export interface ReaderLibraryStatus {
  status: "available" | "unavailable" | "stale";
  available: boolean;
  active_generation: string | null;
  cached_generations_count: number;
  last_sync_at: string | null;
  last_sync_check: string | null;
  stale: boolean;
  stale_threshold_hours: number;
  search_mode: "vector" | "lexical";
  document_count: number;
  chunk_count: number;
  model_fingerprint: string | null;
  source_commit: string | null;
  published_at: string | null;
}

export interface RegistryStatus {
  total_sources: number;
  enabled_sources: number;
  disabled_sources: number;
  by_kind: Record<SourceKind, number>;
}

export interface FreshnessStatus {
  published_up_to_date: boolean;
  all_sources_fresh: boolean;
  notice: string;
}

export interface KnowledgeLibraryStatus {
  inspected_at: string;
  registry: RegistryStatus;
  producer: ProducerStatus;
  reader: ReaderLibraryStatus;
  freshness: FreshnessStatus;
}

export interface GetLibraryStatusOptions {
  projectRoot?: string;
  knowledgeHome?: string;
  reader?: ReaderPort;
  queueManager?: JobQueueManager;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}

// ============================================================================
// Time Formatting Utilities (Asia/Seoul +09:00)
// ============================================================================

/**
 * Formats a Date or ISO timestamp string into Asia/Seoul time (+09:00) ISO string.
 */
export function formatSeoulTime(input?: string | Date | null): string {
  if (!input) return "-";
  const date = typeof input === "string" ? new Date(input) : input;
  if (Number.isNaN(date.getTime())) return String(input);
  return nowIsoWithOffset(date, 540);
}

/**
 * Formats a Date or ISO timestamp string into human-friendly Korean display string.
 * Example: '2026-10-09 10:30:00 (+09:00)'
 */
export function formatSeoulDisplay(input?: string | Date | null): string {
  if (!input) return "- (미기록)";
  const date = typeof input === "string" ? new Date(input) : input;
  if (Number.isNaN(date.getTime())) return String(input);
  const iso = nowIsoWithOffset(date, 540);
  const parts = iso.split("T");
  const d = parts[0];
  const t = parts[1];
  if (!d || !t) return iso;
  const timePart = t.slice(0, 8);
  const offsetPart = t.slice(8);
  return `${d} ${timePart} (${offsetPart})`;
}

// ============================================================================
// Error Classification & Redaction Utilities
// ============================================================================

/**
 * Categorizes raw error messages into standardized error codes.
 */
export function classifyErrorType(error?: string): string {
  if (!error) return "UNKNOWN_ERROR";
  const err = error.toLowerCase();
  if (err.includes("rate limit") || err.includes("429") || err.includes("rate_limited")) {
    return "RATE_LIMITED";
  }
  if (err.includes("timeout") || err.includes("timed out") || err.includes("etimedout")) {
    return "TIMEOUT";
  }
  if (
    err.includes("private network") ||
    err.includes("ssrf") ||
    err.includes("link-local") ||
    err.includes("localhost") ||
    err.includes("private_network_denied")
  ) {
    return "SECURITY_DENIED";
  }
  if (err.includes("404") || err.includes("not found")) {
    return "NOT_FOUND";
  }
  if (
    err.includes("500") ||
    err.includes("502") ||
    err.includes("503") ||
    err.includes("504") ||
    err.includes("server error")
  ) {
    return "SERVER_ERROR";
  }
  if (err.includes("dns") || err.includes("enotfound") || err.includes("getaddrinfo")) {
    return "DNS_FAILURE";
  }
  if (
    err.includes("credential") ||
    err.includes("credentials_disallowed") ||
    err.includes("unauthorized") ||
    err.includes("401") ||
    err.includes("403")
  ) {
    return "CREDENTIAL_OR_AUTH_ERROR";
  }
  if (err.includes("lease expired") || err.includes("worker lease")) {
    return "LEASE_EXPIRED";
  }
  if (
    err.includes("parse") ||
    err.includes("syntax") ||
    err.includes("html") ||
    err.includes("unsupported")
  ) {
    return "CONTENT_PARSE_ERROR";
  }
  if (err.includes("integrity") || err.includes("corrupt") || err.includes("checksum")) {
    return "INTEGRITY_ERROR";
  }
  return "FETCH_OR_PROCESSING_ERROR";
}

/**
 * Redacts secrets, tokens, embedded credentials, and sensitive endpoints from strings.
 */
export function redactSecrets(text: string, env: NodeJS.ProcessEnv = process.env): string {
  if (typeof text !== "string" || !text) return text;

  let redacted = text;

  // 1. Redact embedded credentials in URLs: https://user:pass@host -> https://[REDACTED_AUTH]@host
  redacted = redacted.replace(
    /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^@/\s:]+):([^@/\s]+)@/g,
    "$1[REDACTED_AUTH]@",
  );
  redacted = redacted.replace(
    /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^@/\s]+)@/g,
    "$1[REDACTED_AUTH]@",
  );

  // 2. Redact sensitive query parameters: ?token=xxx, &key=xxx, etc.
  redacted = redacted.replace(
    /([?&])(token|key|api_key|apikey|secret|access_token|password|auth|sig|signature)=([^&#\s]+)/gi,
    "$1$2=[REDACTED]",
  );

  // 3. Redact GitHub personal access tokens
  redacted = redacted.replace(/\bgh[pousr]_[A-Za-z0-9_]{16,}\b/g, "ghp_[REDACTED]");
  redacted = redacted.replace(/\bgithub_pat_[A-Za-z0-9_]{16,}\b/g, "github_pat_[REDACTED]");

  // 4. Redact AWS / S3 / Cloudflare R2 Access Key IDs
  redacted = redacted.replace(/\bAKIA[0-9A-Z]{16}\b/g, "AKIA[REDACTED]");

  // 5. Redact Cloudflare Account IDs in R2 endpoints: https://<32-hex-account-id>.r2.cloudflarestorage.com
  redacted = redacted.replace(
    /https:\/\/([a-fA-F0-9]{32})\.r2\.cloudflarestorage\.com/g,
    "https://[REDACTED_ACCOUNT].r2.cloudflarestorage.com",
  );

  // 6. Redact Bearer and Basic authentication headers
  redacted = redacted.replace(/\bBearer\s+([A-Za-z0-9\-._~+/]+=*)\b/gi, "Bearer [REDACTED]");
  redacted = redacted.replace(/\bBasic\s+([A-Za-z0-9+/]+=*)\b/gi, "Basic [REDACTED]");

  // 7. Redact key-value pairs of common sensitive words
  redacted = redacted.replace(
    /\b(secret[_-]?access[_-]?key|secret[_-]?key|access[_-]?key[_-]?id|api[_-]?key|password|credential|private[_-]?key)[\s:=]+([^\s,;'"]+)/gi,
    "$1=[REDACTED]",
  );

  // 8. Redact environment variable values if present in active env
  if (env && typeof env === "object") {
    for (const [key, val] of Object.entries(env)) {
      if (
        val &&
        typeof val === "string" &&
        val.length >= 6 &&
        /SECRET|KEY|TOKEN|PASSWORD|AUTH|CREDENTIAL/i.test(key)
      ) {
        if (redacted.includes(val)) {
          redacted = redacted.split(val).join("[REDACTED]");
        }
      }
    }
  }

  return redacted;
}

/**
 * Recursively redacts all string values in an object or array.
 */
export function redactData<T>(val: T, env: NodeJS.ProcessEnv = process.env): T {
  if (typeof val === "string") {
    return redactSecrets(val, env) as unknown as T;
  }
  if (val === null || val === undefined) {
    return val;
  }
  if (Array.isArray(val)) {
    return val.map((item) => redactData(item, env)) as unknown as T;
  }
  if (typeof val === "object") {
    const res: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val)) {
      res[k] = redactData(v, env);
    }
    return res as T;
  }
  return val;
}

// ============================================================================
// Core Inspection Implementation
// ============================================================================

/**
 * Inspects and returns the comprehensive knowledge library status.
 *
 * Invariant: Strictly read-only; never modifies database, file locks, or overlays.
 */
export async function getLibraryStatus(
  options: GetLibraryStatusOptions = {},
): Promise<KnowledgeLibraryStatus> {
  const projectRoot = options.projectRoot
    ? path.resolve(options.projectRoot)
    : process.cwd();
  const env = options.env || process.env;
  const paths = getKnowledgePaths(options.knowledgeHome, env);
  const now = options.now || new Date();
  const inspectedAt = nowIsoWithOffset(now, 540);

  // --------------------------------------------------------------------------
  // 1. Registry Status (Git-tracked knowledge/sources/*.json)
  // --------------------------------------------------------------------------
  let totalSources = 0;
  let enabledSources = 0;
  let disabledSources = 0;
  const byKind: Record<SourceKind, number> = {
    "github-repo": 0,
    "github-stars": 0,
    web: 0,
  };
  const sourcesMap = new Map<string, SourceSpec>();

  const sourcesDir = path.join(projectRoot, "knowledge", "sources");
  if (fs.existsSync(sourcesDir)) {
    try {
      const files = fs.readdirSync(sourcesDir);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const filePath = path.join(sourcesDir, file);
        try {
          const raw = fs.readFileSync(filePath, "utf8");
          const spec = JSON.parse(raw) as SourceSpec;
          totalSources++;
          if (spec.enabled !== false) {
            enabledSources++;
          } else {
            disabledSources++;
          }
          if (spec.kind in byKind) {
            byKind[spec.kind]++;
          }
          if (spec.source_id) {
            sourcesMap.set(spec.source_id, spec);
          }
        } catch {
          // ignore corrupted individual source file in read-only inspection
        }
      }
    } catch {
      // non-fatal
    }
  }

  const registryStatus: RegistryStatus = {
    total_sources: totalSources,
    enabled_sources: enabledSources,
    disabled_sources: disabledSources,
    by_kind: byKind,
  };

  // --------------------------------------------------------------------------
  // 2. Reader Status (Local cache and active pointer)
  // --------------------------------------------------------------------------
  let readerStatus: ReaderLibraryStatus;

  if (options.reader) {
    let rs: ReaderStatus | null = null;
    if (typeof (options.reader as ReaderService).getReaderStatus === "function") {
      rs = await (options.reader as ReaderService).getReaderStatus();
    } else {
      const basic = await options.reader.getStatus();
      rs = {
        status: basic.stale ? "stale" : basic.generation ? "available" : "unavailable",
        available: Boolean(basic.generation),
        catalog_id: "main",
        generation: basic.generation,
        source_commit: null,
        published_at: null,
        last_successful_sync: null,
        last_sync_check: null,
        mode: basic.mode,
        document_count: 0,
        chunk_count: 0,
        db_path: null,
        model_fingerprint: null,
        stale: basic.stale,
      };
    }

    // Determine cached generations count
    let cachedGenerationsCount = 0;
    const readerCacheDir =
      (options.reader as any).cacheDir || paths.root;
    const snapshotsDir = path.join(readerCacheDir, "snapshots");
    if (fs.existsSync(snapshotsDir)) {
      try {
        const entries = fs.readdirSync(snapshotsDir, { withFileTypes: true });
        cachedGenerationsCount = entries.filter(
          (e) => e.isDirectory() && !e.name.endsWith(".partial"),
        ).length;
      } catch {
        cachedGenerationsCount = 0;
      }
    }

    readerStatus = {
      status: rs.status,
      available: rs.available,
      active_generation: rs.generation,
      cached_generations_count: cachedGenerationsCount,
      last_sync_at: rs.last_successful_sync,
      last_sync_check: rs.last_sync_check,
      stale: rs.stale,
      stale_threshold_hours: (options.reader as any).staleThresholdHours ?? 24,
      search_mode: rs.mode,
      document_count: rs.document_count,
      chunk_count: rs.chunk_count,
      model_fingerprint: rs.model_fingerprint,
      source_commit: rs.source_commit,
      published_at: rs.published_at,
    };
  } else {
    // Read local cache metadata directly without instantiating mutating components
    const activePath = path.join(paths.root, "active.json");
    const syncStatePath = path.join(paths.root, "sync-state.json");
    let activePointer: any = null;
    let syncState: any = null;

    if (fs.existsSync(activePath)) {
      try {
        activePointer = JSON.parse(fs.readFileSync(activePath, "utf8"));
      } catch {}
    }
    if (fs.existsSync(syncStatePath)) {
      try {
        syncState = JSON.parse(fs.readFileSync(syncStatePath, "utf8"));
      } catch {}
    }

    let cachedGenerationsCount = 0;
    if (fs.existsSync(paths.snapshots)) {
      try {
        const entries = fs.readdirSync(paths.snapshots, { withFileTypes: true });
        cachedGenerationsCount = entries.filter(
          (e) => e.isDirectory() && !e.name.endsWith(".partial"),
        ).length;
      } catch {
        cachedGenerationsCount = 0;
      }
    }

    if (activePointer && activePointer.generation) {
      const manifest = activePointer.manifest || {};
      const lastSync = activePointer.last_successful_sync || syncState?.last_successful_sync || null;
      let isStale = false;
      if (lastSync) {
        const diffMs = now.getTime() - Date.parse(lastSync);
        if (Number.isFinite(diffMs) && diffMs >= 24 * 3600 * 1000) {
          isStale = true;
        }
      }

      readerStatus = {
        status: isStale ? "stale" : "available",
        available: true,
        active_generation: activePointer.generation,
        cached_generations_count: cachedGenerationsCount,
        last_sync_at: lastSync,
        last_sync_check: syncState?.last_sync_check || lastSync,
        stale: isStale,
        stale_threshold_hours: 24,
        search_mode: manifest.sqlite_vec_version ? "vector" : "lexical",
        document_count: manifest.document_count || 0,
        chunk_count: manifest.chunk_count || 0,
        model_fingerprint: manifest.model_fingerprint || null,
        source_commit: manifest.input_commit || null,
        published_at: manifest.created_at || activePointer.published_at || null,
      };
    } else {
      readerStatus = {
        status: "unavailable",
        available: false,
        active_generation: null,
        cached_generations_count: cachedGenerationsCount,
        last_sync_at: syncState?.last_successful_sync || null,
        last_sync_check: syncState?.last_sync_check || null,
        stale: false,
        stale_threshold_hours: 24,
        search_mode: "lexical",
        document_count: 0,
        chunk_count: 0,
        model_fingerprint: null,
        source_commit: null,
        published_at: null,
      };
    }
  }

  // --------------------------------------------------------------------------
  // 3. Producer Status (Jobs, Sync Ledger, and Execution Timestamps)
  // --------------------------------------------------------------------------
  const jobsSummary: ProducerJobsSummary = {
    pending: 0,
    in_progress: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
  };
  const failedSources: ProducerFailedSource[] = [];

  let jobs: JobRecord[] = [];
  let activeWorkerId: string | null = null;
  let lastFetchAt: string | null = null;
  let lastEmbedAt: string | null = null;
  let lastPullCommit: string | null = null;
  let lastPullAt: string | null = null;
  let lastPublishAt: string | null = null;

  if (options.queueManager) {
    try {
      const summary = await options.queueManager.getJobSummary();
      jobsSummary.pending = summary.pending;
      jobsSummary.in_progress = summary.in_progress;
      jobsSummary.completed = summary.completed;
      jobsSummary.failed = summary.failed;
      jobsSummary.skipped = summary.skipped;

      jobs = await options.queueManager.listJobs();
    } catch {
      // non-fatal
    }
  } else {
    // Read ledger file directly without acquiring locks
    const candidateLedgerPaths = [
      path.join(paths.producerJobs, "ledger.json"),
      path.join(paths.producer, "jobs.json"),
      path.join(paths.producerJobs, "jobs.json"),
    ];

    for (const lp of candidateLedgerPaths) {
      if (fs.existsSync(lp)) {
        try {
          const raw = fs.readFileSync(lp, "utf8");
          const ledger = JSON.parse(raw);
          if (ledger && Array.isArray(ledger.jobs)) {
            jobs = ledger.jobs;
            for (const j of jobs) {
              if (j.status in jobsSummary) {
                jobsSummary[j.status as keyof ProducerJobsSummary]++;
              }
            }
          }
          break;
        } catch {
          // ignore corrupted ledger
        }
      }
    }
  }

  // Process job records
  for (const job of jobs) {
    if (job.status === "in_progress" && job.worker_id) {
      activeWorkerId = job.worker_id;
    }

    // Determine latest fetch and embed timestamps from job updates
    const attemptTime = job.last_attempt_at || job.updated_at;
    if (attemptTime) {
      if (!lastFetchAt || Date.parse(attemptTime) > Date.parse(lastFetchAt)) {
        lastFetchAt = attemptTime;
      }
    }
    if (job.status === "completed" && job.action !== "tombstone" && job.updated_at) {
      if (!lastEmbedAt || Date.parse(job.updated_at) > Date.parse(lastEmbedAt)) {
        lastEmbedAt = job.updated_at;
      }
    }

    if (job.input_commit && !lastPullCommit) {
      lastPullCommit = job.input_commit;
    }

    if (job.status === "failed" || (Boolean(job.error) && job.attempt_count > 0)) {
      const err = job.error || "Unknown processing error";
      const errType = classifyErrorType(err);
      let nextRetryAt: string | null = null;
      if (job.status === "failed") {
        nextRetryAt = "최대 시도 횟수 초과 (수동 재설정 필요)";
      } else if (job.attempt_count < job.max_attempts) {
        nextRetryAt = job.lease_expires_at || "스케줄 주기 시 자동 재시도 대기";
      } else {
        nextRetryAt = "최대 시도 횟수 초과 (수동 재설정 필요)";
      }

      failedSources.push({
        source_id: job.source_id,
        url: job.url || sourcesMap.get(job.source_id)?.url || "-",
        kind: job.kind || sourcesMap.get(job.source_id)?.kind,
        error: err,
        error_type: errType,
        attempt_count: job.attempt_count,
        max_attempts: job.max_attempts,
        next_retry_at: nextRetryAt,
      });
    }
  }

  // Inspect sync-ledger.json for pull and commit cursors
  const syncLedgerPath = path.join(paths.producer, "sync-ledger.json");
  if (fs.existsSync(syncLedgerPath)) {
    try {
      const raw = fs.readFileSync(syncLedgerPath, "utf8");
      const ledger = JSON.parse(raw);
      if (ledger.last_seen_commit) {
        lastPullCommit = ledger.last_seen_commit;
      }
      if (ledger.last_published_commit && !readerStatus.source_commit) {
        readerStatus.source_commit = ledger.last_published_commit;
      }
      if (ledger.sources && typeof ledger.sources === "object") {
        for (const cursor of Object.values(ledger.sources) as any[]) {
          if (cursor.last_attempt_at) {
            if (!lastFetchAt || Date.parse(cursor.last_attempt_at) > Date.parse(lastFetchAt)) {
              lastFetchAt = cursor.last_attempt_at;
            }
          }
          if (cursor.last_success_at) {
            if (!lastEmbedAt || Date.parse(cursor.last_success_at) > Date.parse(lastEmbedAt)) {
              lastEmbedAt = cursor.last_success_at;
            }
          }
        }
      }
    } catch {}
  }

  // Check latest published snapshot timestamp
  const latestSnapshotPath = path.join(paths.snapshots, "latest.json");
  if (fs.existsSync(latestSnapshotPath)) {
    try {
      const raw = fs.readFileSync(latestSnapshotPath, "utf8");
      const latestObj = JSON.parse(raw);
      lastPublishAt =
        latestObj.updated_at ||
        latestObj.created_at ||
        latestObj.manifest?.created_at ||
        null;
      if (latestObj.input_commit && !lastPullCommit) {
        lastPullCommit = latestObj.input_commit;
      }
    } catch {}
  }
  if (!lastPublishAt && readerStatus.published_at) {
    lastPublishAt = readerStatus.published_at;
  }

  const producerAvailable =
    fs.existsSync(paths.producer) ||
    options.queueManager !== undefined ||
    jobs.length > 0;

  const producerStatus: ProducerStatus = {
    available: producerAvailable,
    last_pull_commit: lastPullCommit,
    last_pull_at: lastPullAt,
    last_fetch_at: lastFetchAt,
    last_embed_at: lastEmbedAt,
    last_publish_at: lastPublishAt,
    jobs_summary: jobsSummary,
    failed_sources: failedSources,
    active_worker_id: activeWorkerId,
    producer_dir: producerAvailable ? paths.producer : null,
  };

  // --------------------------------------------------------------------------
  // 4. Freshness and Integrity Diagnosis
  // --------------------------------------------------------------------------
  const hasFailedSources = failedSources.length > 0;
  const hasPendingJobs = jobsSummary.pending > 0 || jobsSummary.in_progress > 0;
  const isPublishedUpToDate = Boolean(
    readerStatus.available &&
      lastPullCommit &&
      readerStatus.source_commit === lastPullCommit,
  );

  let notice = "";
  if (hasFailedSources) {
    notice = `⚠️ 주의: 스냅샷 발행 성공이 전체 등록 소스의 최신화를 의미하지 않습니다. 실패한 소스(${failedSources.length}건)가 존재하므로 일부 원문은 구버전이거나 인덱스에서 누락되었을 수 있습니다.`;
  } else if (hasPendingJobs) {
    notice = `⏳ 수집 및 반영 진행 중: 현재 처리 대기 또는 진행 중인 작업(${jobsSummary.pending + jobsSummary.in_progress}건)이 있습니다. 다음 스냅샷에 포함될 예정입니다.`;
  } else if (readerStatus.available) {
    notice = "✅ 전체 소스 동기화 완료: 모든 등록 소스가 정상 수집되어 최신 스냅샷에 반영되었습니다.";
  } else {
    notice = "ℹ️ 로컬 캐시 없음: 원격 스냅샷 동기화 또는 생산자 최초 빌드가 필요합니다.";
  }

  const freshness: FreshnessStatus = {
    published_up_to_date: isPublishedUpToDate,
    all_sources_fresh: !hasFailedSources && !hasPendingJobs,
    notice,
  };

  const status: KnowledgeLibraryStatus = {
    inspected_at: inspectedAt,
    registry: registryStatus,
    producer: producerStatus,
    reader: readerStatus,
    freshness,
  };

  // Redact all sensitive fields recursively before returning
  return redactData(status, env);
}

// ============================================================================
// Human-Readable Korean Formatter
// ============================================================================

/**
 * Formats KnowledgeLibraryStatus into a clean, human-readable Korean status table.
 */
export function formatLibraryStatusText(status: KnowledgeLibraryStatus): string {
  const lines: string[] = [];

  lines.push("=".repeat(80));
  lines.push("  하네스 지식 라이브러리(Knowledge Library) 상태 보고서");
  lines.push(`  조회 시각: ${formatSeoulDisplay(status.inspected_at)}`);
  lines.push("=".repeat(80));
  lines.push("");

  // 1. Registry Status
  lines.push("[1] 등록 레지스트리 (Registry Status)");
  lines.push("-".repeat(80));
  lines.push(
    `- 총 등록 소스: ${status.registry.total_sources}개 (활성: ${status.registry.enabled_sources}개, 비활성: ${status.registry.disabled_sources}개)`,
  );
  lines.push("- 소스 유형별:");
  lines.push(`  • GitHub 저장소 (github-repo): ${status.registry.by_kind["github-repo"]}개`);
  lines.push(`  • GitHub 별표 (github-stars): ${status.registry.by_kind["github-stars"]}개`);
  lines.push(`  • 일반 웹 문서 (web): ${status.registry.by_kind["web"]}개`);
  lines.push("");

  // 2. Producer Status
  lines.push("[2] 생산자 파이프라인 (Producer Status - Windows)");
  lines.push("-".repeat(80));
  if (!status.producer.available) {
    lines.push("- 생산자 상태: 미구성 또는 비활성 (Windows 전용 clone 환경에서 구동됩니다)");
  } else {
    lines.push("- 최근 실행 이력 (Asia/Seoul):");
    const commitDisplay = status.producer.last_pull_commit
      ? `${status.producer.last_pull_commit.slice(0, 10)}...`
      : "- (미기록)";
    lines.push(`  • 마지막 Git Pull 커밋: ${commitDisplay}`);
    lines.push(`  • 마지막 문서 수집 (Fetch): ${formatSeoulDisplay(status.producer.last_fetch_at)}`);
    lines.push(`  • 마지막 임베딩 (Embed): ${formatSeoulDisplay(status.producer.last_embed_at)}`);
    lines.push(`  • 마지막 스냅샷 발행 (Publish): ${formatSeoulDisplay(status.producer.last_publish_at)}`);
    lines.push("- 큐 작업 현황:");
    lines.push(
      `  • 대기(Pending): ${status.producer.jobs_summary.pending}건 | 진행 중(In Progress): ${status.producer.jobs_summary.in_progress}건 | 완료(Completed): ${status.producer.jobs_summary.completed}건`,
    );
    lines.push(
      `  • 실패(Failed): ${status.producer.jobs_summary.failed}건 | 건너뜀(Skipped): ${status.producer.jobs_summary.skipped}건`,
    );

    if (status.producer.failed_sources.length > 0) {
      lines.push("");
      lines.push(`- 수집 실패 소스 목록 (${status.producer.failed_sources.length}건):`);
      status.producer.failed_sources.forEach((fail, idx) => {
        lines.push(`  [${idx + 1}] 소스 ID: ${fail.source_id.slice(0, 16)}...`);
        lines.push(`      URL: ${fail.url}`);
        lines.push(`      오류 유형: ${fail.error_type}`);
        lines.push(`      오류 원인: ${fail.error}`);
        lines.push(`      시도 횟수: ${fail.attempt_count}/${fail.max_attempts}`);
        lines.push(`      다음 재시도: ${fail.next_retry_at || "-"}`);
      });
    }
  }
  lines.push("");

  // 3. Reader Status
  lines.push("[3] 소비자 로컬 캐시 (Reader Status)");
  lines.push("-".repeat(80));
  if (!status.reader.available) {
    lines.push("- 상태: 사용 불가 (로컬 캐시 스냅샷 없음 - sync 명령으로 초기 다운로드 필요)");
  } else {
    const statusLabel =
      status.reader.status === "stale"
        ? "만료됨 (stale - 동기화 권장)"
        : "정상 (available)";
    lines.push(`- 상태: ${statusLabel}`);
    lines.push(`- 활성 세대 (Generation): ${status.reader.active_generation || "-"}`);
    lines.push(`- 보관된 스냅샷 세대 수: ${status.reader.cached_generations_count}개`);
    lines.push(`- 마지막 동기화 성공: ${formatSeoulDisplay(status.reader.last_sync_at)}`);
    lines.push(`- 마지막 동기화 점검: ${formatSeoulDisplay(status.reader.last_sync_check)}`);
    lines.push(`- 스냅샷 발행 시각: ${formatSeoulDisplay(status.reader.published_at)}`);
    lines.push(
      `- 검색 모드: ${status.reader.search_mode} (${status.reader.search_mode === "vector" ? "벡터 + FTS 하이브리드" : "FTS 키워드 전용"})`,
    );
    lines.push(
      `- 색인 규모: 문서 ${status.reader.document_count}개 / 청크 ${status.reader.chunk_count}개`,
    );
    if (status.reader.source_commit) {
      lines.push(`- 스냅샷 기준 커밋: ${status.reader.source_commit.slice(0, 10)}...`);
    }
  }
  lines.push("");

  // 4. Freshness and Separation Notice
  lines.push("[4] 원문 최신화 및 발행 분리 진단 (Freshness & Integrity)");
  lines.push("-".repeat(80));
  lines.push(status.freshness.notice);
  lines.push("=".repeat(80));

  const textOutput = lines.join("\n");
  return redactSecrets(textOutput);
}

// ============================================================================
// CLI Entry Point
// ============================================================================

async function runCli(): Promise<void> {
  const args = process.argv.slice(2);
  const jsonMode = args.includes("--json");

  let projectRoot: string | undefined;
  const rootIdx = args.indexOf("--project-root");
  if (rootIdx !== -1 && rootIdx + 1 < args.length) {
    projectRoot = args[rootIdx + 1];
  }

  let knowledgeHome: string | undefined;
  const homeIdx = args.indexOf("--knowledge-home");
  if (homeIdx !== -1 && homeIdx + 1 < args.length) {
    knowledgeHome = args[homeIdx + 1];
  }

  try {
    const status = await getLibraryStatus({ projectRoot, knowledgeHome });
    if (jsonMode) {
      console.log(JSON.stringify(status, null, 2));
    } else {
      console.log(formatLibraryStatusText(status));
    }
  } catch (err: any) {
    console.error(`지식 라이브러리 상태 조회 실패: ${err.message}`);
    process.exit(1);
  }
}

// Execute CLI when directly invoked
if (process.argv[1]) {
  try {
    const currentScript = fileURLToPath(import.meta.url);
    const invokedScript = path.resolve(process.argv[1]);
    if (currentScript === invokedScript) {
      void runCli();
    }
  } catch {
    // ignore
  }
}
