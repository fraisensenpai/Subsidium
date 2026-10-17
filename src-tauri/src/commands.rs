use crate::agent;
use crate::indexing::{self, IndexStats};
use crate::pricing;
use crate::providers::{self, AgentMessage, ChatMessage, ProviderConfig, ToolCall};
use crate::retrieval::{self, SearchHit};
use crate::settings::{self, add_model_usage, AppSettings, AppSettingsUpdate};
use crate::terminal;
use crate::workspace::{FileNode, ScanSummary};
use crate::AppState;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use tauri::{AppHandle, State};

/// Runs the full Phase 1 pipeline for a newly selected workspace:
/// discover files -> apply ignore rules -> parse supported languages ->
/// update the structural index -> return everything the UI needs to
/// render the Explorer and Project Intelligence panels.
#[tauri::command]
pub async fn open_workspace(
    root: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(FileNode, ScanSummary, IndexStats), String> {
    let root_path = PathBuf::from(root);

    let (tree, summary, stats) = tauri::async_runtime::spawn_blocking(move || {
        indexing::build_index(&root_path)
    })
    .await
    .map_err(|e| format!("indexing task panicked: {e}"))?
    .map_err(|e| e.to_string())?;

    let workspace_root = PathBuf::from(&summary.workspace_root);
    *state.active_root.lock().unwrap() = Some(workspace_root.clone());

    // Move the terminal's idle shell into the new workspace so it opens
    // (and any manual commands run) in the selected folder.
    let session = state.running_terminal.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _ = terminal::spawn_shell(&app, &workspace_root, &session);
    });

    Ok((tree, summary, stats))
}

/// Re-reads the index stats for the currently active workspace without
/// re-scanning — cheap status check, e.g. after a file-watcher event in a
/// later phase triggers a background re-index.
#[tauri::command]
pub async fn get_index_stats(state: State<'_, AppState>) -> Result<IndexStats, String> {
    let root = state
        .active_root
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "no workspace is open".to_string())?;

    tauri::async_runtime::spawn_blocking(move || indexing::stats_for(&root))
        .await
        .map_err(|e| format!("task panicked: {e}"))?
        .map_err(|e| e.to_string())
}

/// Re-scans the workspace and returns the fresh file tree — used after the
/// agent creates or changes files so the Explorer reflects them. Also runs a
/// *shallow* index pass (`build_index_shallow`): new files get a `files`
/// row and their symbols parsed, and rows for deleted files are dropped, so
/// a file a `run_command` generated is immediately findable in Search.
/// Existing files are left untouched (never re-read), so this stays far
/// cheaper than `open_workspace`'s full hash pass.
#[tauri::command]
pub async fn refresh_file_tree(state: State<'_, AppState>) -> Result<FileNode, String> {
    let root = state
        .active_root
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "no workspace is open".to_string())?;

    tauri::async_runtime::spawn_blocking(move || indexing::build_index_shallow(&root).map(|(tree, _stats)| tree))
        .await
        .map_err(|e| format!("refresh task panicked: {e}"))?
        .map_err(|e| e.to_string())
}

/// Runs the retrieval layer (symbol name / file name / full-text search)
/// against the currently open workspace. This is what the Context Engine
/// will build on in the next phase — for now the UI shows raw results
/// directly so the retrieval quality can be sanity-checked on real
/// workspaces before an AI provider is wired up to consume it.
#[tauri::command]
pub async fn search_workspace(
    query: String,
    state: State<'_, AppState>,
) -> Result<Vec<SearchHit>, String> {
    let root = state
        .active_root
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "no workspace is open".to_string())?;

    tauri::async_runtime::spawn_blocking(move || retrieval::search(&root, &query))
        .await
        .map_err(|e| format!("search task panicked: {e}"))?
        .map_err(|e| e.to_string())
}

/// Reads a file's current content for the code editor. `relative_path` is
/// relative to the active workspace root — the frontend never sees or
/// sends absolute paths.
#[tauri::command]
pub async fn read_file(relative_path: String, state: State<'_, AppState>) -> Result<String, String> {
    let root = state
        .active_root
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "no workspace is open".to_string())?;

    tauri::async_runtime::spawn_blocking(move || {
        let full = crate::workspace::resolve_workspace_path(&root, &relative_path)
            .map_err(|e| e.to_string())?;
        std::fs::read_to_string(full).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("read task panicked: {e}"))?
}

/// Writes the editor's content to disk and incrementally re-indexes just
/// that file, so search/symbol results reflect the edit immediately
/// without a full workspace re-scan. This is manual editing (the human in
/// the app editing a file directly) — separate from the eventual
/// agent-proposes-a-diff flow in a later phase, which will reuse this
/// same write path once a change is approved.
#[tauri::command]
pub async fn write_file(
    relative_path: String,
    content: String,
    state: State<'_, AppState>,
) -> Result<IndexStats, String> {
    let root = state
        .active_root
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "no workspace is open".to_string())?;

    let root_for_write = root.clone();
    let relative_for_write = relative_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let full = crate::workspace::resolve_workspace_path(&root_for_write, &relative_for_write)
            .map_err(|e| e.to_string())?;
        std::fs::write(full, content).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("write task panicked: {e}"))??;

    tauri::async_runtime::spawn_blocking(move || indexing::reindex_file(&root, &relative_path))
        .await
        .map_err(|e| format!("reindex task panicked: {e}"))?
        .map_err(|e| e.to_string())
}

/// Lists models the given (possibly not-yet-saved) provider credentials
/// can see, so the settings UI can offer a picker instead of the user
/// having to type/remember an exact model id.
#[tauri::command]
pub async fn list_provider_models(
    provider: String,
    base_url: Option<String>,
    api_key: Option<String>,
) -> Result<Vec<providers::ModelSummary>, String> {
    let key = api_key.filter(|k| !k.is_empty());

    let result = match provider.as_str() {
        "anthropic" => {
            let key = key.ok_or_else(|| "Enter an API key first".to_string())?;
            providers::anthropic::list_models(&key).await
        }
        "gemini" => {
            let key = key.ok_or_else(|| "Enter an API key first".to_string())?;
            providers::gemini::list_models(&key).await
        }
        "openai_compatible" => {
            // Local gateways (LM Studio, vLLM, LocalAI) often need no key.
            let key = key.unwrap_or_default();
            let base = base_url.ok_or_else(|| "Enter a base URL first".to_string())?;
            providers::openai_compatible::list_models(&base, &key).await
        }
        "ollama" => {
            let base = base_url.unwrap_or_else(|| "http://localhost:11434".to_string());
            providers::ollama::list_models(&base).await
        }
        other => Err(anyhow::anyhow!("unknown provider: {other}")),
    };

    result.map_err(|e| e.to_string())
}

/// Lists the models available to an already-saved provider config (by
/// id) — the chat panel's in-place model switcher calls this so the user
/// can flip between e.g. all the Gemini models without leaving the
/// conversation. Uses the config's stored key; fails gracefully if the
/// provider can't be reached (the UI falls back to a curated list).
#[tauri::command]
pub async fn list_models_for_config(id: String) -> Result<Vec<providers::ModelSummary>, String> {
    let config = tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<providers::ProviderConfig> {
        let file = providers::list_configs()?;
        file.into_iter()
            .find(|c| c.id == id)
            .ok_or_else(|| anyhow::anyhow!("no provider config with id {id}"))
    })
    .await
    .map_err(|e| format!("task panicked: {e}"))?
    .map_err(|e| e.to_string())?;

    let key = providers::get_api_key(&config.id).map_err(|e| e.to_string())?;
    providers::list_models_for(&config, key)
        .await
        .map_err(|e| e.to_string())
}

/// Lists every configured provider account (never including API keys).
#[tauri::command]
pub async fn list_provider_configs() -> Result<Vec<ProviderConfig>, String> {
    tauri::async_runtime::spawn_blocking(providers::list_configs)
        .await
        .map_err(|e| format!("task panicked: {e}"))?
        .map_err(|e| e.to_string())
}

/// Returns the currently active provider config, if any — used to show
/// "which model am I talking to" before the first message is even sent.
#[tauri::command]
pub async fn get_active_provider_config() -> Result<Option<ProviderConfig>, String> {
    tauri::async_runtime::spawn_blocking(providers::get_active_config)
        .await
        .map_err(|e| format!("task panicked: {e}"))?
        .map_err(|e| e.to_string())
}

/// Creates or updates one provider account. An empty `config.id` means
/// "new" — the backend assigns a real id and returns the saved config so
/// the frontend can track it. If this is the very first provider ever
/// added, it becomes active automatically. An empty/missing `api_key`
/// leaves whatever key is already stored (if any) untouched, so editing
/// the model or label doesn't force re-entering the key.
#[tauri::command]
pub async fn save_provider_config(config: ProviderConfig, api_key: Option<String>) -> Result<ProviderConfig, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let saved = providers::save_config(config)?;
        if let Some(key) = api_key {
            if !key.is_empty() {
                providers::set_api_key(&saved.id, &key)?;
            }
        }
        Ok::<ProviderConfig, anyhow::Error>(saved)
    })
    .await
    .map_err(|e| format!("task panicked: {e}"))?
    .map_err(|e| e.to_string())
}

/// Makes one already-saved provider account the active one for the agent.
#[tauri::command]
pub async fn set_active_provider(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || providers::set_active(&id))
        .await
        .map_err(|e| format!("task panicked: {e}"))?
        .map_err(|e| e.to_string())
}

/// Deletes a provider account entirely (config + its stored key). If it
/// was active, another configured account (if any) becomes active.
#[tauri::command]
pub async fn delete_provider_config(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || providers::delete_config(&id))
        .await
        .map_err(|e| format!("task panicked: {e}"))?
        .map_err(|e| e.to_string())
}

/// Removes just the stored API key for an account, keeping the rest of
/// its config (model, base URL, label) in place.
#[tauri::command]
pub async fn remove_provider_key(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || providers::delete_api_key(&id))
        .await
        .map_err(|e| format!("task panicked: {e}"))?
        .map_err(|e| e.to_string())
}

/// Whether an account already has a key saved — used by the settings form
/// to show "a key is already saved" instead of a blank required field.
#[tauri::command]
pub async fn has_provider_key(id: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || providers::get_api_key(&id))
        .await
        .map_err(|e| format!("task panicked: {e}"))?
        .map_err(|e| e.to_string())
        .map(|k| k.is_some())
}

/// Sends a trivial prompt through the given (possibly not-yet-saved)
/// provider config and returns its reply — used by the settings form's
/// "Test Connection" button, and by onboarding, so a bad key/URL/model is
/// caught immediately. If `api_key` is empty/omitted, falls back to
/// whatever key is already saved for `config.id` (so testing after
/// editing an existing account doesn't require re-entering the key).
#[tauri::command]
pub async fn test_provider_connection(
    config: ProviderConfig,
    api_key: Option<String>,
) -> Result<providers::AiResponse, String> {
    let key = match api_key.filter(|k| !k.is_empty()) {
        Some(k) => Some(k),
        None if !config.id.is_empty() => providers::get_api_key(&config.id).map_err(|e| e.to_string())?,
        None => None,
    };

    let provider = providers::build_provider(&config, key).map_err(|e| e.to_string())?;
    let messages = vec![ChatMessage {
        role: "user".to_string(),
        content: "Reply with exactly: pong".to_string(),
    }];

    provider.send(&messages).await.map_err(|e| e.to_string())
}

/// Runs `git status --porcelain -b` for the Git tab (separate from the
/// agent's `git_status` tool — same underlying command, but this is
/// user-triggered and doesn't touch agent state/history).
#[tauri::command]
pub async fn git_status(state: State<'_, AppState>) -> Result<String, String> {
    let root = state
        .active_root
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "no workspace is open".to_string())?;

    tauri::async_runtime::spawn_blocking(move || agent::execute_read_only(&root, "git_status", &serde_json::json!({})))
        .await
        .map_err(|e| format!("git task panicked: {e}"))?
        .map_err(|e| e.to_string())
}

/// Runs `git diff` (optionally scoped to one path) for the Git tab.
#[tauri::command]
pub async fn git_diff(path: Option<String>, state: State<'_, AppState>) -> Result<String, String> {
    let root = state
        .active_root
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "no workspace is open".to_string())?;

    let args = match path {
        Some(p) => serde_json::json!({ "path": p }),
        None => serde_json::json!({}),
    };

    tauri::async_runtime::spawn_blocking(move || agent::execute_read_only(&root, "git_diff", &args))
        .await
        .map_err(|e| format!("git task panicked: {e}"))?
        .map_err(|e| e.to_string())
}

// ─────────────────────────────────────────────────────────────────────
// Terminal panel
// ─────────────────────────────────────────────────────────────────────

/// Sends raw keystrokes to the process currently running in the Terminal
/// panel (typed in the xterm view). No-op when nothing is running.
#[tauri::command]
pub async fn terminal_input(data: String, state: State<'_, AppState>) -> Result<(), String> {
    terminal::write_input(&state.running_terminal, &data);
    Ok(())
}

/// Kills whatever command is currently running in the Terminal panel.
/// The blocked runner sees EOF, reports the exit, and the session clears.
#[tauri::command]
pub async fn terminal_kill(state: State<'_, AppState>) -> Result<(), String> {
    let session = state.running_terminal.clone();
    tauri::async_runtime::spawn_blocking(move || terminal::kill_current(&session));
    Ok(())
}

/// Keeps the PTY size in sync with the on-screen terminal (the xterm
/// Fit addon reports this whenever the panel is resized).
#[tauri::command]
pub async fn terminal_resize(cols: u16, rows: u16, state: State<'_, AppState>) -> Result<(), String> {
    terminal::resize(&state.running_terminal, cols, rows);
    Ok(())
}

/// Starts the Terminal panel's idle interactive shell if nothing is running.
/// After an agent command finishes, the pane deliberately keeps that
/// command's output on screen rather than immediately swapping in a fresh
/// shell (a new console would clear it), so the shell is started lazily the
/// first time the user types. Idempotent: never replaces a live process.
#[tauri::command]
pub async fn terminal_start_shell(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let session = state.running_terminal.clone();
    if terminal::has_live_process(&session) {
        return Ok(());
    }

    let root = state
        .active_root
        .lock()
        .unwrap()
        .clone()
        .or_else(dirs::home_dir)
        .ok_or_else(|| "no workspace is open".to_string())?;

    tauri::async_runtime::spawn_blocking(move || {
        terminal::spawn_shell(&app, &root, &session).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("terminal task panicked: {e}"))?
}

// ─────────────────────────────────────────────────────────────────────
// App settings (token budget)
// ─────────────────────────────────────────────────────────────────────

/// Loads settings and applies the periodic auto-reset when one is due,
/// clearing this session's not-yet-flushed deltas if usage was actually
/// reset. Persists whenever the reset state changed.
async fn load_settings_with_reset(state: &State<'_, AppState>) -> Result<AppSettings, String> {
    let mut settings = tauri::async_runtime::spawn_blocking(settings::load)
        .await
        .map_err(|e| format!("task panicked: {e}"))?
        .map_err(|e| e.to_string())?;

    match settings::maybe_auto_reset(&mut settings) {
        settings::ResetOutcome::Unchanged => {}
        outcome => {
            if outcome == settings::ResetOutcome::Reset {
                *state.pending_usage.lock().unwrap() = 0;
                *state.pending_model_usage.lock().unwrap() = Vec::new();
            }
            let to_save = settings.clone();
            let _ = tauri::async_runtime::spawn_blocking(move || settings::save(&to_save)).await;
        }
    }
    Ok(settings)
}

/// Returns the app settings with any not-yet-persisted session usage
/// folded in, so the status bar always reflects the true spend. Also
/// performs the periodic auto-reset when it's due, so the budget refreshes
/// even while the app is left open.
#[tauri::command]
pub async fn get_app_settings(state: State<'_, AppState>) -> Result<AppSettings, String> {
    let mut settings = load_settings_with_reset(&state).await?;
    settings.tokens_used = settings.tokens_used.saturating_add(*state.pending_usage.lock().unwrap());
    merge_pending_model_usage(&mut settings, &state);
    Ok(settings)
}

/// Applies a settings change: the token limit, the auto-reset interval,
/// and/or a manual usage reset. Returns the resulting settings.
#[tauri::command]
pub async fn save_app_settings(
    update: AppSettingsUpdate,
    state: State<'_, AppState>,
) -> Result<AppSettings, String> {
    let mut settings = tauri::async_runtime::spawn_blocking(settings::load)
        .await
        .map_err(|e| format!("task panicked: {e}"))?
        .map_err(|e| e.to_string())?;

    if let Some(limit) = update.token_limit {
        settings.token_limit = limit;
    }
    if let Some(hours) = update.reset_interval_hours {
        // Changing the period restarts the countdown from now, so the user
        // gets a full interval rather than an immediate surprise reset.
        if hours != settings.reset_interval_hours {
            settings.last_reset_at = settings::now_unix();
        }
        settings.reset_interval_hours = hours;
    }
    if update.reset_usage {
        settings.tokens_used = 0;
        settings.usage_by_model.clear();
        settings.last_reset_at = settings::now_unix();
        *state.pending_usage.lock().unwrap() = 0;
        *state.pending_model_usage.lock().unwrap() = Vec::new();
    }

    let saved = settings.clone();
    tauri::async_runtime::spawn_blocking(move || settings::save(&saved))
        .await
        .map_err(|e| format!("task panicked: {e}"))?
        .map_err(|e| e.to_string())?;
    Ok(settings)
}

/// Opens an http(s) URL in the user's default browser. A Tauri webview is
/// not a browser — clicking a plain `<a target="_blank">` does nothing — so
/// "open in browser" affordances in the UI route through here.
#[tauri::command]
pub async fn open_external_url(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("only http(s) URLs can be opened".to_string());
    }

    // Launch the OS handler directly rather than through a shell: cmd.exe
    // would expand `%`-sequences and treat `&` as a command separator,
    // corrupting percent-encoded URLs and query strings.
    #[cfg(target_os = "windows")]
    let spawned = std::process::Command::new("explorer").arg(&url).spawn();

    #[cfg(target_os = "macos")]
    let spawned = std::process::Command::new("open").arg(&url).spawn();

    #[cfg(all(unix, not(target_os = "macos")))]
    let spawned = std::process::Command::new("xdg-open").arg(&url).spawn();

    spawned
        .map(|_| ())
        .map_err(|e| format!("could not open the link: {e}"))
}

// ─────────────────────────────────────────────────────────────────────
// Agent tool loop
// ─────────────────────────────────────────────────────────────────────

/// One log entry for a read-only tool the agent called during a turn —
/// surfaced in the UI ("used search_code: ...") for transparency, even
/// though these run automatically without asking.
#[derive(Debug, Clone, Serialize)]
pub struct ToolLogEntry {
    pub tool_name: String,
    pub arguments: serde_json::Value,
    pub result_preview: String,
}

/// What one call to the agent loop returns: either a finished reply, or a
/// privileged tool call waiting on the user's approval. `tool_log` lists
/// every read-only tool call made along the way, in order, so the UI can
/// show the agent's work even though the whole turn resolves in one
/// synchronous round-trip from the frontend's point of view.
#[derive(Debug, Clone, Serialize)]
pub struct AgentTurnResult {
    pub status: String, // "final" | "pending_approval" | "stopped" | "aborted" | "limit_reached" | "step_limit"
    pub text: Option<String>,
    pub thinking: Option<String>,
    pub pending_tool: Option<ToolCall>,
    pub pending_description: Option<String>,
    pub pending_diff: Option<String>,
    pub tool_log: Vec<ToolLogEntry>,
    pub model: Option<String>,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub total_input_tokens: u64,
    pub total_output_tokens: u64,
    pub conversation_id: Option<i64>,
    /// Cumulative tokens spent across all conversations this session and
    /// before (the global budget counter shown in the status bar).
    pub tokens_used: u64,
    /// The user's configured token budget (`0` = unlimited).
    pub token_limit: u64,
}

/// Requests the running agent turn to stop. The loop honors this between
/// steps and right after each provider call returns, reporting back with a
/// "stopped" result; any command the agent is currently running in the
/// Terminal panel is killed immediately.
#[tauri::command]
pub async fn agent_stop(state: State<'_, AppState>) -> Result<(), String> {
    state.agent_stop_requested.store(true, Ordering::SeqCst);
    // Ask a command the agent is blocked on to stop. This only sets a flag
    // the drain loop polls (it holds the child handle, so it kills the
    // process itself) — the idle shell is deliberately left alone when the
    // agent is just thinking.
    terminal::request_stop(&state.running_terminal);
    Ok(())
}

/// Sends a new user message and drives the agent loop until it either
/// finishes with text or needs approval for a privileged tool call.
/// Refuses to start if the global token budget has been spent.
#[tauri::command]
pub async fn agent_send_message(text: String, state: State<'_, AppState>) -> Result<AgentTurnResult, String> {
    // One turn at a time: a message sent right after "New conversation" must
    // not run concurrently with the turn that reset abandoned — both would
    // write to the single shared history. The lock is released on return.
    let _turn = state.agent_turn_lock.lock().await;

    // A fresh turn starts clean — clear any leftover stop request (e.g.
    // from a Stop click that arrived just after the previous turn ended).
    state.agent_stop_requested.store(false, Ordering::SeqCst);
    // Remember which conversation this turn belongs to; if it's replaced
    // before the turn finishes, the loop abandons it instead of writing the
    // reply into the new one.
    let generation = state.conversation_generation.load(Ordering::SeqCst);

    // Apply a due periodic reset first, so a spent budget doesn't block the
    // first message of a new period.
    let settings = load_settings_with_reset(&state).await?;
    let used = settings.tokens_used.saturating_add(*state.pending_usage.lock().unwrap());
    if settings.token_limit > 0 && used >= settings.token_limit {
        return Err(format!(
            "Token limit reached — {used} of {} tokens used. \
             Raise the limit in Settings → App to keep chatting.",
            settings.token_limit
        ));
    }

    state
        .agent_history
        .lock()
        .unwrap()
        .push(AgentMessage::User { text });

    let result = run_agent_loop(&state, generation).await;
    flush_pending_usage(&state).await;
    result
}

/// Resolves the pending privileged tool call (write_file / run_command)
/// and resumes the agent loop. `approved: false` still tells the model
/// what happened — it's a tool result saying the user denied it, not a
/// silent no-op — so the agent can react (try something else, ask a
/// different question, etc.) instead of getting stuck.
///
/// An approved `run_command` runs in the Terminal panel: its output
/// streams to the UI live *and* is returned to the model as the tool
/// result, so the agent knows what happened.
#[tauri::command]
pub async fn agent_respond_to_approval(
    approved: bool,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<AgentTurnResult, String> {
    // Serialize with other turns (see agent_send_message).
    let _turn = state.agent_turn_lock.lock().await;

    let root = state
        .active_root
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "no workspace is open".to_string())?;

    let generation = state.conversation_generation.load(Ordering::SeqCst);

    let pending = state
        .pending_tool_call
        .lock()
        .unwrap()
        .take()
        .ok_or_else(|| "no pending action to respond to".to_string())?;

    let content = if approved {
        if pending.name == "run_command" {
            let command = pending.arguments["command"].as_str().unwrap_or("").to_string();
            if command.is_empty() {
                "Action failed: missing 'command' argument".to_string()
            } else {
                let root = root.clone();
                let session = state.running_terminal.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    terminal::run_command_sync(&app, &root, &command, &session)
                        .unwrap_or_else(|e| format!("Action failed: {e}"))
                })
                .await
                .map_err(|e| format!("tool task panicked: {e}"))?
            }
        } else {
            let root = root.clone();
            let tool = pending.clone();
            tauri::async_runtime::spawn_blocking(move || {
                agent::execute_privileged(&root, &tool.name, &tool.arguments)
            })
            .await
            .map_err(|e| format!("tool task panicked: {e}"))?
            .unwrap_or_else(|e| format!("Action failed: {e}"))
        }
    } else {
        "The user denied this action. Do not attempt it again without asking first; suggest an alternative or ask a clarifying question.".to_string()
    };

    // The conversation was replaced while the action was running (the user
    // hit "New conversation") — drop the result instead of writing it into
    // the conversation they're now in.
    if state.conversation_generation.load(Ordering::SeqCst) != generation {
        return Ok(ended_early_result(
            &root,
            &state,
            generation,
            "aborted",
            None,
            Vec::new(),
            String::new(),
            None,
            None,
        )
        .await);
    }

    state.agent_history.lock().unwrap().push(AgentMessage::ToolResult {
        tool_call_id: pending.id,
        name: pending.name,
        content,
    });

    // NOTE: deliberately do NOT clear agent_stop_requested here. If the user
    // pressed Stop while the command/action was running, the loop's first
    // check must still see it and stop instead of continuing the turn.
    let result = run_agent_loop(&state, generation).await;
    flush_pending_usage(&state).await;
    result
}

/// Clears the current agent conversation (a fresh "New Conversation").
/// Does not touch provider settings. The next message sent will create a
/// new row in the conversations table rather than continuing the old one.
#[tauri::command]
pub async fn agent_reset(state: State<'_, AppState>) -> Result<(), String> {
    // Invalidate any in-flight turn *first*, so it can't write its reply
    // into the conversation we're about to clear (the "reply landed in the
    // new chat" bug).
    state.conversation_generation.fetch_add(1, Ordering::SeqCst);
    *state.agent_history.lock().unwrap() = Vec::new();
    *state.pending_tool_call.lock().unwrap() = None;
    *state.usage_totals.lock().unwrap() = (0, 0);
    *state.active_conversation_id.lock().unwrap() = None;
    state.agent_stop_requested.store(false, Ordering::SeqCst);
    // A command left running by the conversation we just abandoned would
    // otherwise linger in the Terminal panel, still attached and swallowing
    // any input typed into it. Ask it to stop (the runner owns the child and
    // is the one that can actually kill it).
    terminal::request_stop(&state.running_terminal);
    Ok(())
}

/// Lists past conversations for the active workspace, most recently
/// updated first, for the Agent panel's History dropdown.
#[tauri::command]
pub async fn list_conversations(
    state: State<'_, AppState>,
) -> Result<Vec<indexing::db::ConversationSummary>, String> {
    let root = state
        .active_root
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "no workspace is open".to_string())?;

    tauri::async_runtime::spawn_blocking(move || {
        let conn = indexing::db::open_for_workspace(&root)?;
        indexing::db::list_conversations(&conn)
    })
    .await
    .map_err(|e| format!("task panicked: {e}"))?
    .map_err(|e| e.to_string())
}

/// Loads a past conversation back into the live agent state — so sending
/// another message continues it — and returns its messages for the UI to
/// render. Any dangling pending approval from before is dropped (a past
/// conversation is either finished or was abandoned; either way there's
/// nothing live to approve).
#[tauri::command]
pub async fn load_conversation(id: i64, state: State<'_, AppState>) -> Result<Vec<AgentMessage>, String> {
    let root = state
        .active_root
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "no workspace is open".to_string())?;

    let messages = tauri::async_runtime::spawn_blocking(move || {
        let conn = indexing::db::open_for_workspace(&root)?;
        indexing::db::load_conversation_messages(&conn, id)
    })
    .await
    .map_err(|e| format!("task panicked: {e}"))?
    .map_err(|e| e.to_string())?;

    // Switching conversations invalidates any turn still running for the one
    // we're leaving, so its reply can't land here.
    state.conversation_generation.fetch_add(1, Ordering::SeqCst);

    *state.agent_history.lock().unwrap() = messages.clone();
    *state.active_conversation_id.lock().unwrap() = Some(id);
    *state.pending_tool_call.lock().unwrap() = None;
    // Historical usage wasn't stored per-message, so the session counter
    // restarts at 0 rather than showing a stale or wrong total.
    *state.usage_totals.lock().unwrap() = (0, 0);
    // Stop any command the conversation we're leaving left running (see
    // agent_reset) — it belongs to a turn that's now abandoned.
    terminal::request_stop(&state.running_terminal);

    Ok(messages)
}

/// Deletes a past conversation. If it's the one currently active, clears
/// that too so the next message starts a fresh one instead of silently
/// recreating the row that was just deleted.
#[tauri::command]
pub async fn delete_conversation(id: i64, state: State<'_, AppState>) -> Result<(), String> {
    let root = state
        .active_root
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "no workspace is open".to_string())?;

    tauri::async_runtime::spawn_blocking(move || {
        let conn = indexing::db::open_for_workspace(&root)?;
        indexing::db::delete_conversation(&conn, id)
    })
    .await
    .map_err(|e| format!("task panicked: {e}"))?
    .map_err(|e| e.to_string())?;

    let mut active = state.active_conversation_id.lock().unwrap();
    if *active == Some(id) {
        *active = None;
        // An in-flight turn would otherwise recreate the row we just
        // deleted; invalidate it.
        state.conversation_generation.fetch_add(1, Ordering::SeqCst);
    }
    Ok(())
}

/// Current global token spend (stored + not-yet-flushed session delta)
/// and the configured limit. Called at each exit point of the agent loop
/// so the result the UI renders is accurate as of that moment.
async fn usage_snapshot(state: &State<'_, AppState>) -> (u64, u64) {
    let settings = tauri::async_runtime::spawn_blocking(settings::load)
        .await
        .ok()
        .and_then(|r| r.ok())
        .unwrap_or_default();
    let used = settings.tokens_used.saturating_add(*state.pending_usage.lock().unwrap());
    (used, settings.token_limit)
}

/// Folds this session's not-yet-flushed per-model usage records into
/// `settings.usage_by_model`. Pure state read — used by
/// `get_app_settings` so the breakdown stays current without touching
/// the settings file.
fn merge_pending_model_usage(settings: &mut AppSettings, state: &State<'_, AppState>) {
    let pending = state.pending_model_usage.lock().unwrap().clone();
    for (provider, model, input, output) in pending {
        let weighted = pricing::equivalent_tokens(&provider, &model, input, output);
        add_model_usage(&mut settings.usage_by_model, &provider, &model, input, output, weighted);
    }
}

/// Writes this session's accumulated token spend into the settings file,
/// so the budget survives restarts. Best-effort: the budget is a soft
/// guard, so a failed write (disk error, etc.) logs and moves on instead
/// of failing the turn the user just completed.
async fn flush_pending_usage(state: &State<'_, AppState>) {
    let delta = {
        let mut slot = state.pending_usage.lock().unwrap();
        let delta = *slot;
        *slot = 0;
        delta
    };
    let model_records = {
        let mut slot = state.pending_model_usage.lock().unwrap();
        std::mem::take(&mut *slot)
    };
    if delta == 0 && model_records.is_empty() {
        return;
    }
    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut settings = settings::load().unwrap_or_default();
        settings.tokens_used = settings.tokens_used.saturating_add(delta);
        for (provider, model, input, output) in model_records {
            let weighted = pricing::equivalent_tokens(&provider, &model, input, output);
            add_model_usage(
                &mut settings.usage_by_model,
                &provider,
                &model,
                input,
                output,
                weighted,
            );
        }
        settings::save(&settings)
    })
    .await;
    if let Ok(Err(e)) = result {
        eprintln!("subsidium: failed to flush token usage: {e}");
    }
}

/// Persists the current in-memory history to the active conversation row,
/// creating one (titled from the first user message) if this is the
/// first turn. Best-effort: a persistence failure is logged to stderr but
/// never surfaces to the user — losing the saved transcript shouldn't
/// also break the live conversation they're in the middle of.
///
/// `generation` is the conversation the caller's turn belongs to: if it has
/// since been replaced, nothing is written (the history now belongs to a
/// different conversation).
async fn persist_conversation(
    root: &std::path::Path,
    state: &State<'_, AppState>,
    generation: u64,
) -> Option<i64> {
    if state.conversation_generation.load(Ordering::SeqCst) != generation {
        return None;
    }
    let history = state.agent_history.lock().unwrap().clone();
    if history.is_empty() {
        return None;
    }

    let existing_id = *state.active_conversation_id.lock().unwrap();
    let root = root.to_path_buf();

    let conversation_id = match existing_id {
        Some(id) => id,
        None => {
            let title: String = history
                .iter()
                .find_map(|m| match m {
                    AgentMessage::User { text } => Some(text.chars().take(60).collect::<String>()),
                    _ => None,
                })
                .unwrap_or_else(|| "New conversation".to_string());

            let root2 = root.clone();
            let created = tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<i64> {
                let conn = indexing::db::open_for_workspace(&root2)?;
                indexing::db::create_conversation(&conn, &title)
            })
            .await
            .ok()
            .and_then(|r| r.ok());

            match created {
                Some(id) => {
                    *state.active_conversation_id.lock().unwrap() = Some(id);
                    id
                }
                None => {
                    eprintln!("subsidium: failed to create conversation row");
                    return None;
                }
            }
        }
    };

    let root3 = root.clone();
    let saved = tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<()> {
        let conn = indexing::db::open_for_workspace(&root3)?;
        indexing::db::save_conversation_messages(&conn, conversation_id, &history)?;
        Ok(())
    })
    .await;

    if let Ok(Err(e)) = saved {
        eprintln!("subsidium: failed to save conversation {conversation_id}: {e}");
    }

    Some(conversation_id)
}

/// Builds the result for a turn that ended without a normal answer:
/// `"stopped"` (the user pressed Stop) or `"aborted"` (the conversation was
/// replaced mid-turn). Persistence is a no-op for an abandoned turn, so its
/// reply can never leak into the conversation the user switched to.
#[allow(clippy::too_many_arguments)]
async fn ended_early_result(
    root: &std::path::Path,
    state: &State<'_, AppState>,
    generation: u64,
    status: &str,
    text: Option<String>,
    tool_log: Vec<ToolLogEntry>,
    model: String,
    input: Option<u64>,
    output: Option<u64>,
) -> AgentTurnResult {
    let totals = *state.usage_totals.lock().unwrap();
    let (tokens_used, token_limit) = usage_snapshot(state).await;
    let conversation_id = persist_conversation(root, state, generation).await;
    AgentTurnResult {
        status: status.to_string(),
        text,
        thinking: None,
        pending_tool: None,
        pending_description: None,
        pending_diff: None,
        tool_log,
        model: if model.is_empty() { None } else { Some(model) },
        input_tokens: input,
        output_tokens: output,
        total_input_tokens: totals.0,
        total_output_tokens: totals.1,
        conversation_id,
        tokens_used,
        token_limit,
    }
}

/// Caps what is sent to the provider so a long conversation can't blow past
/// the model's context window. The *stored* transcript is never touched —
/// only the copy handed to the provider. The cut is always moved forward to
/// a `User` message so an assistant `tool_call` is never separated from the
/// `ToolResult` that answers it (providers reject an orphaned tool result).
fn trim_history(history: &[AgentMessage]) -> Vec<AgentMessage> {
    // Rough, provider-agnostic budget. Characters ≈ tokens × 4, so this is
    // on the order of ~30k tokens of history — comfortably inside every
    // model these providers expose, with room for the reply and tools.
    const MAX_MESSAGES: usize = 40;
    const MAX_CHARS: usize = 120_000;

    fn approx_len(message: &AgentMessage) -> usize {
        match message {
            AgentMessage::User { text } => text.chars().count() + 8,
            AgentMessage::Assistant { text, tool_calls } => {
                text.as_deref().map(|t| t.chars().count()).unwrap_or(0)
                    + tool_calls
                        .iter()
                        .map(|c| c.arguments.to_string().chars().count() + 24)
                        .sum::<usize>()
                    + 8
            }
            AgentMessage::ToolResult { content, .. } => content.chars().count() + 8,
        }
    }

    let total: usize = history.iter().map(approx_len).sum();
    if history.len() <= MAX_MESSAGES && total <= MAX_CHARS {
        return history.to_vec();
    }

    // Walk back from the newest message, keeping as much as fits the budget.
    let mut start = history.len();
    let mut chars = 0usize;
    for (i, message) in history.iter().enumerate().rev() {
        if history.len() - i > MAX_MESSAGES || chars + approx_len(message) > MAX_CHARS {
            break;
        }
        chars += approx_len(message);
        start = i;
    }

    // Align the cut to a `User` boundary so tool-call/tool-result pairs stay
    // whole. Prefer the first `User` at or after the cut; if the cut landed
    // past the last user message, fall back to that user message itself.
    if let Some(offset) = history[start..]
        .iter()
        .position(|m| matches!(m, AgentMessage::User { .. }))
    {
        start += offset;
    } else if let Some(last_user) = history
        .iter()
        .rposition(|m| matches!(m, AgentMessage::User { .. }))
    {
        start = last_user;
    }

    history[start..].to_vec()
}

/// The actual loop: ask the model for a turn, and if it wants to call a
/// tool, either run it immediately (read-only) and loop again, or stop
/// and hand control back to the user (privileged). Shared by
/// `agent_send_message` and `agent_respond_to_approval` — both just push
/// a message onto the history first and then call this. `generation` is the
/// conversation this turn belongs to; if it changes mid-turn the loop
/// abandons the turn (see `ended_early_result`).
async fn run_agent_loop(state: &State<'_, AppState>, generation: u64) -> Result<AgentTurnResult, String> {
    let root = state
        .active_root
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "no workspace is open".to_string())?;

    let config = providers::get_active_config()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "no AI provider configured yet — set one up in AI Settings".to_string())?;
    let api_key = providers::get_api_key(&config.id).map_err(|e| e.to_string())?;
    let provider = providers::build_provider(&config, api_key).map_err(|e| e.to_string())?;
    let tools = agent::tool_definitions();

    let mut tool_log = Vec::new();
    let mut last_model = String::new();
    let mut last_thinking: Option<String> = None;
    let mut last_input: Option<u64> = None;
    let mut last_output: Option<u64> = None;

    for _ in 0..agent::MAX_STEPS {
        // The conversation was replaced while this turn was in flight (the
        // user started a new one or opened another) — abandon it: no history
        // writes, no persistence, and a status the panel drops.
        if state.conversation_generation.load(Ordering::SeqCst) != generation {
            return Ok(ended_early_result(
                &root,
                state,
                generation,
                "aborted",
                None,
                tool_log,
                last_model,
                last_input,
                last_output,
            )
            .await);
        }

        // Stop requested since the last checkpoint. End here, before starting
        // the next step.
        if state.agent_stop_requested.swap(false, Ordering::SeqCst) {
            state
                .agent_history
                .lock()
                .unwrap()
                .push(AgentMessage::Assistant {
                    text: Some("Stopped by the user.".to_string()),
                    tool_calls: Vec::new(),
                });
            return Ok(ended_early_result(
                &root,
                state,
                generation,
                "stopped",
                Some("Stopped by the user.".to_string()),
                tool_log,
                last_model,
                last_input,
                last_output,
            )
            .await);
        }

        // Enforce the budget *inside* the loop, not only at the start of a
        // turn. One turn can make up to MAX_STEPS provider calls, and a turn
        // resumed from an approval walks straight back into this loop —
        // without this check the limit only ever governed the first call.
        {
            let (used, limit) = usage_snapshot(state).await;
            if limit > 0 && used >= limit {
                let text = format!(
                    "Token limit reached — {used} of {limit} weighted tokens used. \
                     Raise the limit in Settings → App to keep going."
                );
                state.agent_history.lock().unwrap().push(AgentMessage::Assistant {
                    text: Some(text.clone()),
                    tool_calls: Vec::new(),
                });
                return Ok(ended_early_result(
                    &root,
                    state,
                    generation,
                    "limit_reached",
                    Some(text),
                    tool_log,
                    last_model,
                    last_input,
                    last_output,
                )
                .await);
            }
        }

        let history = {
            let full = state.agent_history.lock().unwrap();
            trim_history(&full)
        };

        let turn = provider
            .send_agent_turn(&history, &tools)
            .await
            .map_err(|e| e.to_string())?;

        last_model = turn.model.clone();
        last_thinking = turn.thinking.clone();
        last_input = turn.input_tokens;
        last_output = turn.output_tokens;
        if let (Some(i), Some(o)) = (turn.input_tokens, turn.output_tokens) {
            // Conversation-scope totals stay raw (shown in the panel as
            // "X in · Y out"), but the global budget counts
            // model-weighted tokens — an expensive model burns the
            // budget faster than a cheap one for the same raw count.
            state.usage_totals.lock().unwrap().0 += i;
            state.usage_totals.lock().unwrap().1 += o;
            let weighted = pricing::equivalent_tokens(&config.provider, &turn.model, i, o);
            *state.pending_usage.lock().unwrap() += weighted;
            state
                .pending_model_usage
                .lock()
                .unwrap()
                .push((config.provider.clone(), turn.model.clone(), i, o));
        }

        // Usage above is real — the provider call happened and is billed —
        // but if the conversation was replaced, or Stop arrived while the
        // call was in flight, discard the model's response. Checking *here*
        // (not only at the top of the loop) is what makes Stop work on a
        // turn where the model answers directly and never loops again.
        if state.conversation_generation.load(Ordering::SeqCst) != generation {
            return Ok(ended_early_result(
                &root,
                state,
                generation,
                "aborted",
                None,
                tool_log,
                last_model,
                last_input,
                last_output,
            )
            .await);
        }
        if state.agent_stop_requested.swap(false, Ordering::SeqCst) {
            state
                .agent_history
                .lock()
                .unwrap()
                .push(AgentMessage::Assistant {
                    text: Some("Stopped by the user.".to_string()),
                    tool_calls: Vec::new(),
                });
            return Ok(ended_early_result(
                &root,
                state,
                generation,
                "stopped",
                Some("Stopped by the user.".to_string()),
                tool_log,
                last_model,
                last_input,
                last_output,
            )
            .await);
        }

        if turn.tool_calls.is_empty() {
            state.agent_history.lock().unwrap().push(AgentMessage::Assistant {
                text: turn.text.clone(),
                tool_calls: Vec::new(),
            });

            let totals = *state.usage_totals.lock().unwrap();
            let (tokens_used, token_limit) = usage_snapshot(state).await;
            let conversation_id = persist_conversation(&root, state, generation).await;
            return Ok(AgentTurnResult {
                status: "final".to_string(),
                text: Some(turn.text.unwrap_or_default()),
                thinking: last_thinking.clone(),
                pending_tool: None,
                pending_description: None,
                pending_diff: None,
                tool_log,
                model: Some(last_model),
                input_tokens: last_input,
                output_tokens: last_output,
                total_input_tokens: totals.0,
                total_output_tokens: totals.1,
                conversation_id,
                tokens_used,
                token_limit,
            });
        }

        // Models occasionally ask for several tools at once. When they're
        // all read-only we run them all in this step and feed every result
        // back — nothing is silently dropped and it saves a round-trip. If
        // any call needs approval we fall back to handling just the first
        // one, so the privileged path stays strictly one-approval-at-a-time.
        if turn.tool_calls.len() > 1 && turn.tool_calls.iter().all(|c| agent::is_read_only(&c.name)) {
            state.agent_history.lock().unwrap().push(AgentMessage::Assistant {
                text: turn.text.clone(),
                tool_calls: turn.tool_calls.clone(),
            });

            for call in turn.tool_calls.clone() {
                let root_for_tool = root.clone();
                let call_for_tool = call.clone();
                let result = tauri::async_runtime::spawn_blocking(move || {
                    agent::execute_read_only(&root_for_tool, &call_for_tool.name, &call_for_tool.arguments)
                })
                .await
                .map_err(|e| format!("tool task panicked: {e}"))?
                .unwrap_or_else(|e| format!("Error: {e}"));

                tool_log.push(ToolLogEntry {
                    tool_name: call.name.clone(),
                    arguments: call.arguments.clone(),
                    result_preview: result.chars().take(200).collect(),
                });

                state.agent_history.lock().unwrap().push(AgentMessage::ToolResult {
                    tool_call_id: call.id,
                    name: call.name,
                    content: result,
                });
            }
            // Loop again — the model gets every tool result on the next turn.
            continue;
        }

        // Otherwise handle one tool call per step (a privileged call, or a
        // mixed batch: run the first and let the loop pick up the rest on
        // the next turn rather than assuming multi-call ordering doesn't
        // matter).
        let call = turn.tool_calls[0].clone();

        state.agent_history.lock().unwrap().push(AgentMessage::Assistant {
            text: turn.text.clone(),
            tool_calls: vec![call.clone()],
        });

        if agent::is_read_only(&call.name) {
            let root_for_tool = root.clone();
            let call_for_tool = call.clone();
            let result = tauri::async_runtime::spawn_blocking(move || {
                agent::execute_read_only(&root_for_tool, &call_for_tool.name, &call_for_tool.arguments)
            })
            .await
            .map_err(|e| format!("tool task panicked: {e}"))?
            .unwrap_or_else(|e| format!("Error: {e}"));

            tool_log.push(ToolLogEntry {
                tool_name: call.name.clone(),
                arguments: call.arguments.clone(),
                result_preview: result.chars().take(200).collect(),
            });

            state.agent_history.lock().unwrap().push(AgentMessage::ToolResult {
                tool_call_id: call.id,
                name: call.name,
                content: result,
            });
            // Loop again — the model gets the tool result on the next turn.
        } else {
            *state.pending_tool_call.lock().unwrap() = Some(call.clone());

            let diff = if call.name == "write_file" {
                let root_for_diff = root.clone();
                let call_for_diff = call.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    agent::diff_for_write(&root_for_diff, &call_for_diff.arguments)
                })
                .await
                .ok()
                .flatten()
            } else {
                None
            };

            let totals = *state.usage_totals.lock().unwrap();
            let (tokens_used, token_limit) = usage_snapshot(state).await;
            let conversation_id = persist_conversation(&root, state, generation).await;
            return Ok(AgentTurnResult {
                status: "pending_approval".to_string(),
                text: turn.text,
                thinking: last_thinking.clone(),
                pending_tool: Some(call.clone()),
                pending_description: Some(agent::describe(&call.name, &call.arguments)),
                pending_diff: diff,
                tool_log,
                model: Some(last_model),
                input_tokens: last_input,
                output_tokens: last_output,
                total_input_tokens: totals.0,
                total_output_tokens: totals.1,
                conversation_id,
                tokens_used,
                token_limit,
            });
        }
    }

    let totals = *state.usage_totals.lock().unwrap();
    let (tokens_used, token_limit) = usage_snapshot(state).await;
    let conversation_id = persist_conversation(&root, state, generation).await;
    Ok(AgentTurnResult {
        status: "step_limit".to_string(),
        text: Some(format!(
            "Stopped after {} steps without a final answer — the task may be too large for one turn. \
             Try breaking it down, or ask me to continue.",
            agent::MAX_STEPS
        )),
        thinking: last_thinking,
        pending_tool: None,
        pending_description: None,
        pending_diff: None,
        tool_log,
        model: Some(last_model),
        input_tokens: last_input,
        output_tokens: last_output,
        total_input_tokens: totals.0,
        total_output_tokens: totals.1,
        conversation_id,
        tokens_used,
        token_limit,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user(text: &str) -> AgentMessage {
        AgentMessage::User {
            text: text.to_string(),
        }
    }

    fn assistant(text: Option<&str>, calls: Vec<ToolCall>) -> AgentMessage {
        AgentMessage::Assistant {
            text: text.map(|t| t.to_string()),
            tool_calls: calls,
        }
    }

    fn tool_result(id: &str) -> AgentMessage {
        AgentMessage::ToolResult {
            tool_call_id: id.to_string(),
            name: "read_file".to_string(),
            content: "ok".to_string(),
        }
    }

    fn call(id: &str) -> ToolCall {
        ToolCall {
            id: id.to_string(),
            name: "read_file".to_string(),
            arguments: serde_json::json!({ "path": "src/main.rs" }),
            thought_signature: None,
        }
    }

    #[test]
    fn trim_history_leaves_short_conversations_untouched() {
        let history = vec![user("hi"), assistant(Some("hello"), vec![])];
        assert_eq!(trim_history(&history).len(), 2);
    }

    #[test]
    fn trim_history_drops_oldest_but_keeps_tool_pairs_whole() {
        // 30 user/assistant/toolresult exchanges blows the message cap.
        let mut history = Vec::new();
        for i in 0..40 {
            history.push(user(&format!("question {i}")));
            history.push(assistant(None, vec![call(&format!("c{i}"))]));
            history.push(tool_result(&format!("c{i}")));
            history.push(assistant(Some(&format!("answer {i}")), vec![]));
        }

        let trimmed = trim_history(&history);

        assert!(trimmed.len() < history.len(), "expected trimming to happen");
        // Never start on a ToolResult — that would be an orphaned tool result
        // some providers reject outright.
        assert!(
            !matches!(trimmed.first(), Some(AgentMessage::ToolResult { .. })),
            "trimmed history must start on a user/assistant boundary"
        );
        // The newest message always survives.
        assert!(matches!(trimmed.last(), Some(AgentMessage::Assistant { .. })));
    }

    #[test]
    fn trim_history_keeps_the_cut_on_a_user_boundary() {
        let mut history = Vec::new();
        for i in 0..50 {
            history.push(user(&format!("u{i}")));
            history.push(assistant(Some("a"), vec![]));
        }

        let trimmed = trim_history(&history);
        assert!(matches!(trimmed.first(), Some(AgentMessage::User { .. })));
        assert!(trimmed.len() < history.len());
    }
}
