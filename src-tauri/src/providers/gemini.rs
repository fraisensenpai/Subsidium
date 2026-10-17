use super::{AgentMessage, AgentTurn, AiProvider, AiResponse, ChatMessage, ModelSummary, ToolCall, ToolDefinition};
use anyhow::{anyhow, Context, Result};
use async_trait::async_trait;
use serde_json::{json, Value};

pub struct GeminiProvider {
    api_key: String,
    model: String,
    client: reqwest::Client,
}

impl GeminiProvider {
    pub fn new(api_key: String, model: String) -> Self {
        Self {
            api_key,
            model,
            client: super::http_client(),
        }
    }
}

/// Lists models this key can use, filtered to ones that actually support
/// `generateContent` (the API also returns embedding-only models etc.,
/// which would be useless as chat options here).
pub async fn list_models(api_key: &str) -> Result<Vec<ModelSummary>> {
    let url = format!("https://generativelanguage.googleapis.com/v1beta/models?key={api_key}");
    let response = super::http_client()
        .get(&url)
        .send()
        .await
        .context("request to Gemini's models API failed")?;

    let status = response.status();
    let payload: serde_json::Value = response
        .json()
        .await
        .context("failed to parse Gemini's models response")?;

    if !status.is_success() {
        let message = payload["error"]["message"]
            .as_str()
            .unwrap_or("unknown error");
        return Err(anyhow!("Gemini API error ({status}): {message}"));
    }

    Ok(payload["models"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|m| {
            m["supportedGenerationMethods"]
                .as_array()
                .map(|methods| methods.iter().any(|method| method == "generateContent"))
                .unwrap_or(false)
        })
        .filter_map(|m| {
            let full_name = m["name"].as_str()?; // "models/gemini-2.5-flash"
            let id = full_name.strip_prefix("models/").unwrap_or(full_name).to_string();
            Some(ModelSummary {
                id,
                display_name: m["displayName"].as_str().map(|s| s.to_string()),
            })
        })
        .collect())
}

#[async_trait]
impl AiProvider for GeminiProvider {
    async fn send(&self, messages: &[ChatMessage]) -> Result<AiResponse> {
        let url = format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
            self.model, self.api_key
        );

        // Gemini uses "model" instead of "assistant" for the other side of
        // the conversation, and nests text under contents[].parts[].text
        // rather than a flat content string.
        let contents: Vec<_> = messages
            .iter()
            .map(|m| {
                let role = if m.role == "assistant" { "model" } else { "user" };
                json!({ "role": role, "parts": [{ "text": m.content }] })
            })
            .collect();

        let body = json!({ "contents": contents });

        let response = self
            .client
            .post(&url)
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .context("request to the Gemini API failed")?;

        let status = response.status();
        let payload: serde_json::Value = response
            .json()
            .await
            .context("failed to parse Gemini's response")?;

        if !status.is_success() {
            let message = payload["error"]["message"]
                .as_str()
                .unwrap_or("unknown error");
            return Err(anyhow!("Gemini API error ({status}): {message}"));
        }

        let text = payload["candidates"][0]["content"]["parts"][0]["text"]
            .as_str()
            .ok_or_else(|| anyhow!("unexpected Gemini response shape: {payload}"))?
            .to_string();

        let usage = &payload["usageMetadata"];
        Ok(AiResponse {
            text,
            model: self.model.clone(),
            input_tokens: usage["promptTokenCount"].as_u64(),
            output_tokens: usage["candidatesTokenCount"].as_u64(),
        })
    }

    async fn send_agent_turn(&self, history: &[AgentMessage], tools: &[ToolDefinition]) -> Result<AgentTurn> {
        let url = format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
            self.model, self.api_key
        );

        let contents = to_gemini_contents(history);
        let function_declarations: Vec<Value> = tools
            .iter()
            .map(|t| {
                json!({
                    "name": t.name,
                    "description": t.description,
                    "parameters": t.parameters,
                })
            })
            .collect();

        let body = json!({
            "contents": contents,
            "tools": [{ "function_declarations": function_declarations }],
            // Ask "thinking" Gemini models to include a summary of their
            // reasoning in the response parts (as parts with "thought":
            // true) rather than just the final answer.
            "generationConfig": { "thinkingConfig": { "includeThoughts": true } },
        });

        let response = self
            .client
            .post(&url)
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .context("request to the Gemini API failed")?;

        let status = response.status();
        let payload: Value = response
            .json()
            .await
            .context("failed to parse Gemini's response")?;

        if !status.is_success() {
            let message = payload["error"]["message"]
                .as_str()
                .unwrap_or("unknown error");
            return Err(anyhow!("Gemini API error ({status}): {message}"));
        }

        let mut text: Option<String> = None;
        let mut thinking: Option<String> = None;
        let mut tool_calls = Vec::new();
        let parts = payload["candidates"][0]["content"]["parts"]
            .as_array()
            .cloned()
            .unwrap_or_default();

        for (i, part) in parts.into_iter().enumerate() {
            let is_thought = part["thought"].as_bool().unwrap_or(false);
            if let Some(t) = part["text"].as_str() {
                if is_thought {
                    thinking = Some(match thinking {
                        Some(existing) => format!("{existing}{t}"),
                        None => t.to_string(),
                    });
                } else {
                    text = Some(match text {
                        Some(existing) => format!("{existing}{t}"),
                        None => t.to_string(),
                    });
                }
            }
            if part.get("functionCall").is_some() {
                let fc = &part["functionCall"];
                tool_calls.push(ToolCall {
                    // Gemini doesn't hand back a call id, unlike Anthropic/
                    // OpenAI — we synthesize one and use it consistently
                    // when building the functionResponse turn below.
                    id: format!("call_{i}"),
                    name: fc["name"].as_str().unwrap_or_default().to_string(),
                    arguments: fc["args"].clone(),
                    // "Thinking" Gemini models attach this to the Part
                    // alongside functionCall and require it echoed back
                    // verbatim on the next turn (see to_gemini_contents
                    // below) or the API rejects the request with a 400.
                    thought_signature: part["thoughtSignature"].as_str().map(|s| s.to_string()),
                });
            }
        }

        let usage = &payload["usageMetadata"];
        Ok(AgentTurn {
            text,
            thinking,
            tool_calls,
            model: self.model.clone(),
            input_tokens: usage["promptTokenCount"].as_u64(),
            output_tokens: usage["candidatesTokenCount"].as_u64(),
        })
    }
}

/// Converts our provider-agnostic history into Gemini's `contents` shape.
fn to_gemini_contents(history: &[AgentMessage]) -> Vec<Value> {
    history
        .iter()
        .map(|m| match m {
            AgentMessage::User { text } => json!({ "role": "user", "parts": [{ "text": text }] }),
            AgentMessage::Assistant { text, tool_calls } => {
                let mut parts = Vec::new();
                if let Some(t) = text {
                    if !t.is_empty() {
                        parts.push(json!({ "text": t }));
                    }
                }
                for tc in tool_calls {
                    let mut part = json!({ "functionCall": { "name": tc.name, "args": tc.arguments } });
                    if let Some(sig) = &tc.thought_signature {
                        // Required by "thinking" Gemini models on replay —
                        // see the note where this is captured, above.
                        part["thoughtSignature"] = json!(sig);
                    }
                    parts.push(part);
                }
                json!({ "role": "model", "parts": parts })
            }
            AgentMessage::ToolResult { name, content, .. } => {
                // Gemini rejects a "function" role (confirmed against a
                // live 400 error listing valid roles) — a functionResponse
                // part is sent back as a "user" turn instead.
                json!({
                    "role": "user",
                    "parts": [{
                        "functionResponse": {
                            "name": name,
                            "response": { "content": content },
                        }
                    }]
                })
            }
        })
        .collect()
}
