import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { staticFallback } from "../modelCatalog";
import { AgentChatEntry, AgentMessage, AgentTurnResult, ConversationSummary, ModelSummary, ProviderConfig, ToolLogEntry } from "../types";
import Markdown from "./Markdown";

// Converts the backend's raw provider-agnostic history (as loaded from a
// past conversation) into the display entries the panel already knows how
// to render. ToolResult messages aren't shown as their own bubble — their
// content is folded into the "used <tool>" chip on the Assistant message
// that requested them, same as a live turn.
function transcriptFromMessages(messages: AgentMessage[]): AgentChatEntry[] {
  const resultsByCallId = new Map<string, string>();
  for (const m of messages) {
    if (m.kind === "ToolResult") resultsByCallId.set(m.tool_call_id, m.content);
  }

  const entries: AgentChatEntry[] = [];
  for (const m of messages) {
    if (m.kind === "User") {
      entries.push({ kind: "user", text: m.text });
    } else if (m.kind === "Assistant") {
      const toolLog: ToolLogEntry[] = m.tool_calls.map((tc) => ({
        tool_name: tc.name,
        arguments: tc.arguments,
        result_preview: (resultsByCallId.get(tc.id) ?? "").slice(0, 200),
      }));
      if (m.text || toolLog.length > 0) {
        entries.push({ kind: "assistant", text: m.text ?? "", thinking: null, toolLog });
      }
    }
    // ToolResult entries are consumed above, not rendered standalone.
  }
  return entries;
}

export default function AgentPanel({
  hasWorkspace,
  onFileWritten,
  onUsageChange,
}: {
  hasWorkspace: boolean;
  onFileWritten: (path: string) => void;
  onUsageChange?: (used: number, limit: number) => void;
}) {
  const [entries, setEntries] = useState<AgentChatEntry[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [totals, setTotals] = useState<{ input: number; output: number } | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<number | null>(null);
  const [providerConfig, setProviderConfig] = useState<ProviderConfig | null>(null);
  const [providerLabel, setProviderLabel] = useState<string | null>(null);
  const [lastModel, setLastModel] = useState<string | null>(null);
  // Model ids the in-chat switcher can pick from: the provider's live
  // model list when reachable, the curated catalog otherwise.
  const [modelOptions, setModelOptions] = useState<ModelSummary[]>([]);
  const [switchingModel, setSwitchingModel] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!hasWorkspace) return;
    invoke<ProviderConfig | null>("get_active_provider_config")
      .then((c) => {
        setProviderConfig(c);
        setProviderLabel(c ? c.label : null);
        setLastModel(c ? c.model : null);
        if (c) refreshModelOptions(c);
      })
      .catch(() => {
        setProviderConfig(null);
        setProviderLabel(null);
        setLastModel(null);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasWorkspace]);

  async function refreshModelOptions(config: ProviderConfig) {
    // Start from the curated list so the dropdown always has options even
    // when the provider's models API can't be reached; the live results
    // (with display names) replace it when they arrive.
    setModelOptions(staticFallback(config.provider));
    try {
      const list = await invoke<ModelSummary[]>("list_models_for_config", { id: config.id });
      if (list.length > 0) setModelOptions(list);
    } catch {
      // keep the curated fallback
    }
  }

  // Current model + live/curated options, deduped and with the current
  // model always present (a provider sometimes returns ids that differ
  // slightly from what was configured).
  function modelOptionsFor(): ModelSummary[] {
    const current = lastModel ?? providerConfig?.model;
    const seen = new Set<string>();
    const out: ModelSummary[] = [];
    for (const m of modelOptions) {
      if (!seen.has(m.id)) {
        seen.add(m.id);
        out.push(m);
      }
    }
    if (current && !seen.has(current)) out.unshift({ id: current, display_name: null });
    return out;
  }

  // Switches the model for the active provider mid-conversation — the
  // next turn simply uses the new model (the backend re-reads the config
  // per turn), and the choice persists in providers.json.
  async function switchModel(next: string) {
    const config = providerConfig;
    if (!config || next === (lastModel ?? config.model) || switchingModel) return;
    setSwitchingModel(true);
    try {
      const saved = await invoke<ProviderConfig>("save_provider_config", {
        config: { ...config, model: next },
        apiKey: null,
      });
      setProviderConfig(saved);
      setLastModel(saved.model);
    } catch (err) {
      setEntries((prev) => [...prev, { kind: "error", text: String(err) }]);
    } finally {
      setSwitchingModel(false);
    }
  }

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [entries]);

  async function toggleHistory() {
    const next = !showHistory;
    setShowHistory(next);
    if (next && hasWorkspace) {
      try {
        setConversations(await invoke<ConversationSummary[]>("list_conversations"));
      } catch {
        setConversations([]);
      }
    }
  }

  async function openConversation(id: number) {
    setShowHistory(false);
    setBusy(true);
    try {
      const messages = await invoke<AgentMessage[]>("load_conversation", { id });
      setEntries(transcriptFromMessages(messages));
      setActiveConversationId(id);
      setTotals(null); // historical token usage wasn't stored per message
    } catch (err) {
      setEntries((prev) => [...prev, { kind: "error", text: String(err) }]);
    } finally {
      setBusy(false);
    }
  }

  async function removeConversation(id: number, e: React.MouseEvent) {
    e.stopPropagation();
    await invoke("delete_conversation", { id });
    setConversations((prev) => prev.filter((c) => c.id !== id));
    if (activeConversationId === id) {
      setEntries([]);
      setActiveConversationId(null);
      setTotals(null);
    }
  }

  function applyResult(result: AgentTurnResult) {
    setTotals({ input: result.total_input_tokens, output: result.total_output_tokens });
    onUsageChange?.(result.tokens_used, result.token_limit);
    if (result.conversation_id !== null) setActiveConversationId(result.conversation_id);
    if (result.model) setLastModel(result.model);

    if (result.status === "pending_approval" && result.pending_tool) {
      // Narrowed into a local: TS doesn't keep the narrowing of
      // result.pending_tool inside the setEntries callback below.
      const pendingTool = result.pending_tool;
      setEntries((prev) => [
        ...prev,
        ...(result.text
          ? [{ kind: "assistant", text: result.text, thinking: result.thinking, toolLog: result.tool_log } as AgentChatEntry]
          : []),
        {
          kind: "approval",
          tool: pendingTool,
          description: result.pending_description ?? pendingTool.name,
          diff: result.pending_diff,
          resolved: null,
        },
      ]);
    } else {
      setEntries((prev) => [
        ...prev,
        { kind: "assistant", text: result.text ?? "", thinking: result.thinking, toolLog: result.tool_log },
      ]);
    }

    // A write_file the agent already had approved earlier in this turn
    // means the file on disk changed — refresh the editor if it's open.
    for (const entry of result.tool_log) {
      if (entry.tool_name === "write_file" && typeof entry.arguments === "object" && entry.arguments) {
        const path = (entry.arguments as { path?: string }).path;
        if (path) onFileWritten(path);
      }
    }
  }

  // Requests the running agent turn to stop — the loop checks the flag
  // between steps and reports back as a normal ("stopped") result.
  async function stopAgent() {
    await invoke("agent_stop").catch(() => {});
  }

  async function send() {
    const text = input.trim();
    if (!text || busy || !hasWorkspace) return;
    setInput("");
    setEntries((prev) => [...prev, { kind: "user", text }]);
    setBusy(true);
    try {
      const result = await invoke<AgentTurnResult>("agent_send_message", { text });
      applyResult(result);
    } catch (err) {
      setEntries((prev) => [...prev, { kind: "error", text: String(err) }]);
    } finally {
      setBusy(false);
    }
  }

  async function respond(index: number, approved: boolean) {
    setEntries((prev) =>
      prev.map((e, i) => (i === index && e.kind === "approval" ? { ...e, resolved: approved ? "approved" : "denied" } : e))
    );
    setBusy(true);
    try {
      const result = await invoke<AgentTurnResult>("agent_respond_to_approval", { approved });
      if (approved && entries[index]?.kind === "approval") {
        const tool = (entries[index] as Extract<AgentChatEntry, { kind: "approval" }>).tool;
        if (tool.name === "write_file" && typeof tool.arguments === "object" && tool.arguments) {
          const path = (tool.arguments as { path?: string }).path;
          if (path) onFileWritten(path);
        }
      }
      applyResult(result);
    } catch (err) {
      setEntries((prev) => [...prev, { kind: "error", text: String(err) }]);
    } finally {
      setBusy(false);
    }
  }

  async function startNew() {
    await invoke("agent_reset");
    setEntries([]);
    setTotals(null);
    setActiveConversationId(null);
    setShowHistory(false);
  }

  return (
    <div className="h-full flex flex-col min-h-0 relative">
      <div className="flex items-center justify-between px-3 h-9 border-b border-border shrink-0">
        <div className="min-w-0 flex items-center gap-1.5">
          {providerConfig && (
            <>
              <span className="px-1.5 py-0.5 rounded bg-accent/10 text-accent text-[11px] font-medium truncate shrink-0">
                {providerLabel}
              </span>
              <select
                value={lastModel ?? providerConfig.model}
                onChange={(e) => switchModel(e.target.value)}
                disabled={busy || switchingModel}
                title="Switch model — takes effect on the next message"
                className="max-w-[150px] bg-panel border border-border rounded px-1.5 py-0.5 text-[11px] font-mono text-muted hover:text-ink outline-none focus:border-accent-dim disabled:opacity-50 transition shrink-0"
              >
                {modelOptionsFor().map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id}
                  </option>
                ))}
              </select>
            </>
          )}
          <span className="text-muted text-[11px] truncate">
            {totals
              ? `${totals.input.toLocaleString("en-US")} in · ${totals.output.toLocaleString("en-US")} out`
              : "No messages yet"}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={toggleHistory}
            className="px-2 h-6 rounded border border-border text-[11px] text-muted hover:text-ink hover:border-accent-dim transition"
          >
            History
          </button>
          <button
            onClick={startNew}
            className="px-2 h-6 rounded border border-border text-[11px] text-muted hover:text-ink hover:border-accent-dim transition"
          >
            New
          </button>
        </div>
      </div>

      {showHistory && (
        <div className="absolute right-2 top-9 z-10 w-64 max-h-72 overflow-y-auto bg-panel2 border border-border rounded-md shadow-lg">
          {conversations.length === 0 ? (
            <div className="px-3 py-2 text-xs text-muted">No past conversations yet.</div>
          ) : (
            conversations.map((c) => (
              <div
                key={c.id}
                onClick={() => openConversation(c.id)}
                className={`px-3 py-2 text-xs cursor-pointer border-b border-border/60 last:border-b-0 hover:bg-panel flex items-center justify-between gap-2 ${
                  activeConversationId === c.id ? "bg-panel" : ""
                }`}
              >
                <div className="min-w-0">
                  <div className="truncate text-ink/90">{c.title}</div>
                  <div className="text-muted/70 text-[10px]">{c.updated_at}</div>
                </div>
                <button
                  onClick={(e) => removeConversation(c.id, e)}
                  className="text-muted hover:text-bad shrink-0"
                  title="Delete"
                >
                  ✕
                </button>
              </div>
            ))
          )}
        </div>
      )}

      <div ref={scrollRef} className="flex-1 overflow-y-auto min-h-0 px-3 py-3 space-y-2.5 chat-scroll">
        {entries.length === 0 && (
          <div className="text-sm text-muted text-center mt-8 px-6 leading-relaxed">
            {hasWorkspace
              ? "Ask the agent to explain, find, or change something in this workspace."
              : "Select a workspace first."}
          </div>
        )}

        {entries.map((entry, i) => (
          <div
            key={i}
            className="msg-in"
            style={{ animationDelay: `${Math.min(i, 5) * 25}ms` }}
          >
            <ChatEntry entry={entry} onRespond={(approved) => respond(i, approved)} />
          </div>
        ))}

        {busy && (
          <div className="flex items-center px-1">
            <div className="flex items-center gap-1.5 text-xs text-muted px-2.5 py-1.5 rounded-full bg-panel border border-border">
              Working
              <span className="dot" />
              <span className="dot" />
              <span className="dot" />
            </div>
          </div>
        )}
      </div>

      <div className="px-3 pt-2.5 pb-3 border-t border-border shrink-0 flex gap-2 items-end">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          disabled={!hasWorkspace || busy}
          placeholder={
            hasWorkspace ? "Message the agent…" : "Select a workspace to chat"
          }
          className="flex-1 bg-panel border border-border rounded-lg px-3 py-2 text-sm outline-none placeholder:text-muted/60 focus:border-accent-dim disabled:opacity-50 transition"
        />
        {busy ? (
          <button
            onClick={stopAgent}
            className="h-[34px] px-4 rounded-lg bg-bad/15 text-bad border border-bad/30 text-sm font-medium hover:bg-bad/25 transition shrink-0 flex items-center gap-1.5"
            title="Stop the agent"
          >
            <SquareGlyph />
            Stop
          </button>
        ) : (
          <button
            onClick={send}
            disabled={!hasWorkspace || !input.trim()}
            className="h-[34px] px-4 rounded-lg bg-accent text-base text-sm font-medium disabled:opacity-35 hover:brightness-110 transition shrink-0"
          >
            Send
          </button>
        )}
      </div>
    </div>
  );
}

function DiffView({ diff }: { diff: string }) {
  const lines = diff.split("\n").filter((_, i, arr) => !(i === arr.length - 1 && arr[i] === ""));
  return (
    <div className="max-h-56 overflow-y-auto bg-base border border-border rounded-md text-[11px] font-mono">
      {lines.map((line, i) => {
        const isAdd = line.startsWith("+");
        const isDel = line.startsWith("-");
        return (
          <div
            key={i}
            className={`px-2 whitespace-pre-wrap ${
              isAdd ? "bg-good/10 text-good" : isDel ? "bg-bad/10 text-bad" : "text-muted"
            }`}
          >
            {line || " "}
          </div>
        );
      })}
    </div>
  );
}

function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="max-w-[90%]">
      <button
        onClick={() => setOpen((o) => !o)}
        className="text-[11px] text-muted hover:text-ink italic flex items-center gap-1"
      >
        <span>{open ? "▾" : "▸"}</span> thinking…
      </button>
      {open && (
        <div className="mt-1 border-l-2 border-border pl-2 text-[11px] text-muted italic whitespace-pre-wrap">
          {text}
        </div>
      )}
    </div>
  );
}

function ChatEntry({ entry, onRespond }: { entry: AgentChatEntry; onRespond: (approved: boolean) => void }) {
  if (entry.kind === "user") {
    return (
      <div className="flex justify-end gap-2">
        <div className="max-w-[85%] bg-brand text-white rounded-2xl rounded-br-md px-4 py-2 text-sm whitespace-pre-wrap leading-relaxed shadow-[0_1px_3px_rgba(0,0,0,0.18)]">
          {entry.text}
        </div>
      </div>
    );
  }

  if (entry.kind === "assistant") {
    return (
      <div className="flex gap-2">
        <div className="w-6 h-6 mt-0.5 rounded-lg bg-panel2 border border-border flex items-center justify-center shrink-0 shadow-sm">
          <SparkGlyph />
        </div>
        <div className="space-y-1.5 min-w-0 flex-1">
          {entry.toolLog.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {entry.toolLog.map((t, i) => (
                <span
                  key={i}
                  title={t.result_preview}
                  className="chip-in text-[10px] px-1.5 py-0.5 rounded bg-panel border border-border text-muted font-mono"
                  style={{ animationDelay: `${i * 40}ms` }}
                >
                  ⇢ {t.tool_name}
                </span>
              ))}
            </div>
          )}
          {entry.thinking && <ThinkingBlock text={entry.thinking} />}
          {entry.text && (
            <div className="bg-panel border border-border rounded-2xl rounded-tl-md px-4 py-2.5 text-sm shadow-sm overflow-x-auto">
              <Markdown text={entry.text} />
            </div>
          )}
        </div>
      </div>
    );
  }

  if (entry.kind === "error") {
    return (
      <div className="flex gap-2">
        <div className="w-6 h-6 mt-0.5 rounded-md bg-panel2 border border-border flex items-center justify-center shrink-0">
          <ErrorGlyph />
        </div>
        <div className="text-xs text-bad bg-bad/10 border border-bad/15 rounded-lg px-3 py-2 flex-1">{entry.text}</div>
      </div>
    );
  }

  // approval card
  return (
    <div className="ml-8 border border-accent-dim/50 bg-accent/[0.05] rounded-lg px-3.5 py-3 space-y-2.5">
      <div className="flex items-center gap-1.5 text-xs text-accent font-medium">
        <ShieldGlyph />
        Approval needed
      </div>
      <div className="text-sm font-mono text-ink/90 bg-base/60 border border-border/60 rounded-md px-2.5 py-1.5">
        {entry.description}
      </div>
      {entry.diff && <DiffView diff={entry.diff} />}
      {entry.resolved === null ? (
        <div className="flex gap-2">
          <button
            onClick={() => onRespond(true)}
            className="px-3 h-7 rounded-md bg-accent text-base text-xs font-medium hover:brightness-110 transition"
          >
            Approve
          </button>
          <button
            onClick={() => onRespond(false)}
            className="px-3 h-7 rounded-md border border-border text-xs text-muted hover:text-ink hover:border-accent-dim transition"
          >
            Deny
          </button>
        </div>
      ) : (
        <div
          className={`text-xs flex items-center gap-1 ${
            entry.resolved === "approved" ? "text-good" : "text-bad"
          }`}
        >
          {entry.resolved === "approved" ? (
            <>
              <CheckGlyph /> Approved — running in the terminal / applied
            </>
          ) : (
            <>
              <XGlyph /> Denied
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Tiny glyphs for chat chrome ──────────────────────────────────────
function SparkGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-accent">
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
    </svg>
  );
}

function ShieldGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}

function CheckGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function XGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function ErrorGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-bad">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}

function SquareGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
      <rect x="5" y="5" width="14" height="14" rx="2" />
    </svg>
  );
}
