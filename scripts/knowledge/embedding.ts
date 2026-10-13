/**
 * embedding.ts — Text embedding service, instruction formatting, batching,
 * vector validation, and local llama.cpp server adapter.
 *
 * Implements EmbedderPort with:
 * - Deterministic model profile and fingerprint validation.
 * - Text normalization and query instruction prepending.
 * - Batch size enforcement (max 32 texts per batch).
 * - Vector validation: 1024 dimensions, rejection of NaN/Infinity, L2 normalization.
 * - Local llama.cpp HTTP server adapter and offline mock mode.
 * - Cancellation and timeout handling via withPortTimeout.
 */

import { createHash } from "node:crypto";
import {
  type EmbeddingProfile,
  type EmbedderPort,
  type PortOptions,
  ModelCompatibilityError,
  computeModelFingerprint,
  validateEmbeddingProfile,
  withPortTimeout,
} from "./contracts.ts";
import { loadRuntimeLock } from "./runtime.ts";

// ============================================================================
// Service Configuration & Provider Interfaces
// ============================================================================

export interface EmbeddingProvider {
  embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[] | number[][]>;
}

export interface EmbedderServiceOptions {
  profile?: EmbeddingProfile;
  baseUrl?: string;
  batchSizeLimit?: number;
  mode?: "remote" | "mock" | "auto";
  fetchFn?: typeof fetch;
  provider?: EmbeddingProvider;
  timeoutMs?: number;
}

// ============================================================================
// Mock Embedding Provider (for offline tests and evaluation)
// ============================================================================

/**
 * Generates a deterministic, L2-normalized pseudo-embedding for testing.
 */
export function generateMockVector(text: string, dimensions = 1024): Float32Array {
  const hash = createHash("sha256").update(text).digest();
  const vector = new Float32Array(dimensions);
  let sumSq = 0;

  for (let i = 0; i < dimensions; i++) {
    const byte = hash[i % hash.length] ?? 0;
    const seed = (byte * 31 + i * 17) % 256;
    const val = (seed - 128) / 128.0;
    vector[i] = val;
    sumSq += val * val;
  }

  const norm = Math.sqrt(sumSq);
  if (norm > 0) {
    for (let i = 0; i < dimensions; i++) {
      vector[i] = vector[i]! / norm;
    }
  }

  return vector;
}

export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions: number;

  constructor(dimensions = 1024) {
    this.dimensions = dimensions;
  }

  async embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    if (signal?.aborted) {
      const err = new Error("Mock embedding operation aborted");
      err.name = "AbortError";
      throw err;
    }

    return texts.map((text) => generateMockVector(text, this.dimensions));
  }
}

// ============================================================================
// HTTP / llama.cpp Embedding Provider
// ============================================================================

export class HttpEmbeddingProvider implements EmbeddingProvider {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly modelId?: string;

  constructor(options: { baseUrl?: string; fetchFn?: typeof fetch; modelId?: string } = {}) {
    this.baseUrl = (options.baseUrl || "http://127.0.0.1:8080").replace(/\/+$/, "");
    this.fetchFn = options.fetchFn || globalThis.fetch;
    this.modelId = options.modelId;
  }

  async embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    if (texts.length === 0) return [];

    // Attempt OpenAI-compatible /v1/embeddings endpoint first (standard in llama-server)
    try {
      const v1Url = `${this.baseUrl}/v1/embeddings`;
      const res = await this.fetchFn(v1Url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: texts,
          model: this.modelId || "embedding",
        }),
        signal,
      });

      if (res.ok) {
        const body = (await res.json()) as {
          data?: Array<{ embedding: number[]; index: number }>;
        };

        if (Array.isArray(body.data)) {
          // Sort by index to guarantee input ordering
          const sorted = [...body.data].sort((a, b) => a.index - b.index);
          return sorted.map((item) => new Float32Array(item.embedding));
        }
      }
    } catch (err: unknown) {
      // If aborted, let the abort propagate
      if (signal?.aborted) throw err;
      // Fall through to try /embedding endpoint
    }

    // Secondary attempt: native llama.cpp /embedding endpoint (single item or array)
    const embeddingUrl = `${this.baseUrl}/embedding`;
    const results: Float32Array[] = [];

    for (const text of texts) {
      let res: Response;
      try {
        res = await this.fetchFn(embeddingUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: text }),
          signal,
        });
      } catch (err: unknown) {
        if (signal?.aborted) throw err;
        throw new ModelCompatibilityError(
          "MODEL_UNAVAILABLE",
          `Failed to connect to local embedding server at ${this.baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new ModelCompatibilityError(
          "MODEL_UNAVAILABLE",
          `Embedding server returned HTTP ${res.status}: ${errText}`,
        );
      }

      const body = (await res.json()) as { embedding?: number[] };
      if (!Array.isArray(body.embedding)) {
        throw new ModelCompatibilityError(
          "MODEL_UNAVAILABLE",
          "Embedding server returned invalid response format: missing 'embedding' array",
        );
      }

      results.push(new Float32Array(body.embedding));
    }

    return results;
  }
}

// ============================================================================
// EmbedderService Implementation
// ============================================================================

export class EmbedderService implements EmbedderPort {
  private readonly profile: EmbeddingProfile;
  private readonly provider: EmbeddingProvider;
  private readonly batchSizeLimit: number;
  private readonly defaultTimeoutMs: number;

  constructor(options: EmbedderServiceOptions = {}) {
    // 1. Resolve and validate EmbeddingProfile
    let rawProfile = options.profile;
    if (!rawProfile) {
      const lock = loadRuntimeLock();
      rawProfile = lock.embedding_profile;
    }

    this.profile = validateEmbeddingProfile(rawProfile);

    // Verify computed fingerprint matches profile fingerprint
    const computed = computeModelFingerprint(this.profile);
    if (this.profile.fingerprint.toLowerCase() !== computed) {
      throw new ModelCompatibilityError(
        "MODEL_FINGERPRINT_MISMATCH",
        `Profile fingerprint mismatch. Provided: ${this.profile.fingerprint}, Computed: ${computed}`,
      );
    }

    // 2. Resolve batch limits & timeouts
    this.batchSizeLimit = options.batchSizeLimit ?? 32;
    this.defaultTimeoutMs = options.timeoutMs ?? 30000;

    // 3. Resolve Provider
    if (options.provider) {
      this.provider = options.provider;
    } else {
      const mode =
        options.mode ??
        (process.env.KNOWLEDGE_EMBEDDER_MODE?.toLowerCase() === "mock" ? "mock" : "remote");

      if (mode === "mock") {
        this.provider = new MockEmbeddingProvider(this.profile.dimensions);
      } else {
        this.provider = new HttpEmbeddingProvider({
          baseUrl: options.baseUrl,
          fetchFn: options.fetchFn,
          modelId: this.profile.model_id,
        });
      }
    }
  }

  /**
   * Returns the validated EmbeddingProfile.
   */
  async getProfile(_options?: PortOptions): Promise<EmbeddingProfile> {
    return this.profile;
  }

  /**
   * Direct synchronous accessor to the profile.
   */
  get embeddingProfile(): EmbeddingProfile {
    return this.profile;
  }

  /**
   * Embeds a search query with the profile's query_instruction prepended.
   */
  async embedQuery(query: string, options?: PortOptions): Promise<Float32Array> {
    if (typeof query !== "string") {
      throw new ModelCompatibilityError("MODEL_UNAVAILABLE", "Query must be a string");
    }

    const cleanedQuery = this.cleanText(query);
    const instructedQuery = `${this.profile.query_instruction}${cleanedQuery}`;

    const [vector] = await this.embedDocumentsInternal([instructedQuery], options);
    if (!vector) {
      throw new ModelCompatibilityError("MODEL_UNAVAILABLE", "Failed to obtain vector for query");
    }

    return vector;
  }

  /**
   * Embeds a batch of document texts, enforcing batch size limit (<= 32)
   * and vector invariants.
   */
  async embedDocuments(texts: string[], options?: PortOptions): Promise<Float32Array[]> {
    return this.embedDocumentsInternal(texts, options);
  }

  /**
   * Alias satisfying EmbedderPort.embedBatch interface.
   */
  async embedBatch(texts: string[], options?: PortOptions): Promise<Float32Array[]> {
    return this.embedDocumentsInternal(texts, options);
  }

  // ==========================================================================
  // Internal Execution & Invariant Verification
  // ==========================================================================

  private async embedDocumentsInternal(
    texts: string[],
    options?: PortOptions,
  ): Promise<Float32Array[]> {
    if (!Array.isArray(texts)) {
      throw new ModelCompatibilityError("MODEL_UNAVAILABLE", "texts must be an array of strings");
    }

    if (texts.length === 0) {
      return [];
    }

    const cleanedTexts = texts.map((t) => this.cleanText(t));

    return withPortTimeout(
      async (signal) => {
        const allVectors: Float32Array[] = [];

        // Chunk into batches of size <= batchSizeLimit
        for (let i = 0; i < cleanedTexts.length; i += this.batchSizeLimit) {
          const chunk = cleanedTexts.slice(i, i + this.batchSizeLimit);
          const rawBatch = await this.provider.embed(chunk, signal);

          if (!Array.isArray(rawBatch) || rawBatch.length !== chunk.length) {
            throw new ModelCompatibilityError(
              "MODEL_UNAVAILABLE",
              `Provider returned ${rawBatch?.length ?? 0} vectors for a batch of ${chunk.length} inputs`,
            );
          }

          for (let j = 0; j < rawBatch.length; j++) {
            const rawVec = rawBatch[j]!;
            const validated = this.validateAndNormalizeVector(rawVec, i + j);
            allVectors.push(validated);
          }
        }

        return allVectors;
      },
      {
        signal: options?.signal,
        timeoutMs: options?.timeoutMs ?? this.defaultTimeoutMs,
      },
    );
  }

  /**
   * Normalizes input text by removing null characters and trimming.
   */
  private cleanText(text: string): string {
    if (typeof text !== "string") return "";
    return text.replace(/\0/g, "").trim();
  }

  /**
   * Validates dimensions (1024), checks for NaN/Infinity, and verifies/enforces L2 normalization.
   */
  private validateAndNormalizeVector(
    raw: Float32Array | number[],
    index: number,
  ): Float32Array {
    if (!raw || typeof raw.length !== "number") {
      throw new ModelCompatibilityError(
        "MODEL_UNAVAILABLE",
        `Item at index ${index} is not a valid vector`,
      );
    }

    if (raw.length !== this.profile.dimensions) {
      throw new ModelCompatibilityError(
        "DIMENSION_MISMATCH",
        `Vector dimension mismatch at index ${index}: expected ${this.profile.dimensions}, got ${raw.length}`,
        { expected: this.profile.dimensions, actual: raw.length, index },
      );
    }

    const vector = raw instanceof Float32Array ? raw : new Float32Array(raw);
    let sumSq = 0;

    for (let i = 0; i < vector.length; i++) {
      const val = vector[i]!;
      if (!Number.isFinite(val)) {
        throw new ModelCompatibilityError(
          "MODEL_UNAVAILABLE",
          `Vector at index ${index} contains NaN or non-finite value at dimension ${i}`,
          { index, dimension: i, value: val },
        );
      }
      sumSq += val * val;
    }

    // Verify / enforce L2 normalization if required by profile
    if (this.profile.normalization) {
      const norm = Math.sqrt(sumSq);
      if (norm === 0) {
        throw new ModelCompatibilityError(
          "MODEL_UNAVAILABLE",
          `Zero-norm vector produced at index ${index}`,
          { index },
        );
      }

      // If norm is not unit length, normalize it
      if (Math.abs(norm - 1.0) > 1e-4) {
        for (let i = 0; i < vector.length; i++) {
          vector[i] = vector[i]! / norm;
        }
      }
    }

    return vector;
  }
}
