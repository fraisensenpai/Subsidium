pub mod treesitter;

/// A symbol extracted from a source file's AST. `file` is attached by the
/// caller (the indexer already knows which file it's parsing).
#[derive(Debug, Clone)]
pub struct ExtractedSymbol {
    pub name: String,
    pub kind: SymbolKind,
    pub start_line: usize, // 1-based, inclusive
    pub end_line: usize,   // 1-based, inclusive
}

/// The kinds of symbol a parser can report. `Const` and `Module` are part of
/// the vocabulary but not emitted by any query yet — they're kept so adding a
/// language that has them (Go's `const`, Python modules, …) is a query change,
/// not an enum change.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)]
pub enum SymbolKind {
    Function,
    Method,
    Class,
    Interface,
    TypeAlias,
    Struct,
    Enum,
    Const,
    Module,
}

impl SymbolKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            SymbolKind::Function => "function",
            SymbolKind::Method => "method",
            SymbolKind::Class => "class",
            SymbolKind::Interface => "interface",
            SymbolKind::TypeAlias => "type",
            SymbolKind::Struct => "struct",
            SymbolKind::Enum => "enum",
            SymbolKind::Const => "const",
            SymbolKind::Module => "module",
        }
    }
}

/// Languages Phase 1 can extract symbols from. Scanning/indexing-as-a-file
/// still works for every language in `workspace::language::detect` — this
/// list only gates AST-level symbol extraction.
///
/// To add a language: add a tree-sitter grammar dependency in Cargo.toml,
/// a case in `treesitter::parse`, and add it here. No other module needs
/// to change.
pub fn supported_for_symbols(language: &str) -> bool {
    matches!(
        language,
        "rust" | "javascript" | "jsx" | "typescript" | "tsx" | "python"
    )
}

/// Parses `source` as `language` and returns whatever symbols we could
/// confidently extract. Returns an empty vec (never an error) on languages
/// we don't support yet or on parse failure — a workspace with one
/// unparseable file should never take down the whole indexing run.
pub fn extract_symbols(language: &str, source: &str) -> Vec<ExtractedSymbol> {
    if !supported_for_symbols(language) {
        return Vec::new();
    }
    treesitter::parse(language, source).unwrap_or_default()
}
