-- Subsidium structural index — one SQLite file per workspace, stored at
-- <workspace>/.subsidium/index.db. Phase 1 populates `files` and
-- `symbols`; `edges` (call/import/reference relationships) is defined now
-- so the retrieval layer in a later phase has a stable schema to target,
-- but Phase 1 does not yet populate it.

CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
    id            INTEGER PRIMARY KEY,
    relative_path TEXT NOT NULL UNIQUE,
    language      TEXT,
    content_hash  TEXT NOT NULL,      -- for incremental re-index skip checks
    last_indexed  TEXT NOT NULL       -- ISO 8601
);

CREATE TABLE IF NOT EXISTS symbols (
    id         INTEGER PRIMARY KEY,
    file_id    INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    kind       TEXT NOT NULL,          -- function | method | class | struct | enum | interface | type | const | module
    start_line INTEGER NOT NULL,
    end_line   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_file  ON symbols(file_id);

-- Full-text search over symbol names for fast name/text retrieval.
CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
    name,
    content='symbols',
    content_rowid='id'
);

-- Structural relationships between symbols (calls, imports, references).
-- Populated starting in the retrieval-layer phase, not Phase 1.
CREATE TABLE IF NOT EXISTS edges (
    id            INTEGER PRIMARY KEY,
    from_symbol   INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
    to_symbol     INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
    relation      TEXT NOT NULL       -- calls | imports | extends | implements | references
);

CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_symbol);
CREATE INDEX IF NOT EXISTS idx_edges_to   ON edges(to_symbol);

-- Agent chat history, per workspace. Each conversation is a full
-- provider-agnostic AgentMessage transcript (see providers::AgentMessage),
-- stored as JSON per message so it can be replayed straight back into a
-- provider call without re-deriving it from a display-only format.
CREATE TABLE IF NOT EXISTS conversations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    seq             INTEGER NOT NULL,
    message_json    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conversation_messages ON conversation_messages(conversation_id, seq);
