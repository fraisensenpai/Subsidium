//! AST-based symbol extraction.
//!
//! NOTE on versions: tree-sitter grammar crates occasionally rename their
//! entrypoint function between releases (e.g. `language()` vs a `LANGUAGE`
//! const vs per-dialect functions like `language_typescript()`). The calls
//! below match the tree-sitter-{rust,javascript,typescript,python} 0.21.x
//! series; if `cargo build` reports a missing symbol here, check that
//! crate's docs.rs page for its current entrypoint and adjust just this
//! file — nothing else depends on these exact names.

use super::{ExtractedSymbol, SymbolKind};
use anyhow::{anyhow, Result};
use tree_sitter::{Language, Node, Parser, Query, QueryCursor};

pub fn parse(language: &str, source: &str) -> Result<Vec<ExtractedSymbol>> {
    let (ts_language, query_src) = grammar_for(language)?;

    let mut parser = Parser::new();
    parser.set_language(&ts_language)?;
    let tree = parser
        .parse(source, None)
        .ok_or_else(|| anyhow!("tree-sitter failed to parse source"))?;

    let query = Query::new(&ts_language, query_src)?;
    let mut cursor = QueryCursor::new();
    let bytes = source.as_bytes();

    let mut symbols = Vec::new();
    let mut matches = cursor.matches(&query, tree.root_node(), bytes);
    while let Some(m) = matches.next() {
        for capture in m.captures {
            let capture_name = query.capture_names()[capture.index as usize];
            let (kind, def_node) = match capture_name {
                "function.name" => (SymbolKind::Function, enclosing(capture.node)),
                "method.name" => (SymbolKind::Method, enclosing(capture.node)),
                "class.name" => (SymbolKind::Class, enclosing(capture.node)),
                "struct.name" => (SymbolKind::Struct, enclosing(capture.node)),
                "enum.name" => (SymbolKind::Enum, enclosing(capture.node)),
                "interface.name" => (SymbolKind::Interface, enclosing(capture.node)),
                "type.name" => (SymbolKind::TypeAlias, enclosing(capture.node)),
                _ => continue,
            };

            let name = capture
                .node
                .utf8_text(bytes)
                .unwrap_or("<unknown>")
                .to_string();

            symbols.push(ExtractedSymbol {
                name,
                kind,
                start_line: def_node.start_position().row + 1,
                end_line: def_node.end_position().row + 1,
            });
        }
    }

    Ok(symbols)
}

/// The capture is on the identifier node; walk up to its parent
/// (the actual function/class/etc. definition) to get accurate line span.
fn enclosing(name_node: Node) -> Node {
    name_node.parent().unwrap_or(name_node)
}

fn grammar_for(language: &str) -> Result<(Language, &'static str)> {
    Ok(match language {
        "rust" => (tree_sitter_rust::language(), RUST_QUERY),
        "javascript" | "jsx" => (tree_sitter_javascript::language(), JS_QUERY),
        "typescript" => (tree_sitter_typescript::language_typescript(), TS_QUERY),
        "tsx" => (tree_sitter_typescript::language_tsx(), TS_QUERY),
        "python" => (tree_sitter_python::language(), PYTHON_QUERY),
        other => return Err(anyhow!("no grammar wired up for language: {other}")),
    })
}

const RUST_QUERY: &str = r#"
(function_item name: (identifier) @function.name)
(struct_item name: (type_identifier) @struct.name)
(enum_item name: (type_identifier) @enum.name)
(trait_item name: (type_identifier) @interface.name)
(const_item name: (identifier) @function.name)
"#;

const JS_QUERY: &str = r#"
(function_declaration name: (identifier) @function.name)
(class_declaration name: (identifier) @class.name)
(method_definition name: (property_identifier) @method.name)
"#;

const TS_QUERY: &str = r#"
(function_declaration name: (identifier) @function.name)
(class_declaration name: (type_identifier) @class.name)
(method_definition name: (property_identifier) @method.name)
(interface_declaration name: (type_identifier) @interface.name)
(type_alias_declaration name: (type_identifier) @type.name)
"#;

const PYTHON_QUERY: &str = r#"
(function_definition name: (identifier) @function.name)
(class_definition name: (identifier) @class.name)
"#;
