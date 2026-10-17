pub mod db;

use crate::parsing;
use crate::workspace::{scanner, FileNode, ScanSummary};
use anyhow::Result;
use serde::Serialize;
use std::hash::{Hash, Hasher};
use std::path::Path;

#[derive(Debug, Clone, Serialize)]
pub struct IndexStats {
    pub file_count: usize,
    pub symbol_count: usize,
    pub edge_count: usize,
    pub last_indexed_at: String,
}

/// Scans the workspace and (re)builds the structural index, skipping files
/// whose content hasn't changed since the last run. This is Phase 1's
/// incremental indexing: coarse (whole-file) rather than the eventual
/// "re-parse only the changed AST range" version, but it already avoids
/// the expensive part — re-parsing and re-writing symbols for files that
/// haven't changed — on every open of a previously-indexed workspace.
pub fn build_index(root: &Path) -> Result<(FileNode, ScanSummary, IndexStats)> {
    let scan = scanner::scan(root)?;
    let conn = db::open_for_workspace(root)?;

    for file in &scan.files {
        let content = match std::fs::read_to_string(&file.absolute_path) {
            Ok(c) => c,
            Err(_) => continue, // binary-ish or unreadable file; skip rather than fail the run
        };
        let hash = content_hash(&content);
        let language = file.language.as_deref();

        let unchanged = db::existing_hash(&conn, &file.relative_path)? == Some(hash.clone());

        // Every readable file gets a `files` row (and is therefore
        // reachable by name/full-text search) regardless of whether we
        // can extract symbols from it. Symbol extraction only runs for
        // languages parsing::supported_for_symbols knows about, and only
        // when the file actually changed.
        let file_id = db::upsert_file(&conn, &file.relative_path, language, &hash)?;

        if unchanged {
            continue;
        }

        if let Some(language) = language {
            if parsing::supported_for_symbols(language) {
                let symbols = parsing::extract_symbols(language, &content);
                db::replace_symbols(&conn, file_id, &symbols)?;
            }
        }
    }

    let counts = db::counts(&conn)?;
    let stats = IndexStats {
        file_count: counts.file_count,
        symbol_count: counts.symbol_count,
        edge_count: counts.edge_count,
        last_indexed_at: chrono::Utc::now().to_rfc3339(),
    };

    Ok((scan.tree, scan.summary, stats))
}

/// Lightweight follow-up to an agent action: picks up files that appeared
/// since the last index (and drops rows for files that vanished) without
/// re-reading and re-hashing every already-known file. The full
/// `build_index` still runs when a workspace is opened; this exists only so
/// a `run_command` that generates files (a scaffold, a codegen step) shows
/// up in search and the Explorer right away, without making every approval
/// cost a full read pass over the whole tree.
///
/// Caveat: a file that *changed* on disk without going through
/// `write_file`/`reindex_file` keeps its old symbols until the next full
/// `build_index`. New files and deletions are always picked up.
pub fn build_index_shallow(root: &Path) -> Result<(FileNode, IndexStats)> {
    let scan = scanner::scan(root)?;
    let conn = db::open_for_workspace(root)?;

    let keep: std::collections::HashSet<String> =
        scan.files.iter().map(|f| f.relative_path.clone()).collect();

    for file in &scan.files {
        // Skip anything already indexed — the point of this pass is to be
        // cheap, so it never re-reads or re-hashes known files.
        if db::existing_hash(&conn, &file.relative_path)?.is_some() {
            continue;
        }
        let content = match std::fs::read_to_string(&file.absolute_path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let hash = content_hash(&content);
        let language = file.language.as_deref();
        let file_id = db::upsert_file(&conn, &file.relative_path, language, &hash)?;
        if let Some(language) = language {
            if parsing::supported_for_symbols(language) {
                let symbols = parsing::extract_symbols(language, &content);
                db::replace_symbols(&conn, file_id, &symbols)?;
            }
        }
    }

    db::prune_files(&conn, &keep)?;

    let counts = db::counts(&conn)?;
    let stats = IndexStats {
        file_count: counts.file_count,
        symbol_count: counts.symbol_count,
        edge_count: counts.edge_count,
        last_indexed_at: chrono::Utc::now().to_rfc3339(),
    };
    Ok((scan.tree, stats))
}

pub fn stats_for(root: &Path) -> Result<IndexStats> {
    let conn = db::open_for_workspace(root)?;
    let counts = db::counts(&conn)?;
    Ok(IndexStats {
        file_count: counts.file_count,
        symbol_count: counts.symbol_count,
        edge_count: counts.edge_count,
        last_indexed_at: chrono::Utc::now().to_rfc3339(),
    })
}

/// Re-indexes a single file after a manual edit in the built-in editor,
/// without re-scanning the whole workspace. Called right after a save so
/// search results stay accurate without the user needing to trigger a
/// full re-index.
pub fn reindex_file(root: &Path, relative_path: &str) -> Result<IndexStats> {
    let absolute = root.join(relative_path);
    let conn = db::open_for_workspace(root)?;

    let content = std::fs::read_to_string(&absolute)?;
    let hash = content_hash(&content);
    let language = crate::workspace::language::detect(&absolute);

    let file_id = db::upsert_file(&conn, relative_path, language.as_deref(), &hash)?;

    if let Some(language) = &language {
        if parsing::supported_for_symbols(language) {
            let symbols = parsing::extract_symbols(language, &content);
            db::replace_symbols(&conn, file_id, &symbols)?;
        }
    }

    stats_for(root)
}

/// Deterministic (non-cryptographic) content hash used only to detect
/// "did this file change since last index" — not a security boundary.
/// Swap for blake3/sha256 if that guarantee ever matters here.
fn content_hash(content: &str) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    content.hash(&mut hasher);
    format!("{:x}", hasher.finish())
}
