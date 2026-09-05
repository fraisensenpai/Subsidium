use crate::indexing;
use crate::retrieval;
use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use std::path::Path;

/// Hard cap on how many provider round-trips a single user message can
/// trigger before the loop gives up and reports back. Without this, a
/// model stuck calling the same read-only tool over and over would run
/// forever (and burn tokens doing it).
pub const MAX_STEPS: usize = 12;

pub fn tool_definitions() -> Vec<crate::providers::ToolDefinition> {
    use crate::providers::ToolDefinition;

    vec![
        ToolDefinition {
            name: "read_file".into(),
            description: "Read the full contents of a file in the workspace, given a workspace-relative path.".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Workspace-relative file path, e.g. src/main.rs" }
                },
                "required": ["path"]
            }),
        },
        ToolDefinition {
            name: "list_files".into(),
            description: "List indexed files in the workspace, optionally filtered by a path prefix.".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "prefix": { "type": "string", "description": "Optional path prefix filter, e.g. src/components" }
                },
                "required": []
            }),
        },
        ToolDefinition {
            name: "search_code".into(),
            description: "Search the workspace by symbol name, file name, or free text. Prefer this over list_files/read_file when you don't already know the exact file.".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string" }
                },
                "required": ["query"]
            }),
        },
        ToolDefinition {
            name: "write_file".into(),
            description: "Overwrite a file's full contents (creates it if it doesn't exist). This requires explicit user approval before it actually runs — you will be told if the user approved or denied it.".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Workspace-relative file path" },
                    "content": { "type": "string", "description": "The complete new file contents — not a diff, the whole file" }
                },
                "required": ["path", "content"]
            }),
        },
        ToolDefinition {
            name: "run_command".into(),
            description: "Run a shell command in the workspace root — e.g. running tests, a build, or a linter. This requires explicit user approval before it actually runs.".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "command": { "type": "string" }
                },
                "required": ["command"]
            }),
        },
        ToolDefinition {
            name: "git_status".into(),
            description: "Show the working tree status (git status --porcelain -b) — which files are modified, staged, or untracked. Use this before proposing changes to understand what's already in flight.".into(),
            parameters: json!({ "type": "object", "properties": {}, "required": [] }),
        },
        ToolDefinition {
            name: "git_diff".into(),
            description: "Show uncommitted changes (git diff), optionally scoped to one file.".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Optional workspace-relative path to scope the diff to" }
                },
                "required": []
            }),
        },
    ]
}

/// Tools that only read — no side effects, safe to run the moment the
/// model asks for them. Everything else goes through the approval flow
/// in commands.rs (`agent_send_message` / `agent_respond_to_approval`).
pub fn is_read_only(tool_name: &str) -> bool {
    matches!(
        tool_name,
        "read_file" | "list_files" | "search_code" | "git_status" | "git_diff"
    )
}

/// A short, human-readable description of what a privileged tool call is
/// about to do — shown in the approval card in the UI so the user isn't
/// approving a raw JSON blob blind.
pub fn describe(tool_name: &str, args: &Value) -> String {
    match tool_name {
        "write_file" => {
            let path = args["path"].as_str().unwrap_or("?");
            let len = args["content"].as_str().map(|c| c.len()).unwrap_or(0);
            format!("Write to {path} ({len} bytes)")
        }
        "run_command" => {
            let command = args["command"].as_str().unwrap_or("?");
            format!("Run: {command}")
        }
        other => format!("{other}({args})"),
    }
}

pub fn execute_read_only(root: &Path, name: &str, args: &Value) -> Result<String> {
    match name {
        "read_file" => {
            let path = args["path"].as_str().ok_or_else(|| anyhow!("missing 'path'"))?;
            let content = std::fs::read_to_string(root.join(path))
                .map_err(|e| anyhow!("could not read {path}: {e}"))?;
            // A huge file dumped into the model's context helps no one —
            // nudge toward search_code for anything this size instead.
            Ok(truncate(&content, 20_000))
        }
        "list_files" => {
            let prefix = args["prefix"].as_str().unwrap_or("");
            let conn = indexing::db::open_for_workspace(root)?;
            let mut stmt = conn.prepare(
                "SELECT relative_path FROM files WHERE relative_path LIKE ?1 ORDER BY relative_path LIMIT 300",
            )?;
            let pattern = format!("{prefix}%");
            let rows: Vec<String> = stmt
                .query_map([pattern], |r| r.get(0))?
                .filter_map(|r| r.ok())
                .collect();
            Ok(if rows.is_empty() {
                "No matching files.".to_string()
            } else {
                rows.join("\n")
            })
        }
        "search_code" => {
            let query = args["query"].as_str().ok_or_else(|| anyhow!("missing 'query'"))?;
            let hits = retrieval::search(root, query)?;
            let formatted: Vec<String> = hits
                .iter()
                .take(30)
                .map(|h| match h.line {
                    Some(line) => format!("[{}] {}:{} — {}", h.source, h.file, line, h.snippet),
                    None => format!("[{}] {} — {}", h.source, h.file, h.snippet),
                })
                .collect();
            Ok(if formatted.is_empty() {
                "No results.".to_string()
            } else {
                formatted.join("\n")
            })
        }
        "git_status" => run_git(root, &["status", "--porcelain=v1", "-b"]),
        "git_diff" => {
            let mut cmd_args = vec!["diff".to_string()];
            if let Some(path) = args["path"].as_str() {
                cmd_args.push(path.to_string());
            }
            run_git(root, &cmd_args.iter().map(String::as_str).collect::<Vec<_>>())
        }
        other => Err(anyhow!("'{other}' is not a read-only tool")),
    }
}

/// Runs `write_file` or `run_command`. Only ever called after the user has
/// explicitly approved the pending action (see commands.rs) — nothing in
/// the agent loop calls this automatically.
pub fn execute_privileged(root: &Path, name: &str, args: &Value) -> Result<String> {
    match name {
        "write_file" => {
            let path = args["path"].as_str().ok_or_else(|| anyhow!("missing 'path'"))?;
            let content = args["content"].as_str().ok_or_else(|| anyhow!("missing 'content'"))?;
            std::fs::write(root.join(path), content)
                .map_err(|e| anyhow!("could not write {path}: {e}"))?;
            indexing::reindex_file(root, path)?;
            Ok(format!("Wrote {path} ({} bytes).", content.len()))
        }
        "run_command" => {
            let command = args["command"].as_str().ok_or_else(|| anyhow!("missing 'command'"))?;
            run_shell(root, command)
        }
        other => Err(anyhow!("'{other}' is not a privileged tool")),
    }
}

/// KNOWN LIMITATION: no timeout — a command that waits on input or never
/// exits (a dev server started without a background flag, for instance)
/// will hang this call indefinitely. A real implementation should run
/// this with a kill-after-N-seconds wrapper; flagging rather than solving
/// that here since it needs a process-management crate decision.
fn run_shell(root: &Path, command: &str) -> Result<String> {
    #[cfg(target_os = "windows")]
    let output = std::process::Command::new("cmd")
        .args(["/C", command])
        .current_dir(root)
        .output()?;

    #[cfg(not(target_os = "windows"))]
    let output = std::process::Command::new("sh")
        .args(["-c", command])
        .current_dir(root)
        .output()?;

    let mut combined = String::new();
    combined.push_str(&String::from_utf8_lossy(&output.stdout));
    combined.push_str(&String::from_utf8_lossy(&output.stderr));
    combined.push_str(&format!("\n[exit code: {}]", output.status.code().unwrap_or(-1)));
    Ok(truncate(&combined, 8_000))
}

/// Runs `git` in the workspace root. Never errors out hard on failure
/// (no git installed, not a repository, ...) — instead returns that as
/// text so the model can see "this isn't a git repo" and adjust, rather
/// than the whole tool call failing opaquely.
fn run_git(root: &Path, args: &[&str]) -> Result<String> {
    let output = std::process::Command::new("git")
        .args(args)
        .current_dir(root)
        .output();

    let output = match output {
        Ok(o) => o,
        Err(e) => return Ok(format!("git is not available on this machine: {e}")),
    };

    let mut combined = String::new();
    combined.push_str(&String::from_utf8_lossy(&output.stdout));
    combined.push_str(&String::from_utf8_lossy(&output.stderr));
    if combined.trim().is_empty() {
        combined = "(no output — likely a clean working tree)".to_string();
    }
    Ok(truncate(&combined, 8_000))
}

/// Computes a unified-ish diff between what's on disk now and what a
/// pending `write_file` call would write, shown in the approval card so
/// the user isn't approving a byte count blind. Returns `None` only if
/// the call is missing its arguments (shouldn't happen — the model's
/// schema requires them); a brand-new file diffs against empty content.
pub fn diff_for_write(root: &Path, args: &Value) -> Option<String> {
    let path = args["path"].as_str()?;
    let new_content = args["content"].as_str()?;
    let old_content = std::fs::read_to_string(root.join(path)).unwrap_or_default();

    if old_content == new_content {
        return Some("No changes — new content is identical to what's on disk.".to_string());
    }

    let diff = similar::TextDiff::from_lines(old_content.as_str(), new_content);
    let mut out = String::new();
    for change in diff.iter_all_changes() {
        let sign = match change.tag() {
            similar::ChangeTag::Delete => "-",
            similar::ChangeTag::Insert => "+",
            similar::ChangeTag::Equal => " ",
        };
        out.push_str(sign);
        out.push_str(&change.to_string());
        if !out.ends_with('\n') {
            out.push('\n');
        }
    }
    Some(truncate(&out, 6_000))
}

fn truncate(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        s.to_string()
    } else {
        let truncated: String = s.chars().take(max_chars).collect();
        format!("{truncated}\n…[truncated]")
    }
}
