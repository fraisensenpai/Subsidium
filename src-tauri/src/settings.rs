use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

/// App-level settings, distinct from provider configs (which live in
/// `providers.json`). `token_limit` is the user's budget for agent turns;
/// `tokens_used` is the cumulative amount spent across conversations and
/// app restarts, so the limit stays meaningful. `0` as a limit means
/// "unlimited".
///
/// `tokens_used` is counted in *model-weighted* tokens (see pricing.rs):
/// an expensive model burns more budget than a cheap one for the same
/// raw token count. `usage_by_model` keeps the raw input/output counts
/// per model so the settings UI can show where the budget went.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    #[serde(default = "default_token_limit")]
    pub token_limit: u64,
    #[serde(default)]
    pub tokens_used: u64,
    #[serde(default)]
    pub usage_by_model: Vec<ModelUsageRecord>,
}

/// Cumulative usage attributable to one (provider, model) pair.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelUsageRecord {
    pub provider: String,
    pub model: String,
    /// Raw token counts reported by the API, kept for transparency.
    pub input_tokens: u64,
    pub output_tokens: u64,
    /// Model-weighted tokens consumed against the budget (see pricing.rs).
    pub weighted_tokens: u64,
}

fn default_token_limit() -> u64 {
    1_000_000
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            token_limit: default_token_limit(),
            tokens_used: 0,
            usage_by_model: Vec::new(),
        }
    }
}

/// Folds one turn's raw usage into the per-model records, creating the
/// record on first use and keeping the weighted total in sync.
pub fn add_model_usage(records: &mut Vec<ModelUsageRecord>, provider: &str, model: &str, input: u64, output: u64, weighted: u64) {
    if let Some(record) = records
        .iter_mut()
        .find(|r| r.provider == provider && r.model == model)
    {
        record.input_tokens = record.input_tokens.saturating_add(input);
        record.output_tokens = record.output_tokens.saturating_add(output);
        record.weighted_tokens = record.weighted_tokens.saturating_add(weighted);
    } else {
        records.push(ModelUsageRecord {
            provider: provider.to_string(),
            model: model.to_string(),
            input_tokens: input,
            output_tokens: output,
            weighted_tokens: weighted,
        });
    }
    records.sort_by(|a, b| b.weighted_tokens.cmp(&a.weighted_tokens));
}

/// What the settings UI is allowed to change in one call. Either field can
/// be omitted: `token_limit` sets the budget, `reset_usage` zeroes the
/// cumulative counter (e.g. at the start of a new billing period).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct AppSettingsUpdate {
    #[serde(default)]
    pub token_limit: Option<u64>,
    #[serde(default)]
    pub reset_usage: bool,
}

fn config_path() -> Result<std::path::PathBuf> {
    let dir = dirs::config_dir()
        .context("could not determine OS config directory")?
        .join("subsidium");
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("settings.json"))
}

pub fn load() -> Result<AppSettings> {
    let path = config_path()?;
    if !path.exists() {
        return Ok(AppSettings::default());
    }
    let content = std::fs::read_to_string(path)?;
    // A corrupted/partial file falls back to defaults rather than bricking
    // the settings UI.
    Ok(serde_json::from_str(&content).unwrap_or_default())
}

pub fn save(settings: &AppSettings) -> Result<()> {
    let path = config_path()?;
    std::fs::write(path, serde_json::to_string_pretty(settings)?)?;
    Ok(())
}