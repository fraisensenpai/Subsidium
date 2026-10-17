import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { StripeIcon, TerminalIcon } from "./icons";

interface TerminalData {
  data: string;
}

interface TerminalStatus {
  status: "shell" | "running" | "exit" | string;
  code: number | null;
  cwd: string | null;
}

function xtermTheme(theme: "light" | "dark") {
  if (theme === "light") {
    return {
      background: "#f6f6f4",
      foreground: "#1a1b18",
      cursor: "#1c7649",
      cursorAccent: "#f6f6f4",
      selectionBackground: "rgba(28, 118, 73, 0.22)",
    };
  }
  return {
    background: "#0d0f0e",
    foreground: "#e6e9e5",
    cursor: "#3db576",
    cursorAccent: "#0d0f0e",
    selectionBackground: "rgba(61, 181, 118, 0.28)",
  };
}

const MONO_FONT =
  '"Cascadia Code", "Cascadia Mono", Consolas, ui-monospace, "SFMono-Regular", monospace';

export default function TerminalPanel({ theme }: { theme: "light" | "dark" }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // "running" = a command (agent-approved) owns the pane; "shell" = the
  // idle interactive shell is up; "exit" = last command finished.
  const [phase, setPhase] = useState<"shell" | "running" | "exit">("shell");
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  // Mirror of `phase`, readable from the xterm input handler created in the
  // once-only lifecycle effect below (which would otherwise capture the
  // initial value forever).
  const phaseRef = useRef<"shell" | "running" | "exit">("shell");
  // A command queued to run in a fresh shell once the pane is free — set
  // when the user submits a command while a process is still running (the
  // text must not be fed to that process as an answer to its prompt).
  const pendingRunRef = useRef<string | null>(null);
  const pendingTimerRef = useRef<number | null>(null);

  // Runs a queued command once nothing owns the pane anymore.
  function runQueued() {
    const queued = pendingRunRef.current;
    if (queued === null) return;
    pendingRunRef.current = null;
    if (pendingTimerRef.current !== null) {
      window.clearTimeout(pendingTimerRef.current);
      pendingTimerRef.current = null;
    }
    void (async () => {
      await invoke("terminal_start_shell").catch(() => {});
      await invoke("terminal_input", { data: queued + "\r" }).catch(() => {});
    })();
  }

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  // ── Terminal lifecycle ────────────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 12,
      lineHeight: 1.25,
      fontFamily: MONO_FONT,
      scrollback: 5000,
      theme: xtermTheme(theme),
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    termRef.current = term;
    fitRef.current = fit;

    // Keep the pty size in sync with the visible terminal and report it to
    // the backend (also on the first layout, so the very first spawned
    // process already has the correct dimensions).
    const syncSize = () => {
      try {
        fit.fit();
      } catch {
        // container not laid out yet
      }
      invoke("terminal_resize", { cols: term.cols, rows: term.rows }).catch(() => {});
    };
    syncSize();
    const resizeObserver = new ResizeObserver(syncSize);
    resizeObserver.observe(container);

    // Forward keystrokes to the terminal's process — the idle shell or
    // whatever command is running in the pane. Always on, exactly like a
    // normal terminal. After an agent command finishes the pane intentionally
    // keeps that command's output on screen with no process attached, so the
    // first keystroke starts the idle shell (which is why we must not do
    // that for a still-running command — typing there is interactive input).
    const dataDisposable = term.onData((data) => {
      void (async () => {
        if (phaseRef.current === "exit") {
          await invoke("terminal_start_shell").catch(() => {});
        }
        await invoke("terminal_input", { data }).catch(() => {});
      })();
    });

    return () => {
      dataDisposable.dispose();
      resizeObserver.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-theme when the app theme changes.
  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.theme = xtermTheme(theme);
  }, [theme]);

  // ── Backend events ────────────────────────────────────────────────
  useEffect(() => {
    let unlisteners: UnlistenFn[] = [];
    let cancelled = false;
    (async () => {
      try {
        const unData = await listen<TerminalData>("terminal:data", (event) => {
          if (!cancelled) termRef.current?.write(event.payload.data);
        });
        const unStatus = await listen<TerminalStatus>("terminal:status", (event) => {
          if (cancelled) return;
          const payload = event.payload;
          if (payload.status === "running") {
            setPhase("running");
            setExitCode(null);
            // Focus the terminal so the user can type straight into an
            // interactive prompt without clicking first.
            setTimeout(() => termRef.current?.focus(), 50);
          } else if (payload.status === "shell") {
            // The idle shell is up (or came back after a command) — the
            // pane is just a normal terminal again.
            setPhase("shell");
            setExitCode(null);
          } else {
            setPhase("exit");
            setExitCode(payload.code ?? -1);
            if (pendingRunRef.current !== null) {
              // A command was waiting for the pane to free up — run it now.
              runQueued();
            } else {
              setTimeout(() => inputRef.current?.focus(), 50);
            }
          }
        });
        unlisteners = [unData, unStatus];
      } catch {
        // backend unavailable (browser dev) — terminal just stays empty
      }
    })();
    return () => {
      cancelled = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Actions ───────────────────────────────────────────────────────
  // The input strip *runs commands*. If a process is already running it
  // would swallow the line as an answer to its prompt (the "my new command
  // didn't run" bug), so we stop it first — and run the command once the
  // pane is free. Answer a running prompt by typing in the terminal view
  // above, which always forwards keystrokes to the process.
  async function submit() {
    const text = input.trim();
    if (text === "") return;
    setInput("");
    if (phaseRef.current === "running") {
      pendingRunRef.current = text;
      if (pendingTimerRef.current !== null) window.clearTimeout(pendingTimerRef.current);
      // Safety net: if the "exit" event never arrives (nothing was actually
      // draining), still run the command shortly.
      pendingTimerRef.current = window.setTimeout(() => {
        pendingTimerRef.current = null;
        runQueued();
      }, 1500);
      // Stop the agent's turn too, so it doesn't immediately launch another
      // command that steals the pane back before ours runs.
      await invoke("agent_stop").catch(() => {});
      await invoke("terminal_kill").catch(() => {});
      return;
    }
    // The shell may have exited (an agent command leaves its output on
    // screen with nothing running) — start it before sending the line.
    if (phaseRef.current === "exit") {
      await invoke("terminal_start_shell").catch(() => {});
    }
    await invoke("terminal_input", { data: text + "\r" }).catch(() => {});
  }

  async function kill() {
    // Stop the agent's turn as well, so it doesn't keep issuing commands
    // into the pane right after we clear it.
    await invoke("agent_stop").catch(() => {});
    await invoke("terminal_kill").catch(() => {});
  }

  function clearScreen() {
    termRef.current?.clear();
  }

  const running = phase === "running";

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="h-9 flex items-center justify-between px-3 bg-panel border-b border-border shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <TerminalIcon size={13} className="text-muted shrink-0" />
          <span className="micro-label">Terminal</span>
          <span
            className={`w-1.5 h-1.5 rounded-full shrink-0 ml-0.5 ${
              running ? "bg-accent animate-pulse" : phase === "exit" ? (exitCode === 0 ? "bg-good/70" : "bg-bad/70") : "bg-border-strong"
            }`}
          />
          {running && <span className="text-[10px] text-accent">running</span>}
          {phase === "exit" && (
            <span className={`text-[10px] font-mono ${exitCode === 0 ? "text-good" : "text-bad"}`}>
              exit {exitCode}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={kill}
            disabled={!running}
            title="Kill"
            className="w-6 h-6 rounded-md text-muted hover:text-bad disabled:opacity-40 transition flex items-center justify-center"
          >
            <StripeIcon size={9} />
          </button>
          <button
            onClick={clearScreen}
            className="h-6 px-2 rounded-md text-[11px] text-muted hover:text-ink hover:bg-panel2 transition"
          >
            Clear
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 bg-base relative">
        <div ref={containerRef} className="absolute inset-0 px-1 py-1" />
      </div>

      <div className="p-2 border-t border-border shrink-0 flex gap-2 items-center">
        <span className={`text-xs font-mono shrink-0 ${running ? "text-accent" : "text-muted"}`}>❯</span>
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder={
            running
              ? "Running — type a command to stop it and run this instead (answer prompts in the terminal above)…"
              : "Type a command and press Enter…"
          }
          className="flex-1 bg-panel2 border border-border rounded-md px-2 py-1 font-mono text-xs outline-none focus:border-accent-dim transition"
        />
      </div>
    </div>
  );
}
