use super::SearchHit;
use anyhow::Result;
use rusqlite::Connection;
use std::path::Path;

/// Files larger than this are skipped during full-text search — avoids a
/// single huge generated/data file dominating scan time.
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;

/// Case-insensitive substring search across every file the index knows
/// about, read live from disk. This deliberately does not store file
/// contents in the index (the spec explicitly warns against turning the
/// project index into a copy of the source tree) — it trades a bit of
/// search latency for not duplicating the workspace on disk and always
/// searching current file contents, not a stale copy.
///
/// Returns at most `max_matches` hits, stopping the scan early once that
/// cap is hit rather than reading every remaining file.
pub fn grep(conn: &Connection, root: &Path, term: &str, max_matches: usize) -> Result<Vec<SearchHit>> {
    let needle = term.to_lowercase();
    let mut hits = Vec::new();

    let mut stmt = conn.prepare("SELECT relative_path FROM files")?;
    let paths: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .filter_map(|r| r.ok())
        .collect();

    for relative_path in paths {
        if hits.len() >= max_matches {
            break;
        }

        let absolute = root.join(&relative_path);
        let Ok(meta) = std::fs::metadata(&absolute) else {
            continue;
        };
        if meta.len() > MAX_FILE_BYTES {
            continue;
        }

        let Ok(content) = std::fs::read_to_string(&absolute) else {
            continue; // binary file, or not valid UTF-8 — skip rather than fail the search
        };

        for (idx, line) in content.lines().enumerate() {
            if line.to_lowercase().contains(&needle) {
                hits.push(SearchHit {
                    source: "text".to_string(),
                    file: relative_path.clone(),
                    line: Some(idx + 1),
                    snippet: line.trim().chars().take(200).collect(),
                    symbol_name: None,
                    symbol_kind: None,
                });
                if hits.len() >= max_matches {
                    break;
                }
            }
        }
    }

    Ok(hits)
}
