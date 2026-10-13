/**
 * migrations.ts — Schema initialization, generation management, and database integrity
 * for the harness knowledge library SQLite catalog.
 */

import { DatabaseSync } from "node:sqlite";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { StorageError } from "./contracts.ts";

export interface CatalogMeta {
  catalog_id: string;
  schema_version: number;
  generation: string;
  model_fingerprint: string;
  created_at: string;
}

export interface OpenCatalogOptions {
  readonly?: boolean;
  busyTimeoutMs?: number;
}

export interface IntegrityCheckResult {
  ok: boolean;
  errors: string[];
  rowCounts: Record<string, number>;
}

/**
 * Opens a SQLite database connection with standard catalog pragmas:
 * - foreign_keys = ON
 * - busy_timeout = 5000 (or custom)
 * - journal_mode = WAL (for non-memory, read-write databases)
 */
export function openCatalogDatabase(
  dbPath: string,
  options: OpenCatalogOptions = {},
): DatabaseSync {
  const isMemory = dbPath === ":memory:";
  const readonly = options.readonly ?? false;

  const db = new DatabaseSync(dbPath, {
    readOnly: readonly,
  });

  db.exec("PRAGMA foreign_keys = ON;");
  const busyTimeout = options.busyTimeoutMs ?? 5000;
  db.exec(`PRAGMA busy_timeout = ${busyTimeout};`);

  if (!isMemory && !readonly) {
    db.exec("PRAGMA journal_mode = WAL;");
  }

  return db;
}

/**
 * Checks whether the sqlite-vec extension (vec0 virtual table module) is available.
 */
export function isVec0Available(db: DatabaseSync): boolean {
  try {
    const rows = db.prepare("PRAGMA module_list").all() as Array<{ name?: string }>;
    return rows.some((row) => row.name === "vec0");
  } catch {
    return false;
  }
}

/**
 * Reads and returns the active catalog metadata, or null if tables are not initialized.
 */
export function getCatalogMeta(db: DatabaseSync): CatalogMeta | null {
  try {
    const tableExists = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'kl_meta'")
      .get();
    if (!tableExists) return null;

    const row = db
      .prepare(
        "SELECT catalog_id, schema_version, generation, model_fingerprint, created_at FROM kl_meta LIMIT 1",
      )
      .get() as
      | {
          catalog_id: string;
          schema_version: number;
          generation: string;
          model_fingerprint: string;
          created_at: string;
        }
      | undefined;

    if (!row) return null;

    return {
      catalog_id: row.catalog_id,
      schema_version: Number(row.schema_version),
      generation: row.generation,
      model_fingerprint: row.model_fingerprint,
      created_at: row.created_at,
    };
  } catch {
    return null;
  }
}

/**
 * Loads the SQL DDL from schema.sql.
 */
export function loadSchemaSql(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const schemaPath = join(currentDir, "schema.sql");
  if (!existsSync(schemaPath)) {
    throw new StorageError(
      "STORAGE_ERROR",
      `schema.sql not found at ${schemaPath}`,
    );
  }
  return readFileSync(schemaPath, "utf-8");
}

/**
 * Initializes catalog tables, virtual tables, triggers, and writes kl_meta.
 */
export function initCatalogSchema(
  db: DatabaseSync,
  meta: {
    catalog_id: string;
    generation: string;
    model_fingerprint: string;
    created_at?: string;
  },
): { initialized: boolean; meta: CatalogMeta } {
  const existingMeta = getCatalogMeta(db);
  if (existingMeta) {
    return { initialized: false, meta: existingMeta };
  }

  const ddl = loadSchemaSql();
  db.exec(ddl);

  // If sqlite-vec is available, initialize vec0 virtual table
  if (isVec0Available(db)) {
    try {
      db.exec(
        "CREATE VIRTUAL TABLE IF NOT EXISTS kl_chunks_vec USING vec0(chunk_id TEXT PRIMARY KEY, vector FLOAT[1024]);",
      );
    } catch {
      // vec0 optional; fallback to kl_embeddings BLOB
    }
  }

  const createdAt = meta.created_at ?? new Date().toISOString();
  const insertMeta = db.prepare(`
    INSERT INTO kl_meta (catalog_id, schema_version, generation, model_fingerprint, created_at)
    VALUES (?, 1, ?, ?, ?)
  `);

  insertMeta.run(
    meta.catalog_id,
    meta.generation,
    meta.model_fingerprint.toLowerCase(),
    createdAt,
  );

  const activeMeta: CatalogMeta = {
    catalog_id: meta.catalog_id,
    schema_version: 1,
    generation: meta.generation,
    model_fingerprint: meta.model_fingerprint.toLowerCase(),
    created_at: createdAt,
  };

  return { initialized: true, meta: activeMeta };
}

/**
 * Determines whether a new generation must be built because of schema or model fingerprint change.
 */
export function shouldRotateGeneration(
  activeMeta: CatalogMeta | null,
  target: { schema_version?: number; model_fingerprint: string },
): boolean {
  if (!activeMeta) return true;
  const targetSchema = target.schema_version ?? 1;
  if (activeMeta.schema_version !== targetSchema) return true;
  if (
    activeMeta.model_fingerprint.toLowerCase() !==
    target.model_fingerprint.toLowerCase()
  ) {
    return true;
  }
  return false;
}

/**
 * Generates a unique, sortable generation identifier.
 */
export function createGenerationId(prefix = "gen"): string {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:T.Z]/g, "")
    .slice(0, 14);
  const nonce = randomBytes(4).toString("hex");
  return `${prefix}_${timestamp}_${nonce}`;
}

/**
 * Verifies database structural and index integrity.
 * Runs PRAGMA integrity_check, PRAGMA foreign_key_check, FTS5 integrity-check,
 * and collects row counts.
 */
export function verifyCatalogIntegrity(db: DatabaseSync): IntegrityCheckResult {
  const errors: string[] = [];

  // 1. PRAGMA integrity_check
  try {
    const integrityRows = db.prepare("PRAGMA integrity_check").all() as Array<{
      integrity_check?: string;
    }>;
    for (const r of integrityRows) {
      if (r.integrity_check && r.integrity_check.toLowerCase() !== "ok") {
        errors.push(`Integrity check failed: ${r.integrity_check}`);
      }
    }
  } catch (err) {
    errors.push(`PRAGMA integrity_check error: ${String(err)}`);
  }

  // 2. PRAGMA foreign_key_check
  try {
    const fkRows = db.prepare("PRAGMA foreign_key_check").all();
    if (fkRows.length > 0) {
      errors.push(`Foreign key check failed with ${fkRows.length} violations`);
    }
  } catch (err) {
    errors.push(`PRAGMA foreign_key_check error: ${String(err)}`);
  }

  // 3. FTS5 index integrity check
  try {
    db.exec("INSERT INTO kl_chunks_fts(kl_chunks_fts) VALUES('integrity-check');");
  } catch (err) {
    errors.push(`FTS5 index integrity check failed: ${String(err)}`);
  }

  // 4. Collect row counts
  const rowCounts: Record<string, number> = {};
  const tables = [
    "kl_meta",
    "kl_sources",
    "kl_documents",
    "kl_chunks",
    "kl_capabilities",
    "kl_embeddings",
    "kl_chunks_fts",
  ];

  for (const table of tables) {
    try {
      const result = db
        .prepare(`SELECT COUNT(*) as count FROM ${table}`)
        .get() as { count?: number } | undefined;
      rowCounts[table] = Number(result?.count ?? 0);
    } catch {
      rowCounts[table] = -1;
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    rowCounts,
  };
}
