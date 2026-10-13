/**
 * feedback.ts — Project-local Knowledge Feedback Service.
 *
 * Implements FeedbackPort and project-level knowledge overlay:
 * - Stores user decisions ('accepted' | 'dismissed' | 'deferred' | 'excluded')
 *   and reasons in `<projectRoot>/.harness/knowledge-overlay.json`.
 * - AC-4 Project Isolation: feedback is strictly local to `.harness/` of each project.
 *   Never uploaded or shared to Git source registry or R2 snapshot storage.
 * - Multi-project isolation: Project A and Project B maintain independent overlays.
 * - Non-destructive and atomic file operations with cancellation and timeout handling.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { randomBytes } from "node:crypto";

import {
  withPortTimeout,
  KnowledgeError,
  CancellationError,
  TimeoutError,
  type FeedbackPort,
  type IdeaFeedback,
  type PortOptions,
} from "./contracts.ts";

// ============================================================================
// Types & Constants
// ============================================================================

export type FeedbackStatus = "accepted" | "dismissed" | "deferred" | "excluded";

export interface ProjectOverlayRecord {
  status: FeedbackStatus;
  reason?: string;
  updated_at: string;
}

export type ProjectOverlay = Record<string, ProjectOverlayRecord>;

export const OVERLAY_FILE_NAME = "knowledge-overlay.json";
export const HARNESS_DIR_NAME = ".harness";

// ============================================================================
// Helpers
// ============================================================================

export function getOverlayFilePath(projectRoot: string): string {
  const absRoot = resolve(projectRoot);
  return join(absRoot, HARNESS_DIR_NAME, OVERLAY_FILE_NAME);
}

function parseOverlayFile(filePath: string): ProjectOverlay {
  if (!existsSync(filePath)) {
    return {};
  }

  try {
    const raw = readFileSync(filePath, "utf8");
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    const overlay: ProjectOverlay = {};
    for (const [key, val] of Object.entries(parsed)) {
      if (val && typeof val === "object" && !Array.isArray(val)) {
        const item = val as Record<string, unknown>;
        const validStatuses: FeedbackStatus[] = ["accepted", "dismissed", "deferred", "excluded"];
        if (typeof item.status === "string" && validStatuses.includes(item.status as FeedbackStatus)) {
          overlay[key] = {
            status: item.status as FeedbackStatus,
            reason: typeof item.reason === "string" ? item.reason : undefined,
            updated_at: typeof item.updated_at === "string" ? item.updated_at : new Date().toISOString(),
          };
        }
      }
    }
    return overlay;
  } catch {
    // Return empty on JSON syntax error or read failure
    return {};
  }
}

function writeOverlayFileAtomic(filePath: string, overlay: ProjectOverlay): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const tmpPath = join(
    dir,
    `.${OVERLAY_FILE_NAME}.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}.tmp`,
  );

  const payload = JSON.stringify(overlay, null, 2);

  try {
    writeFileSync(tmpPath, payload, "utf8");
    renameSync(tmpPath, filePath);
  } catch (err) {
    if (existsSync(tmpPath)) {
      try {
        unlinkSync(tmpPath);
      } catch {
        // Ignore unlink error
      }
    }
    throw new KnowledgeError(
      "STORAGE_ERROR",
      `Failed to write knowledge overlay file at ${filePath}: ${String(err)}`,
      { filePath, cause: String(err) },
    );
  }
}

// ============================================================================
// Service Implementation
// ============================================================================

export class FeedbackService implements FeedbackPort {
  /**
   * Records feedback for a candidate source or capability.
   *
   * Overload 1 (Project-aware signature):
   * recordFeedback(projectRoot, sourceId, status, reason?, options?)
   *
   * Overload 2 (FeedbackPort standard signature):
   * recordFeedback(feedback, options?)
   */
  async recordFeedback(
    feedback: IdeaFeedback,
    options?: PortOptions,
  ): Promise<void>;
  async recordFeedback(
    projectRoot: string,
    sourceId: string,
    status: FeedbackStatus,
    reason?: string,
    options?: PortOptions,
  ): Promise<void>;
  async recordFeedback(
    first: string | IdeaFeedback,
    second?: string | PortOptions,
    third?: FeedbackStatus,
    fourth?: string,
    fifth?: PortOptions,
  ): Promise<void> {
    if (typeof first === "object" && first !== null) {
      // Called with (feedback: IdeaFeedback, options?: PortOptions)
      const fb = first as IdeaFeedback;
      const opts = (second as PortOptions) || {};
      const projectRoot = fb.project_name ? resolve(fb.project_name) : process.cwd();
      const statusMap: Record<"adopt" | "hold" | "reject", FeedbackStatus> = {
        adopt: "accepted",
        hold: "deferred",
        reject: "dismissed",
      };
      const status: FeedbackStatus = statusMap[fb.decision] || "deferred";
      return this.recordFeedbackInternal(projectRoot, fb.capability_name, status, fb.reason, opts);
    }

    // Called with (projectRoot, sourceId, status, reason?, options?)
    const projectRoot = String(first);
    const sourceId = String(second ?? "");
    const status = third as FeedbackStatus;
    const reason = typeof fourth === "string" ? fourth : undefined;
    const opts = (fifth || (typeof fourth === "object" ? fourth : undefined)) as PortOptions | undefined;

    return this.recordFeedbackInternal(projectRoot, sourceId, status, reason, opts);
  }

  private async recordFeedbackInternal(
    projectRoot: string,
    sourceId: string,
    status: FeedbackStatus,
    reason?: string,
    options?: PortOptions,
  ): Promise<void> {
    const validStatuses: FeedbackStatus[] = ["accepted", "dismissed", "deferred", "excluded"];
    if (!validStatuses.includes(status)) {
      throw new KnowledgeError("UNKNOWN_ERROR", `Invalid feedback status: ${status}`, { status });
    }

    if (!sourceId || !sourceId.trim()) {
      throw new KnowledgeError("UNKNOWN_ERROR", "Missing or empty sourceId for feedback");
    }

    return await withPortTimeout(async (signal) => {
      if (signal.aborted) {
        throw new CancellationError("OPERATION_CANCELLED", "Operation cancelled before recording feedback");
      }

      const filePath = getOverlayFilePath(projectRoot);
      const overlay = parseOverlayFile(filePath);

      overlay[sourceId.trim()] = {
        status,
        reason: reason?.trim() || undefined,
        updated_at: new Date().toISOString(),
      };

      if (signal.aborted) {
        throw new CancellationError("OPERATION_CANCELLED", "Operation cancelled while recording feedback");
      }

      writeOverlayFileAtomic(filePath, overlay);
    }, options);
  }

  /**
   * Retrieves the overlay records for a specific project.
   */
  async getProjectOverlay(
    projectRoot: string,
    options?: PortOptions,
  ): Promise<ProjectOverlay> {
    return await withPortTimeout(async (signal) => {
      if (signal.aborted) {
        throw new CancellationError("OPERATION_CANCELLED", "Operation cancelled before reading overlay");
      }

      const filePath = getOverlayFilePath(projectRoot);
      return parseOverlayFile(filePath);
    }, options);
  }

  /**
   * Implements FeedbackPort.getFeedback().
   * Reads the current working directory's overlay and converts to IdeaFeedback[].
   */
  async getFeedback(options?: PortOptions): Promise<IdeaFeedback[]> {
    return await withPortTimeout(async (signal) => {
      if (signal.aborted) {
        throw new CancellationError("OPERATION_CANCELLED", "Operation cancelled before listing feedback");
      }

      const overlay = await this.getProjectOverlay(process.cwd(), options);
      const list: IdeaFeedback[] = [];

      for (const [key, rec] of Object.entries(overlay)) {
        let decision: "adopt" | "hold" | "reject" = "hold";
        if (rec.status === "accepted") decision = "adopt";
        else if (rec.status === "dismissed" || rec.status === "excluded") decision = "reject";

        list.push({
          capability_name: key,
          decision,
          reason: rec.reason || `Marked as ${rec.status}`,
          timestamp: rec.updated_at,
          project_name: process.cwd(),
        });
      }

      return list;
    }, options);
  }

  /**
   * Clears or removes the knowledge overlay for a specific project.
   */
  async clearProjectOverlay(
    projectRoot: string,
    options?: PortOptions,
  ): Promise<void> {
    return await withPortTimeout(async (signal) => {
      if (signal.aborted) {
        throw new CancellationError("OPERATION_CANCELLED", "Operation cancelled before clearing overlay");
      }

      const filePath = getOverlayFilePath(projectRoot);
      if (existsSync(filePath)) {
        try {
          unlinkSync(filePath);
        } catch {
          // Fallback to writing empty object
          writeOverlayFileAtomic(filePath, {});
        }
      }
    }, options);
  }
}

// ============================================================================
// Singletons & Filter Utility Functions
// ============================================================================

export const feedbackService = new FeedbackService();

export async function recordFeedback(
  projectRoot: string,
  sourceId: string,
  status: FeedbackStatus,
  reason?: string,
  options?: PortOptions,
): Promise<void> {
  return feedbackService.recordFeedback(projectRoot, sourceId, status, reason, options);
}

export async function getProjectOverlay(
  projectRoot: string,
  options?: PortOptions,
): Promise<ProjectOverlay> {
  return feedbackService.getProjectOverlay(projectRoot, options);
}

export async function clearProjectOverlay(
  projectRoot: string,
  options?: PortOptions,
): Promise<void> {
  return feedbackService.clearProjectOverlay(projectRoot, options);
}

/**
 * Checks if a candidate sourceId or capability is dismissed or excluded in the overlay.
 */
export function isSourceExcludedOrDismissed(
  overlay: ProjectOverlay,
  sourceId: string,
): boolean {
  if (!overlay || !sourceId) return false;
  const entry = overlay[sourceId];
  if (!entry) return false;
  return entry.status === "dismissed" || entry.status === "excluded";
}

/**
 * Checks if a candidate sourceId or capability is strictly excluded in the overlay.
 */
export function isSourceExcluded(
  overlay: ProjectOverlay,
  sourceId: string,
): boolean {
  if (!overlay || !sourceId) return false;
  return overlay[sourceId]?.status === "excluded";
}

/**
 * Checks if a candidate sourceId or capability is accepted in the overlay.
 */
export function isSourceAccepted(
  overlay: ProjectOverlay,
  sourceId: string,
): boolean {
  if (!overlay || !sourceId) return false;
  return overlay[sourceId]?.status === "accepted";
}
