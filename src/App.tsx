import { useEffect, useState } from "react";
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
import { AppSettings, ProviderConfig, WorkspaceState } from "./types";

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
  // editor, so CodeEditor (keyed on path+this) remounts and re-reads the
  // new content from disk instead of silently showing stale text.
  const [editorReloadTick, setEditorReloadTick] = useState(0);

  function refreshTokens() {
    invoke<AppSettings>("get_app_settings")
      .then((s) => setTokens({ used: s.tokens_used, limit: s.token_limit }))
      .catch(() => {});
  }

  useEffect(() => {
    refreshTokens();
  }, []);

  function handleAgentFileWritten(path: string) {
    if (path === selectedFile) {
      setEditorReloadTick((t) => t + 1);
    }
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
      <header className="h-12 flex items-center justify-between px-3 border-b border-border shrink-0">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-2 h-2 rounded-full bg-brand shadow-[0_0_6px_rgba(21,107,58,0.7)] shrink-0" />
          <span className="font-semibold tracking-tight text-sm text-brand">Subsidium</span>
          {workspaceName && (
            <span className="text-xs text-muted truncate border-l border-border pl-2.5 ml-0.5 max-w-[240px]">
              {workspaceName}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
          <button
            onClick={() => setShowSettings(true)}
            className="h-7 px-2.5 rounded border border-border text-xs text-muted hover:text-ink hover:border-accent-dim transition flex items-center gap-1.5"
            title="Settings"
          >
            <SettingsIcon />
            Settings
          </button>
          <WorkspacePicker
            busy={busy}
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
          <div className="h-full flex flex-col min-h-0 border-r border-border">
            <PanelHeader title="Explorer" icon={<FolderIcon />} />
            <FileExplorer tree={state.tree} onSelect={setSelectedFile} selectedPath={selectedFile} />
          </div>
        </Panel>

        <PanelResizeHandle className="resize-handle resize-handle-h" />

        {/* Middle column: code editor on top, terminal below it. */}
        <Panel defaultSize={52} minSize={28} className="min-w-0">
          <PanelGroup direction="vertical" className="h-full min-h-0">
            <Panel defaultSize={66} minSize={25} className="min-h-0">
              <CodeEditor key={`${selectedFile ?? ""}:${editorReloadTick}`} path={selectedFile} />
            </Panel>
            <PanelResizeHandle className="resize-handle resize-handle-v" />
            <Panel defaultSize={34} minSize={14} className="min-h-0">
              <div className="h-full flex flex-col min-h-0 border-t border-border">
                <TerminalPanel theme={theme} />
              </div>
            </Panel>
          </PanelGroup>
        </Panel>

        <PanelResizeHandle className="resize-handle resize-handle-h" />

        <Panel defaultSize={30} minSize={22} className="min-w-0">
          <div className="h-full flex flex-col min-h-0 border-l border-border">
            <div className="flex border-b border-border shrink-0">
              <TabButton
                label="Agent"
                icon={<ChatIcon />}
                active={rightTab === "agent"}
                onClick={() => setRightTab("agent")}
              />
              <TabButton
                label="Search"
                icon={<SearchIcon />}
                active={rightTab === "search"}
                onClick={() => setRightTab("search")}
              />
              <TabButton
                label="Intel"
                icon={<PulseIcon />}
                active={rightTab === "intel"}
                onClick={() => setRightTab("intel")}
              />
              <TabButton
                label="Git"
                icon={<GitIcon />}
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
                onUsageChange={(used, limit) => setTokens({ used, limit })}
              />
            </div>
            <div className={rightTab === "search" ? "flex-1 min-h-0 flex flex-col" : "hidden"}>
              <SearchPanel hasWorkspace={!!state.root} onSelectFile={setSelectedFile} />
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

function PanelHeader({ title, icon }: { title: string; icon?: React.ReactNode }) {
  return (
    <div className="h-9 flex items-center gap-2 px-3 text-xs text-muted border-b border-border shrink-0 select-none">
      {icon}
      <span>{title}</span>
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
      className={`flex-1 h-9 text-xs font-medium transition flex items-center justify-center gap-1.5 border-b-2 ${
        active
          ? "text-ink border-accent bg-accent/[0.04]"
          : "text-muted border-transparent hover:text-ink hover:bg-panel/50"
      }`}
    >
      {icon}
      {label}
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
      className="h-8 flex items-center gap-3 px-3 border-t border-border shrink-0"
      title="Usage is counted in model-weighted tokens: each model consumes budget according to its price, so an expensive model burns the budget faster than a cheap one."
    >
      <div className="flex items-center gap-1.5 shrink-0 text-muted">
        <SparkIcon />
        <span className="text-[11px]">Token budget</span>
      </div>
      <div className="flex-1 h-1.5 rounded-full bg-panel2 overflow-hidden">
        <div
          className={`h-full transition-all duration-300 ${over ? "bg-bad" : "bg-accent"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className={`text-[11px] font-mono shrink-0 tabular-nums ${over ? "text-bad" : "text-muted"}`}>
        {formatTokens(used)} / {limit > 0 ? formatTokens(limit) : "∞"}
        <span className={over ? "text-bad" : "text-muted/60"}> weighted</span>
      </span>
    </div>
  );
}

// ── Small inline icons (stroke-based, inherit currentColor) ─────────

function SettingsIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function ChatIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.35-4.35" />
    </svg>
  );
}

function PulseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  );
}

function GitIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="6" r="3" />
      <path d="M6 9v6M18 9a6 6 0 0 1-6 6h-2" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function SparkIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2l2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4z" />
    </svg>
  );
}