use anyhow::{Context, Result};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

pub const DATA_EVENT: &str = "terminal:data";
pub const STATUS_EVENT: &str = "terminal:status";

/// Upper bound on how long an agent-run command may occupy the pane/turn.
/// A command that never exits — a dev server started with no background
/// flag, an interactive prompt, a runaway loop — would otherwise hang the
/// agent indefinitely, since the loop blocks until the process is gone.
/// Killing it lets the turn continue and tells the model what happened.
const COMMAND_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

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
///   status. Nothing is running afterwards — the shell is started lazily
///   the next time the user types into the pane.
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
    /// Set when whatever runs in the pane should be stopped. `kill_current`
    /// sets it, but the process that's actually running a command owns the
    /// child handle for the whole time it drains output, so the drain loop
    /// polls this flag and kills the child itself instead of the killer
    /// blocking on the (held) child lock. Cleared whenever a new process is
    /// spawned.
    pub kill_requested: AtomicBool,
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
            kill_requested: AtomicBool::new(false),
        }
    }
}

/// Kills the process currently running in the terminal, if any. Called when
/// a new process takes over the pane, and by the Kill button. (The agent's
/// Stop button uses `request_stop` instead, so it leaves the idle shell
/// alone.)
pub fn kill_current(session: &PtySession) {
    // Flag it first: a `run_command_sync` currently draining output holds
    // the child lock for the whole run, so the killer below would block
    // until the command finished on its own. The drain loop polls this and
    // kills the child itself, so Stop takes effect immediately.
    session.kill_requested.store(true, Ordering::SeqCst);
    // Closing the master PTY next unblocks the reader thread (its read()
    // call returns an error or EOF), so it exits instead of lingering and
    // emitting stale data into the next process's output.
    *session.master.lock().unwrap() = None;
    if let Some(mut child) = session.child.lock().unwrap().take() {
        kill_process_tree(child.as_mut());
        let _ = child.kill();
        let _ = child.wait();
    }
    *session.writer.lock().unwrap() = None;
}

/// Asks whatever is running in the pane to stop *without* touching the idle
/// interactive shell: only a command being drained checks this flag, and
/// since it holds the child handle for the whole run it kills the process
/// itself. Used by the agent's Stop button so it never tears down the
/// shell when the agent is merely thinking (not running a command).
pub fn request_stop(session: &PtySession) {
    session.kill_requested.store(true, Ordering::SeqCst);
}

/// Kills a process *and its descendants*. `Child::kill` only terminates the
/// direct child (e.g. `cmd.exe`), which is not enough for the common "the
/// agent started a dev server" case: the shell dies but the node/python
/// process it launched keeps running and holding the port. On Windows
/// `taskkill /T` walks the process tree; elsewhere the POSIX shells we spawn
/// are one-shot so killing the direct child is sufficient.
fn kill_process_tree(child: &mut (dyn Child + Send + Sync)) {
    #[cfg(target_os = "windows")]
    if let Some(pid) = child.process_id() {
        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = child;
    }
}

/// Whether a process is currently attached to the pane — the idle shell or
/// a command that's still running. Lets `terminal_start_shell` be
/// idempotent: it must not spawn a new console (which would clear the pane)
/// when something is already there.
pub fn has_live_process(session: &PtySession) -> bool {
    let mut guard = session.child.lock().unwrap();
    match guard.as_mut() {
        Some(child) => child.try_wait().ok().flatten().is_none(),
        None => false,
    }
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

    // A fresh process starts un-killed, even if the previous one was
    // stopped (the flag is sticky so an in-flight drain loop can see it).
    session.kill_requested.store(false, Ordering::SeqCst);

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
/// tool result. The run is bounded: the Stop button kills the process, and
/// `COMMAND_TIMEOUT` kills it if it never exits on its own, so a stuck
/// command can't hang the turn forever. Nothing is left running
/// afterwards; the idle shell comes back lazily on the next keystroke.
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

    // Make the command visible in the pane: unlike an interactive prompt,
    // `cmd /C` (and `sh -c`) don't echo the command they were handed, so
    // without this the user sees output with no idea what produced it.
    let _ = app.emit(
        DATA_EVENT,
        TerminalDataEvent {
            data: format!("> {command}\r\n"),
        },
    );

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
    let (combined, reason) = {
        let mut guard = session.child.lock().unwrap();
        match guard.as_mut() {
            Some(child) => {
                drain_until_exit(child, &rx, &session.kill_requested, COMMAND_TIMEOUT)
            }
            None => (String::new(), EndReason::Exited),
        }
    };

    // `exit_code` is 0 on a normal successful exit; a killed process
    // surfaces a non-zero teardown code.
    let code = match session.child.lock().unwrap().take() {
        Some(mut child) => child.wait().ok().map(|s| s.exit_code()),
        // Already killed / taken by a newer command (the Stop button runs
        // `kill_current` while we're draining).
        None => None,
    };

    // Detach the dead command's PTY handles *first*, so nothing is running.
    // Emitting "exit" after this (rather than before) matters: a listener
    // that reacts to "exit" by starting a fresh shell — e.g. the panel
    // running a command queued while this one was stopped — would otherwise
    // race with the cleanup below, which spawns no process but does tear
    // down the session. Keeping the order means "exit" is the last word.
    //
    // Respawning the idle shell here instead would allocate a brand new
    // console, and Windows' ConPTY clears the screen when it starts — which
    // wiped the exact output the user was reading (the "command shows up,
    // then the terminal resets a moment later" bug). The shell is started
    // lazily on the user's next keystroke (`terminal_start_shell`).
    kill_current(session);

    let _ = app.emit(
        STATUS_EVENT,
        TerminalStatusEvent {
            status: "exit".into(),
            code,
            cwd: Some(root.display().to_string()),
        },
    );

    // A TTY delivers CRLF line endings; normalize for the model's sake and
    // append the exit status (the agent sees it in the tool result).
    let mut combined = combined.replace("\r\n", "\n").replace('\r', "\n");
    match reason {
        EndReason::Killed => combined.push_str("\n[stopped by the user]"),
        EndReason::TimedOut => combined.push_str(&format!(
            "\n[timed out after {}s — process killed. If this command is long-running \
             or waits for input, run it in the background or with a non-interactive flag]",
            COMMAND_TIMEOUT.as_secs()
        )),
        EndReason::Exited => {}
    }
    match code {
        Some(c) => combined.push_str(&format!("\n[exit code: {c}]")),
        None => combined.push_str("\n[process terminated]\n"),
    }
    Ok(truncate_output(&combined, 8_000))
}

/// How an agent-run command stopped.
enum EndReason {
    /// The process exited on its own.
    Exited,
    /// The Stop / Kill button asked it to stop.
    Killed,
    /// It never exited and hit `COMMAND_TIMEOUT`.
    TimedOut,
}

/// Drains the receiver into the combined output until the child exits, is
/// asked to stop, or times out. Returns the output and how it ended.
///
/// See the note in `run_command_sync` on why process-exit polling (not
/// pipe EOF) is the termination signal.
fn drain_until_exit(
    child: &mut Box<dyn Child + Send + Sync>,
    rx: &mpsc::Receiver<String>,
    kill_requested: &AtomicBool,
    timeout: std::time::Duration,
) -> (String, EndReason) {
    let mut combined = String::new();
    let deadline = std::time::Instant::now() + timeout;
    loop {
        // Stop requested. We hold the child lock for the whole drain, so
        // the killer couldn't take the handle — it only set the flag; the
        // killing happens here.
        if kill_requested.swap(false, Ordering::SeqCst) {
            kill_process_tree(child.as_mut());
            let _ = child.kill();
            collect_stragglers(&mut combined, rx);
            return (combined, EndReason::Killed);
        }

        let exited = child.try_wait().ok().flatten().is_some();
        drain_available(&mut combined, rx);
        if exited {
            collect_stragglers(&mut combined, rx);
            return (combined, EndReason::Exited);
        }

        if std::time::Instant::now() >= deadline {
            kill_process_tree(child.as_mut());
            let _ = child.kill();
            collect_stragglers(&mut combined, rx);
            return (combined, EndReason::TimedOut);
        }

        std::thread::sleep(std::time::Duration::from_millis(25));
    }
}

/// Collects the last bytes that may still be in flight once the process is
/// gone, stopping as soon as the channel falls quiet for a moment.
fn collect_stragglers(combined: &mut String, rx: &mpsc::Receiver<String>) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(300);
    while std::time::Instant::now() < deadline {
        match rx.recv_timeout(std::time::Duration::from_millis(50)) {
            Ok(chunk) => combined.push_str(&chunk),
            Err(_) => break,
        }
    }
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

    /// Creates the throwaway directory a test runs its shell in.
    fn probe_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(name);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// What to look for in the PTY transcript. Only the directory *name* is
    /// matched, not the full path: the platforms disagree about separators,
    /// case, and whether the temp dir is a symlink (`/tmp` vs
    /// `/private/tmp` on macOS), and none of that is what these tests are
    /// about. Lowercased because cmd.exe output is case-insensitive.
    fn needle(dir: &std::path::Path) -> String {
        dir.file_name()
            .expect("probe dir has a name")
            .to_string_lossy()
            .to_lowercase()
    }

    /// Reads the PTY transcript until EOF, but never blocks forever: the read
    /// runs on its own thread and we only wait a bounded time for it. A shell
    /// that lingers (or a grandchild that inherited the pty) must not be able
    /// to hang the whole test run -- Windows ConPTY in particular does not
    /// always deliver EOF once the child exits.
    fn read_bounded(
        mut reader: Box<dyn std::io::Read + Send>,
        budget: std::time::Duration,
    ) -> String {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut out = String::new();
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => out.push_str(&String::from_utf8_lossy(&buf[..n])),
                }
            }
            let _ = tx.send(out);
        });
        rx.recv_timeout(budget).unwrap_or_default()
    }

    /// Verifies the full "terminal opens in the workspace folder" behavior,
    /// headless: the interactive shell starts in the requested directory and
    /// accepts typed input.
    #[test]
    fn interactive_shell_opens_in_cwd_and_accepts_input() {
        let target = probe_dir("subsidium-shell-test");

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
        let reader = master.try_clone_reader().unwrap();

        // Ask the shell where it is, then close it. `%CD%` is cmd.exe's
        // current-directory variable; `$(pwd)` is the POSIX equivalent.
        #[cfg(target_os = "windows")]
        let _ = writer.write_all(b"echo [CWD]%CD%\r\nexit\r");
        #[cfg(not(target_os = "windows"))]
        let _ = writer.write_all(b"echo [CWD]$(pwd)\nexit\n");
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

        let out = read_bounded(reader, std::time::Duration::from_secs(5));

        let expected = needle(&target);
        let actual = out.to_lowercase();
        assert!(
            actual.contains(&expected),
            "shell did not open in {expected}:\n{actual}"
        );
    }

    /// Verifies that a process spawned through the PTY actually starts in
    /// the requested working directory — the mechanism behind "the terminal
    /// opens in the workspace folder". `cmd /C cd` prints cmd's current
    /// directory; `sh -c pwd` is the POSIX equivalent.
    #[test]
    fn pty_respects_cwd() {
        let target = probe_dir("subsidium-cwd-test");

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

        #[cfg(target_os = "windows")]
        let script = "cd";
        #[cfg(not(target_os = "windows"))]
        let script = "pwd";

        let (shell, flag) = command_shell();
        let mut cmd = CommandBuilder::new(shell);
        cmd.arg(flag);
        cmd.arg(script);
        cmd.cwd(&target);
        let mut child = slave.spawn_command(cmd).expect("spawn");
        drop(slave);

        // Wait for the process to finish, then close our copy of the pty's
        // write end so the reader sees EOF and we can collect the output.
        let writer = master.take_writer().expect("take_writer");
        let reader = master.try_clone_reader().expect("reader");
        let _ = child.wait();
        drop(writer);

        let out = read_bounded(reader, std::time::Duration::from_secs(5));

        let expected = needle(&target);
        let actual = out.to_lowercase();
        assert!(
            actual.contains(&expected),
            "pty did not start in {expected}:\n{actual}"
        );
    }
}