/**
 * catalog.ts — SQLite catalog service, single-writer locking, chunking,
 * deduplication diffing, and tombstone handling for the harness knowledge library.
 *
 * Implements CatalogPort with:
 * - Single writer transaction model with file lock (catalog.lock).
 * - Paragraph & heading aware chunking (~512 target tokens, 64 token overlap).
 * - Diffing & deduplication (AC-1):
 *   - Identical document content hash + matching model fingerprint skips embedding (0 calls).
 *   - Partially modified document only embeds chunks whose hash is not already indexed.
 * - Tombstone exclusion from active chunks and searches (AC-2).
 * - Multi-generation rotation detection (AC-3).
 * - Integrity checks verifying PRAGMA integrity_check, foreign keys, and FTS5.
 */

import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  type CatalogPort,
  type Chunk,
  type DocumentRevision,
  type EmbedderPort,
  type PortOptions,
  type CapabilityCandidate,
  type SourceSpec,
  StorageError,
  validateDocumentRevision,
  validateSourceSpec,
  withPortTimeout,
} from "./contracts.ts";
import {
  type CatalogMeta,
  openCatalogDatabase,
  initCatalogSchema,
  getCatalogMeta,
  verifyCatalogIntegrity,
  isVec0Available,
  createGenerationId,
  type IntegrityCheckResult,
} from "./migrations.ts";

// ============================================================================
// Service Options
// ============================================================================

export interface CatalogServiceOptions {
  dbPath?: string;
  db?: DatabaseSync;
  catalogId?: string;
  generation?: string;
  modelFingerprint?: string;
  embedder?: EmbedderPort;
  lockPath?: string;
  lockTimeoutMs?: number;
  lockLeaseMs?: number;
}

// ============================================================================
// File Lock (Single Writer)
// ============================================================================

export class CatalogLock {
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
        throw new StorageError(
          "OPERATION_CANCELLED",
          "Lock acquisition cancelled by signal",
        );
      }

      try {
        // Try atomic exclusive creation
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
            `Failed to open lock file '${this.lockPath}': ${err.message}`,
          );
        }

        // Lock file exists — check if stale
        try {
          const stats = fs.statSync(this.lockPath);
          const ageMs = Date.now() - stats.mtimeMs;
          if (ageMs > this.leaseMs) {
            // Reclaim expired lease
            try {
              fs.unlinkSync(this.lockPath);
            } catch {
              // lost race to unlink, retry in next loop
            }
          }
        } catch {
          // stats failed (e.g. unlinked between open and stat), retry
        }

        // Wait before retry
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
    }

    throw new StorageError(
      "STORAGE_ERROR",
      `Timed out after ${this.timeoutMs}ms waiting for catalog lock at ${this.lockPath}`,
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
// Chunking Algorithm
// ============================================================================

export interface ChunkingOptions {
  targetTokens?: number;
  overlapTokens?: number;
}

/**
 * Splits document text into paragraph and heading-aligned chunks of approximately
 * `targetTokens` tokens (default 512) with `overlapTokens` overlap (default 64).
 */
export function chunkDocument(
  doc: DocumentRevision,
  options: ChunkingOptions = {},
): Chunk[] {
  const text = doc.text;
  if (!text || !text.trim()) {
    return [];
  }

  const targetTokens = options.targetTokens ?? 512;
  const overlapTokens = options.overlapTokens ?? 64;

  // Approximate token count: 1 token ~ 3.5 characters
  const estimateTokens = (str: string) => Math.max(1, Math.ceil(str.length / 3.5));

  // Split text by lines while tracking headings and paragraph blocks
  const lines = text.split(/\r?\n/);
  interface Block {
    text: string;
    heading?: string;
    byteOffset: number;
    tokens: number;
  }

  const blocks: Block[] = [];
  let currentHeading: string | undefined;
  let currentBlockLines: string[] = [];
  let currentBlockOffset = 0;
  let runningOffset = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineBytes = Buffer.byteLength(line, "utf8") + 1; // +1 for newline

    // Check heading
    const headingMatch = /^#{1,6}\s+(.*)$/.exec(line.trim());
    if (headingMatch) {
      // Flush previous block if any
      if (currentBlockLines.length > 0) {
        const blkText = currentBlockLines.join("\n").trim();
        if (blkText) {
          blocks.push({
            text: blkText,
            heading: currentHeading,
            byteOffset: currentBlockOffset,
            tokens: estimateTokens(blkText),
          });
        }
        currentBlockLines = [];
      }
      currentHeading = headingMatch[1]?.trim();
      currentBlockOffset = runningOffset;
      currentBlockLines.push(line);
      runningOffset += lineBytes;
      continue;
    }

    if (line.trim() === "") {
      // Paragraph boundary
      if (currentBlockLines.length > 0) {
        const blkText = currentBlockLines.join("\n").trim();
        if (blkText) {
          blocks.push({
            text: blkText,
            heading: currentHeading,
            byteOffset: currentBlockOffset,
            tokens: estimateTokens(blkText),
          });
        }
        currentBlockLines = [];
      }
    } else {
      if (currentBlockLines.length === 0) {
        currentBlockOffset = runningOffset;
      }
      currentBlockLines.push(line);
    }

    runningOffset += lineBytes;
  }

  // Flush remaining block
  if (currentBlockLines.length > 0) {
    const blkText = currentBlockLines.join("\n").trim();
    if (blkText) {
      blocks.push({
        text: blkText,
        heading: currentHeading,
        byteOffset: currentBlockOffset,
        tokens: estimateTokens(blkText),
      });
    }
  }

  if (blocks.length === 0) {
    return [];
  }

  // Group blocks into chunks of ~targetTokens
  const chunks: Chunk[] = [];
  let chunkBuffer: Block[] = [];
  let currentTokens = 0;

  const emitChunk = () => {
    if (chunkBuffer.length === 0) return;
    const firstBlock = chunkBuffer[0]!;
    const lastBlock = chunkBuffer[chunkBuffer.length - 1]!;
    const chunkText = chunkBuffer.map((b) => b.text).join("\n\n");
    const heading = chunkBuffer.find((b) => b.heading)?.heading;
    const byteOffset = firstBlock.byteOffset;
    const tokenEstimate = estimateTokens(chunkText);
    const hash = createHash("sha256").update(chunkText).digest("hex");
    const chunkId = createHash("sha256")
      .update(`${doc.document_id}:${chunks.length}:${hash}`)
      .digest("hex");

    chunks.push({
      chunk_id: chunkId,
      document_id: doc.document_id,
      source_id: doc.source_id,
      text: chunkText,
      heading,
      byte_offset: byteOffset,
      token_estimate: tokenEstimate,
      hash,
    });

    // Handle overlap: retain trailing blocks totaling ~overlapTokens
    let overlapCount = 0;
    let overlapTokensAcc = 0;
    for (let j = chunkBuffer.length - 1; j >= 0; j--) {
      overlapTokensAcc += chunkBuffer[j]!.tokens;
      overlapCount++;
      if (overlapTokensAcc >= overlapTokens) break;
    }

    chunkBuffer = chunkBuffer.slice(chunkBuffer.length - overlapCount);
    currentTokens = chunkBuffer.reduce((sum, b) => sum + b.tokens, 0);
  };

  for (const block of blocks) {
    if (currentTokens + block.tokens > targetTokens && chunkBuffer.length > 0) {
      emitChunk();
    }
    chunkBuffer.push(block);
    currentTokens += block.tokens;
  }

  if (chunkBuffer.length > 0) {
    // Emit last chunk
    const firstBlock = chunkBuffer[0]!;
    const chunkText = chunkBuffer.map((b) => b.text).join("\n\n");
    const heading = chunkBuffer.find((b) => b.heading)?.heading;
    const byteOffset = firstBlock.byteOffset;
    const tokenEstimate = estimateTokens(chunkText);
    const hash = createHash("sha256").update(chunkText).digest("hex");
    const chunkId = createHash("sha256")
      .update(`${doc.document_id}:${chunks.length}:${hash}`)
      .digest("hex");

    chunks.push({
      chunk_id: chunkId,
      document_id: doc.document_id,
      source_id: doc.source_id,
      text: chunkText,
      heading,
      byte_offset: byteOffset,
      token_estimate: tokenEstimate,
      hash,
    });
  }

  return chunks;
}

// ============================================================================
// Vector Helper Functions
// ============================================================================

export function vectorToBlob(vec: Float32Array | number[] | Buffer): Buffer {
  if (Buffer.isBuffer(vec)) return vec;
  if (vec instanceof Float32Array) {
    return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
  }
  const f32 = new Float32Array(vec);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

export function blobToVector(blob: Buffer | Uint8Array): Float32Array {
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

// ============================================================================
// CatalogService Implementation
// ============================================================================

export class CatalogService implements CatalogPort {
  private db: DatabaseSync;
  private readonly dbPath: string;
  private readonly lockPath?: string;
  private readonly lockTimeoutMs: number;
  private readonly lockLeaseMs: number;
  private embedder?: EmbedderPort;
  private meta: CatalogMeta;
  private ownsDb: boolean = false;

  constructor(options: CatalogServiceOptions = {}) {
    this.dbPath = options.dbPath ?? ":memory:";
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5000;
    this.lockLeaseMs = options.lockLeaseMs ?? 30000;
    this.embedder = options.embedder;

    if (this.dbPath !== ":memory:") {
      this.lockPath =
        options.lockPath ?? path.join(path.dirname(this.dbPath), "catalog.lock");
    }

    if (options.db) {
      this.db = options.db;
      this.ownsDb = false;
    } else {
      this.db = openCatalogDatabase(this.dbPath);
      this.ownsDb = true;
    }

    const catalogId = options.catalogId ?? "default_catalog";
    const generation = options.generation ?? createGenerationId();
    const modelFingerprint = (
      options.modelFingerprint ??
      "0000000000000000000000000000000000000000000000000000000000000000"
    ).toLowerCase();

    const initResult = initCatalogSchema(this.db, {
      catalog_id: catalogId,
      generation,
      model_fingerprint: modelFingerprint,
    });

    this.meta = initResult.meta;
  }

  /**
   * Returns the underlying SQLite database connection.
   */
  getDatabase(): DatabaseSync {
    return this.db;
  }

  /**
   * Sets or updates the embedder used for on-demand chunk embedding.
   */
  setEmbedder(embedder: EmbedderPort): void {
    this.embedder = embedder;
  }

  /**
   * Executes an action inside a file lock and immediate transaction.
   */
  private async withWriterTransaction<T>(
    signal: AbortSignal | undefined,
    action: () => Promise<T> | T,
  ): Promise<T> {
    let lock: CatalogLock | undefined;
    if (this.lockPath) {
      lock = new CatalogLock(this.lockPath, this.lockTimeoutMs, this.lockLeaseMs);
      await lock.acquire(signal);
    }

    try {
      this.db.exec("BEGIN IMMEDIATE;");
      try {
        const result = await action();
        this.db.exec("COMMIT;");
        return result;
      } catch (err) {
        try {
          this.db.exec("ROLLBACK;");
        } catch {
          // ignore rollback error
        }
        throw err;
      }
    } finally {
      if (lock) {
        lock.release();
      }
    }
  }

  /**
   * Ingests or updates a source specification in kl_sources.
   */
  async ingestSource(spec: SourceSpec, options?: PortOptions): Promise<void> {
    const validated = validateSourceSpec(spec);

    await withPortTimeout(
      async (signal) => {
        await this.withWriterTransaction(signal, () => {
          const stmt = this.db.prepare(`
            INSERT OR REPLACE INTO kl_sources (
              source_id, kind, url, title, tags, note, enabled, refresh_hours, provenance, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);

          stmt.run(
            validated.source_id,
            validated.kind,
            validated.url,
            validated.title ?? null,
            JSON.stringify(validated.tags),
            validated.note ?? null,
            validated.enabled ? 1 : 0,
            validated.refresh_hours,
            validated.provenance,
            validated.created_at,
            validated.updated_at,
          );
        });
      },
      options,
    );
  }

  /**
   * Ingests a document revision and its chunks with deduplication and diffing.
   *
   * AC-1 rules:
   * - If document content_hash is unchanged and model fingerprint matches:
   *   skip embedding entirely (0 embedding calls!).
   * - If partially modified: only call embedder on chunks whose hash is not
   *   already in kl_embeddings for the active model fingerprint!
   */
  async upsertDocument(
    doc: DocumentRevision,
    chunks?: Chunk[],
    vectors?: Array<Float32Array | number[]>,
    options?: PortOptions & {
      capabilities?: CapabilityCandidate[];
    },
  ): Promise<{ documentId: string; chunksUpserted: number }> {
    const validatedDoc = validateDocumentRevision(doc);

    return await withPortTimeout(
      async (signal) => {
        return await this.withWriterTransaction(signal, async () => {
          // 1. Ensure source exists in kl_sources (insert minimal record if missing)
          const sourceExists = this.db
            .prepare("SELECT 1 FROM kl_sources WHERE source_id = ?")
            .get(validatedDoc.source_id);

          if (!sourceExists) {
            const now = new Date().toISOString();
            this.db
              .prepare(`
                INSERT INTO kl_sources (
                  source_id, kind, url, title, tags, note, enabled, refresh_hours, provenance, created_at, updated_at
                ) VALUES (?, 'web', ?, ?, '[]', NULL, 1, 24.0, 'manual', ?, ?)
              `)
              .run(validatedDoc.source_id, validatedDoc.url, validatedDoc.title ?? null, now, now);
          }

          // 2. Check existing document record
          const existingDoc = this.db
            .prepare("SELECT content_hash, status FROM kl_documents WHERE document_id = ?")
            .get(validatedDoc.document_id) as
            | { content_hash?: string; status?: string }
            | undefined;

          const activeFingerprint = this.meta.model_fingerprint.toLowerCase();

          // 3. Diff check: If document content_hash is identical and already indexed:
          if (
            existingDoc &&
            existingDoc.content_hash === validatedDoc.content_hash &&
            existingDoc.status !== "tombstone"
          ) {
            // Verify chunks exist and are embedded
            const existingChunkCount = (
              this.db
                .prepare("SELECT COUNT(*) as count FROM kl_chunks WHERE document_id = ?")
                .get(validatedDoc.document_id) as { count?: number }
            )?.count ?? 0;

            if (existingChunkCount > 0) {
              // Check if embeddings exist for this fingerprint
              const embeddedCount = (
                this.db
                  .prepare(`
                    SELECT COUNT(*) as count
                    FROM kl_embeddings e
                    JOIN kl_chunks c ON e.chunk_id = c.chunk_id
                    WHERE c.document_id = ? AND e.model_fingerprint = ?
                  `)
                  .get(validatedDoc.document_id, activeFingerprint) as { count?: number }
              )?.count ?? 0;

              if (embeddedCount === existingChunkCount) {
                // Completely unchanged — skip embedding completely (0 calls)
                // Just update status/fetched_at if changed
                this.db
                  .prepare(`
                    UPDATE kl_documents
                    SET status = ?, fetched_at = ?, title = ?, license = ?, error = ?
                    WHERE document_id = ?
                  `)
                  .run(
                    validatedDoc.status,
                    validatedDoc.fetched_at,
                    validatedDoc.title ?? null,
                    validatedDoc.license ?? null,
                    validatedDoc.error ?? null,
                    validatedDoc.document_id,
                  );

                return {
                  documentId: validatedDoc.document_id,
                  chunksUpserted: 0,
                };
              }
            }
          }

          // 4. Resolve chunks (auto-chunk if not supplied or empty)
          const finalChunks: Chunk[] =
            chunks && chunks.length > 0
              ? chunks
              : chunkDocument(validatedDoc);

          // 5. Deduplication & Vector Resolution (AC-1)
          const resolvedVectors: Buffer[] = [];
          const missingChunksIndices: number[] = [];
          const missingTexts: string[] = [];

          if (vectors && vectors.length === finalChunks.length) {
            for (let i = 0; i < finalChunks.length; i++) {
              resolvedVectors[i] = vectorToBlob(vectors[i]!);
            }
          } else {
            // Check existing embeddings by chunk hash for the active model fingerprint
            const findEmbeddingStmt = this.db.prepare(`
              SELECT e.vector, e.dimensions
              FROM kl_embeddings e
              JOIN kl_chunks c ON e.chunk_id = c.chunk_id
              WHERE c.hash = ? AND e.model_fingerprint = ?
              LIMIT 1
            `);

            for (let i = 0; i < finalChunks.length; i++) {
              const chunk = finalChunks[i]!;
              const match = findEmbeddingStmt.get(chunk.hash, activeFingerprint) as
                | { vector?: Buffer; dimensions?: number }
                | undefined;

              if (match && match.vector) {
                resolvedVectors[i] = match.vector;
              } else {
                missingChunksIndices.push(i);
                missingTexts.push(chunk.text);
              }
            }

            // Only call embedder for chunks whose hash is NOT already in kl_embeddings!
            if (missingTexts.length > 0) {
              if (!this.embedder) {
                // If no embedder provided, generate mock zero vectors or fail
                // For safe fallback when no embedder configured, generate 1024-dim zero vectors
                const zeroBuf = Buffer.alloc(1024 * 4);
                for (const idx of missingChunksIndices) {
                  resolvedVectors[idx] = zeroBuf;
                }
              } else {
                // Call embedBatch on ONLY the missing chunks
                const generated = await this.embedder.embedBatch(missingTexts, {
                  signal,
                });

                if (generated.length !== missingTexts.length) {
                  throw new StorageError(
                    "STORAGE_ERROR",
                    `Embedder returned ${generated.length} vectors for ${missingTexts.length} chunks`,
                  );
                }

                for (let k = 0; k < missingChunksIndices.length; k++) {
                  const chunkIdx = missingChunksIndices[k]!;
                  const rawVec = generated[k]!;
                  resolvedVectors[chunkIdx] = vectorToBlob(rawVec);
                }
              }
            }
          }

          // 6. Delete old chunks for this document (cascades to embeddings and triggers FTS delete)
          this.db
            .prepare("DELETE FROM kl_chunks WHERE document_id = ?")
            .run(validatedDoc.document_id);

          // 7. Upsert document record
          this.db
            .prepare(`
              INSERT OR REPLACE INTO kl_documents (
                document_id, source_id, url, revision, content_hash, title, text, license, fetched_at, status, error
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `)
            .run(
              validatedDoc.document_id,
              validatedDoc.source_id,
              validatedDoc.url,
              validatedDoc.revision,
              validatedDoc.content_hash,
              validatedDoc.title ?? null,
              validatedDoc.text,
              validatedDoc.license ?? null,
              validatedDoc.fetched_at,
              validatedDoc.status,
              validatedDoc.error ?? null,
            );

          // 8. Insert chunks (triggers automatically populate kl_chunks_fts)
          const insertChunkStmt = this.db.prepare(`
            INSERT INTO kl_chunks (
              chunk_id, document_id, source_id, text, heading, byte_offset, token_estimate, hash
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `);

          const insertEmbeddingStmt = this.db.prepare(`
            INSERT OR REPLACE INTO kl_embeddings (
              chunk_id, model_fingerprint, vector, dimensions, created_at
            ) VALUES (?, ?, ?, ?, ?)
          `);

          const now = new Date().toISOString();
          const hasVec0 = isVec0Available(this.db);
          let insertVec0Stmt;
          if (hasVec0) {
            try {
              insertVec0Stmt = this.db.prepare(
                "INSERT OR REPLACE INTO kl_chunks_vec(chunk_id, vector) VALUES (?, ?)",
              );
            } catch {
              // ignore
            }
          }

          for (let i = 0; i < finalChunks.length; i++) {
            const chunk = finalChunks[i]!;
            const vecBlob = resolvedVectors[i]!;
            const dims = vecBlob.byteLength / 4;

            insertChunkStmt.run(
              chunk.chunk_id,
              chunk.document_id,
              chunk.source_id,
              chunk.text,
              chunk.heading ?? null,
              chunk.byte_offset,
              chunk.token_estimate,
              chunk.hash,
            );

            insertEmbeddingStmt.run(
              chunk.chunk_id,
              activeFingerprint,
              vecBlob,
              dims,
              now,
            );

            if (insertVec0Stmt) {
              try {
                insertVec0Stmt.run(chunk.chunk_id, vecBlob);
              } catch {
                // ignore vec0 errors
              }
            }
          }

          // 9. Optional capabilities
          if (options?.capabilities && options.capabilities.length > 0) {
            const insertCapStmt = this.db.prepare(`
              INSERT INTO kl_capabilities (
                capability_name, integration_type, description, evidence_quote, evidence_chunk_id
              ) VALUES (?, ?, ?, ?, ?)
            `);

            for (const cap of options.capabilities) {
              insertCapStmt.run(
                cap.capability_name,
                cap.integration_type,
                cap.description ?? null,
                cap.evidence_quote ?? null,
                cap.evidence_chunk_id ?? null,
              );
            }
          }

          return {
            documentId: validatedDoc.document_id,
            chunksUpserted: finalChunks.length,
          };
        });
      },
      options,
    );
  }

  /**
   * Marks a document as tombstone and removes its chunks from active search index.
   * Satisfies AC-2.
   */
  async tombstoneDocument(documentId: string, options?: PortOptions): Promise<void> {
    await withPortTimeout(
      async (signal) => {
        await this.withWriterTransaction(signal, () => {
          // Set status = 'tombstone' in kl_documents
          this.db
            .prepare(`
              UPDATE kl_documents
              SET status = 'tombstone', error = NULL
              WHERE document_id = ? OR source_id = ?
            `)
            .run(documentId, documentId);

          // Delete chunks for this document (triggers clean up kl_chunks_fts and cascade cleans embeddings)
          this.db
            .prepare("DELETE FROM kl_chunks WHERE document_id = ? OR source_id = ?")
            .run(documentId, documentId);

          // Mark source disabled in kl_sources if matching source_id
          this.db
            .prepare("UPDATE kl_sources SET enabled = 0 WHERE source_id = ?")
            .run(documentId);

          // If vec0 exists, clean up orphaned entries
          if (isVec0Available(this.db)) {
            try {
              this.db.exec(`
                DELETE FROM kl_chunks_vec
                WHERE chunk_id NOT IN (SELECT chunk_id FROM kl_chunks)
              `);
            } catch {
              // ignore
            }
          }
        });
      },
      options,
    );
  }

  /**
   * Returns the current catalog generation identifier.
   */
  async getGeneration(options?: PortOptions): Promise<string> {
    return await withPortTimeout(async () => {
      const meta = getCatalogMeta(this.db);
      if (meta) {
        this.meta = meta;
        return meta.generation;
      }
      return this.meta.generation;
    }, options);
  }

  /**
   * Rotates generation when schema or model fingerprint changes (AC-3).
   */
  rotateGeneration(newGeneration?: string): string {
    const gen = newGeneration ?? createGenerationId();
    this.db
      .prepare("UPDATE kl_meta SET generation = ? WHERE catalog_id = ?")
      .run(gen, this.meta.catalog_id);
    this.meta.generation = gen;
    return gen;
  }

  /**
   * Retrieves a document by documentId.
   */
  async getDocument(documentId: string): Promise<DocumentRevision | null> {
    const row = this.db
      .prepare(`
        SELECT document_id, source_id, url, revision, content_hash, title, text, license, fetched_at, status, error
        FROM kl_documents
        WHERE document_id = ?
      `)
      .get(documentId) as any;

    if (!row) return null;

    return {
      document_id: row.document_id,
      source_id: row.source_id,
      url: row.url,
      revision: row.revision,
      content_hash: row.content_hash,
      title: row.title ?? undefined,
      text: row.text,
      license: row.license ?? undefined,
      fetched_at: row.fetched_at,
      status: row.status,
      error: row.error ?? undefined,
    };
  }

  /**
   * Lists documents optionally filtered by sourceId, excluding tombstones if requested.
   */
  async listDocuments(
    sourceId?: string,
    includeTombstones = false,
  ): Promise<DocumentRevision[]> {
    let sql = `
      SELECT document_id, source_id, url, revision, content_hash, title, text, license, fetched_at, status, error
      FROM kl_documents
    `;
    const params: any[] = [];
    const conditions: string[] = [];

    if (sourceId) {
      conditions.push("source_id = ?");
      params.push(sourceId);
    }

    if (!includeTombstones) {
      conditions.push("status != 'tombstone'");
    }

    if (conditions.length > 0) {
      sql += " WHERE " + conditions.join(" AND ");
    }

    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map((row) => ({
      document_id: row.document_id,
      source_id: row.source_id,
      url: row.url,
      revision: row.revision,
      content_hash: row.content_hash,
      title: row.title ?? undefined,
      text: row.text,
      license: row.license ?? undefined,
      fetched_at: row.fetched_at,
      status: row.status,
      error: row.error ?? undefined,
    }));
  }

  /**
   * Retrieves chunks for a document.
   */
  async getChunks(documentId: string): Promise<Chunk[]> {
    const rows = this.db
      .prepare(`
        SELECT chunk_id, document_id, source_id, text, heading, byte_offset, token_estimate, hash
        FROM kl_chunks
        WHERE document_id = ?
        ORDER BY byte_offset ASC
      `)
      .all(documentId) as any[];

    return rows.map((r) => ({
      chunk_id: r.chunk_id,
      document_id: r.document_id,
      source_id: r.source_id,
      text: r.text,
      heading: r.heading ?? undefined,
      byte_offset: Number(r.byte_offset),
      token_estimate: Number(r.token_estimate),
      hash: r.hash,
    }));
  }

  /**
   * Retrieves vector embedding for a chunk.
   */
  async getChunkEmbedding(
    chunkId: string,
    modelFingerprint?: string,
  ): Promise<Float32Array | null> {
    const fp = (modelFingerprint ?? this.meta.model_fingerprint).toLowerCase();
    const row = this.db
      .prepare(`
        SELECT vector FROM kl_embeddings WHERE chunk_id = ? AND model_fingerprint = ?
      `)
      .get(chunkId, fp) as { vector?: Buffer } | undefined;

    if (!row || !row.vector) return null;
    return blobToVector(row.vector);
  }

  /**
   * Full-text search over chunks, excluding tombstone documents (AC-2).
   */
  async searchFts(
    query: string,
    limit = 20,
  ): Promise<
    Array<{
      chunk_id: string;
      document_id: string;
      source_id: string;
      text: string;
      heading?: string;
    }>
  > {
    const sanitizedQuery = query.replace(/['"\\]/g, " ").trim();
    if (!sanitizedQuery) return [];

    const rows = this.db
      .prepare(`
        SELECT c.chunk_id, c.document_id, c.source_id, c.text, c.heading
        FROM kl_chunks_fts f
        JOIN kl_chunks c ON f.chunk_id = c.chunk_id
        JOIN kl_documents d ON c.document_id = d.document_id
        WHERE kl_chunks_fts MATCH ? AND d.status != 'tombstone'
        ORDER BY rank
        LIMIT ?
      `)
      .all(sanitizedQuery, limit) as any[];

    return rows.map((r) => ({
      chunk_id: r.chunk_id,
      document_id: r.document_id,
      source_id: r.source_id,
      text: r.text,
      heading: r.heading ?? undefined,
    }));
  }

  /**
   * Verifies catalog database structural, foreign key, and FTS5 integrity.
   */
  async verifyIntegrity(): Promise<IntegrityCheckResult> {
    return verifyCatalogIntegrity(this.db);
  }

  /**
   * Closes the database connection if owned by this service.
   */
  close(): void {
    if (this.ownsDb) {
      try {
        this.db.close();
      } catch {
        // ignore
      }
    }
  }
}
