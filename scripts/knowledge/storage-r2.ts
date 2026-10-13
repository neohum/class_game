/**
 * storage-r2.ts — Cloudflare R2 / S3-compatible ObjectStore adapter.
 *
 * Implements ObjectStorePort backed by private Cloudflare R2.
 * Uses guarded dynamic import for @aws-sdk/client-s3 to preserve
 * zero runtime dependencies in the base harness.
 * Credentials and endpoints are never leaked to logs or error messages.
 */

import { StorageError, type PortOptions } from "./contracts.ts";
import {
  type ObjectStorePort,
  validateStorageKey,
  computeEtag,
  normalizeEtag,
} from "./storage.ts";

// ============================================================================
// Configuration & Types
// ============================================================================

export interface R2StorageConfig {
  bucket?: string;
  accountId?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  endpoint?: string;
  /** Injected S3 client instance for testing without external packages */
  client?: any;
}

// ============================================================================
// Redaction & Error Helpers
// ============================================================================

/**
 * Scrubs credentials, access keys, authorization headers, and secrets from text.
 */
export function redactSecrets(text: string, secrets: Array<string | undefined>): string {
  let result = text;
  for (const secret of secrets) {
    if (secret && typeof secret === "string" && secret.length >= 4) {
      result = result.split(secret).join("[REDACTED]");
    }
  }
  return result
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|rk|pk|ghp|github_pat)[-_][-A-Za-z0-9_]{6,}\b/g, "[REDACTED_TOKEN]")
    .replace(
      /(access[_-]?key[_-]?id|secret[_-]?access[_-]?key|password|secret|token)\s*[:=]\s*["']?[^"'\s&,]+["']?/gi,
      "$1=[REDACTED]",
    );
}

function isPreconditionFailed(err: any): boolean {
  if (!err) return false;
  return (
    err.name === "PreconditionFailed" ||
    err.name === "AtLeastOneConditionFailed" ||
    err.code === "PreconditionFailed" ||
    err.$metadata?.httpStatusCode === 412 ||
    (typeof err.message === "string" && err.message.toLowerCase().includes("precondition failed"))
  );
}

async function streamToBuffer(body: any): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (typeof body.transformToByteArray === "function") {
    const bytes = await body.transformToByteArray();
    return Buffer.from(bytes);
  }
  if (typeof body[Symbol.asyncIterator] === "function") {
    const chunks: Buffer[] = [];
    for await (const chunk of body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  if (typeof body === "string") {
    return Buffer.from(body, "utf-8");
  }
  return Buffer.from(body);
}

// ============================================================================
// Guarded Dynamic Import of @aws-sdk/client-s3
// ============================================================================

let cachedS3Module: any = null;

export async function loadS3Sdk(): Promise<any> {
  if (cachedS3Module) return cachedS3Module;
  try {
    cachedS3Module = await import("@aws-sdk/client-s3");
    return cachedS3Module;
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    if (
      error?.code === "ERR_MODULE_NOT_FOUND" ||
      error?.code === "MODULE_NOT_FOUND" ||
      error?.message?.includes("Cannot find package") ||
      error?.message?.includes("Cannot find module")
    ) {
      throw new StorageError(
        "ERR_SDK_MISSING" as any,
        "The optional package '@aws-sdk/client-s3' is required for R2 object storage. Please install it with: npm install @aws-sdk/client-s3@^3.700.0",
        { package: "@aws-sdk/client-s3" },
      );
    }
    throw err;
  }
}

async function createCommand(name: string, input: any): Promise<any> {
  try {
    const s3 = await loadS3Sdk();
    const CommandClass = s3[name];
    if (CommandClass) {
      return new CommandClass(input);
    }
  } catch (err: any) {
    if (err?.code === "ERR_SDK_MISSING") {
      // Return structured fallback command object for mock clients
      return { commandName: name, input, ...input };
    }
    throw err;
  }
  return { commandName: name, input, ...input };
}

// ============================================================================
// R2StorageAdapter
// ============================================================================

export class R2StorageAdapter implements ObjectStorePort {
  readonly bucket: string;
  readonly accountId?: string;
  readonly endpoint?: string;
  private readonly accessKeyId?: string;
  private readonly secretAccessKey?: string;
  private client: any | null = null;

  constructor(config?: R2StorageConfig) {
    this.bucket = config?.bucket || process.env.R2_BUCKET || process.env.CLOUDFLARE_R2_BUCKET || "";
    this.accountId = config?.accountId || process.env.R2_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID || undefined;
    this.accessKeyId = config?.accessKeyId || process.env.R2_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID || undefined;
    this.secretAccessKey =
      config?.secretAccessKey || process.env.R2_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY || undefined;

    this.endpoint =
      config?.endpoint ||
      process.env.R2_ENDPOINT ||
      (this.accountId ? `https://${this.accountId}.r2.cloudflarestorage.com` : undefined);

    if (config?.client) {
      this.client = config.client;
    }
  }

  private async getClient(): Promise<any> {
    if (this.client) return this.client;

    if (!this.bucket) {
      throw new StorageError("STORAGE_ERROR", "R2 bucket name is required");
    }
    if (!this.endpoint) {
      throw new StorageError("STORAGE_ERROR", "R2 endpoint or accountId is required");
    }
    if (!this.accessKeyId || !this.secretAccessKey) {
      throw new StorageError("STORAGE_ERROR", "R2 accessKeyId and secretAccessKey are required");
    }

    const s3 = await loadS3Sdk();
    this.client = new s3.S3Client({
      region: "auto",
      endpoint: this.endpoint,
      credentials: {
        accessKeyId: this.accessKeyId,
        secretAccessKey: this.secretAccessKey,
      },
    });

    return this.client;
  }

  private formatError(err: unknown, action: string, key?: string): StorageError {
    const sensitive = [this.secretAccessKey, this.accessKeyId, this.endpoint].filter(Boolean);
    const raw = err instanceof Error ? err.message : String(err);
    const scrubbed = redactSecrets(raw, sensitive);

    if (err instanceof StorageError) {
      return new StorageError(err.code, redactSecrets(err.message, sensitive), err.details);
    }

    return new StorageError("STORAGE_ERROR", `R2 ${action} failed: ${scrubbed}`, key ? { key } : undefined);
  }

  async putObject(
    key: string,
    data: Buffer | Uint8Array | string,
    options?: { contentType?: string; portOptions?: PortOptions },
  ): Promise<{ etag: string; size: number }> {
    validateStorageKey(key);
    if (options?.portOptions?.signal?.aborted) {
      throw new StorageError("OPERATION_CANCELLED", "Storage operation cancelled");
    }

    const client = await this.getClient();
    const body = typeof data === "string" ? Buffer.from(data, "utf-8") : Buffer.from(data);

    try {
      const cmd = await createCommand("PutObjectCommand", {
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: options?.contentType || "application/octet-stream",
      });

      const res = await client.send(cmd, { abortSignal: options?.portOptions?.signal });
      const rawEtag = res?.ETag || computeEtag(body);
      const etag = rawEtag.startsWith('"') ? rawEtag : `"${rawEtag}"`;

      return { etag, size: body.length };
    } catch (err: unknown) {
      throw this.formatError(err, "putObject", key);
    }
  }

  async getObject(
    key: string,
    options?: PortOptions,
  ): Promise<{ data: Buffer; etag: string; size: number; contentType?: string } | null> {
    validateStorageKey(key);
    if (options?.signal?.aborted) {
      throw new StorageError("OPERATION_CANCELLED", "Storage operation cancelled");
    }

    const client = await this.getClient();

    try {
      const cmd = await createCommand("GetObjectCommand", {
        Bucket: this.bucket,
        Key: key,
      });

      const res = await client.send(cmd, { abortSignal: options?.signal });
      const data = await streamToBuffer(res.Body);
      const rawEtag = res?.ETag || computeEtag(data);
      const etag = rawEtag.startsWith('"') ? rawEtag : `"${rawEtag}"`;

      return {
        data,
        etag,
        size: data.length,
        contentType: res.ContentType,
      };
    } catch (err: any) {
      if (err?.name === "NoSuchKey" || err?.name === "NotFound" || err?.$metadata?.httpStatusCode === 404) {
        return null;
      }
      throw this.formatError(err, "getObject", key);
    }
  }

  async headObject(
    key: string,
    options?: PortOptions,
  ): Promise<{ etag: string; size: number; contentType?: string; lastModified?: string } | null> {
    validateStorageKey(key);
    if (options?.signal?.aborted) {
      throw new StorageError("OPERATION_CANCELLED", "Storage operation cancelled");
    }

    const client = await this.getClient();

    try {
      const cmd = await createCommand("HeadObjectCommand", {
        Bucket: this.bucket,
        Key: key,
      });

      const res = await client.send(cmd, { abortSignal: options?.signal });
      const rawEtag = res?.ETag || "";
      const etag = rawEtag ? (rawEtag.startsWith('"') ? rawEtag : `"${rawEtag}"`) : "";

      return {
        etag,
        size: typeof res.ContentLength === "number" ? res.ContentLength : 0,
        contentType: res.ContentType,
        lastModified:
          res.LastModified instanceof Date
            ? res.LastModified.toISOString()
            : res.LastModified
              ? String(res.LastModified)
              : undefined,
      };
    } catch (err: any) {
      if (err?.name === "NotFound" || err?.name === "NoSuchKey" || err?.$metadata?.httpStatusCode === 404) {
        return null;
      }
      throw this.formatError(err, "headObject", key);
    }
  }

  async deleteObject(key: string, options?: PortOptions): Promise<boolean> {
    validateStorageKey(key);
    if (options?.signal?.aborted) {
      throw new StorageError("OPERATION_CANCELLED", "Storage operation cancelled");
    }

    const client = await this.getClient();

    try {
      const cmd = await createCommand("DeleteObjectCommand", {
        Bucket: this.bucket,
        Key: key,
      });

      await client.send(cmd, { abortSignal: options?.signal });
      return true;
    } catch (err: any) {
      if (err?.name === "NotFound" || err?.name === "NoSuchKey" || err?.$metadata?.httpStatusCode === 404) {
        return false;
      }
      throw this.formatError(err, "deleteObject", key);
    }
  }

  async listObjects(
    prefix: string,
    options?: PortOptions,
  ): Promise<Array<{ key: string; size: number; lastModified?: string }>> {
    validateStorageKey(prefix, true);
    if (options?.signal?.aborted) {
      throw new StorageError("OPERATION_CANCELLED", "Storage operation cancelled");
    }

    const client = await this.getClient();

    try {
      const cmd = await createCommand("ListObjectsV2Command", {
        Bucket: this.bucket,
        Prefix: prefix,
      });

      const res = await client.send(cmd, { abortSignal: options?.signal });
      const items = res?.Contents || [];

      return items.map((item: any) => ({
        key: item.Key || "",
        size: typeof item.Size === "number" ? item.Size : 0,
        lastModified:
          item.LastModified instanceof Date
            ? item.LastModified.toISOString()
            : item.LastModified
              ? String(item.LastModified)
              : undefined,
      }));
    } catch (err: unknown) {
      throw this.formatError(err, "listObjects", prefix);
    }
  }

  async compareAndSwapPointer(
    pointerKey: string,
    expectedEtag: string | null,
    newContent: string,
    options?: PortOptions,
  ): Promise<{ success: boolean; currentEtag: string }> {
    validateStorageKey(pointerKey);
    if (options?.signal?.aborted) {
      throw new StorageError("OPERATION_CANCELLED", "Storage operation cancelled");
    }

    const client = await this.getClient();
    const body = Buffer.from(newContent, "utf-8");

    // Case 1: Initial creation (expected to not exist)
    if (expectedEtag === null) {
      const current = await this.headObject(pointerKey, options);
      if (current !== null) {
        return { success: false, currentEtag: current.etag };
      }

      try {
        const cmd = await createCommand("PutObjectCommand", {
          Bucket: this.bucket,
          Key: pointerKey,
          Body: body,
          ContentType: "application/json",
          IfNoneMatch: "*",
        });

        const res = await client.send(cmd, { abortSignal: options?.signal });
        const rawEtag = res?.ETag || computeEtag(body);
        const etag = rawEtag.startsWith('"') ? rawEtag : `"${rawEtag}"`;

        return { success: true, currentEtag: etag };
      } catch (err: any) {
        if (isPreconditionFailed(err)) {
          const fresh = await this.headObject(pointerKey, options);
          return { success: false, currentEtag: fresh?.etag || "" };
        }
        throw this.formatError(err, "compareAndSwapPointer", pointerKey);
      }
    }

    // Case 2: Conditional update using S3 IfMatch
    const formattedEtag = expectedEtag.startsWith('"') ? expectedEtag : `"${expectedEtag}"`;

    try {
      const cmd = await createCommand("PutObjectCommand", {
        Bucket: this.bucket,
        Key: pointerKey,
        Body: body,
        ContentType: "application/json",
        IfMatch: formattedEtag,
      });

      const res = await client.send(cmd, { abortSignal: options?.signal });
      const rawEtag = res?.ETag || computeEtag(body);
      const etag = rawEtag.startsWith('"') ? rawEtag : `"${rawEtag}"`;

      return { success: true, currentEtag: etag };
    } catch (err: any) {
      if (isPreconditionFailed(err)) {
        const fresh = await this.headObject(pointerKey, options);
        return { success: false, currentEtag: fresh?.etag || "" };
      }
      throw this.formatError(err, "compareAndSwapPointer", pointerKey);
    }
  }
}
