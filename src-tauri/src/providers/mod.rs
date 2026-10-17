pub mod anthropic;
pub mod gemini;
pub mod ollama;
pub mod openai_compatible;

use anyhow::{Context, Result};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};

/// Shared `reqwest` client for every provider request. `reqwest::Client::new()`
/// sets **no** timeout, so a provider that accepts the connection but then
/// stalls — a hung gateway, a dropped network, a proxy that never answers —
/// would block the agent turn forever. Worse, the Stop button can't interrupt
/// it: the agent loop only checks the stop flag *after* the provider call
/// returns. A connect timeout fails fast on an unreachable host; the overall
/// request timeout bounds a slow or stalled response.
pub fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(180))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

/// A single turn in a conversation, provider-agnostic. Used for the
/// simple one-off "Test Connection" call.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String, // "user" | "assistant"
    pub content: String,
}

/// What a provider call returns: not just the reply text, but which model
/// actually answered and how many tokens it cost.
#[derive(Debug, Clone, Serialize)]
pub struct AiResponse {
    pub text: String,
    pub model: String,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
}

/// A tool the agent can call, described in JSON-schema form. Each provider
/// module translates this into whatever shape its own tool-calling API
/// expects (Anthropic's input_schema, OpenAI's function.parameters,
/// Gemini's function_declarations, ...).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value, // JSON Schema for the arguments object
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: serde_json::Value,
    /// Gemini-specific: some "thinking" models attach a `thoughtSignature`
    /// to a functionCall part and require it echoed back verbatim on the
    /// next turn, or the API rejects the request. `None` for every other
    /// provider — this field just rides along unused for them.
    #[serde(default)]
    pub thought_signature: Option<String>,
}

/// Provider-agnostic representation of one turn in an agent conversation.
/// Each provider module converts a `&[AgentMessage]` history to and from
/// its own wire format — nothing outside `providers/` needs to know the
/// difference between, say, Anthropic's content-block messages and
/// OpenAI's tool_calls array.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum AgentMessage {
    User {
        text: String,
    },
    Assistant {
        text: Option<String>,
        tool_calls: Vec<ToolCall>,
    },
    ToolResult {
        tool_call_id: String,
        name: String,
        content: String,
    },
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentTurn {
    pub text: Option<String>,
    /// Reasoning/"thinking" text, when the model and provider expose it.
    /// Best-effort and inconsistent across providers — see the note in
    /// each provider file for exactly what's captured and how it was
    /// requested (or not). `None` is the common case, not a bug.
    pub thinking: Option<String>,
    pub tool_calls: Vec<ToolCall>,
    pub model: String,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
}

/// Implemented once per vendor/API shape. Adding a new provider means
/// adding a new file in this module implementing this trait and a match
/// arm in `build_provider` — nothing else in the app depends on which
/// providers exist.
#[async_trait]
pub trait AiProvider: Send + Sync {
    /// Sends `messages` and returns the assistant's reply plus usage info.
    /// Used for the "Test Connection" flow.
    async fn send(&self, messages: &[ChatMessage]) -> Result<AiResponse>;

    /// One step of an agent conversation: sends the full history plus the
    /// available tools, and returns either final text, one or more tool
    /// calls to execute, or both. The agent loop in commands.rs drives
    /// this in a cycle until a turn comes back with no tool calls.
    async fn send_agent_turn(&self, history: &[AgentMessage], tools: &[ToolDefinition]) -> Result<AgentTurn>;
}

/// One configured AI account. The user can add as many of these as they
/// want (multiple providers, or multiple accounts of the same provider);
/// exactly one is "active" at a time for the agent to actually use. The
/// API key is never part of this struct — it lives in the OS keychain,
/// looked up by `id`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderConfig {
    /// Stable unique id, generated on first save (e.g. "anthropic-<ts>").
    /// Empty when the frontend is submitting a brand-new, not-yet-saved
    /// entry — `save_config` assigns a real one.
    #[serde(default)]
    pub id: String,
    /// User-facing name shown in the provider list, e.g. "Anthropic" or
    /// "Work OpenRouter". Defaults to the provider's display name if the
    /// user doesn't rename it.
    pub label: String,
    /// "anthropic" | "gemini" | "openai_compatible" | "ollama"
    pub provider: String,
    /// Required for "openai_compatible" and "ollama" (points at the
    /// server); ignored for "anthropic"/"gemini" (fixed endpoints).
    pub base_url: Option<String>,
    pub model: String,
    /// Which catalog preset (brand) this account was created from — e.g.
    /// "openai", "openrouter", "groq", "deepseek", "lmstudio". Descriptive
    /// only: `provider`, `base_url` and `model` already carry everything the
    /// request path needs. It lets the UI show the vendor name and offer the
    /// right curated model list. `None` for accounts created before presets
    /// existed, or a bare custom endpoint.
    #[serde(default)]
    pub preset: Option<String>,
}

/// One entry in a provider's model list, returned by each module's
/// `list_models` so the settings UI can offer a picker instead of asking
/// the user to type/remember an exact model id.
#[derive(Debug, Clone, Serialize)]
pub struct ModelSummary {
    pub id: String,
    pub display_name: Option<String>,
}

mod secrets {
    use anyhow::{Context, Result};

    const SERVICE: &str = "subsidium";

    /// Keyed by a ProviderConfig's `id`, not its provider type — so two
    /// accounts of the same provider (e.g. two different OpenRouter keys)
    /// don't collide.
    pub fn set_api_key(id: &str, key: &str) -> Result<()> {
        let entry = keyring::Entry::new(SERVICE, id)?;
        entry.set_password(key).context("failed to write API key to OS keychain")
    }

    pub fn get_api_key(id: &str) -> Result<Option<String>> {
        let entry = keyring::Entry::new(SERVICE, id)?;
        match entry.get_password() {
            Ok(key) => Ok(Some(key)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    pub fn delete_api_key(id: &str) -> Result<()> {
        let entry = keyring::Entry::new(SERVICE, id)?;
        match entry.delete_password() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
}

pub use secrets::{delete_api_key, get_api_key, set_api_key};

#[derive(Debug, Default, Serialize, Deserialize)]
struct ProvidersFile {
    #[serde(default)]
    providers: Vec<ProviderConfig>,
    #[serde(default)]
    active_id: Option<String>,
}

fn config_path() -> Result<std::path::PathBuf> {
    let dir = dirs::config_dir()
        .context("could not determine OS config directory")?
        .join("subsidium");
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("providers.json"))
}

fn read_file() -> Result<ProvidersFile> {
    let path = config_path()?;
    if !path.exists() {
        return Ok(ProvidersFile::default());
    }
    let content = std::fs::read_to_string(path)?;
    Ok(serde_json::from_str(&content).unwrap_or_default())
}

fn write_file(file: &ProvidersFile) -> Result<()> {
    let path = config_path()?;
    std::fs::write(path, serde_json::to_string_pretty(file)?)?;
    Ok(())
}

pub fn list_configs() -> Result<Vec<ProviderConfig>> {
    Ok(read_file()?.providers)
}

/// Creates or updates a provider entry. A blank `id` means "new" — one is
/// generated from the provider type + a timestamp. If this is the first
/// provider ever added, it's made active automatically (nothing to choose
/// between yet). Returns the saved config (with its id filled in) so the
/// caller can track it.
pub fn save_config(mut config: ProviderConfig) -> Result<ProviderConfig> {
    let mut file = read_file()?;

    if config.id.is_empty() {
        config.id = format!(
            "{}-{}",
            config.provider,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        );
    }

    if let Some(existing) = file.providers.iter_mut().find(|p| p.id == config.id) {
        *existing = config.clone();
    } else {
        file.providers.push(config.clone());
    }

    if file.active_id.is_none() {
        file.active_id = Some(config.id.clone());
    }

    write_file(&file)?;
    Ok(config)
}

pub fn delete_config(id: &str) -> Result<()> {
    let mut file = read_file()?;
    file.providers.retain(|p| p.id != id);
    if file.active_id.as_deref() == Some(id) {
        file.active_id = file.providers.first().map(|p| p.id.clone());
    }
    write_file(&file)?;
    let _ = delete_api_key(id);
    Ok(())
}

pub fn set_active(id: &str) -> Result<()> {
    let mut file = read_file()?;
    if !file.providers.iter().any(|p| p.id == id) {
        anyhow::bail!("no provider config with id {id}");
    }
    file.active_id = Some(id.to_string());
    write_file(&file)
}

pub fn get_active_config() -> Result<Option<ProviderConfig>> {
    let file = read_file()?;
    Ok(file
        .active_id
        .and_then(|id| file.providers.into_iter().find(|p| p.id == id)))
}

/// Builds the concrete provider from a config and an API key. The key is
/// passed in explicitly (rather than this function reaching into the
/// keychain itself) so the same code path works for both a saved config
/// (caller looks the key up by id) and a not-yet-saved one being tested
/// live from the settings form (caller passes what the user just typed).
/// Lists the models available to an already-saved provider config: loads
/// its stored key (when it needs one), calls the provider's models API,
/// and returns the pickable options. Used by the chat's in-place model
/// switcher (and the settings form once a key is saved) so the user
/// never has to type/remember an exact model id.
pub async fn list_models_for(config: &ProviderConfig, api_key: Option<String>) -> Result<Vec<ModelSummary>> {
    match config.provider.as_str() {
        "anthropic" => {
            let key = api_key.context("no API key for this Anthropic account")?;
            anthropic::list_models(&key).await
        }
        "gemini" => {
            let key = api_key.context("no API key for this Gemini account")?;
            gemini::list_models(&key).await
        }
        "openai_compatible" => {
            // Local gateways (LM Studio, vLLM, LocalAI) commonly need no
            // key at all — send an empty one rather than refusing outright;
            // a real gateway that does need one answers with a clear 401.
            let key = api_key.unwrap_or_default();
            let base_url = config
                .base_url
                .clone()
                .context("base_url is required for an OpenAI-compatible provider")?;
            openai_compatible::list_models(&base_url, &key).await
        }
        "ollama" => {
            let base_url = config
                .base_url
                .clone()
                .unwrap_or_else(|| "http://localhost:11434".to_string());
            ollama::list_models(&base_url).await
        }
        other => anyhow::bail!("unknown provider: {other}"),
    }
}

pub fn build_provider(config: &ProviderConfig, api_key: Option<String>) -> Result<Box<dyn AiProvider>> {
    Ok(match config.provider.as_str() {
        "anthropic" => {
            let key = api_key.context("no API key for this Anthropic account")?;
            Box::new(anthropic::AnthropicProvider::new(key, config.model.clone()))
        }
        "gemini" => {
            let key = api_key.context("no API key for this Gemini account")?;
            Box::new(gemini::GeminiProvider::new(key, config.model.clone()))
        }
        "openai_compatible" => {
            // See the note in `list_models_for`: an empty key is allowed so
            // keyless local servers (LM Studio, vLLM, …) work.
            let key = api_key.unwrap_or_default();
            let base_url = config
                .base_url
                .clone()
                .context("base_url is required for an OpenAI-compatible provider")?;
            Box::new(openai_compatible::OpenAiCompatibleProvider::new(
                base_url,
                key,
                config.model.clone(),
            ))
        }
        "ollama" => {
            let base_url = config
                .base_url
                .clone()
                .unwrap_or_else(|| "http://localhost:11434".to_string());
            Box::new(ollama::OllamaProvider::new(base_url, config.model.clone()))
        }
        other => anyhow::bail!("unknown provider: {other}"),
    })
}
