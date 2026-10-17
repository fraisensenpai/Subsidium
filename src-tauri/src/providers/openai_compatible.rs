use super::{AgentMessage, AgentTurn, AiProvider, AiResponse, ChatMessage, ModelSummary, ToolCall, ToolDefinition};
use anyhow::{anyhow, Context, Result};
use async_trait::async_trait;
use serde_json::{json, Value};

pub struct OpenAiCompatibleProvider {
    base_url: String,
    api_key: String,
    model: String,
    client: reqwest::Client,
}

impl OpenAiCompatibleProvider {
    pub fn new(base_url: String, api_key: String, model: String) -> Self {
        Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            api_key,
            model,
            client: super::http_client(),
        }
    }
}

/// Lists models via the standard `GET /models` endpoint most
/// OpenAI-compatible providers (OpenAI itself, OpenRouter, Groq, ...)
/// expose. Some gateways serve entries with no useful `id` — those are
/// filtered out rather than shown as blank options.
pub async fn list_models(base_url: &str, api_key: &str) -> Result<Vec<ModelSummary>> {
    let base = base_url.trim_end_matches('/');
    let url = format!("{base}/models");

    let response = super::http_client()
        .get(&url)
        .bearer_auth(api_key)
        .send()
        .await
        .context("request to the models endpoint failed")?;

    let status = response.status();
    let payload: serde_json::Value = response
        .json()
        .await
        .context("failed to parse the models response")?;

    if !status.is_success() {
        let message = payload["error"]["message"]
            .as_str()
            .unwrap_or("unknown error");
        return Err(anyhow!("API error ({status}): {message}"));
    }

    let mut models: Vec<ModelSummary> = payload["data"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|m| {
            let id = m["id"].as_str()?.to_string();
            if id.is_empty() {
                return None;
            }
            Some(ModelSummary {
                id,
                display_name: None,
            })
        })
        .collect();

    models.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(models)
}

#[async_trait]
impl AiProvider for OpenAiCompatibleProvider {
    async fn send(&self, messages: &[ChatMessage]) -> Result<AiResponse> {
        let url = format!("{}/chat/completions", self.base_url);
        let body = json!({
            "model": self.model,
            "messages": messages,
            // Some OpenAI-compatible gateways (OpenRouter in particular)
            // reserve credits up front based on max_tokens, defaulting to
            // a model's full context window if it's omitted — which can
            // trigger a 402 even though the actual reply is short. Cap it
            // to something reasonable; raise this if you need longer
            // replies once agent turns need more room.
            "max_tokens": 4096,
        });

        let response = self
            .client
            .post(&url)
            .bearer_auth(&self.api_key)
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .context("request to the OpenAI-compatible API failed")?;

        let status = response.status();
        let payload: serde_json::Value = response
            .json()
            .await
            .context("failed to parse the API response")?;

        if !status.is_success() {
            let message = payload["error"]["message"]
                .as_str()
                .unwrap_or("unknown error");
            return Err(anyhow!("API error ({status}): {message}"));
        }

        let text = payload["choices"][0]["message"]["content"]
            .as_str()
            .map(|s| s.to_string())
            .ok_or_else(|| anyhow!("unexpected response shape: {payload}"))?;

        let usage = &payload["usage"];
        Ok(AiResponse {
            text,
            model: payload["model"].as_str().unwrap_or(&self.model).to_string(),
            input_tokens: usage["prompt_tokens"].as_u64(),
            output_tokens: usage["completion_tokens"].as_u64(),
        })
    }

    async fn send_agent_turn(&self, history: &[AgentMessage], tools: &[ToolDefinition]) -> Result<AgentTurn> {
        let url = format!("{}/chat/completions", self.base_url);
        let messages = to_openai_messages(history);
        let tool_defs: Vec<Value> = tools
            .iter()
            .map(|t| {
                json!({
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.parameters,
                    }
                })
            })
            .collect();

        let body = json!({
            "model": self.model,
            "messages": messages,
            "tools": tool_defs,
            "max_tokens": 4096,
        });

        let response = self
            .client
            .post(&url)
            .bearer_auth(&self.api_key)
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .context("request to the OpenAI-compatible API failed")?;

        let status = response.status();
        let payload: Value = response
            .json()
            .await
            .context("failed to parse the API response")?;

        if !status.is_success() {
            let message = payload["error"]["message"]
                .as_str()
                .unwrap_or("unknown error");
            return Err(anyhow!("API error ({status}): {message}"));
        }

        let message = &payload["choices"][0]["message"];
        let text = message["content"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());

        // Not a standardized OpenAI field, but several gateways that route
        // to reasoning-capable models (OpenRouter in particular) attach a
        // "reasoning" string to the message. Passive best-effort capture —
        // no request param requests it, since that varies per gateway.
        let thinking = message["reasoning"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());

        let mut tool_calls = Vec::new();
        for tc in message["tool_calls"].as_array().cloned().unwrap_or_default() {
            let id = tc["id"].as_str().unwrap_or_default().to_string();
            let name = tc["function"]["name"].as_str().unwrap_or_default().to_string();
            let args_str = tc["function"]["arguments"].as_str().unwrap_or("{}");
            let arguments: Value = serde_json::from_str(args_str).unwrap_or(json!({}));
            tool_calls.push(ToolCall { id, name, arguments, thought_signature: None });
        }

        let usage = &payload["usage"];
        Ok(AgentTurn {
            text,
            thinking,
            tool_calls,
            model: payload["model"].as_str().unwrap_or(&self.model).to_string(),
            input_tokens: usage["prompt_tokens"].as_u64(),
            output_tokens: usage["completion_tokens"].as_u64(),
        })
    }
}

/// OpenAI's shape: assistant turns carry a `tool_calls` array (arguments
/// JSON-encoded as a *string*, not a nested object), and each tool result
/// is its own message with `role: "tool"` referencing `tool_call_id`.
fn to_openai_messages(history: &[AgentMessage]) -> Vec<Value> {
    history
        .iter()
        .map(|m| match m {
            AgentMessage::User { text } => json!({ "role": "user", "content": text }),
            AgentMessage::Assistant { text, tool_calls } => {
                let mut msg = json!({
                    "role": "assistant",
                    "content": text.clone().unwrap_or_default(),
                });
                if !tool_calls.is_empty() {
                    let calls: Vec<Value> = tool_calls
                        .iter()
                        .map(|tc| {
                            json!({
                                "id": tc.id,
                                "type": "function",
                                "function": {
                                    "name": tc.name,
                                    "arguments": serde_json::to_string(&tc.arguments).unwrap_or_default(),
                                }
                            })
                        })
                        .collect();
                    msg["tool_calls"] = json!(calls);
                }
                msg
            }
            AgentMessage::ToolResult { tool_call_id, content, .. } => {
                json!({ "role": "tool", "tool_call_id": tool_call_id, "content": content })
            }
        })
        .collect()
}
