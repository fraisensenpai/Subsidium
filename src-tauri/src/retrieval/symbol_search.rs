use super::SearchHit;
use anyhow::Result;
use rusqlite::{params, Connection};

/// Substring match against indexed symbol names. LIKE rather than the
/// symbols_fts virtual table on purpose: user queries are arbitrary text
/// (they might contain `%`, quotes, punctuation), and FTS5's query syntax
/// would need escaping to stay safe/correct for that. LIKE is slower on a
/// huge symbol table but Phase 2's target scale doesn't need FTS's ranking
/// yet — symbols_fts is already there in the schema for when it does.
pub fn by_name(conn: &Connection, term: &str) -> Result<Vec<SearchHit>> {
    let mut stmt = conn.prepare(
        "SELECT files.relative_path, symbols.name, symbols.kind, symbols.start_line
         FROM symbols
         JOIN files ON files.id = symbols.file_id
         WHERE symbols.name LIKE ?1 ESCAPE '\\'
         LIMIT 50",
    )?;

    let pattern = format!("%{}%", escape_like(term));
    let rows = stmt.query_map(params![pattern], |row| {
        let file: String = row.get(0)?;
        let name: String = row.get(1)?;
        let kind: String = row.get(2)?;
        let line: i64 = row.get(3)?;
        Ok(SearchHit {
            source: "symbol".to_string(),
            file,
            line: Some(line as usize),
            snippet: format!("{kind} {name}"),
            symbol_name: Some(name),
            symbol_kind: Some(kind),
        })
    })?;

    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// Substring match against indexed file paths — e.g. typing `auth`
/// surfaces `src/auth/middleware.ts` even if nothing inside it is named
/// "auth".
pub fn by_file_name(conn: &Connection, term: &str) -> Result<Vec<SearchHit>> {
    let mut stmt = conn.prepare(
        "SELECT relative_path FROM files WHERE relative_path LIKE ?1 ESCAPE '\\' LIMIT 30",
    )?;

    let pattern = format!("%{}%", escape_like(term));
    let rows = stmt.query_map(params![pattern], |row| {
        let file: String = row.get(0)?;
        Ok(SearchHit {
            source: "file".to_string(),
            file: file.clone(),
            line: None,
            snippet: file,
            symbol_name: None,
            symbol_kind: None,
        })
    })?;

    Ok(rows.filter_map(|r| r.ok()).collect())
}

fn escape_like(term: &str) -> String {
    term.replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}
