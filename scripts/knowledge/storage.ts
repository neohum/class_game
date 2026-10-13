/**
 * storage.ts — Unified ObjectStore port and local filesystem adapter.
 *
 * Implements ObjectStorePort for local testing/fixtures and delegates
 * to R2StorageAdapter for production R2 cloud storage.
 * Enforces key boundaries under catalogs/<catalog_id>/... and rejects
 * path traversal attacks.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { StorageError, type PortOptions } from "./contracts.ts";
import { R2StorageAdapter, type R2StorageConfig } from "./storage-r2.ts";

// ============================================================================
// Configuration & Port Interface
// ============================================================================

export interface ObjectStoreConfig {
  type: "local" | "r2";
  localDir?: string;
  r2?: {
    bucket: string;
    accountId?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    endpoint?: string;
  };
}

export interface ObjectStorePort {
  putObject(
    key: string,
    data: Buffer | Uint8Array | string,
    options?: { contentType?: string; portOptions?: PortOptions },
  ): Promise<{ etag: string; size: number }>;

  getObject(
    key: string,
    options?: PortOptions,
  ): Promise<{ data: Buffer; etag: string; size: number; contentType?: string } | null>;

  headObject(
    key: string,
    options?: PortOptions,
  ): Promise<{ etag: string; size: number; contentType?: string; lastModified?: string } | null>;

  deleteObject(key: string, options?: PortOptions): Promise<boolean>;

  listObjects(
    prefix: string,
    options?: PortOptions,
  ): Promise<Array<{ key: string; size: number; lastModified?: string }>>;

  compareAndSwapPointer(
    pointerKey: string,
    expectedEtag: string | null,
    newContent: string,
    options?: PortOptions,
  ): Promise<{ success: boolean; currentEtag: string }>;
}

// ============================================================================
// Key Validation and ETag Utilities
// ============================================================================

/**
 * Validates that an object key or prefix is safe and conforms to the
 * `catalogs/<catalog_id>/...` hierarchy. Rejects path traversal, leading slashes,
 * consecutive slashes, backslashes, and Windows drive letters.
 */
export function validateStorageKey(key: string, isPrefix = false): void {
  if (typeof key !== "string" || key.trim() === "") {
    throw new StorageError("STORAGE_ERROR", "Key must be a non-empty string");
  }

  // Reject null bytes
  if (key.includes("\0")) {
    throw new StorageError("STORAGE_ERROR", `Key contains invalid null bytes: '${key}'`, { key });
  }

  // Reject leading slash
  if (key.startsWith("/")) {
    throw new StorageError("STORAGE_ERROR", `Key must not start with a leading slash: '${key}'`, { key });
  }

  // Reject backslashes
  if (key.includes("\\")) {
    throw new StorageError("STORAGE_ERROR", `Key must use forward slashes only: '${key}'`, { key });
  }

  // Reject consecutive slashes '//'
  if (key.includes("//")) {
    throw new StorageError("STORAGE_ERROR", `Key contains consecutive slashes '//': '${key}'`, { key });
  }

  // Reject Windows drive letters (e.g. C:) or absolute paths
  if (/^[a-zA-Z]:/.test(key) || path.isAbsolute(key)) {
    throw new StorageError("STORAGE_ERROR", `Absolute paths are disallowed: '${key}'`, { key });
  }

  // Check path segments for directory traversal
  const segments = key.split("/");
  for (const seg of segments) {
    if (seg === ".." || seg === ".") {
      throw new StorageError("STORAGE_ERROR", `Directory traversal segment '${seg}' disallowed in key: '${key}'`, {
        key,
      });
    }
  }

  // For prefixes: must start with 'catalogs' or 'catalogs/'
  if (isPrefix) {
    if (key !== "catalogs" && !key.startsWith("catalogs/")) {
      throw new StorageError("STORAGE_ERROR", `Prefix must begin with 'catalogs' or 'catalogs/': '${key}'`, { key });
    }
    return;
  }

  // For object keys: must strictly follow 'catalogs/<catalog_id>/<subpath>'
  if (!key.startsWith("catalogs/")) {
    throw new StorageError("STORAGE_ERROR", `Object key must begin with 'catalogs/<catalog_id>/': '${key}'`, { key });
  }

  if (segments.length < 3) {
    throw new StorageError(
      "STORAGE_ERROR",
      `Object key must specify a subpath under 'catalogs/<catalog_id>/': '${key}'`,
      { key },
    );
  }

  const catalogId = segments[1];
  if (!catalogId || !/^[a-zA-Z0-9_-]+$/.test(catalogId)) {
    throw new StorageError("STORAGE_ERROR", `Invalid catalog ID '${catalogId}' in key: '${key}'`, { key });
  }

  for (let i = 2; i < segments.length; i++) {
    const s = segments[i];
    if (!s || s.trim() === "") {
      throw new StorageError("STORAGE_ERROR", `Empty path segment in key: '${key}'`, { key });
    }
  }
}

/**
 * Computes an MD5 ETag wrapped in double quotes, standard for S3/R2 object storage.
 * Note: ETag is distinct from the SHA-256 integrity hash of snapshot manifests.
 */
export function computeEtag(data: Buffer | Uint8Array | string): string {
  const buf = typeof data === "string" ? Buffer.from(data, "utf-8") : Buffer.from(data);
  const hash = createHash("md5").update(buf).digest("hex");
  return `"${hash}"`;
}

/**
 * Normalizes an ETag by removing leading/trailing double quotes and whitespace.
 */
export function normalizeEtag(etag: string | null | undefined): string | null {
  if (!etag) return null;
  return etag.trim().replace(/^"|"$/g, "");
}

// ============================================================================
// Local Filesystem Adapter
// ============================================================================

export class LocalStorageAdapter implements ObjectStorePort {
  readonly baseDir: string;

  constructor(localDir?: string) {
    this.baseDir = path.resolve(localDir || path.join(process.cwd(), ".cache", "knowledge-storage"));
  }

  private resolvePath(key: string): string {
    const target = path.resolve(this.baseDir, key);
    if (!target.startsWith(this.baseDir + path.sep)) {
      throw new StorageError("STORAGE_ERROR", `Key escapes base storage directory: '${key}'`, { key });
    }
    return target;
  }

  private checkCancellation(options?: PortOptions): void {
    if (options?.signal?.aborted) {
      throw new StorageError("OPERATION_CANCELLED", "Storage operation was cancelled");
    }
  }

  async putObject(
    key: string,
    data: Buffer | Uint8Array | string,
    options?: { contentType?: string; portOptions?: PortOptions },
  ): Promise<{ etag: string; size: number }> {
    validateStorageKey(key);
    this.checkCancellation(options?.portOptions);

    const buffer = typeof data === "string" ? Buffer.from(data, "utf-8") : Buffer.from(data);
    const targetPath = this.resolvePath(key);
    const metaPath = `${targetPath}.meta.json`;
    const etag = computeEtag(buffer);

    await fs.mkdir(path.dirname(targetPath), { recursive: true });

    // Atomic write to prevent partial writes
    const tmpPath = `${targetPath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;
    await fs.writeFile(tmpPath, buffer);
    await fs.rename(tmpPath, targetPath);

    const meta = {
      etag,
      size: buffer.length,
      contentType: options?.contentType || "application/octet-stream",
      lastModified: new Date().toISOString(),
    };
    await fs.writeFile(metaPath, JSON.stringify(meta), "utf-8");

    return { etag, size: buffer.length };
  }

  async getObject(
    key: string,
    options?: PortOptions,
  ): Promise<{ data: Buffer; etag: string; size: number; contentType?: string } | null> {
    validateStorageKey(key);
    this.checkCancellation(options);

    const targetPath = this.resolvePath(key);
    const metaPath = `${targetPath}.meta.json`;

    try {
      const data = await fs.readFile(targetPath);
      let meta: { etag?: string; size?: number; contentType?: string } = {};

      try {
        const metaRaw = await fs.readFile(metaPath, "utf-8");
        meta = JSON.parse(metaRaw);
      } catch {
        meta.etag = computeEtag(data);
        meta.size = data.length;
        meta.contentType = "application/octet-stream";
      }

      return {
        data,
        etag: meta.etag || computeEtag(data),
        size: data.length,
        contentType: meta.contentType,
      };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        return null;
      }
      throw new StorageError(
        "STORAGE_ERROR",
        `Failed to read object '${key}': ${(err as Error).message}`,
        { key },
      );
    }
  }

  async headObject(
    key: string,
    options?: PortOptions,
  ): Promise<{ etag: string; size: number; contentType?: string; lastModified?: string } | null> {
    validateStorageKey(key);
    this.checkCancellation(options);

    const targetPath = this.resolvePath(key);
    const metaPath = `${targetPath}.meta.json`;

    try {
      const stat = await fs.stat(targetPath);
      let meta: { etag?: string; contentType?: string; lastModified?: string } = {};

      try {
        const metaRaw = await fs.readFile(metaPath, "utf-8");
        meta = JSON.parse(metaRaw);
      } catch {
        const data = await fs.readFile(targetPath);
        meta.etag = computeEtag(data);
        meta.contentType = "application/octet-stream";
        meta.lastModified = stat.mtime.toISOString();
      }

      return {
        etag: meta.etag || "",
        size: stat.size,
        contentType: meta.contentType,
        lastModified: meta.lastModified || stat.mtime.toISOString(),
      };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        return null;
      }
      throw new StorageError(
        "STORAGE_ERROR",
        `Failed to head object '${key}': ${(err as Error).message}`,
        { key },
      );
    }
  }

  async deleteObject(key: string, options?: PortOptions): Promise<boolean> {
    validateStorageKey(key);
    this.checkCancellation(options);

    const targetPath = this.resolvePath(key);
    const metaPath = `${targetPath}.meta.json`;

    try {
      await fs.unlink(targetPath);
      await fs.unlink(metaPath).catch(() => {});
      return true;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        return false;
      }
      throw new StorageError(
        "STORAGE_ERROR",
        `Failed to delete object '${key}': ${(err as Error).message}`,
        { key },
      );
    }
  }

  async listObjects(
    prefix: string,
    options?: PortOptions,
  ): Promise<Array<{ key: string; size: number; lastModified?: string }>> {
    validateStorageKey(prefix, true);
    this.checkCancellation(options);

    const filePaths: string[] = [];

    const walk = async (dir: string): Promise<void> => {
      let entries: import("node:fs").Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return;
        throw err;
      }

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.isFile()) {
          if (
            !entry.name.endsWith(".meta.json") &&
            !entry.name.includes(".tmp.") &&
            !entry.name.endsWith(".cas.lock")
          ) {
            filePaths.push(fullPath);
          }
        }
      }
    };

    await walk(this.baseDir);

    const matchedKeys = filePaths
      .map((fp) => path.relative(this.baseDir, fp).split(path.sep).join("/"))
      .filter((k) => k.startsWith(prefix))
      .sort((a, b) => a.localeCompare(b));

    const results: Array<{ key: string; size: number; lastModified?: string }> = [];
    for (const k of matchedKeys) {
      const head = await this.headObject(k, options);
      if (head) {
        results.push({
          key: k,
          size: head.size,
          lastModified: head.lastModified,
        });
      }
    }

    return results;
  }

  async compareAndSwapPointer(
    pointerKey: string,
    expectedEtag: string | null,
    newContent: string,
    options?: PortOptions,
  ): Promise<{ success: boolean; currentEtag: string }> {
    validateStorageKey(pointerKey);
    this.checkCancellation(options);

    const lockPath = path.resolve(this.baseDir, `${pointerKey}.cas.lock`);
    await fs.mkdir(path.dirname(lockPath), { recursive: true });

    // Acquire lock file atomically
    const start = Date.now();
    const timeout = options?.timeoutMs || 5000;
    let handle: fs.FileHandle | null = null;

    while (!handle) {
      this.checkCancellation(options);
      try {
        handle = await fs.open(lockPath, "wx");
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException)?.code === "EEXIST") {
          if (Date.now() - start > timeout) {
            throw new StorageError(
              "OPERATION_TIMEOUT",
              `Timeout acquiring CAS pointer lock for '${pointerKey}'`,
              { pointerKey },
            );
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        } else {
          throw err;
        }
      }
    }

    try {
      const current = await this.headObject(pointerKey, options);
      const normalizedExpected = normalizeEtag(expectedEtag);
      const normalizedCurrent = current ? normalizeEtag(current.etag) : null;

      if (normalizedExpected === null) {
        if (current !== null) {
          return { success: false, currentEtag: current.etag };
        }
      } else {
        if (current === null || normalizedCurrent !== normalizedExpected) {
          return { success: false, currentEtag: current?.etag || "" };
        }
      }

      const putResult = await this.putObject(pointerKey, newContent, {
        contentType: "application/json",
        portOptions: options,
      });

      return { success: true, currentEtag: putResult.etag };
    } finally {
      if (handle) {
        await handle.close().catch(() => {});
        await fs.unlink(lockPath).catch(() => {});
      }
    }
  }
}

// ============================================================================
// Factory Function
// ============================================================================

export function createObjectStore(config: ObjectStoreConfig): ObjectStorePort {
  if (config.type === "local") {
    return new LocalStorageAdapter(config.localDir);
  }
  if (config.type === "r2") {
    return new R2StorageAdapter(config.r2);
  }
  throw new StorageError("STORAGE_ERROR", `Unsupported storage type: ${(config as any).type}`);
}
