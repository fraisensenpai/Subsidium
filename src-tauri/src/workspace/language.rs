/// Best-effort language detection from a file extension. This drives both
/// the "language" badge in the Explorer UI and the by-language counts in
/// ScanSummary. It is intentionally decoupled from which languages we can
/// actually *parse* (see parsing::supported_for_symbols) — Subsidium should
/// still show/index-as-a-file any language it can't extract symbols from
/// yet, rather than skipping it silently.
pub fn detect(path: &std::path::Path) -> Option<String> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    let lang = match ext.as_str() {
        "rs" => "rust",
        "ts" => "typescript",
        "tsx" => "tsx",
        "js" | "mjs" | "cjs" => "javascript",
        "jsx" => "jsx",
        "py" | "pyi" => "python",
        "go" => "go",
        "java" => "java",
        "kt" | "kts" => "kotlin",
        "c" | "h" => "c",
        "cpp" | "cc" | "cxx" | "hpp" => "cpp",
        "cs" => "csharp",
        "rb" => "ruby",
        "php" => "php",
        "swift" => "swift",
        "json" => "json",
        "toml" => "toml",
        "yaml" | "yml" => "yaml",
        "md" | "mdx" => "markdown",
        "html" => "html",
        "css" | "scss" | "less" => "css",
        "sql" => "sql",
        _ => return None,
    };
    Some(lang.to_string())
}
