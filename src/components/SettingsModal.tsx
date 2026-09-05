import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import ProviderConfigForm from "./ProviderConfigForm";
import { AppSettings, ProviderConfig } from "../types";

const PROVIDER_LABELS: Record<ProviderConfig["provider"], string> = {
  anthropic: "Anthropic",
  gemini: "Google Gemini",
  openai_compatible: "OpenAI-compatible",
  ollama: "Ollama (local)",
};

function formatTokens(n: number): string {
  return n.toLocaleString("en-US");
}

export default function SettingsModal({
  onClose,
  onChanged,
  theme,
  onThemeChange,
}: {
  onClose: () => void;
  onChanged?: () => void;
  theme?: "light" | "dark";
  onThemeChange?: (theme: "light" | "dark") => void;
}) {
  const [tab, setTab] = useState<"ai" | "app">("ai");

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-panel border border-border rounded-xl w-full max-w-md p-5 shadow-2xl max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-5">
          <div className="flex gap-5">
            <TabButton label="AI Providers" active={tab === "ai"} onClick={() => setTab("ai")} />
            <TabButton label="App" active={tab === "app"} onClick={() => setTab("app")} />
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-md text-muted hover:text-ink hover:bg-panel2 transition text-sm"
            title="Close"
          >
            ✕
          </button>
        </div>

        {tab === "ai" ? (
          <AiProvidersTab onChanged={onChanged} />
        ) : (
          <AppSettingsTab onChanged={onChanged} theme={theme} onThemeChange={onThemeChange} />
        )}
      </div>
    </div>
  );
}

function TabButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`text-sm pb-1 border-b-2 transition ${
        active ? "text-ink border-accent" : "text-muted border-transparent hover:text-ink"
      }`}
    >
      {label}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────
// AI Providers tab (port of the former AiSettingsModal)
// ─────────────────────────────────────────────────────────────────────

type View = { kind: "list" } | { kind: "new" } | { kind: "edit"; config: ProviderConfig };

function AiProvidersTab({ onChanged }: { onChanged?: () => void }) {
  const [configs, setConfigs] = useState<ProviderConfig[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [view, setView] = useState<View>({ kind: "list" });

  async function refresh() {
    const [list, active] = await Promise.all([
      invoke<ProviderConfig[]>("list_provider_configs"),
      invoke<ProviderConfig | null>("get_active_provider_config"),
    ]);
    setConfigs(list);
    setActiveId(active?.id ?? null);
  }

  useEffect(() => {
    refresh();
  }, []);

  async function setActive(id: string) {
    await invoke("set_active_provider", { id });
    setActiveId(id);
    onChanged?.();
  }

  async function remove(id: string) {
    await invoke("delete_provider_config", { id });
    await refresh();
    onChanged?.();
  }

  return (
    <div className="space-y-3">
      {view.kind === "list" && (
        <>
          {configs.length === 0 && (
            <div className="text-sm text-muted text-center py-4">No providers configured yet.</div>
          )}

          {configs.length > 0 && (
            <div className="border border-border rounded-lg divide-y divide-border overflow-hidden">
              {configs.map((c) => (
                <div key={c.id} className="px-3 py-2.5 flex items-center gap-2">
                  <button
                    onClick={() => setActive(c.id)}
                    title={activeId === c.id ? "Active" : "Make active"}
                    className={`w-3.5 h-3.5 rounded-full border shrink-0 ${
                      activeId === c.id ? "bg-accent border-accent" : "border-border"
                    }`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-ink/90 truncate">{c.label}</div>
                    <div className="text-[11px] text-muted truncate">
                      {PROVIDER_LABELS[c.provider]} · {c.model || "no model set"}
                    </div>
                  </div>
                  <button
                    onClick={() => setView({ kind: "edit", config: c })}
                    className="text-xs text-muted hover:text-ink shrink-0"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => remove(c.id)}
                    className="text-xs text-muted hover:text-bad shrink-0"
                  >
                    Delete
                  </button>
                </div>
              ))}
            </div>
          )}

          <button
            onClick={() => setView({ kind: "new" })}
            className="w-full px-3 py-2 rounded-md border border-border text-sm text-muted hover:text-ink hover:border-accent-dim transition"
          >
            + Add provider
          </button>
        </>
      )}

      {view.kind === "new" && (
        <ProviderConfigForm
          onSaved={async () => {
            await refresh();
            setView({ kind: "list" });
            onChanged?.();
          }}
          onCancel={() => setView({ kind: "list" })}
        />
      )}

      {view.kind === "edit" && (
        <ProviderConfigForm
          initial={view.config}
          onSaved={async () => {
            await refresh();
            setView({ kind: "list" });
            onChanged?.();
          }}
          onCancel={() => setView({ kind: "list" })}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// App tab — token budget
// ─────────────────────────────────────────────────────────────────────

function AppSettingsTab({
  onChanged,
  theme,
  onThemeChange,
}: {
  onChanged?: () => void;
  theme?: "light" | "dark";
  onThemeChange?: (theme: "light" | "dark") => void;
}) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [limit, setLimit] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<AppSettings>("get_app_settings")
      .then((s) => {
        setSettings(s);
        setLimit(String(s.token_limit));
      })
      .catch((err) => setError(String(err)));
  }, []);

  async function saveLimit() {
    const parsed = Number(limit);
    if (!Number.isInteger(parsed) || parsed < 0) {
      setError("Enter a valid whole number. 0 means unlimited.");
      return;
    }
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      await invoke("save_app_settings", { update: { tokenLimit: parsed, resetUsage: false } });
      setMessage("Token limit saved.");
      onChanged?.();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  async function resetUsage() {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      await invoke("save_app_settings", { update: { tokenLimit: null, resetUsage: true } });
      setMessage("Token usage reset to 0.");
      onChanged?.();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  const used = settings?.tokens_used ?? 0;
  const limitValue = settings?.token_limit ?? 0;
  const over = limitValue > 0 && used >= limitValue;

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-xs text-muted mb-2">Appearance</h3>
        <div className="flex gap-2">
          {(
            [
              ["light", "☀ Light"],
              ["dark", "☾ Dark"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              onClick={() => onThemeChange?.(value)}
              className={`flex-1 px-3 py-2 rounded-lg border text-sm transition ${
                theme === value
                  ? "border-accent bg-accent/10 text-ink"
                  : "border-border text-muted hover:text-ink hover:border-accent-dim"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="border-t border-border" />

      <div>
        <h3 className="text-xs text-muted mb-1.5">Token budget</h3>
        <p className="text-[11px] text-muted/80 mb-2">
          Cumulative spend on agent conversations across all models, counted in model-weighted tokens:
          each model burns budget according to its price, so an expensive model drains the budget faster
          than a cheap one for the same raw token count. The agent pauses once the limit is reached —
          0 means unlimited.
        </p>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={0}
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
            className="flex-1 bg-base border border-border rounded-md px-2 py-1.5 text-sm outline-none focus:border-accent-dim"
          />
          <button
            onClick={saveLimit}
            disabled={saving}
            className="px-3 py-1.5 rounded-md bg-accent text-base text-sm font-medium disabled:opacity-40 hover:brightness-110"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      <div className="border border-border rounded-lg px-3 py-2.5">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-xs text-muted">Tokens used</span>
          <span className={`text-xs font-mono ${over ? "text-bad" : "text-ink/90"}`}>
            {formatTokens(used)} / {limitValue > 0 ? formatTokens(limitValue) : "∞"}
          </span>
        </div>
        <div className="h-2 rounded-full bg-panel2 overflow-hidden">
          <div
            className={`h-full transition-all ${over ? "bg-bad" : "bg-accent"}`}
            style={{ width: `${limitValue > 0 ? Math.min(100, (used / limitValue) * 100) : 0}%` }}
          />
        </div>
        <button
          onClick={resetUsage}
          disabled={saving || used === 0}
          className="mt-2.5 text-[11px] text-muted hover:text-bad disabled:opacity-40"
        >
          Reset usage to 0
        </button>
      </div>

      {(settings?.usage_by_model ?? []).length > 0 && (
        <div>
          <h3 className="text-xs text-muted mb-1.5">Usage by model</h3>
          <div className="border border-border rounded-lg divide-y divide-border overflow-hidden">
            {settings!.usage_by_model.map((r) => (
              <div
                key={`${r.provider}:${r.model}`}
                className="px-3 py-2 text-xs flex items-center justify-between gap-2"
              >
                <div className="min-w-0">
                  <div className="font-mono text-ink/90 truncate">{r.model}</div>
                  <div className="text-muted/70 text-[10px]">
                    {r.provider} · {formatTokens(r.input_tokens)} in / {formatTokens(r.output_tokens)} out
                  </div>
                </div>
                <span className="font-mono text-muted shrink-0" title="Model-weighted tokens">
                  {formatTokens(r.weighted_tokens)} wt
                </span>
              </div>
            ))}
          </div>
          <p className="text-[10px] text-muted/70 mt-1.5">
            Raw input/output per model; the budget counts weighted tokens (by each model's price).
          </p>
        </div>
      )}

      {error && <div className="text-xs text-bad">{error}</div>}
      {message && <div className="text-xs text-good">{message}</div>}
    </div>
  );
}