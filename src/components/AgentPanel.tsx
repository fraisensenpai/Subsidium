import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { staticFallbackFor } from "../modelCatalog";
import {
  AgentChatEntry,
  AgentMessage,
  AgentTurnResult,
  ConversationSummary,
  ModelSummary,
  ProviderConfig,
  ToolLogEntry,
} from "../types";
import Markdown from "./Markdown";
import { CheckIcon, CloseIcon, PlusIcon, StripeIcon, WarningIcon, ArrowRightIcon } from "./icons";

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
  onFilesChanged,
  onUsageChange,
}: {
  hasWorkspace: boolean;
  onFileWritten: (path: string) => void;
  /** Called after a privileged action that may have changed files on disk. */
  onFilesChanged?: () => void;
  onUsageChange?: (used: number, limit: number) => void;
}) {
  const [entries, setEntries] = useState<AgentChatEntry[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  // True between the Stop click and the turn actually coming back — lets the
  // button say "Stopping…" instead of looking like the click did nothing
  // while an in-flight provider call / command unwinds.
  const [stopping, setStopping] = useState(false);
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
  // Identifies the in-flight turn's UI "session". Bumped whenever the user
  // switches context (new conversation, opens another, deletes the active
  // one) so a turn that's still resolving is dropped instead of being
  // rendered into the conversation the user has moved to.
  const turnTokenRef = useRef(0);
  // Wraps the History button and its dropdown so a click anywhere else
  // closes the menu (previously it stayed open until the button was hit
  // again, hovering over the transcript).
  const historyRef = useRef<HTMLDivElement>(null);

  // While a turn is winding down after Stop, clear the pending flag once it
  // actually returns.
  useEffect(() => {
    if (!busy) setStopping(false);
  }, [busy]);

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
    setModelOptions(staticFallbackFor(config));
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

  // Close the History dropdown when the user clicks outside it.
  useEffect(() => {
    if (!showHistory) return;
    function onPointerDown(e: PointerEvent) {
      if (!historyRef.current?.contains(e.target as Node)) setShowHistory(false);
    }
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [showHistory]);

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
    // Leaving the current conversation — drop any turn still resolving for
    // it so its reply can't be appended here.
    const token = ++turnTokenRef.current;
    setStopping(false);
    setBusy(true);
    try {
      const messages = await invoke<AgentMessage[]>("load_conversation", { id });
      if (token !== turnTokenRef.current) return;
      setEntries(transcriptFromMessages(messages));
      setActiveConversationId(id);
      setTotals(null); // historical token usage wasn't stored per message
    } catch (err) {
      if (token === turnTokenRef.current) {
        setEntries((prev) => [...prev, { kind: "error", text: String(err) }]);
      }
    } finally {
      if (token === turnTokenRef.current) setBusy(false);
    }
  }

  async function removeConversation(id: number, e: React.MouseEvent) {
    e.stopPropagation();
    await invoke("delete_conversation", { id });
    setConversations((prev) => prev.filter((c) => c.id !== id));
    if (activeConversationId === id) {
      // The active conversation is gone — invalidate any turn still running
      // for it (the backend aborts it too) and show an empty pane.
      turnTokenRef.current++;
      setStopping(false);
      setBusy(false);
      setEntries([]);
      setActiveConversationId(null);
      setTotals(null);
    }
  }

  function applyResult(result: AgentTurnResult) {
    // A turn the backend abandoned because the conversation was replaced —
    // nothing to render.
    if (result.status === "aborted") return;
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
    } else if (result.status === "limit_reached" || result.status === "step_limit") {
      // The turn ended early for a structural reason (token budget spent, or
      // the step cap hit) rather than the model finishing — render it as a
      // distinct notice so it doesn't read like a normal reply.
      setEntries((prev) => [
        ...prev,
        { kind: "notice", text: result.text ?? "", toolLog: result.tool_log },
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

  // Requests the running agent turn to stop — the loop checks the flag right
  // after the in-flight provider call returns, and any command running in the
  // Terminal panel is killed immediately.
  async function stopAgent() {
    if (stopping) return;
    setStopping(true);
    await invoke("agent_stop").catch(() => {});
  }

  async function send() {
    const text = input.trim();
    if (!text || busy || !hasWorkspace) return;
    setInput("");
    setEntries((prev) => [...prev, { kind: "user", text }]);
    const token = ++turnTokenRef.current;
    setBusy(true);
    try {
      const result = await invoke<AgentTurnResult>("agent_send_message", { text });
      if (token === turnTokenRef.current) applyResult(result);
    } catch (err) {
      if (token === turnTokenRef.current) {
        setEntries((prev) => [...prev, { kind: "error", text: String(err) }]);
      }
    } finally {
      if (token === turnTokenRef.current) setBusy(false);
    }
  }

  async function respond(index: number, approved: boolean) {
    setEntries((prev) =>
      prev.map((e, i) => (i === index && e.kind === "approval" ? { ...e, resolved: approved ? "approved" : "denied" } : e))
    );
    const approvedTool =
      approved && entries[index]?.kind === "approval"
        ? (entries[index] as Extract<AgentChatEntry, { kind: "approval" }>).tool
        : null;
    const token = ++turnTokenRef.current;
    setBusy(true);
    try {
      const result = await invoke<AgentTurnResult>("agent_respond_to_approval", { approved });
      // Disk side effects are real regardless of which conversation is now
      // showing, so refresh the editor/Explorer before the staleness guard.
      if (approvedTool) {
        if (
          approvedTool.name === "write_file" &&
          typeof approvedTool.arguments === "object" &&
          approvedTool.arguments
        ) {
          const path = (approvedTool.arguments as { path?: string }).path;
          if (path) onFileWritten(path);
        }
        // A privileged action can add or change files on disk — a
        // run_command (a script that writes a file, for instance) just as
        // much as a write_file — so rescan the Explorer either way.
        onFilesChanged?.();
      }
      if (token !== turnTokenRef.current) return;
      applyResult(result);
    } catch (err) {
      if (token === turnTokenRef.current) {
        setEntries((prev) => [...prev, { kind: "error", text: String(err) }]);
      }
    } finally {
      if (token === turnTokenRef.current) setBusy(false);
    }
  }

  async function startNew() {
    // Invalidate the in-flight turn first — its reply must not land in the
    // new conversation (the backend aborts it too).
    const token = ++turnTokenRef.current;
    setStopping(false);
    setShowHistory(false);
    setEntries([]);
    setTotals(null);
    setActiveConversationId(null);
    setBusy(true);
    try {
      await invoke("agent_reset");
    } catch {
      // ignore
    } finally {
      if (token === turnTokenRef.current) setBusy(false);
    }
  }

  return (
    <div className="h-full flex flex-col min-h-0 relative">
      <div className="flex items-center justify-between px-3 h-10 border-b border-border shrink-0 gap-2">
        <div className="min-w-0 flex items-center gap-1.5">
          {providerConfig && (
            <>
              <span className="px-1.5 py-0.5 rounded-md bg-accent/10 text-accent text-[11px] font-medium truncate shrink-0 max-w-[110px]">
                {providerLabel}
              </span>
              <select
                value={lastModel ?? providerConfig.model}
                onChange={(e) => switchModel(e.target.value)}
                disabled={busy || switchingModel}
                title="Switch model — takes effect on the next message"
                className="max-w-[150px] bg-panel2 border border-border rounded-md px-1.5 py-0.5 text-[11px] font-mono text-ink/80 hover:border-border-strong outline-none focus:border-accent-dim disabled:opacity-50 transition shrink-0"
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
              : ""}
          </span>
        </div>
        <div ref={historyRef} className="relative flex items-center gap-1 shrink-0">
          <button
            onClick={toggleHistory}
            className="px-2 h-6 rounded-md border border-border text-[11px] text-muted hover:text-ink hover:border-border-strong transition"
          >
            History
          </button>
          <button
            onClick={startNew}
            title="New conversation"
            className="w-6 h-6 rounded-md border border-border text-muted hover:text-ink hover:border-border-strong transition flex items-center justify-center"
          >
            <PlusIcon size={13} />
          </button>

          {showHistory && (
            <div className="absolute right-0 top-9 z-20 w-64 max-h-72 overflow-y-auto bg-panel border border-border rounded-lg elev-2 fade-in">
              {conversations.length === 0 ? (
                <div className="px-3 py-2 text-xs text-muted">No past conversations yet.</div>
              ) : (
                conversations.map((c) => (
                  <div
                    key={c.id}
                    onClick={() => openConversation(c.id)}
                    className={`px-3 py-2 text-xs cursor-pointer border-b border-border/60 last:border-b-0 hover:bg-panel2 flex items-center justify-between gap-2 ${
                      activeConversationId === c.id ? "bg-panel2" : ""
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="truncate text-ink/90">{c.title}</div>
                      <div className="text-muted/70 text-[10px]">{c.updated_at}</div>
                    </div>
                    <button
                      onClick={(e) => removeConversation(c.id, e)}
                      className="text-muted hover:text-bad shrink-0 transition"
                      title="Delete"
                    >
                      <CloseIcon size={12} />
                    </button>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto min-h-0 px-3 py-3 space-y-3 chat-scroll">
        {entries.length === 0 && (
          <div className="text-sm text-muted text-center mt-10 px-6 leading-relaxed">
            {hasWorkspace
              ? "Ask the agent to explain, find, or change something in this workspace."
              : "Select a workspace first."}
          </div>
        )}

        {entries.map((entry, i) => (
          <div key={i} className="msg-in" style={{ animationDelay: `${Math.min(i, 5) * 25}ms` }}>
            <ChatEntry entry={entry} onRespond={(approved) => respond(i, approved)} />
          </div>
        ))}

        {busy && (
          <div className="flex items-center px-1">
            <div className="flex items-center gap-1.5 text-xs text-muted px-2.5 py-1.5 rounded-full bg-panel border border-border elev-1">
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
          placeholder={hasWorkspace ? "Message the agent…" : "Select a workspace to chat"}
          className="flex-1 bg-panel2 border border-border rounded-lg px-3 py-2 text-sm outline-none placeholder:text-muted/60 focus:border-accent-dim disabled:opacity-50 transition"
        />
        {busy ? (
          <button
            onClick={stopAgent}
            disabled={stopping}
            className="h-[34px] px-4 rounded-lg bg-bad/10 text-bad border border-bad/30 text-sm font-medium hover:bg-bad/20 transition shrink-0 flex items-center gap-1.5 disabled:opacity-60"
            title="Stop the agent"
          >
            <StripeIcon size={9} />
            {stopping ? "Stopping…" : "Stop"}
          </button>
        ) : (
          <button
            onClick={send}
            disabled={!hasWorkspace || !input.trim()}
            className="h-[34px] px-4 rounded-lg bg-accent text-white text-sm font-medium disabled:opacity-35 hover:brightness-110 transition shrink-0"
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
    <div className="max-h-56 overflow-y-auto bg-sunken border border-border rounded-md text-[11px] font-mono">
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
        <span className={`inline-block transition-transform ${open ? "rotate-90" : ""}`}>›</span>
        thinking
      </button>
      {open && (
        <div className="mt-1 border-l-2 border-border pl-2.5 text-[11px] text-muted italic whitespace-pre-wrap">
          {text}
        </div>
      )}
    </div>
  );
}

function ToolChips({ logs }: { logs: ToolLogEntry[] }) {
  if (logs.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {logs.map((t, i) => (
        <span
          key={i}
          title={t.result_preview}
          className="chip-in text-[10px] px-1.5 py-0.5 rounded-md bg-panel2 border border-border text-muted font-mono inline-flex items-center gap-1"
          style={{ animationDelay: `${i * 40}ms` }}
        >
          <ArrowRightIcon size={9} className="text-accent/70" />
          {t.tool_name}
        </span>
      ))}
    </div>
  );
}

function AgentMark() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="1" y="1" width="22" height="22" rx="7" fill="rgb(var(--c-accent) / 0.12)" />
      <path d="M12 6.5 16.8 9.4v5.2L12 17.5 7.2 14.6V9.4z" fill="rgb(var(--c-accent) / 0.9)" />
    </svg>
  );
}

function ChatEntry({ entry, onRespond }: { entry: AgentChatEntry; onRespond: (approved: boolean) => void }) {
  if (entry.kind === "user") {
    return (
      <div className="flex justify-end gap-2">
        <div className="max-w-[85%] bg-accent/10 border border-accent/20 text-ink rounded-2xl rounded-br-md px-3.5 py-2 text-sm whitespace-pre-wrap leading-relaxed">
          {entry.text}
        </div>
      </div>
    );
  }

  if (entry.kind === "assistant") {
    return (
      <div className="flex gap-2">
        <div className="shrink-0 mt-0.5">
          <AgentMark />
        </div>
        <div className="space-y-1.5 min-w-0 flex-1">
          <ToolChips logs={entry.toolLog} />
          {entry.thinking && <ThinkingBlock text={entry.thinking} />}
          {entry.text && (
            <div className="bg-panel border border-border rounded-2xl rounded-tl-md px-3.5 py-2.5 text-sm elev-1 overflow-x-auto">
              <Markdown text={entry.text} />
            </div>
          )}
        </div>
      </div>
    );
  }

  if (entry.kind === "notice") {
    return (
      <div className="flex gap-2">
        <div className="w-6 h-6 mt-0.5 rounded-md bg-warn/10 border border-warn/20 flex items-center justify-center shrink-0 text-warn">
          <WarningIcon size={13} />
        </div>
        <div className="space-y-1.5 min-w-0 flex-1">
          <ToolChips logs={entry.toolLog} />
          <div className="text-xs text-warn bg-warn/10 border border-warn/20 rounded-lg px-3 py-2">
            {entry.text}
          </div>
        </div>
      </div>
    );
  }

  if (entry.kind === "error") {
    return (
      <div className="flex gap-2">
        <div className="w-6 h-6 mt-0.5 rounded-md bg-bad/10 border border-bad/20 flex items-center justify-center shrink-0 text-bad">
          <WarningIcon size={13} />
        </div>
        <div className="text-xs text-bad bg-bad/10 border border-bad/15 rounded-lg px-3 py-2 flex-1">
          {entry.text}
        </div>
      </div>
    );
  }

  // approval card
  return (
    <div className="ml-8 border border-accent/30 bg-accent/[0.04] rounded-xl px-3.5 py-3 space-y-2.5">
      <div className="flex items-center gap-1.5 text-xs text-accent font-medium">
        <span className="w-1.5 h-1.5 rounded-full bg-accent" />
        Approval needed
      </div>
      <div className="text-[13px] font-mono text-ink/90 bg-sunken border border-border rounded-md px-2.5 py-1.5">
        {entry.description}
      </div>
      {entry.diff && <DiffView diff={entry.diff} />}
      {entry.resolved === null ? (
        <div className="flex gap-2">
          <button
            onClick={() => onRespond(true)}
            className="px-3 h-7 rounded-md bg-accent text-white text-xs font-medium hover:brightness-110 transition"
          >
            Approve
          </button>
          <button
            onClick={() => onRespond(false)}
            className="px-3 h-7 rounded-md border border-border text-xs text-muted hover:text-ink hover:border-border-strong transition"
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
              <CheckIcon size={12} /> Approved — running in the terminal / applied
            </>
          ) : (
            <>
              <CloseIcon size={12} /> Denied
            </>
          )}
        </div>
      )}
    </div>
  );
}
