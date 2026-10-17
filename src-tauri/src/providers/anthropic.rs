use super::{AgentMessage, AgentTurn, AiProvider, AiResponse, ChatMessage, ModelSummary, ToolCall, ToolDefinition};
use anyhow::{anyhow, Context, Result};
use async_trait::async_trait;
use serde_json::{json, Value};

const API_URL: &str = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION: &str = "2023-06-01";

/// Lists models available to this API key. Called before the user has
/// necessarily saved anything, so it's a free function rather than a
/// method on AnthropicProvider (which requires a chosen model to build).
pub async fn list_models(api_key: &str) -> Result<Vec<ModelSummary>> {
    let response = super::http_client()
        .get("https://api.anthropic.com/v1/models")
        .header("x-api-key", api_key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .send()
        .await
        .context("request to Anthropic's models API failed")?;

    let status = response.status();
    let payload: serde_json::Value = response
        .json()
        .await
        .context("failed to parse Anthropic's models response")?;

    if !status.is_success() {
        let message = payload["error"]["message"]
            .as_str()
            .unwrap_or("unknown error");
        return Err(anyhow!("Anthropic API error ({status}): {message}"));
    }

    Ok(payload["data"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|m| {
            let id = m["id"].as_str()?.to_string();
            Some(ModelSummary {
                id,
                display_name: m["display_name"].as_str().map(|s| s.to_string()),
            })
        })
        .collect())
}

pub struct AnthropicProvider {
    api_key: String,
    model: String,
    client: reqwest::Client,
}

impl AnthropicProvider {
    pub fn new(api_key: String, model: String) -> Self {
        Self {
            api_key,
            model,
            client: super::http_client(),
        }
    }
}

#[async_trait]
impl AiProvider for AnthropicProvider {
    async fn send(&self, messages: &[ChatMessage]) -> Result<AiResponse> {
        let body = json!({
            "model": self.model,
            "max_tokens": 1024,
            "messages": messages,
        });

        let response = self
            .client
            .post(API_URL)
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", ANTHROPIC_VERSION)
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .context("request to Anthropic API failed")?;

        let status = response.status();
        let payload: serde_json::Value = response
            .json()
            .await
            .context("failed to parse Anthropic API response")?;

        if !status.is_success() {
            let message = payload["error"]["message"]
                .as_str()
                .unwrap_or("unknown error");
            return Err(anyhow!("Anthropic API error ({status}): {message}"));
        }

        let text = payload["content"]
            .as_array()
            .and_then(|blocks| blocks.iter().find_map(|b| b["text"].as_str()))
            .map(|s| s.to_string())
            .ok_or_else(|| anyhow!("unexpected Anthropic response shape: {payload}"))?;

        let usage = &payload["usage"];
        Ok(AiResponse {
            text,
            model: payload["model"].as_str().unwrap_or(&self.model).to_string(),
            input_tokens: usage["input_tokens"].as_u64(),
            output_tokens: usage["output_tokens"].as_u64(),
        })
    }

    async fn send_agent_turn(&self, history: &[AgentMessage], tools: &[ToolDefinition]) -> Result<AgentTurn> {
        let messages = to_anthropic_messages(history);
        let tool_defs: Vec<Value> = tools
            .iter()
            .map(|t| {
                json!({
                    "name": t.name,
                    "description": t.description,
                    "input_schema": t.parameters,
                })
            })
            .collect();

        let body = json!({
            "model": self.model,
            "max_tokens": 4096,
            "tools": tool_defs,
            "messages": messages,
        });

        let response = self
            .client
            .post(API_URL)
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", ANTHROPIC_VERSION)
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .context("request to Anthropic API failed")?;

        let status = response.status();
        let payload: Value = response
            .json()
            .await
            .context("failed to parse Anthropic API response")?;

        if !status.is_success() {
            let message = payload["error"]["message"]
                .as_str()
                .unwrap_or("unknown error");
            return Err(anyhow!("Anthropic API error ({status}): {message}"));
        }

        let mut text: Option<String> = None;
        let mut thinking: Option<String> = None;
        let mut tool_calls = Vec::new();
        for block in payload["content"].as_array().cloned().unwrap_or_default() {
            match block["type"].as_str() {
                Some("text") => {
                    let t = block["text"].as_str().unwrap_or_default();
                    text = Some(match text {
                        Some(existing) => format!("{existing}{t}"),
                        None => t.to_string(),
                    });
                }
                // Anthropic's extended-thinking mode isn't requested here
                // (it needs the returned thinking block's signature echoed
                // back on later turns, which interacts with tool_use in
                // ways that need real API testing to get right) — this
                // arm is defensive, not currently reachable.
                Some("thinking") => {
                    let t = block["thinking"].as_str().unwrap_or_default();
                    thinking = Some(match thinking {
                        Some(existing) => format!("{existing}{t}"),
                        None => t.to_string(),
                    });
                }
                Some("tool_use") => {
                    tool_calls.push(ToolCall {
                        id: block["id"].as_str().unwrap_or_default().to_string(),
                        name: block["name"].as_str().unwrap_or_default().to_string(),
                        arguments: block["input"].clone(),
                        thought_signature: None,
                    });
                }
                _ => {}
            }
        }

        let usage = &payload["usage"];
        Ok(AgentTurn {
            text,
            thinking,
            tool_calls,
            model: payload["model"].as_str().unwrap_or(&self.model).to_string(),
            input_tokens: usage["input_tokens"].as_u64(),
            output_tokens: usage["output_tokens"].as_u64(),
        })
    }
}

/// Converts our provider-agnostic history into Anthropic's message shape:
/// assistant turns carry `tool_use` content blocks, and tool results come
/// back as a `user` turn containing a `tool_result` block referencing the
/// original `tool_use_id`.
fn to_anthropic_messages(history: &[AgentMessage]) -> Vec<Value> {
    history
        .iter()
        .map(|m| match m {
            AgentMessage::User { text } => json!({ "role": "user", "content": text }),
            AgentMessage::Assistant { text, tool_calls } => {
                let mut content = Vec::new();
                if let Some(t) = text {
                    if !t.is_empty() {
                        content.push(json!({ "type": "text", "text": t }));
                    }
                }
                for tc in tool_calls {
                    content.push(json!({
                        "type": "tool_use",
                        "id": tc.id,
                        "name": tc.name,
                        "input": tc.arguments,
                    }));
                }
                json!({ "role": "assistant", "content": content })
            }
            AgentMessage::ToolResult { tool_call_id, content, .. } => {
                json!({
                    "role": "user",
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": tool_call_id,
                        "content": content,
                    }]
                })
            }
        })
        .collect()
}
