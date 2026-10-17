use crate::providers::AgentMessage;
use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use serde::Serialize;
use std::path::Path;

const SCHEMA: &str = include_str!("schema.sql");

/// Opens (creating if needed) the index database for a workspace at
/// `<root>/.subsidium/index.db` and ensures the schema is applied.
/// Re-running this on an already-indexed workspace is cheap and safe —
/// `CREATE TABLE IF NOT EXISTS` makes schema application idempotent.
pub fn open_for_workspace(root: &Path) -> Result<Connection> {
    let dir = root.join(".subsidium");
    std::fs::create_dir_all(&dir)
        .with_context(|| format!("failed to create index dir at {}", dir.display()))?;

    let db_path = dir.join("index.db");
    let conn = Connection::open(&db_path)
        .with_context(|| format!("failed to open index db at {}", db_path.display()))?;

    // Best-effort pragmas: with several connections touching the same DB
    // concurrently (an index scan, a conversation save, a search), setting
    // `journal_mode = WAL` on a busy database can transiently fail with
    // "database is locked". Conversation history must never be silently
    // lost because of that, so a pragma failure is ignored — everything
    // else (schema, queries) works fine without them.
    //
    // `busy_timeout` is the important one: it makes a connection that finds
    // the DB locked *wait* up to 5s for the writer to finish instead of
    // failing immediately with SQLITE_BUSY — which is what actually happens
    // when an index write and a conversation save overlap.
    let _ = conn.busy_timeout(std::time::Duration::from_secs(5));
    let _ = conn.execute_batch("PRAGMA foreign_keys = ON;");
    let _ = conn.execute_batch("PRAGMA journal_mode = WAL;");
    conn.execute_batch(SCHEMA)?;
    Ok(conn)
}

/// Inserts or replaces a file row and returns its row id.
pub fn upsert_file(conn: &Connection, relative_path: &str, language: Option<&str>, content_hash: &str) -> Result<i64> {
    conn.execute(
        "INSERT INTO files (relative_path, language, content_hash, last_indexed)
         VALUES (?1, ?2, ?3, datetime('now'))
         ON CONFLICT(relative_path) DO UPDATE SET
            language = excluded.language,
            content_hash = excluded.content_hash,
            last_indexed = excluded.last_indexed",
        params![relative_path, language, content_hash],
    )?;
    let id: i64 = conn.query_row(
        "SELECT id FROM files WHERE relative_path = ?1",
        params![relative_path],
        |row| row.get(0),
    )?;
    Ok(id)
}

/// Returns the stored content hash for a file, if it's already indexed —
/// used by the caller to skip re-parsing unchanged files (incremental
/// indexing).
pub fn existing_hash(conn: &Connection, relative_path: &str) -> Result<Option<String>> {
    let result = conn.query_row(
        "SELECT content_hash FROM files WHERE relative_path = ?1",
        params![relative_path],
        |row| row.get(0),
    );
    match result {
        Ok(hash) => Ok(Some(hash)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Replaces all symbols belonging to a file (simplest correct approach for
/// Phase 1 — a changed file's symbol set is fully recomputed rather than
/// diffed symbol-by-symbol).
pub fn replace_symbols(
    conn: &Connection,
    file_id: i64,
    symbols: &[crate::parsing::ExtractedSymbol],
) -> Result<()> {
    conn.execute("DELETE FROM symbols WHERE file_id = ?1", params![file_id])?;

    let mut stmt = conn.prepare(
        "INSERT INTO symbols (file_id, name, kind, start_line, end_line)
         VALUES (?1, ?2, ?3, ?4, ?5)",
    )?;
    for symbol in symbols {
        stmt.execute(params![
            file_id,
            symbol.name,
            symbol.kind.as_str(),
            symbol.start_line as i64,
            symbol.end_line as i64,
        ])?;
    }

    // Keep the FTS shadow table in sync for this file's symbols.
    conn.execute(
        "INSERT INTO symbols_fts(symbols_fts) VALUES ('rebuild')",
        [],
    )?;

    Ok(())
}

pub struct Counts {
    pub file_count: usize,
    pub symbol_count: usize,
    pub edge_count: usize,
}

pub fn counts(conn: &Connection) -> Result<Counts> {
    let file_count: usize = conn.query_row("SELECT COUNT(*) FROM files", [], |r| r.get(0))?;
    let symbol_count: usize = conn.query_row("SELECT COUNT(*) FROM symbols", [], |r| r.get(0))?;
    let edge_count: usize = conn.query_row("SELECT COUNT(*) FROM edges", [], |r| r.get(0))?;
    Ok(Counts {
        file_count,
        symbol_count,
        edge_count,
    })
}

// ─────────────────────────────────────────────────────────────────────
// Agent conversation history
// ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct ConversationSummary {
    pub id: i64,
    pub title: String,
    pub updated_at: String,
}

pub fn create_conversation(conn: &Connection, title: &str) -> Result<i64> {
    conn.execute(
        "INSERT INTO conversations (title, created_at, updated_at) VALUES (?1, datetime('now'), datetime('now'))",
        params![title],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Overwrites a conversation's full message list — simplest correct way
/// to keep it in sync with in-memory history, since the agent loop's
/// history is small (a handful to a few dozen messages) and this only
/// runs once per user turn, not per message.
pub fn save_conversation_messages(conn: &Connection, conversation_id: i64, messages: &[AgentMessage]) -> Result<()> {
    conn.execute(
        "DELETE FROM conversation_messages WHERE conversation_id = ?1",
        params![conversation_id],
    )?;

    let mut stmt = conn.prepare(
        "INSERT INTO conversation_messages (conversation_id, seq, message_json) VALUES (?1, ?2, ?3)",
    )?;
    for (i, message) in messages.iter().enumerate() {
        let json = serde_json::to_string(message)?;
        stmt.execute(params![conversation_id, i as i64, json])?;
    }

    conn.execute(
        "UPDATE conversations SET updated_at = datetime('now') WHERE id = ?1",
        params![conversation_id],
    )?;
    Ok(())
}

pub fn list_conversations(conn: &Connection) -> Result<Vec<ConversationSummary>> {
    let mut stmt =
        conn.prepare("SELECT id, title, updated_at FROM conversations ORDER BY updated_at DESC LIMIT 50")?;
    let rows = stmt.query_map([], |row| {
        Ok(ConversationSummary {
            id: row.get(0)?,
            title: row.get(1)?,
            updated_at: row.get(2)?,
        })
    })?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

pub fn load_conversation_messages(conn: &Connection, conversation_id: i64) -> Result<Vec<AgentMessage>> {
    let mut stmt = conn
        .prepare("SELECT message_json FROM conversation_messages WHERE conversation_id = ?1 ORDER BY seq")?;
    let rows = stmt.query_map(params![conversation_id], |row| row.get::<_, String>(0))?;

    let mut messages = Vec::new();
    for row in rows {
        let json = row?;
        // Skip (rather than fail the whole load) any message that doesn't
        // deserialize — e.g. after a future format change — so one bad
        // row doesn't make an entire past conversation unreadable.
        if let Ok(message) = serde_json::from_str(&json) {
            messages.push(message);
        }
    }
    Ok(messages)
}

pub fn delete_conversation(conn: &Connection, conversation_id: i64) -> Result<()> {
    conn.execute("DELETE FROM conversations WHERE id = ?1", params![conversation_id])?;
    Ok(())
}

/// Drops `files` rows (and, via `ON DELETE CASCADE`, their symbols) for any
/// path that is no longer part of `keep`. Used by the lightweight
/// post-agent rescan so a file that was deleted — by hand or by a command
/// the agent ran — stops appearing in search and the file listing.
pub fn prune_files(conn: &Connection, keep: &std::collections::HashSet<String>) -> Result<()> {
    let mut stmt = conn.prepare("SELECT relative_path FROM files")?;
    let indexed: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .filter_map(|r| r.ok())
        .collect();
    drop(stmt);

    let mut removed = 0usize;
    for path in indexed {
        if !keep.contains(&path) {
            conn.execute("DELETE FROM files WHERE relative_path = ?1", params![path])?;
            removed += 1;
        }
    }

    if removed > 0 {
        // Keep the symbol FTS shadow table consistent with what's left.
        conn.execute("INSERT INTO symbols_fts(symbols_fts) VALUES ('rebuild')", [])?;
    }
    Ok(())
}
