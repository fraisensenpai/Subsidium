use super::{AgentMessage, AgentTurn, AiProvider, AiResponse, ChatMessage, ModelSummary, ToolCall, ToolDefinition};
use anyhow::{anyhow, Context, Result};
use async_trait::async_trait;
use serde_json::{json, Value};

pub struct OllamaProvider {
    base_url: String,
    model: String,
    client: reqwest::Client,
}

impl OllamaProvider {
    pub fn new(base_url: String, model: String) -> Self {
        Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            model,
            client: super::http_client(),
        }
    }
}

/// Lists models already pulled locally (`ollama pull ...`) — no API key
/// involved since Ollama runs on the user's own machine.
pub async fn list_models(base_url: &str) -> Result<Vec<ModelSummary>> {
    let base = base_url.trim_end_matches('/');
    let url = format!("{base}/api/tags");

    let response = super::http_client()
        .get(&url)
        .send()
        .await
        .context("request to Ollama failed — is it running (`ollama serve`)?")?;

    let status = response.status();
    let payload: serde_json::Value = response
        .json()
        .await
        .context("failed to parse Ollama's response")?;

    if !status.is_success() {
        return Err(anyhow!("Ollama error ({status})"));
    }

    Ok(payload["models"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|m| {
            let id = m["name"].as_str()?.to_string();
            Some(ModelSummary {
                id,
                display_name: None,
            })
        })
        .collect())
}

#[async_trait]
impl AiProvider for OllamaProvider {
    async fn send(&self, messages: &[ChatMessage]) -> Result<AiResponse> {
        let url = format!("{}/api/chat", self.base_url);
        let body = json!({
            "model": self.model,
            "messages": messages,
            "stream": false,
        });

        let response = self
            .client
            .post(&url)
            .json(&body)
            .send()
            .await
            .context("request to Ollama failed — is it running (`ollama serve`)?")?;

        let status = response.status();
        let payload: serde_json::Value = response
            .json()
            .await
            .context("failed to parse Ollama's response")?;

        if !status.is_success() {
            let message = payload["error"].as_str().unwrap_or("unknown error");
            return Err(anyhow!("Ollama error ({status}): {message}"));
        }

        let text = payload["message"]["content"]
            .as_str()
            .map(|s| s.to_string())
            .ok_or_else(|| anyhow!("unexpected Ollama response shape: {payload}"))?;

        Ok(AiResponse {
            text,
            model: payload["model"].as_str().unwrap_or(&self.model).to_string(),
            input_tokens: payload["prompt_eval_count"].as_u64(),
            output_tokens: payload["eval_count"].as_u64(),
        })
    }

    async fn send_agent_turn(&self, history: &[AgentMessage], tools: &[ToolDefinition]) -> Result<AgentTurn> {
        let url = format!("{}/api/chat", self.base_url);
        let messages = to_ollama_messages(history);
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
            "stream": false,
            // Reasoning-capable local models (deepseek-r1, qwq, ...) put
            // their chain-of-thought in message.thinking when this is set.
            // Ignored by models that don't support it — safe to always send.
            "think": true,
        });

        let response = self
            .client
            .post(&url)
            .json(&body)
            .send()
            .await
            .context("request to Ollama failed — is it running (`ollama serve`)?")?;

        let status = response.status();
        let payload: Value = response
            .json()
            .await
            .context("failed to parse Ollama's response")?;

        if !status.is_success() {
            let message = payload["error"].as_str().unwrap_or("unknown error");
            return Err(anyhow!("Ollama error ({status}): {message}"));
        }

        let message = &payload["message"];
        let text = message["content"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());
        let thinking = message["thinking"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());

        // Note: unlike OpenAI, Ollama doesn't hand back an id per tool
        // call, and `arguments` is already a JSON object (not a
        // JSON-encoded string) — we synthesize an id so the rest of the
        // agent loop can treat every provider uniformly.
        let mut tool_calls = Vec::new();
        for (i, tc) in message["tool_calls"].as_array().cloned().unwrap_or_default().into_iter().enumerate() {
            tool_calls.push(ToolCall {
                id: format!("call_{i}"),
                name: tc["function"]["name"].as_str().unwrap_or_default().to_string(),
                arguments: tc["function"]["arguments"].clone(),
                thought_signature: None,
            });
        }

        Ok(AgentTurn {
            text,
            thinking,
            tool_calls,
            model: payload["model"].as_str().unwrap_or(&self.model).to_string(),
            input_tokens: payload["prompt_eval_count"].as_u64(),
            output_tokens: payload["eval_count"].as_u64(),
        })
    }
}

fn to_ollama_messages(history: &[AgentMessage]) -> Vec<Value> {
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
                                "function": { "name": tc.name, "arguments": tc.arguments }
                            })
                        })
                        .collect();
                    msg["tool_calls"] = json!(calls);
                }
                msg
            }
            AgentMessage::ToolResult { name, content, .. } => {
                json!({ "role": "tool", "name": name, "content": content })
            }
        })
        .collect()
}
