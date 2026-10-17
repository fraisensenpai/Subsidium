// Mirrors the serde-serialized structs in src-tauri/src/workspace/mod.rs
// and src-tauri/src/indexing/mod.rs. Keep in sync with the Rust side.

export interface FileNode {
  path: string; // relative to workspace root
  name: string;
  is_dir: boolean;
  language: string | null;
  children: FileNode[] | null;
}

export interface ScanSummary {
  workspace_root: string;
  total_files: number;
  total_dirs: number;
  ignored_count: number;
  by_language: Record<string, number>;
  duration_ms: number;
}

export interface SymbolInfo {
  name: string;
  kind: string; // function | class | method | interface | type | const | ...
  file: string;
  start_line: number;
  end_line: number;
}

export interface IndexStats {
  file_count: number;
  symbol_count: number;
  edge_count: number;
  last_indexed_at: string; // ISO 8601
}

export interface SearchHit {
  source: "symbol" | "file" | "text";
  file: string;
  line: number | null;
  snippet: string;
  symbol_name: string | null;
  symbol_kind: string | null;
}

export interface WorkspaceState {
  root: string | null;
  tree: FileNode | null;
  scanSummary: ScanSummary | null;
  indexStats: IndexStats | null;
}

export interface ProviderConfig {
  id: string;
  label: string;
  provider: "anthropic" | "gemini" | "openai_compatible" | "ollama";
  base_url: string | null;
  model: string;
  // Catalog preset (brand) this account was created from, e.g. "groq",
  // "openrouter", "lmstudio". Purely descriptive — the backend doesn't read
  // it, but the UI uses it to preselect the right preset and model list.
  preset?: string | null;
}

export interface AiResponse {
  text: string;
  model: string;
  input_tokens: number | null;
  output_tokens: number | null;
}

export interface ModelSummary {
  id: string;
  display_name: string | null;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface ToolLogEntry {
  tool_name: string;
  arguments: unknown;
  result_preview: string;
}

export interface AgentTurnResult {
  status: "final" | "pending_approval" | "stopped" | "aborted" | "limit_reached" | "step_limit";
  text: string | null;
  thinking: string | null;
  pending_tool: ToolCall | null;
  pending_description: string | null;
  pending_diff: string | null;
  tool_log: ToolLogEntry[];
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_input_tokens: number;
  total_output_tokens: number;
  conversation_id: number | null;
  // Global budget (all conversations, survives restarts).
  tokens_used: number;
  token_limit: number;
}

// Mirrors src-tauri/src/settings.rs AppSettings.
export interface AppSettings {
  token_limit: number;
  tokens_used: number;
  usage_by_model: ModelUsageRecord[];
  // Hours between automatic usage resets (0 = never).
  reset_interval_hours: number;
  // Unix timestamp (seconds) of the last reset; 0 when not started yet.
  last_reset_at: number;
}

// Mirrors src-tauri/src/settings.rs ModelUsageRecord.
export interface ModelUsageRecord {
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  weighted_tokens: number;
}

export interface ConversationSummary {
  id: number;
  title: string;
  updated_at: string;
}

// Mirrors the backend's providers::AgentMessage (#[serde(tag = "kind")]) —
// the raw, provider-agnostic wire history, as opposed to AgentChatEntry
// below which is what the panel actually renders.
export type AgentMessage =
  | { kind: "User"; text: string }
  | { kind: "Assistant"; text: string | null; tool_calls: ToolCall[] }
  | { kind: "ToolResult"; tool_call_id: string; name: string; content: string };

// Local chat transcript shape for the Agent panel — not a 1:1 mirror of
// the backend's AgentMessage (which is provider wire-format oriented);
// this is just what the UI needs to render a conversation.
export type AgentChatEntry =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; thinking: string | null; toolLog: ToolLogEntry[] }
  | { kind: "approval"; tool: ToolCall; description: string; diff: string | null; resolved: "approved" | "denied" | null }
  | { kind: "notice"; text: string; toolLog: ToolLogEntry[] }
  | { kind: "error"; text: string };
