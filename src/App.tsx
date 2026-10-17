import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import WorkspacePicker from "./components/WorkspacePicker";
import FileExplorer from "./components/FileExplorer";
import ProjectSummary from "./components/ProjectSummary";
import SearchPanel from "./components/SearchPanel";
import CodeEditor from "./components/CodeEditor";
import SettingsModal from "./components/SettingsModal";
import AgentPanel from "./components/AgentPanel";
import GitPanel from "./components/GitPanel";
import TerminalPanel from "./components/TerminalPanel";
import OnboardingScreen from "./components/OnboardingScreen";
import ThemeToggle, { useTheme } from "./components/ThemeToggle";
import { AppSettings, FileNode, ProviderConfig, WorkspaceState } from "./types";
import crescendoLogo from "../assets/crescendo.png";
import {
  ChatIcon,
  FolderIcon,
  GitBranchIcon,
  PulseIcon,
  SearchIcon,
  SettingsIcon,
  SparkIcon,
} from "./components/icons";

type RightTab = "agent" | "search" | "intel" | "git";

function formatTokens(n: number): string {
  return n.toLocaleString("en-US");
}

export default function App() {
  const { theme, toggle: toggleTheme, set: setTheme } = useTheme();
  const [checkingSetup, setCheckingSetup] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);

  useEffect(() => {
    invoke<ProviderConfig[]>("list_provider_configs")
      .then((configs) => setNeedsSetup(configs.length === 0))
      .catch(() => setNeedsSetup(true))
      .finally(() => setCheckingSetup(false));
  }, []);

  const [state, setState] = useState<WorkspaceState>({
    root: null,
    tree: null,
    scanSummary: null,
    indexStats: null,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [rightTab, setRightTab] = useState<RightTab>("agent");
  const [showSettings, setShowSettings] = useState(false);
  // Global token budget (all conversations, persists across restarts) —
  // shown in the status bar at the bottom and enforced by the backend.
  const [tokens, setTokens] = useState<{ used: number; limit: number } | null>(null);
  // Bumped whenever the agent writes the file currently open in the
  // editor; CodeEditor reacts by reloading — or, if the buffer is dirty,
  // showing a conflict prompt instead of silently discarding the edits.
  const [editorExternalVersion, setEditorExternalVersion] = useState(0);
  // Whether the editor currently has unsaved changes, so we can warn before
  // switching to another file.
  const editorDirtyRef = useRef(false);

  function refreshTokens() {
    invoke<AppSettings>("get_app_settings")
      .then((s) => setTokens({ used: s.tokens_used, limit: s.token_limit }))
      .catch(() => {});
  }

  useEffect(() => {
    refreshTokens();
    // Poll so the status bar stays current and the backend's periodic
    // token-usage reset is applied even while the app sits idle.
    const timer = setInterval(refreshTokens, 60_000);
    return () => clearInterval(timer);
  }, []);

  function handleAgentFileWritten(path: string) {
    if (path === selectedFile) {
      setEditorExternalVersion((v) => v + 1);
    }
  }

  // Opens a file in the editor, warning first if the current buffer has
  // unsaved changes (switching remounts the editor and would drop them).
  function selectFile(next: string | null) {
    if (next !== selectedFile && editorDirtyRef.current) {
      const ok = window.confirm(
        "You have unsaved changes. Discard them and open the selected file?",
      );
      if (!ok) return;
    }
    setSelectedFile(next);
  }

  // Re-scans the workspace and swaps in the fresh file tree. Called after
  // the agent runs a write_file/run_command, which can add or rename files —
  // without this the Explorer keeps showing the pre-agent listing.
  function refreshFileTree() {
    invoke<FileNode>("refresh_file_tree")
      .then((tree) => setState((s) => (s.root ? { ...s, tree } : s)))
      .catch(() => {});
  }

  const workspaceName = state.root ? state.root.split(/[\\/]/).filter(Boolean).pop() : null;

  if (checkingSetup) {
    return <div className="h-screen w-screen bg-base" />;
  }

  if (needsSetup) {
    return <OnboardingScreen onDone={() => setNeedsSetup(false)} />;
  }

  return (
    <div className="h-screen w-screen flex flex-col bg-base text-ink">
      <header className="h-11 flex items-center justify-between px-3 bg-panel border-b border-border shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex items-center gap-2">
            <Logo />
            <span className="font-semibold tracking-tight text-[13.5px] text-ink">Subsidium</span>
          </div>
          {workspaceName && (
            <div className="flex items-center gap-1.5 min-w-0 pl-3 border-l border-border">
              <span className="text-xs text-muted truncate max-w-[260px]" title={state.root ?? undefined}>
                {workspaceName}
              </span>
            </div>
          )}
          <div
            className="flex items-center gap-1.5 pl-3 border-l border-border shrink-0"
            title="Subsidium is made by Crescendo Technologies"
          >
            <img src={crescendoLogo} alt="" className="w-3.5 h-3.5 rounded-[3px]" />
            <span className="text-[11px] text-muted whitespace-nowrap">by Crescendo Technologies</span>
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
          <button
            onClick={() => setShowSettings(true)}
            className="h-7 px-2.5 rounded-md border border-border text-xs text-muted hover:text-ink hover:border-border-strong hover:bg-panel2 transition flex items-center gap-1.5"
            title="Settings"
          >
            <SettingsIcon size={13} />
            Settings
          </button>
          <WorkspacePicker
            busy={busy}
            onConfirmSwitch={() => {
              if (!editorDirtyRef.current) return true;
              return window.confirm(
                "You have unsaved changes in the editor. Switch workspace and discard them?",
              );
            }}
            onStart={() => {
              setBusy(true);
              setError(null);
            }}
            onWorkspaceLoaded={(root, tree, summary, stats) => {
              setState({ root, tree, scanSummary: summary, indexStats: stats });
              setSelectedFile(null);
              setBusy(false);
              // A fresh workspace means a fresh agent conversation — the
              // old one is persisted and still reachable via History in
              // the new workspace's index.
              invoke("agent_reset").catch(() => {});
            }}
            onError={(message) => {
              setError(message);
              setBusy(false);
            }}
          />
        </div>
      </header>

      {error && (
        <div className="px-3 py-1.5 text-xs bg-bad/10 text-bad border-b border-bad/20">{error}</div>
      )}

      <PanelGroup direction="horizontal" className="flex-1 min-h-0">
        <Panel defaultSize={18} minSize={12} className="min-w-0">
          <div className="h-full flex flex-col min-h-0">
            <PanelHeader title="Explorer" icon={<FolderIcon size={13} />} />
            <FileExplorer tree={state.tree} onSelect={selectFile} selectedPath={selectedFile} />
          </div>
        </Panel>

        <PanelResizeHandle className="resize-handle resize-handle-h" />

        {/* Middle column: code editor on top, terminal below it. */}
        <Panel defaultSize={52} minSize={28} className="min-w-0">
          <PanelGroup direction="vertical" className="h-full min-h-0">
            <Panel defaultSize={66} minSize={25} className="min-h-0">
              <CodeEditor
                key={selectedFile ?? ""}
                path={selectedFile}
                theme={theme}
                externalVersion={editorExternalVersion}
                onDirtyChange={(d) => (editorDirtyRef.current = d)}
              />
            </Panel>
            <PanelResizeHandle className="resize-handle resize-handle-v" />
            <Panel defaultSize={34} minSize={14} className="min-h-0">
              <div className="h-full flex flex-col min-h-0">
                <TerminalPanel theme={theme} />
              </div>
            </Panel>
          </PanelGroup>
        </Panel>

        <PanelResizeHandle className="resize-handle resize-handle-h" />

        <Panel defaultSize={30} minSize={22} className="min-w-0">
          <div className="h-full flex flex-col min-h-0 border-l border-border">
            <div className="flex bg-panel border-b border-border shrink-0">
              <TabButton
                label="Agent"
                icon={<ChatIcon size={13} />}
                active={rightTab === "agent"}
                onClick={() => setRightTab("agent")}
              />
              <TabButton
                label="Search"
                icon={<SearchIcon size={13} />}
                active={rightTab === "search"}
                onClick={() => setRightTab("search")}
              />
              <TabButton
                label="Intel"
                icon={<PulseIcon size={13} />}
                active={rightTab === "intel"}
                onClick={() => setRightTab("intel")}
              />
              <TabButton
                label="Git"
                icon={<GitBranchIcon size={13} />}
                active={rightTab === "git"}
                onClick={() => setRightTab("git")}
              />
            </div>
            {/* All panels stay mounted so switching tabs never destroys the
                live chat transcript / search results; inactive ones are
                simply hidden. */}
            <div className={rightTab === "agent" ? "flex-1 min-h-0 flex flex-col" : "hidden"}>
              {/* Keyed by workspace: opening a different workspace resets
                  the visible transcript (the old one is still in History). */}
              <AgentPanel
                key={state.root ?? "none"}
                hasWorkspace={!!state.root}
                onFileWritten={handleAgentFileWritten}
                onFilesChanged={refreshFileTree}
                onUsageChange={(used, limit) => setTokens({ used, limit })}
              />
            </div>
            <div className={rightTab === "search" ? "flex-1 min-h-0 flex flex-col" : "hidden"}>
              <SearchPanel hasWorkspace={!!state.root} onSelectFile={selectFile} />
            </div>
            <div className={rightTab === "intel" ? "flex-1 min-h-0 flex flex-col" : "hidden"}>
              <ProjectSummary summary={state.scanSummary} stats={state.indexStats} />
            </div>
            <div className={rightTab === "git" ? "flex-1 min-h-0 flex flex-col" : "hidden"}>
              <GitPanel hasWorkspace={!!state.root} />
            </div>
          </div>
        </Panel>
      </PanelGroup>

      {/* Token budget status bar */}
      <TokenBar tokens={tokens} />

      {showSettings && (
        <SettingsModal
          onClose={() => setShowSettings(false)}
          onChanged={refreshTokens}
          theme={theme}
          onThemeChange={setTheme}
        />
      )}
    </div>
  );
}

function Logo() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" className="text-brand">
      <path
        d="M12 2.6 20.4 7.3v9.4L12 21.4 3.6 16.7V7.3z"
        fill="rgb(var(--c-brand) / 0.14)"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M12 7.4 16.4 10 12 12.6 7.6 10z" fill="currentColor" />
      <path d="M12 12.6v4.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function PanelHeader({ title, icon }: { title: string; icon?: React.ReactNode }) {
  return (
    <div className="h-9 flex items-center gap-2 px-3 bg-panel border-b border-border shrink-0 select-none">
      {icon && <span className="text-muted">{icon}</span>}
      <span className="micro-label">{title}</span>
    </div>
  );
}

function TabButton({
  label,
  icon,
  active,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      className={`relative h-10 flex-1 text-xs font-medium transition flex items-center justify-center gap-1.5 ${
        active ? "text-ink" : "text-muted hover:text-ink hover:bg-panel2/60"
      }`}
    >
      <span className={active ? "text-accent" : ""}>{icon}</span>
      {label}
      {active && <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-accent" />}
    </button>
  );
}

function TokenBar({ tokens }: { tokens: { used: number; limit: number } | null }) {
  const used = tokens?.used ?? 0;
  const limit = tokens?.limit ?? 0;
  const over = limit > 0 && used >= limit;
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;

  return (
    <div
      className="h-8 flex items-center gap-3 px-3 bg-panel border-t border-border shrink-0"
      title="Usage is counted in model-weighted tokens: each model consumes budget according to its price, so an expensive model burns the budget faster than a cheap one."
    >
      <div className="flex items-center gap-1.5 shrink-0 text-muted">
        <SparkIcon size={12} />
        <span className="micro-label">Budget</span>
      </div>
      <div className="flex-1 h-1.5 rounded-full bg-sunken overflow-hidden">
        <div
          className={`h-full transition-all duration-300 ${over ? "bg-bad" : "bg-accent"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span
        className={`text-[11px] font-mono shrink-0 tabular-nums ${over ? "text-bad" : "text-muted"}`}
      >
        {formatTokens(used)} / {limit > 0 ? formatTokens(limit) : "∞"}
        <span className={over ? "text-bad" : "text-muted/60"}> weighted</span>
      </span>
    </div>
  );
}
