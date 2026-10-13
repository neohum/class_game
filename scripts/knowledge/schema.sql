-- schema.sql — DDL for Knowledge Library SQLite Catalog (schema_version = 1)
-- Namespace prefix: kl_

PRAGMA foreign_keys = ON;

-- Metadata key-value and catalog generation
CREATE TABLE IF NOT EXISTS kl_meta (
  catalog_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  generation TEXT NOT NULL,
  model_fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (catalog_id)
);

-- Registered source specifications
CREATE TABLE IF NOT EXISTS kl_sources (
  source_id TEXT NOT NULL PRIMARY KEY,
  kind TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT,
  tags TEXT NOT NULL, -- JSON array of strings
  note TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  refresh_hours REAL NOT NULL DEFAULT 24.0,
  provenance TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Document revisions fetched from sources
CREATE TABLE IF NOT EXISTS kl_documents (
  document_id TEXT NOT NULL PRIMARY KEY,
  source_id TEXT NOT NULL,
  url TEXT NOT NULL,
  revision TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  title TEXT,
  text TEXT NOT NULL,
  license TEXT,
  fetched_at TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  FOREIGN KEY (source_id) REFERENCES kl_sources(source_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_kl_documents_source_id ON kl_documents(source_id);
CREATE INDEX IF NOT EXISTS idx_kl_documents_status ON kl_documents(status);
CREATE INDEX IF NOT EXISTS idx_kl_documents_content_hash ON kl_documents(content_hash);

-- Document chunks for indexing and vector embedding
CREATE TABLE IF NOT EXISTS kl_chunks (
  chunk_id TEXT NOT NULL PRIMARY KEY,
  document_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  text TEXT NOT NULL,
  heading TEXT,
  byte_offset INTEGER NOT NULL,
  token_estimate INTEGER NOT NULL,
  hash TEXT NOT NULL,
  FOREIGN KEY (document_id) REFERENCES kl_documents(document_id) ON DELETE CASCADE,
  FOREIGN KEY (source_id) REFERENCES kl_sources(source_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_kl_chunks_document_id ON kl_chunks(document_id);
CREATE INDEX IF NOT EXISTS idx_kl_chunks_source_id ON kl_chunks(source_id);
CREATE INDEX IF NOT EXISTS idx_kl_chunks_hash ON kl_chunks(hash);

-- Capability candidates extracted from documents
CREATE TABLE IF NOT EXISTS kl_capabilities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  capability_name TEXT NOT NULL,
  integration_type TEXT NOT NULL,
  description TEXT,
  evidence_quote TEXT,
  evidence_chunk_id TEXT,
  FOREIGN KEY (evidence_chunk_id) REFERENCES kl_chunks(chunk_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_kl_capabilities_chunk_id ON kl_capabilities(evidence_chunk_id);
CREATE INDEX IF NOT EXISTS idx_kl_capabilities_name ON kl_capabilities(capability_name);

-- Chunk embeddings indexed by model fingerprint
CREATE TABLE IF NOT EXISTS kl_embeddings (
  chunk_id TEXT NOT NULL,
  model_fingerprint TEXT NOT NULL,
  vector BLOB NOT NULL,
  dimensions INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (chunk_id, model_fingerprint),
  FOREIGN KEY (chunk_id) REFERENCES kl_chunks(chunk_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_kl_embeddings_fingerprint ON kl_embeddings(model_fingerprint);

-- Full-text search virtual table (FTS5) using unicode61 tokenizer
CREATE VIRTUAL TABLE IF NOT EXISTS kl_chunks_fts USING fts5(
  chunk_id UNINDEXED,
  heading,
  text,
  tokenize = 'unicode61'
);

-- Triggers to synchronize FTS5 index on chunk mutations
CREATE TRIGGER IF NOT EXISTS kl_chunks_ai AFTER INSERT ON kl_chunks BEGIN
  INSERT INTO kl_chunks_fts(chunk_id, heading, text)
  VALUES (new.chunk_id, COALESCE(new.heading, ''), new.text);
END;

CREATE TRIGGER IF NOT EXISTS kl_chunks_ad AFTER DELETE ON kl_chunks BEGIN
  DELETE FROM kl_chunks_fts WHERE chunk_id = old.chunk_id;
END;

CREATE TRIGGER IF NOT EXISTS kl_chunks_au AFTER UPDATE ON kl_chunks BEGIN
  DELETE FROM kl_chunks_fts WHERE chunk_id = old.chunk_id;
  INSERT INTO kl_chunks_fts(chunk_id, heading, text)
  VALUES (new.chunk_id, COALESCE(new.heading, ''), new.text);
END;

-- View of active chunks excluding tombstone documents
CREATE VIEW IF NOT EXISTS kl_active_chunks AS
SELECT c.*
FROM kl_chunks c
JOIN kl_documents d ON c.document_id = d.document_id
WHERE d.status != 'tombstone';
