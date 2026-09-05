/// Model-weighted token accounting.
///
/// The global token budget is counted in *equivalent* tokens, not raw
/// ones: each model has an (input, output) weight derived from its listed
/// price per 1M tokens, normalized so a cheap default model (Gemini 2.0
/// Flash: $0.10 / $0.40 per 1M) weighs 1.0 / 4.0. An expensive model
/// (Claude Opus: $15 / $75) therefore burns 150x / 187x the budget of
/// Flash for the same raw token count, so the budget reflects real cost
/// across providers.
///
/// Unknown / local models default to 1.0 / 1.0 — i.e. the raw token
/// count is used unchanged.

/// Returns (input_weight, output_weight) for a (provider, model) pair.
/// Provider is one of "anthropic" | "gemini" | "openai_compatible" |
/// "ollama"; model is the exact id sent to the API (or as close as we
/// can match it).
pub fn weights(provider: &str, model: &str) -> (f64, f64) {
    let m = model.to_ascii_lowercase();
    match provider {
        "gemini" => gemini(&m),
        "anthropic" => anthropic(&m),
        "openai_compatible" => openai_compatible(&m),
        // Local models cost nothing per token; track raw usage.
        _ => (1.0, 1.0),
    }
}

/// Price per 1M tokens ($) as of 2025 — used to derive weights.
/// `p` is the price; weight = p * 10 (so $0.10/MTok -> 1.0).
fn w(p: f64) -> f64 {
    p * 10.0
}

fn gemini(m: &str) -> (f64, f64) {
    if m.contains("2.5-flash-lite") {
        (w(0.10), w(0.40))
    } else if m.contains("2.5-flash") {
        (w(0.30), w(2.50))
    } else if m.contains("2.5-pro") {
        (w(1.25), w(10.0))
    } else if m.contains("2.0-flash-lite") {
        (w(0.075), w(0.30))
    } else if m.contains("2.0-flash") {
        (w(0.10), w(0.40))
    } else if m.contains("1.5-flash") {
        (w(0.075), w(0.30))
    } else if m.contains("1.5-pro") {
        (w(1.25), w(5.0))
    } else {
        // Unknown Gemini model — assume the cheap tier.
        (w(0.10), w(0.40))
    }
}

fn anthropic(m: &str) -> (f64, f64) {
    if m.contains("opus") {
        (w(15.0), w(75.0))
    } else if m.contains("haiku") {
        (w(0.80), w(4.0))
    } else {
        // sonnet and everything else — the mid tier.
        (w(3.0), w(15.0))
    }
}

fn openai_compatible(m: &str) -> (f64, f64) {
    if m.contains("gpt-4o-mini") || m.contains("gpt-4.1-mini") || m.contains("gpt-4.1-nano") {
        (w(0.40), w(1.60))
    } else if m.contains("gpt-4o") || m.contains("gpt-4.1") {
        (w(2.50), w(10.0))
    } else if m.contains("gpt-4-turbo") {
        (w(10.0), w(30.0))
    } else if m.contains("gpt-4") {
        (w(30.0), w(60.0))
    } else if m.contains("gpt-3.5") {
        (w(0.50), w(1.50))
    } else if m.contains("o1-mini") {
        (w(3.0), w(12.0))
    } else if m.contains("o1") {
        (w(15.0), w(60.0))
    } else if m.contains("o3-mini") {
        (w(1.10), w(4.40))
    } else if m.contains("o3") {
        (w(2.0), w(8.0))
    } else if m.contains("deepseek") {
        (w(0.27), w(1.10))
    } else {
        // OpenRouter-style endpoints and anything else — raw tokens.
        (1.0, 1.0)
    }
}

/// Converts raw token counts to budget-equivalent tokens for a model.
pub fn equivalent_tokens(provider: &str, model: &str, input: u64, output: u64) -> u64 {
    let (wi, wo) = weights(provider, model);
    ((input as f64 * wi).round() as u64).saturating_add((output as f64 * wo).round() as u64)
}