/// Turns a free-form query into candidate identifier tokens, so
/// "authentication sırasında token neden kayboluyor?" also tries matching
/// against symbols/files literally named `token`, `authentication`, etc.
///
/// This is intentionally simple (split on non-alphanumerics, then split
/// camelCase/PascalCase boundaries, drop short/stopword tokens) rather
/// than real NLP — the structural search underneath is cheap enough that
/// over-generating candidate tokens and letting SQL do substring matching
/// is fine for Phase 2's scale.
pub fn identifier_tokens(query: &str) -> Vec<String> {
    const STOPWORDS: &[&str] = &[
        "the", "a", "an", "is", "are", "does", "do", "how", "why", "what", "when",
        "where", "and", "or", "not", "in", "on", "for", "to", "of", "neden", "nasıl",
        "niye", "mi", "mı", "mu", "mü", "sırasında", "ile", "ve", "bir",
    ];

    let mut tokens = Vec::new();

    for raw in query.split(|c: char| !c.is_alphanumeric()) {
        if raw.is_empty() {
            continue;
        }
        for part in split_word_boundaries(raw) {
            let lower = part.to_lowercase();
            if lower.len() < 3 || STOPWORDS.contains(&lower.as_str()) {
                continue;
            }
            if !tokens.contains(&lower) {
                tokens.push(lower);
            }
        }
    }

    tokens
}

/// Splits `authTokenExpired` -> ["auth", "Token", "Expired"] and leaves
/// `snake_case_name` alone (already split by the caller on `_`).
fn split_word_boundaries(word: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();

    for ch in word.chars() {
        if ch.is_uppercase() && !current.is_empty() {
            parts.push(std::mem::take(&mut current));
        }
        current.push(ch);
    }
    if !current.is_empty() {
        parts.push(current);
    }

    if parts.is_empty() {
        vec![word.to_string()]
    } else {
        parts
    }
}
