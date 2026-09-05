mod agent;
mod commands;
mod indexing;
mod parsing;
mod pricing;
mod providers;
mod retrieval;
mod settings;
mod terminal;
mod workspace;

use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use tauri::Manager;

/// Shared app state. Phase 1 keeps one active workspace at a time;
/// later phases may allow multiple open workspaces / tabs.
pub struct AppState {
    pub active_root: Mutex<Option<std::path::PathBuf>>,
    /// The running agent conversation for the active workspace. Lives only
    /// in memory — closing the app or switching workspaces starts fresh.
    pub agent_history: Mutex<Vec<providers::AgentMessage>>,
    /// Set when the agent loop stops to wait for the user to approve or
    /// deny a `write_file`/`run_command` call. `None` the rest of the time.
    pub pending_tool_call: Mutex<Option<providers::ToolCall>>,
    /// Which persisted conversation (see indexing::db conversations table)
    /// the in-memory `agent_history` is being saved into. `None` until the
    /// first message of a new conversation is sent, at which point a row
    /// is created and this is set.
    pub active_conversation_id: Mutex<Option<i64>>,
    /// Running (input, output) token totals for the current agent
    /// conversation, shown in the Agent panel so token spend is visible
    /// as the conversation grows.
    pub usage_totals: Mutex<(u64, u64)>,
    /// Weighted (model-priced) tokens spent this session that haven't been
    /// written to the settings file yet (the file is only touched once per
    /// turn, not per provider round-trip). Added to the stored
    /// `tokens_used` for the global budget.
    pub pending_usage: Mutex<u64>,
    /// This session's per-model raw usage (provider, model, input, output)
    /// not yet merged into `settings.usage_by_model`. Flushed together
    /// with `pending_usage`.
    pub pending_model_usage: Mutex<Vec<(String, String, u64, u64)>>,
    /// The PTY session shown in the Terminal panel — one process at a
    /// time (the idle interactive shell, or the command that replaced it),
    /// shared across threads so input/resize/kill reach it while a
    /// command is running (including during a blocked agent approval).
    pub running_terminal: Arc<terminal::PtySession>,
    /// Set by the Stop button while the agent is working. The agent loop
    /// checks it between steps and returns a "stopped" result as soon as
    /// the in-flight provider call finishes.
    pub agent_stop_requested: Arc<AtomicBool>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            active_root: Mutex::new(None),
            agent_history: Mutex::new(Vec::new()),
            pending_tool_call: Mutex::new(None),
            active_conversation_id: Mutex::new(None),
            usage_totals: Mutex::new((0, 0)),
            pending_usage: Mutex::new(0),
            pending_model_usage: Mutex::new(Vec::new()),
            running_terminal: Arc::new(terminal::PtySession::new()),
            agent_stop_requested: Arc::new(AtomicBool::new(false)),
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        // Start the terminal's idle shell right away (in the home
        // directory until a workspace is selected), so the panel is a real
        // interactive terminal from the first frame.
        .setup(|app| {
            let session = app.state::<AppState>().running_terminal.clone();
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                // Home directory for the initial shell (until a workspace
                // is selected). Never falls back to a relative path: a
                // relative cwd would resolve against the app process's own
                // working directory, which on Windows can be something
                // surprising like C:\WINDOWS\system32.
                let home = dirs::home_dir()
                    .or_else(|| std::env::var_os("USERPROFILE").map(std::path::PathBuf::from))
                    .or_else(|| {
                        let drive = std::env::var_os("HOMEDRIVE")?;
                        let path = std::env::var_os("HOMEPATH")?;
                        Some(std::path::PathBuf::from(format!(
                            "{}{}",
                            drive.to_string_lossy(),
                            path.to_string_lossy()
                        )))
                    })
                    .unwrap_or_else(|| std::path::PathBuf::from("C:\\"));
                let _ = terminal::spawn_shell(&app_handle, &home, &session);
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::open_workspace,
            commands::get_project_summary,
            commands::get_index_stats,
            commands::search_workspace,
            commands::read_file,
            commands::write_file,
            commands::save_provider_config,
            commands::list_provider_configs,
            commands::get_active_provider_config,
            commands::set_active_provider,
            commands::delete_provider_config,
            commands::remove_provider_key,
            commands::has_provider_key,
            commands::list_provider_models,
            commands::list_models_for_config,
            commands::test_provider_connection,
            commands::agent_send_message,
            commands::agent_respond_to_approval,
            commands::agent_stop,
            commands::agent_reset,
            commands::list_conversations,
            commands::load_conversation,
            commands::delete_conversation,
            commands::git_status,
            commands::git_diff,
            commands::terminal_run,
            commands::terminal_input,
            commands::terminal_kill,
            commands::terminal_resize,
            commands::get_app_settings,
            commands::save_app_settings,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Subsidium");
}
