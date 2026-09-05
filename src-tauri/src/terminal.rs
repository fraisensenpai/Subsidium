use anyhow::{Context, Result};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

pub const DATA_EVENT: &str = "terminal:data";
pub const STATUS_EVENT: &str = "terminal:status";

/// A raw chunk of terminal output. Deliberately not line-based: the child
/// runs inside a real TTY, so its output can contain ANSI escape
/// sequences, `\r`, partial lines and cursor movement — the frontend
/// (xterm.js) feeds this straight into a terminal emulator.
#[derive(Clone, serde::Serialize)]
pub struct TerminalDataEvent {
    pub data: String,
}

/// Lifecycle of the process shown in the Terminal panel.
/// - "shell": the idle interactive shell just started (the pane is ready
///   for the user to type into it). `cwd` is where the shell opened.
/// - "running": a command (agent-approved or otherwise) is taking over
///   the pane.
/// - "exit": the command finished (or was killed); `code` is its exit
///   status. The idle shell is respawned right after.
#[derive(Clone, serde::Serialize)]
pub struct TerminalStatusEvent {
    pub status: String,
    pub code: Option<u32>,
    pub cwd: Option<String>,
}

/// Live state of the process currently shown in the Terminal panel. Only
/// one process runs at a time — the idle shell when nothing else is
/// going on, or the command that replaced it. The handles live here
/// (rather than in the blocking runner) so `terminal_input` /
/// `terminal_resize` / `terminal_kill` can reach the process while it
/// runs.
pub struct PtySession {
    pub master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    pub writer: Mutex<Option<Box<dyn Write + Send>>>,
    pub child: Mutex<Option<Box<dyn Child + Send + Sync>>>,
    /// Last known terminal size (cols, rows) — applied to newly spawned
    /// PTYs so the size survives process replacement.
    pub cols: Mutex<u16>,
    pub rows: Mutex<u16>,
    /// Monotonically increasing counter bumped every time a new process is
    /// spawned into the pane. Each reader thread captures the current value
    /// at spawn time; if the generation has advanced by the time the thread
    /// wants to emit a chunk, the chunk belongs to a dead process and must
    /// not reach the frontend (it would be interleaved with the new process's
    /// output and can even contain escape sequences that clear the screen).
    pub generation: Mutex<u64>,
}

/// Interactive shell for a fresh prompt, started *in* `root`. On Windows
/// the command is `cmd /K cd /d "<root>"`: `/K` keeps cmd alive (no
/// `/C`), and the explicit `cd` guarantees the prompt lands in `root`
/// even if the process-level working directory is ignored, relative, or
/// otherwise wrong — the shell's own state is the source of truth.
pub fn interactive_shell_command(root: &Path) -> (String, Vec<String>) {
    #[cfg(target_os = "windows")]
    {
        let root = crate::workspace::strip_windows_extended_prefix(root);
        let mut root_str = root.to_string_lossy().replace('/', "\\");
        while root_str.ends_with('\\') {
            root_str.pop();
        }
        (
            "cmd.exe".to_string(),
            vec!["/K".to_string(), format!("cd /d \"{root_str}\"")],
        )
    }
    #[cfg(not(target_os = "windows"))]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "sh".to_string());
        (shell, Vec::new())
    }
}

/// One-shot shell invocation used to run an agent command: `/C` on
/// Windows, `-c` on Unix — the process exits when the command finishes.
fn command_shell() -> (String, String) {
    #[cfg(target_os = "windows")]
    {
        ("cmd.exe".to_string(), "/C".to_string())
    }
    #[cfg(not(target_os = "windows"))]
    {
        ("sh".to_string(), "-c".to_string())
    }
}

impl PtySession {
    pub fn new() -> Self {
        Self {
            master: Mutex::new(None),
            writer: Mutex::new(None),
            child: Mutex::new(None),
            cols: Mutex::new(100),
            rows: Mutex::new(30),
            generation: Mutex::new(0),
        }
    }
}

/// Kills the process currently running in the terminal, if any. Called
/// when a new process takes over the pane and by the Kill button.
pub fn kill_current(session: &PtySession) {
    // Closing the master PTY first unblocks the reader thread (its read()
    // call returns an error or EOF), so it exits instead of lingering and
    // emitting stale data into the next process's output.
    *session.master.lock().unwrap() = None;
    if let Some(mut child) = session.child.lock().unwrap().take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    *session.writer.lock().unwrap() = None;
}

/// Writes raw input (keystrokes) to the running process's TTY — the idle
/// shell or whatever command is currently in the pane.
pub fn write_input(session: &PtySession, data: &str) {
    let mut writer = session.writer.lock().unwrap();
    if let Some(w) = writer.as_mut() {
        let _ = w.write_all(data.as_bytes());
        let _ = w.flush();
    }
}

/// Updates the PTY size; also remembered for the next spawned process.
pub fn resize(session: &PtySession, cols: u16, rows: u16) {
    let cols = cols.max(2);
    let rows = rows.max(2);
    *session.cols.lock().unwrap() = cols;
    *session.rows.lock().unwrap() = rows;
    if let Some(master) = session.master.lock().unwrap().as_ref() {
        let _ = master.resize(PtySize {
            cols,
            rows,
            pixel_width: 0,
            pixel_height: 0,
        });
    }
}

/// Shared spawn: opens a fresh PTY, starts `cmd` with `root` as its
/// working directory, replaces whatever was running in `session`, and
/// starts the reader thread. The reader forwards every chunk to the
/// frontend as a `terminal:data` event *and* sends it into the returned
/// channel — callers that don't need the output (the idle shell) simply
/// drop the channel.
fn spawn_pty(
    app: &AppHandle,
    root: &Path,
    mut cmd: CommandBuilder,
    session: &Arc<PtySession>,
) -> Result<mpsc::Receiver<String>> {
    // cmd.exe can't use `\\?\`-prefixed paths as a working directory; the
    // folder picker / canonicalize sometimes hand those to us. Strip the
    // prefix so the process actually starts where we asked.
    let root = crate::workspace::strip_windows_extended_prefix(root);
    let pty_system = native_pty_system();
    let (cols, rows) = (*session.cols.lock().unwrap(), *session.rows.lock().unwrap());
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .context("failed to allocate pseudo-terminal")?;
    let (master, slave) = (pair.master, pair.slave);

    cmd.cwd(root.clone());

    let child = slave
        .spawn_command(cmd)
        .with_context(|| format!("failed to start process in {}", root.display()))?;
    // Our copy of the slave must close so the child (its only remaining
    // holder) sees EOF on output when it exits.
    drop(slave);

    let writer = master.take_writer().context("failed to open pty writer")?;
    let reader = master.try_clone_reader().context("failed to open pty reader")?;

    *session.master.lock().unwrap() = Some(master);
    *session.writer.lock().unwrap() = Some(writer);
    *session.child.lock().unwrap() = Some(child);

    // Bump the generation so any in-flight reader threads from a previous
    // process will stop emitting — their chunks belong to a dead PTY and
    // would be interleaved with (or clear) the new process's output.
    let gen = {
        let mut g = session.generation.lock().unwrap();
        *g += 1;
        *g
    };

    // Reader thread: reads raw bytes and forwards complete UTF-8 chunks.
    // A partial multi-byte sequence at the end of a chunk is held back
    // until the next read completes it, so characters are never split.
    // The thread checks the session's generation before each emit and
    // shuts itself down if a newer process has taken over the pane.
    let (tx, rx) = mpsc::channel::<String>();
    let app = app.clone();
    let session = session.clone();
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut buf = [0u8; 4096];
        let mut pending: Vec<u8> = Vec::new();
        loop {
            // If a newer process has been spawned, detach immediately.
            let still_current = {
                let g = session.generation.lock().unwrap();
                *g == gen
            };
            if !still_current {
                break;
            }
            let n = match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => n,
                Err(_) => break,
            };
            pending.extend_from_slice(&buf[..n]);

            let mut complete: Vec<u8> = Vec::new();
            loop {
                match std::str::from_utf8(&pending) {
                    Ok(_) => {
                        complete.append(&mut pending);
                        break;
                    }
                    Err(e) => {
                        let valid = e.valid_up_to();
                        if valid == 0 {
                            break; // waiting for more bytes
                        }
                        complete.extend(pending.drain(..valid));
                    }
                }
            }
            if !complete.is_empty() {
                let chunk = String::from_utf8_lossy(&complete).into_owned();
                // Re-check generation before emitting — the spawn that
                // replaced this process might have happened right after
                // the read returned.
                let still_current = {
                    let g = session.generation.lock().unwrap();
                    *g == gen
                };
                if still_current {
                    let _ = app.emit(DATA_EVENT, TerminalDataEvent { data: chunk.clone() });
                    let _ = tx.send(chunk);
                }
            }
        }
        // Whatever is left at EOF (shouldn't normally be a partial char).
        if !pending.is_empty() {
            let chunk = String::from_utf8_lossy(&pending).into_owned();
            let still_current = {
                let g = session.generation.lock().unwrap();
                *g == gen
            };
            if still_current {
                let _ = app.emit(DATA_EVENT, TerminalDataEvent { data: chunk.clone() });
                let _ = tx.send(chunk);
            }
        }
    });

    Ok(rx)
}

/// Starts the idle interactive shell in `root` (the selected workspace,
/// or the home directory when none is open), replacing whatever was
/// running. Non-blocking: the shell keeps running in the background and
/// the user types straight into it like a normal terminal.
pub fn spawn_shell(app: &AppHandle, root: &Path, session: &Arc<PtySession>) -> Result<()> {
    kill_current(session);

    let (shell, args) = interactive_shell_command(root);
    let mut cmd = CommandBuilder::new(shell);
    for arg in args {
        cmd.arg(arg);
    }

    let _rx = spawn_pty(app, root, cmd, session)?;
    let _ = app.emit(
        STATUS_EVENT,
        TerminalStatusEvent {
            status: "shell".into(),
            code: None,
            cwd: Some(root.display().to_string()),
        },
    );
    Ok(())
}

/// Runs `command` (through the platform shell) in `root` inside a fresh
/// pseudo-terminal attached to `session`, replacing whatever was running
/// (the idle shell). Streams the child's output to the frontend as
/// `terminal:data` events (plus `terminal:status` on start/exit), blocks
/// until the process exits, and returns its full combined output.
///
/// Used by the agent for approved `run_command` calls — the user watches
/// it run live in the Terminal panel *and* can interact with it (type
/// answers to prompts), and the model still receives the output as the
/// tool result. The idle shell is respawned once the command exits so
/// the terminal stays usable.
pub fn run_command_sync(
    app: &AppHandle,
    root: &Path,
    command: &str,
    session: &Arc<PtySession>,
) -> Result<String> {
    kill_current(session);

    let (shell, flag) = command_shell();
    let mut cmd = CommandBuilder::new(shell);
    cmd.arg(flag);
    cmd.arg(command);

    let rx = spawn_pty(app, root, cmd, session)?;

    let _ = app.emit(
        STATUS_EVENT,
        TerminalStatusEvent {
            status: "running".into(),
            code: None,
            cwd: Some(root.display().to_string()),
        },
    );

    // Collect the command's output until the process itself exits. We
    // can't wait for pipe EOF here: the app keeps the pty's write end
    // (the writer) alive for the life of the session, so the read side
    // never signals EOF. Polling the child handle is the reliable signal.
    let combined = {
        let mut guard = session.child.lock().unwrap();
        match guard.as_mut() {
            Some(child) => drain_until_exit(child, &rx),
            None => String::new(),
        }
    };

    // `exit_code` is 0 on a normal successful exit; a killed process
    // surfaces a non-zero teardown code.
    let code = match session.child.lock().unwrap().take() {
        Some(mut child) => child.wait().ok().map(|s| s.exit_code()),
        // Already killed / taken by a newer command.
        None => None,
    };

    let _ = app.emit(
        STATUS_EVENT,
        TerminalStatusEvent {
            status: "exit".into(),
            code,
            cwd: Some(root.display().to_string()),
        },
    );

    // Bring the interactive shell back so the terminal stays usable.
    let _ = spawn_shell(app, root, session);

    // A TTY delivers CRLF line endings; normalize for the model's sake and
    // append the exit status (the agent sees it in the tool result).
    let mut combined = combined.replace("\r\n", "\n").replace('\r', "\n");
    match code {
        Some(c) => combined.push_str(&format!("\n[exit code: {c}]")),
        None => combined.push_str("\n[process terminated]\n"),
    }
    Ok(truncate_output(&combined, 8_000))
}

/// Drains the receiver into `combined` until the child process exits,
/// then gives stragglers a short grace period. Returns `combined`.
///
/// See the note in `run_command_sync` on why process-exit polling (not
/// pipe EOF) is the termination signal.
fn drain_until_exit(
    child: &mut Box<dyn Child + Send + Sync>,
    rx: &mpsc::Receiver<String>,
) -> String {
    let mut combined = String::new();
    loop {
        let exited = child.try_wait().ok().flatten().is_some();
        drain_available(&mut combined, rx);
        if exited {
            // The last bytes may still be in flight; collect briefly.
            let deadline = std::time::Instant::now() + std::time::Duration::from_millis(300);
            while std::time::Instant::now() < deadline {
                match rx.recv_timeout(std::time::Duration::from_millis(50)) {
                    Ok(chunk) => combined.push_str(&chunk),
                    Err(_) => break,
                }
            }
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    combined
}

fn drain_available(combined: &mut String, rx: &mpsc::Receiver<String>) {
    loop {
        match rx.try_recv() {
            Ok(chunk) => combined.push_str(&chunk),
            Err(_) => break,
        }
    }
}

fn truncate_output(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        s.to_string()
    } else {
        let truncated: String = s.chars().take(max_chars).collect();
        format!("{truncated}\n…[truncated]")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verifies that a process spawned through the PTY actually starts in
    /// the requested working directory — the mechanism the "terminal opens
    /// in the workspace folder" behavior relies on. Runs the platform
    /// shell's `cd` (with no arguments it prints the current directory)
    /// and checks the output contains the directory we asked for.
    /// Verifies that the interactive shell actually lands in the requested
    /// directory (via the startup `cd` on Windows) and accepts input — the
    /// full "terminal opens in the workspace folder" behavior, headless.
    #[test]
    fn interactive_shell_opens_in_cwd_and_accepts_input() {
        let target = std::env::temp_dir().join("subsidium-shell-test");
        std::fs::create_dir_all(&target).unwrap();

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 30,
                cols: 100,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let (master, slave) = (pair.master, pair.slave);

        let (shell, args) = interactive_shell_command(&target);
        let mut cmd = CommandBuilder::new(shell);
        for arg in args {
            cmd.arg(arg);
        }
        cmd.cwd(&target);
        let mut child = slave.spawn_command(cmd).unwrap();
        drop(slave);

        let mut writer = master.take_writer().unwrap();
        let mut reader = master.try_clone_reader().unwrap();

        // Ask the shell where it is, then close it. `%CD%` is cmd.exe's
        // current-directory variable; the prompt would show the same path.
        let _ = writer.write_all(b"echo [CWD]%CD%\r\nexit\r");
        let _ = writer.flush();

        // Wait for the shell to exit (bounded), then close our write end
        // so the reader sees EOF and we can collect the transcript.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
        while child.try_wait().ok().flatten().is_none() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        let _ = child.kill();
        let _ = child.wait();
        drop(writer);

        let mut out = String::new();
        let _ = reader.read_to_string(&mut out);

        let expected = target.to_string_lossy().to_lowercase().replace('/', "\\");
        let actual = out.to_lowercase();
        assert!(
            actual.contains(&expected),
            "shell did not open in target dir:\n  expected: {expected}\n  got: {actual}"
        );
    }

    /// Verifies that a process spawned through the PTY actually starts in
    /// the requested working directory — the mechanism the "terminal opens
    /// in the workspace folder" behavior relies on. Runs the platform
    /// shell's `cd` (with no arguments it prints the current directory)
    /// and checks the output contains the directory we asked for.
    #[test]
    fn pty_respects_cwd() {
        let target = std::env::temp_dir().join("subsidium-cwd-test");
        std::fs::create_dir_all(&target).unwrap();

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 30,
                cols: 100,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");
        let (master, slave) = (pair.master, pair.slave);

        let (shell, flag) = command_shell();
        let mut cmd = CommandBuilder::new(shell);
        cmd.arg(flag);
        cmd.arg("cd");
        cmd.cwd(&target);
        let mut child = slave.spawn_command(cmd).expect("spawn");
        drop(slave);

        // Wait for the process to finish, then close our copy of the pty's
        // write end so the reader sees EOF and we can collect the output.
        let mut writer = master.take_writer().expect("take_writer");
        let mut reader = master.try_clone_reader().expect("reader");
        let _ = child.wait();
        drop(writer);

        let mut out = String::new();
        reader.read_to_string(&mut out).expect("read");

        let expected = target.to_string_lossy().to_lowercase().replace('/', "\\");
        let actual = out.to_lowercase();
        assert!(
            actual.contains(&expected),
            "pty cwd mismatch:\n  expected: {expected}\n  got: {actual}"
        );
    }
}