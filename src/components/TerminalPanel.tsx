import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

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
      background: "#fafaf8",
      foreground: "#171816",
      cursor: "#1b7a45",
      cursorAccent: "#fafaf8",
      selectionBackground: "rgba(27, 122, 69, 0.25)",
    };
  }
  return {
    background: "#0a0c0b",
    foreground: "#e4e6e0",
    cursor: "#3ab06c",
    cursorAccent: "#0a0c0b",
    selectionBackground: "rgba(58, 176, 108, 0.3)",
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
    // normal terminal.
    const dataDisposable = term.onData((data) => {
      invoke("terminal_input", { data }).catch(() => {});
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
            setTimeout(() => inputRef.current?.focus(), 50);
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
  }, []);

  // ── Actions ───────────────────────────────────────────────────────
  // The input strip is just another way of typing into the shell/process:
  // the text plus Enter goes straight to the pty, which echoes it back
  // (like typing it in the terminal view itself).
  async function submit() {
    const text = input;
    if (text === "") return;
    setInput("");
    await invoke("terminal_input", { data: text + "\r" }).catch(() => {});
  }

  async function kill() {
    await invoke("terminal_kill").catch(() => {});
  }

  function clearScreen() {
    termRef.current?.clear();
  }

  const running = phase === "running";

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="h-8 flex items-center justify-between px-3 border-b border-border shrink-0 text-xs">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={`w-2 h-2 rounded-full shrink-0 ${
              running ? "bg-accent animate-pulse" : phase === "exit" ? (exitCode === 0 ? "bg-good/70" : "bg-bad/70") : "bg-border"
            }`}
          />
          <span className="text-muted">Terminal</span>
          {running && <span className="text-[10px] text-accent">running…</span>}
          {phase === "exit" && (
            <span className={`text-[10px] font-mono ${exitCode === 0 ? "text-good" : "text-bad"}`}>
              exited {exitCode}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <button onClick={kill} disabled={!running} className="text-muted hover:text-bad disabled:opacity-40">
            Kill
          </button>
          <button onClick={clearScreen} className="text-muted hover:text-ink">
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
            running ? "Interactive input — type a response to the running process…" : "Type a command and press Enter…"
          }
          className="flex-1 bg-base border border-border rounded px-2 py-1 font-mono text-xs outline-none focus:border-accent-dim"
        />
      </div>
    </div>
  );
}