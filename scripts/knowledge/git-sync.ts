/**
 * git-sync.ts — Git synchronization and registry ingestion service for Windows producer.
 *
 * Implements safe, non-destructive synchronization of the Git-tracked URL registry:
 * - Enforces fast-forward only (`git pull --ff-only` semantics).
 * - Refuses to process or publish if working directory is dirty or branches have diverged.
 * - Pins current commit SHA and reads registry snapshot at that exact commit.
 * - Classifies sources (new, modified, TTL-expired, deleted/disabled).
 * - Generates executable job records for JobQueueManager.
 * - SAFETY INVARIANT: Strictly prohibits git push, git reset --hard, force checkouts,
 *   and execution of npm install or any scripts from the pulled repo.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  type SourceKind,
  type SourceSpec,
  validateSourceSpec,
} from "./contracts.ts";
import {
  type JobRecord,
  type EnqueueJobInput,
  type JobQueueManager,
} from "./jobs.ts";

const execFileAsync = promisify(execFile);

// ============================================================================
// Types & Contracts
// ============================================================================

export type GitSyncErrorCode =
  | "NOT_A_GIT_REPO"
  | "DIRTY_WORKING_TREE"
  | "DIVERGED_BRANCH"
  | "FETCH_FAILED"
  | "FORBIDDEN_GIT_COMMAND"
  | "REGISTRY_INVALID"
  | "GIT_EXECUTION_FAILED";

export class GitSyncError extends Error {
  readonly code: GitSyncErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: GitSyncErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "GitSyncError";
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface ExecGitOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface PullRegistryOptions extends ExecGitOptions {
  remote?: string;
  branch?: string;
  throwOnError?: boolean;
}

export interface PullRegistryResult {
  commitSha: string;
  changedFiles: string[];
  diverged: boolean;
  dirty: boolean;
  error?: string;
}

export interface RegistryReadResult {
  commitSha: string;
  catalog: any | null;
  sources: SourceSpec[];
  errors: string[];
  valid: boolean;
}

export type SourceChangeType = "new" | "modified" | "ttl_expired" | "deleted" | "disabled";

export interface SourceCursor {
  source_id: string;
  kind?: SourceKind;
  url?: string;
  source_hash: string;
  last_seen_commit: string;
  last_success_at?: string;
  last_attempt_at?: string;
  status?: string;
}

export interface SyncLedger {
  last_seen_commit?: string;
  last_published_commit?: string;
  sources: Record<string, SourceCursor>;
}

export interface ClassifiedSource {
  source_id: string;
  change_type: SourceChangeType;
  spec?: SourceSpec;
  previous_cursor?: SourceCursor;
  reason: string;
}

export interface SourceClassificationOptions {
  now?: Date;
  defaultRefreshHours?: Record<SourceKind, number>;
}

export interface GitSyncOptions extends PullRegistryOptions {
  now?: Date;
  modelFingerprint?: string;
  maxAttempts?: number;
  defaultRefreshHours?: Record<SourceKind, number>;
}

export interface GitSyncResult {
  commitSha: string;
  changedFiles: string[];
  diverged: boolean;
  dirty: boolean;
  validRegistry: boolean;
  errors: string[];
  classified: ClassifiedSource[];
  enqueuedJobs: JobRecord[];
  diagnostic?: string;
}

// Forbidden git operations that could cause data loss or unauthorized mutation
export const FORBIDDEN_GIT_COMMANDS = new Set([
  "push",
  "reset",
  "clean",
  "rebase",
  "cherry-pick",
]);

/**
 * Asserts that git arguments do not include forbidden destructive commands.
 */
export function assertSafeGitArgs(args: string[]): void {
  for (const arg of args) {
    if (FORBIDDEN_GIT_COMMANDS.has(arg.toLowerCase())) {
      throw new GitSyncError(
        "FORBIDDEN_GIT_COMMAND",
        `Git command '${arg}' is strictly prohibited in producer synchronization`,
      );
    }
  }

  if (args[0] === "checkout" || args[0] === "switch") {
    if (args.includes("-f") || args.includes("--force") || args.includes("-B")) {
      throw new GitSyncError(
        "FORBIDDEN_GIT_COMMAND",
        "Force checkout is strictly prohibited in producer synchronization",
      );
    }
  }
}

/**
 * Computes deterministic content hash of a SourceSpec for change detection.
 */
export function computeSourceHash(spec: SourceSpec): string {
  const payload = {
    source_id: spec.source_id,
    kind: spec.kind,
    url: spec.url,
    title: spec.title ?? "",
    tags: [...spec.tags].sort(),
    note: spec.note ?? "",
    enabled: spec.enabled,
    refresh_hours: spec.refresh_hours,
    provenance: spec.provenance,
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/**
 * Classifies sources against a cursor ledger into new, modified, TTL-expired,
 * and deleted/disabled categories.
 */
export function classifySources(
  currentSources: SourceSpec[],
  previousState: SyncLedger | Record<string, SourceCursor>,
  options?: SourceClassificationOptions,
): ClassifiedSource[] {
  const prevCursors: Record<string, SourceCursor> =
    "sources" in previousState && typeof previousState.sources === "object"
      ? (previousState.sources as Record<string, SourceCursor>)
      : (previousState as Record<string, SourceCursor>);
  const now = options?.now ?? new Date();
  const nowMs = now.getTime();
  const defaultHours: Record<SourceKind, number> = {
    "github-repo": 24,
    "github-stars": 24,
    web: 168,
    ...options?.defaultRefreshHours,
  };

  const results: ClassifiedSource[] = [];
  const seenSourceIds = new Set<string>();

  for (const source of currentSources) {
    seenSourceIds.add(source.source_id);
    const prev = prevCursors[source.source_id];

    if (!source.enabled) {
      results.push({
        source_id: source.source_id,
        change_type: "disabled",
        spec: source,
        previous_cursor: prev,
        reason: "Source is disabled (enabled: false)",
      });
      continue;
    }

    if (!prev) {
      results.push({
        source_id: source.source_id,
        change_type: "new",
        spec: source,
        reason: "New source added to registry",
      });
      continue;
    }

    const currentHash = computeSourceHash(source);
    if (currentHash !== prev.source_hash) {
      results.push({
        source_id: source.source_id,
        change_type: "modified",
        spec: source,
        previous_cursor: prev,
        reason: "Source specification modified",
      });
      continue;
    }

    // Unchanged in git; check TTL expiration
    const refreshHours =
      source.refresh_hours > 0 ? source.refresh_hours : (defaultHours[source.kind] ?? 24);
    const lastSuccessMs = prev.last_success_at ? new Date(prev.last_success_at).getTime() : 0;
    const elapsedHours = (nowMs - lastSuccessMs) / (1000 * 60 * 60);

    if (elapsedHours >= refreshHours) {
      results.push({
        source_id: source.source_id,
        change_type: "ttl_expired",
        spec: source,
        previous_cursor: prev,
        reason: `TTL expired: ${elapsedHours.toFixed(1)}h elapsed >= ${refreshHours}h since last success`,
      });
    }
  }

  // Detect deleted sources (present in previous cursors, but absent in current commit)
  for (const [sourceId, prev] of Object.entries(prevCursors)) {
    if (!seenSourceIds.has(sourceId)) {
      results.push({
        source_id: sourceId,
        change_type: "deleted",
        previous_cursor: prev,
        reason: "Source deleted from registry (tombstone candidate)",
      });
    }
  }

  return results;
}

/**
 * Transforms classified source changes into enqueueable job records.
 */
export function generateJobRecords(
  classified: ClassifiedSource[],
  inputCommit: string,
  options?: {
    maxAttempts?: number;
    modelFingerprint?: string;
  },
): EnqueueJobInput[] {
  const jobs: EnqueueJobInput[] = [];

  for (const item of classified) {
    if (
      item.change_type === "new" ||
      item.change_type === "modified" ||
      item.change_type === "ttl_expired"
    ) {
      if (!item.spec) continue;
      jobs.push({
        source_id: item.source_id,
        kind: item.spec.kind,
        url: item.spec.url,
        input_commit: inputCommit,
        action: "process",
        content_hash: computeSourceHash(item.spec),
        model_fingerprint: options?.modelFingerprint,
        max_attempts: options?.maxAttempts ?? 3,
      });
    } else if (item.change_type === "deleted" || item.change_type === "disabled") {
      jobs.push({
        source_id: item.source_id,
        kind: item.spec?.kind ?? item.previous_cursor?.kind ?? "web",
        url: item.spec?.url ?? item.previous_cursor?.url ?? "",
        input_commit: inputCommit,
        action: "tombstone",
        model_fingerprint: options?.modelFingerprint,
        max_attempts: options?.maxAttempts ?? 3,
      });
    }
  }

  return jobs;
}

// ============================================================================
// GitSyncService Implementation
// ============================================================================

export class GitSyncService {
  /**
   * Safely executes a git command in the target directory with safety guard assertions.
   * Never invokes shell; uses execFile directly.
   */
  async executeGit(
    repoDir: string,
    args: string[],
    options?: ExecGitOptions,
  ): Promise<string> {
    assertSafeGitArgs(args);

    try {
      const { stdout } = await execFileAsync("git", args, {
        cwd: repoDir,
        signal: options?.signal,
        timeout: options?.timeoutMs ?? 30000,
        env: {
          ...process.env,
          // Guarantee machine-readable non-localized output
          LC_ALL: "C",
          LANG: "C",
          ...options?.env,
        },
      });
      return stdout;
    } catch (err: any) {
      if (err.name === "AbortError") {
        throw err;
      }
      throw new GitSyncError(
        "GIT_EXECUTION_FAILED",
        `git ${args.join(" ")} failed: ${err.message}`,
        {
          args,
          stdout: err.stdout,
          stderr: err.stderr,
          code: err.code,
        },
      );
    }
  }

  /**
   * Pinned commit SHA reader.
   */
  async getCommitSha(repoDir: string, ref = "HEAD", options?: ExecGitOptions): Promise<string> {
    const out = await this.executeGit(repoDir, ["rev-parse", ref], options);
    return out.trim();
  }

  /**
   * Pulls the registry repository using fast-forward only semantics.
   * If dirty or diverged, refuses to pull and returns diagnostic state without mutation.
   */
  async pullRegistry(
    repoDir: string,
    options?: PullRegistryOptions,
  ): Promise<PullRegistryResult> {
    // 1. Verify inside git worktree
    const isInside = await this.executeGit(repoDir, ["rev-parse", "--is-inside-work-tree"], options).catch(() => "");
    if (isInside.trim() !== "true") {
      throw new GitSyncError("NOT_A_GIT_REPO", `'${repoDir}' is not a valid git repository`);
    }

    // 2. Pin current commit SHA
    const currentSha = await this.getCommitSha(repoDir, "HEAD", options);

    // 3. Check for uncommitted working tree modifications (dirty check)
    const statusOutput = (await this.executeGit(repoDir, ["status", "--porcelain"], options)).trim();
    if (statusOutput.length > 0) {
      const errorMsg = `Refusing to pull: working directory at '${repoDir}' is dirty with uncommitted changes:\n${statusOutput}`;
      if (options?.throwOnError) {
        throw new GitSyncError("DIRTY_WORKING_TREE", errorMsg, { porcelain: statusOutput });
      }
      return {
        commitSha: currentSha,
        changedFiles: [],
        diverged: false,
        dirty: true,
        error: errorMsg,
      };
    }

    // 4. Determine remote and branch
    const remote = options?.remote ?? "origin";
    let branch = options?.branch;
    if (!branch) {
      const abbrev = (await this.executeGit(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"], options)).trim();
      branch = abbrev === "HEAD" ? "main" : abbrev;
    }

    // 5. Fetch from remote
    try {
      await this.executeGit(repoDir, ["fetch", remote, branch], options);
    } catch (err: any) {
      const errorMsg = `Failed to fetch from ${remote}/${branch}: ${err.message}`;
      if (options?.throwOnError) {
        throw new GitSyncError("FETCH_FAILED", errorMsg, { remote, branch });
      }
      return {
        commitSha: currentSha,
        changedFiles: [],
        diverged: false,
        dirty: false,
        error: errorMsg,
      };
    }

    // 6. Get fetched commit SHA (FETCH_HEAD)
    const fetchHeadSha = (await this.executeGit(repoDir, ["rev-parse", "FETCH_HEAD"], options)).trim();

    if (fetchHeadSha === currentSha) {
      // Already up-to-date
      return {
        commitSha: currentSha,
        changedFiles: [],
        diverged: false,
        dirty: false,
      };
    }

    // 7. Check if current commit is an ancestor of remote branch (fast-forward verification)
    let isAncestor = false;
    try {
      await this.executeGit(repoDir, ["merge-base", "--is-ancestor", currentSha, fetchHeadSha], options);
      isAncestor = true;
    } catch {
      isAncestor = false;
    }

    if (!isAncestor) {
      // Branches have diverged: fail safe and refuse to destroy data
      const errorMsg = `Refusing to pull: local branch has diverged from ${remote}/${branch} (fast-forward impossible)`;
      if (options?.throwOnError) {
        throw new GitSyncError("DIVERGED_BRANCH", errorMsg, {
          currentSha,
          fetchHeadSha,
          remote,
          branch,
        });
      }
      return {
        commitSha: currentSha,
        changedFiles: [],
        diverged: true,
        dirty: false,
        error: errorMsg,
      };
    }

    // 8. Capture changed file list between current and remote commit
    const diffOutput = (
      await this.executeGit(repoDir, ["diff", "--name-only", currentSha, fetchHeadSha], options)
    ).trim();
    const changedFiles = diffOutput ? diffOutput.split("\n").map((f) => f.trim()).filter(Boolean) : [];

    // 9. Execute fast-forward only merge
    await this.executeGit(repoDir, ["merge", "--ff-only", "FETCH_HEAD"], options);

    // 10. Pin updated commit SHA
    const newSha = await this.getCommitSha(repoDir, "HEAD", options);

    return {
      commitSha: newSha,
      changedFiles,
      diverged: false,
      dirty: false,
    };
  }

  /**
   * Reads registry catalog.json and sources at the specified pinned commit.
   * Uses git ls-tree and git show to inspect committed objects without relying on
   * dirty working tree states.
   */
  async readRegistryAtCommit(
    repoDir: string,
    commitSha?: string,
    options?: ExecGitOptions,
  ): Promise<RegistryReadResult> {
    const sha = commitSha ?? (await this.getCommitSha(repoDir, "HEAD", options));
    const errors: string[] = [];
    const sources: SourceSpec[] = [];
    let catalog: any = null;

    let treeFiles: string[] = [];
    try {
      const lsOutput = await this.executeGit(
        repoDir,
        ["ls-tree", "-r", "--name-only", sha, "knowledge/"],
        options,
      );
      treeFiles = lsOutput.split("\n").map((s) => s.trim()).filter(Boolean);
    } catch {
      return {
        commitSha: sha,
        catalog: null,
        sources: [],
        errors: [],
        valid: true,
      };
    }

    // Validate catalog.json if tracked
    if (treeFiles.includes("knowledge/catalog.json")) {
      try {
        const rawCatalog = await this.executeGit(
          repoDir,
          ["show", `${sha}:knowledge/catalog.json`],
          options,
        );
        catalog = JSON.parse(rawCatalog);
        if (catalog.schema_version !== 1) {
          errors.push(`catalog.json schema_version must be 1, got ${String(catalog.schema_version)}`);
        }
        if (typeof catalog.catalog_id !== "string" || !catalog.catalog_id.trim()) {
          errors.push("catalog.json missing or invalid 'catalog_id'");
        }
      } catch (err: any) {
        errors.push(`Failed to parse knowledge/catalog.json at commit ${sha.slice(0, 8)}: ${err.message}`);
      }
    }

    // Validate each source file under knowledge/sources/
    for (const file of treeFiles) {
      if (!file.startsWith("knowledge/sources/") || !file.endsWith(".json")) {
        continue;
      }
      const fileName = file.slice("knowledge/sources/".length);
      const baseName = fileName.slice(0, -5);

      if (!/^[0-9a-fA-F]{64}$/.test(baseName)) {
        errors.push(`Filename '${file}' is not a valid 64-character SHA-256 hex string`);
        continue;
      }

      try {
        const rawContent = await this.executeGit(
          repoDir,
          ["show", `${sha}:${file}`],
          options,
        );
        let parsed: unknown;
        try {
          parsed = JSON.parse(rawContent);
        } catch (parseErr: any) {
          errors.push(`Invalid JSON syntax in '${file}': ${parseErr.message}`);
          continue;
        }

        const spec = validateSourceSpec(parsed);
        if (spec.source_id.toLowerCase() !== baseName.toLowerCase()) {
          errors.push(`source_id '${spec.source_id}' does not match file name '${file}'`);
          continue;
        }

        sources.push(spec);
      } catch (err: any) {
        errors.push(`Validation failed for '${file}': ${err.message}`);
      }
    }

    sources.sort((a, b) => a.source_id.localeCompare(b.source_id));

    return {
      commitSha: sha,
      catalog,
      sources,
      errors,
      valid: errors.length === 0,
    };
  }

  /**
   * Reads registry catalog.json and sources directly from disk in the specified repository.
   * Useful for local development and producer runs against the active worktree.
   */
  async readRegistryFromDisk(
    repoDir: string,
    options?: ExecGitOptions,
  ): Promise<RegistryReadResult> {
    const sha = (await this.getCommitSha(repoDir, "HEAD", options).catch(() => "local-dirty")) || "local-dirty";
    const errors: string[] = [];
    const sources: SourceSpec[] = [];
    let catalog: any = null;

    const catalogPath = path.join(repoDir, "knowledge", "catalog.json");
    if (fs.existsSync(catalogPath)) {
      try {
        const rawCatalog = fs.readFileSync(catalogPath, "utf-8");
        catalog = JSON.parse(rawCatalog);
        if (catalog.schema_version !== 1) {
          errors.push(`catalog.json schema_version must be 1, got ${String(catalog.schema_version)}`);
        }
        if (typeof catalog.catalog_id !== "string" || !catalog.catalog_id.trim()) {
          errors.push("catalog.json missing or invalid 'catalog_id'");
        }
      } catch (err: any) {
        errors.push(`Failed to parse knowledge/catalog.json: ${err.message}`);
      }
    }

    const sourcesDir = path.join(repoDir, "knowledge", "sources");
    if (fs.existsSync(sourcesDir)) {
      try {
        const files = fs.readdirSync(sourcesDir);
        for (const file of files) {
          if (!file.endsWith(".json")) {
            continue;
          }
          const baseName = file.slice(0, -5);
          if (!/^[0-9a-fA-F]{64}$/.test(baseName)) {
            errors.push(`Filename '${file}' is not a valid 64-character SHA-256 hex string`);
            continue;
          }

          try {
            const rawContent = fs.readFileSync(path.join(sourcesDir, file), "utf-8");
            let parsed: unknown;
            try {
              parsed = JSON.parse(rawContent);
            } catch (parseErr: any) {
              errors.push(`Invalid JSON syntax in '${file}': ${parseErr.message}`);
              continue;
            }

            const spec = validateSourceSpec(parsed);
            if (spec.source_id.toLowerCase() !== baseName.toLowerCase()) {
              errors.push(`source_id '${spec.source_id}' does not match file name '${file}'`);
              continue;
            }

            sources.push(spec);
          } catch (err: any) {
            errors.push(`Validation failed for '${file}': ${err.message}`);
          }
        }
      } catch (err: any) {
        errors.push(`Failed to read knowledge/sources directory: ${err.message}`);
      }
    }

    sources.sort((a, b) => a.source_id.localeCompare(b.source_id));

    return {
      commitSha: sha,
      catalog,
      sources,
      errors,
      valid: errors.length === 0,
    };
  }

  /**
   * High-level synchronization workflow:
   * 1. Pulls registry safely with ff-only.
   * 2. Halts if dirty or diverged.
   * 3. Reads registry at pinned commit and validates JSON.
   * 4. Classifies changes (new, modified, TTL-expired, deleted/disabled).
   * 5. Enqueues executable job records into JobQueueManager.
   */
  async syncAndQueue(
    repoDir: string,
    jobQueue: JobQueueManager,
    syncLedger: SyncLedger,
    options?: GitSyncOptions,
  ): Promise<GitSyncResult> {
    const pullResult = await this.pullRegistry(repoDir, options);

    if (pullResult.dirty || pullResult.diverged || pullResult.error) {
      return {
        commitSha: pullResult.commitSha,
        changedFiles: pullResult.changedFiles,
        diverged: pullResult.diverged,
        dirty: pullResult.dirty,
        validRegistry: false,
        errors: pullResult.error ? [pullResult.error] : [],
        classified: [],
        enqueuedJobs: [],
        diagnostic: pullResult.error,
      };
    }

    const registry = await this.readRegistryAtCommit(repoDir, pullResult.commitSha, options);

    if (!registry.valid) {
      return {
        commitSha: pullResult.commitSha,
        changedFiles: pullResult.changedFiles,
        diverged: false,
        dirty: false,
        validRegistry: false,
        errors: registry.errors,
        classified: [],
        enqueuedJobs: [],
        diagnostic: `Registry validation failed with ${registry.errors.length} error(s)`,
      };
    }

    const classified = classifySources(registry.sources, syncLedger, options);
    const jobInputs = generateJobRecords(classified, pullResult.commitSha, options);
    const enqueuedJobs = await jobQueue.enqueueJobs(jobInputs);

    return {
      commitSha: pullResult.commitSha,
      changedFiles: pullResult.changedFiles,
      diverged: false,
      dirty: false,
      validRegistry: true,
      errors: [],
      classified,
      enqueuedJobs,
    };
  }
}
