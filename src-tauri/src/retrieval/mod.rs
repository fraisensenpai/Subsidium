pub mod symbol_search;
pub mod text_search;
pub mod tokenize;

use crate::indexing::db;
use anyhow::Result;
use serde::Serialize;
use std::collections::HashSet;
use std::path::Path;

/// One retrieval hit, already normalized so the frontend (and, later, the
/// Context Engine feeding the AI provider) doesn't need to know which
/// method produced it.
#[derive(Debug, Clone, Serialize)]
pub struct SearchHit {
    /// "symbol" | "file" | "text" — which retrieval method found this.
    /// Kept so the UI can show a badge and the Context Engine can weigh
    /// sources differently later.
    pub source: String,
    pub file: String,
    pub line: Option<usize>,
    pub snippet: String,
    pub symbol_name: Option<String>,
    pub symbol_kind: Option<String>,
}

/// Runs every retrieval method Phase 2 implements and returns a single
/// deduplicated, ranked list:
///
///   1. symbol name search   — exact/substring match against indexed symbols
///   2. file name search     — substring match against file paths
///   3. full-text search     — live grep over indexed files' contents
///
/// Not yet implemented (need pieces from later phases first):
///   - reference search / dependency analysis: needs the `edges` table
///     populated, which needs import/call-resolution during parsing.
///   - semantic retrieval: needs the embedding index described in the
///     spec's SEMANTIC MEMORY section.
///   - metadata filtering: the pieces exist (language/kind columns) but
///     there's no query syntax for it yet — see `tokenize` for where a
///     `lang:rust` style filter would be parsed.
///
/// Both of those slot in as additional match arms / extra passes here
/// without changing this function's signature or the SearchHit shape.
pub fn search(root: &Path, query: &str) -> Result<Vec<SearchHit>> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }

    let conn = db::open_for_workspace(root)?;
    let tokens = tokenize::identifier_tokens(trimmed);

    let mut hits = Vec::new();
    let mut seen: HashSet<(String, Option<usize>, String)> = HashSet::new();

    // 1 & 2: structural (SQLite) lookups — cheap, so try the raw query and
    // every extracted identifier token.
    let mut structural_terms = vec![trimmed.to_string()];
    structural_terms.extend(tokens.iter().cloned());
    structural_terms.dedup();

    for term in &structural_terms {
        for hit in symbol_search::by_name(&conn, term)? {
            push_unique(&mut hits, &mut seen, hit);
        }
    }
    for term in &structural_terms {
        for hit in symbol_search::by_file_name(&conn, term)? {
            push_unique(&mut hits, &mut seen, hit);
        }
    }

    // 3: full-text — only worth grepping the literal phrase (token-by-token
    // grepping over every file is expensive and low-precision), capped so
    // a huge workspace can't make a search hang the UI.
    for hit in text_search::grep(&conn, root, trimmed, 40)? {
        push_unique(&mut hits, &mut seen, hit);
    }

    // Rank: symbol hits first (most structurally relevant), then file
    // name hits, then free-text matches. Stable within each group.
    hits.sort_by_key(|h| match h.source.as_str() {
        "symbol" => 0,
        "file" => 1,
        _ => 2,
    });
    hits.truncate(100);

    Ok(hits)
}

fn push_unique(hits: &mut Vec<SearchHit>, seen: &mut HashSet<(String, Option<usize>, String)>, hit: SearchHit) {
    let key = (hit.file.clone(), hit.line, hit.snippet.clone());
    if seen.insert(key) {
        hits.push(hit);
    }
}
