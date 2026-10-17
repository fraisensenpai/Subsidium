import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import ProviderConfigForm from "./ProviderConfigForm";
import { AppSettings, ProviderConfig } from "../types";
import { presetForConfig } from "../providerPresets";
import { CheckIcon, CloseIcon, PlusIcon, TrashIcon } from "./icons";

function formatTokens(n: number): string {
  return n.toLocaleString("en-US");
}

// Auto-reset periods offered in the settings, in hours. `0` = never.
const RESET_OPTIONS = [
  { value: 0, label: "Never" },
  { value: 1, label: "Every hour" },
  { value: 6, label: "Every 6 hours" },
  { value: 12, label: "Every 12 hours" },
  { value: 24, label: "Daily" },
  { value: 168, label: "Weekly" },
  { value: 720, label: "Every 30 days" },
];

function providerLine(c: ProviderConfig): string {
  const preset = presetForConfig(c);
  return preset?.label ?? c.provider;
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
    <div className="fixed inset-0 bg-black/50 backdrop-blur-[1px] flex items-center justify-center z-50 fade-in" onClick={onClose}>
      <div
        className="bg-panel border border-border rounded-2xl w-full max-w-lg p-5 elev-3 max-h-[86vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <div className="flex gap-5">
            <TabButton label="AI Providers" active={tab === "ai"} onClick={() => setTab("ai")} />
            <TabButton label="App" active={tab === "app"} onClick={() => setTab("app")} />
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-md text-muted hover:text-ink hover:bg-panel2 transition"
            title="Close"
          >
            <CloseIcon size={15} />
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
      className={`text-sm pb-1.5 border-b-2 transition ${
        active ? "text-ink border-accent" : "text-muted border-transparent hover:text-ink"
      }`}
    >
      {label}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────
// AI Providers tab
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
            <div className="text-sm text-muted text-center py-6">
              No providers configured yet.
            </div>
          )}

          {configs.length > 0 && (
            <div className="border border-border rounded-xl divide-y divide-border overflow-hidden bg-panel2/40">
              {configs.map((c) => (
                <div key={c.id} className="px-3 py-2.5 flex items-center gap-3">
                  <button
                    onClick={() => setActive(c.id)}
                    title={activeId === c.id ? "Active" : "Make active"}
                    className={`w-4 h-4 rounded-full border flex items-center justify-center shrink-0 transition ${
                      activeId === c.id ? "bg-accent border-accent text-white" : "border-border-strong hover:border-accent"
                    }`}
                  >
                    {activeId === c.id && <CheckIcon size={10} />}
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-ink truncate">{c.label}</div>
                    <div className="text-[11px] text-muted truncate">
                      {providerLine(c)} · {c.model || "no model set"}
                    </div>
                  </div>
                  <button
                    onClick={() => setView({ kind: "edit", config: c })}
                    className="text-xs text-muted hover:text-ink shrink-0 transition"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => remove(c.id)}
                    className="text-muted hover:text-bad shrink-0 transition"
                    title="Delete"
                  >
                    <TrashIcon size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}

          <button
            onClick={() => setView({ kind: "new" })}
            className="w-full px-3 py-2 rounded-lg border border-dashed border-border-strong text-sm text-muted hover:text-ink hover:border-accent-dim transition flex items-center justify-center gap-1.5"
          >
            <PlusIcon size={14} />
            Add provider
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
// App tab — appearance + token budget
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
  const [interval, setIntervalHours] = useState(24);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<AppSettings>("get_app_settings")
      .then((s) => {
        setSettings(s);
        setLimit(String(s.token_limit));
        setIntervalHours(s.reset_interval_hours);
      })
      .catch((err) => setError(String(err)));
  }, []);

  async function saveBudget() {
    const parsed = Number(limit);
    if (!Number.isInteger(parsed) || parsed < 0) {
      setError("Enter a valid whole number. 0 means unlimited.");
      return;
    }
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const saved = await invoke<AppSettings>("save_app_settings", {
        update: { tokenLimit: parsed, resetIntervalHours: interval, resetUsage: false },
      });
      setSettings(saved);
      setMessage("Budget settings saved.");
      onChanged?.();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  // Persists just the auto-reset interval — it takes effect the moment the
  // user picks a period, instead of waiting for the budget Save button
  // (which only appears next to the token-limit field).
  async function changeInterval(next: number) {
    const prev = interval;
    setIntervalHours(next);
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const saved = await invoke<AppSettings>("save_app_settings", {
        update: { resetIntervalHours: next, resetUsage: false },
      });
      setSettings(saved);
      setIntervalHours(saved.reset_interval_hours);
      setMessage("Auto-reset saved.");
      onChanged?.();
    } catch (err) {
      setIntervalHours(prev);
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
      const saved = await invoke<AppSettings>("save_app_settings", {
        update: { resetUsage: true },
      });
      setSettings(saved);
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
  const intervalLabel =
    RESET_OPTIONS.find((o) => o.value === interval)?.label ?? `Every ${interval} hours`;
  const nextReset =
    settings && settings.reset_interval_hours > 0 && settings.last_reset_at > 0
      ? new Date((settings.last_reset_at + settings.reset_interval_hours * 3600) * 1000)
      : null;

  return (
    <div className="space-y-5">
      <div>
        <h3 className="micro-label mb-2">Appearance</h3>
        <div className="flex gap-2">
          {(
            [
              ["light", "Light"],
              ["dark", "Dark"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              onClick={() => onThemeChange?.(value)}
              className={`flex-1 px-3 py-2 rounded-lg border text-sm transition ${
                theme === value
                  ? "border-accent bg-accent/10 text-ink"
                  : "border-border text-muted hover:text-ink hover:border-border-strong"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="border-t border-border" />

      <div>
        <h3 className="micro-label mb-1.5">Token budget</h3>
        <p className="text-[11px] text-muted leading-relaxed mb-2">
          Cumulative spend on agent conversations across all models, counted in model-weighted
          tokens: each model burns budget according to its price, so an expensive model drains the
          budget faster than a cheap one for the same raw token count. The agent pauses once the
          limit is reached — 0 means unlimited.
        </p>
        <label className="micro-label block mb-1">Token limit</label>
        <div className="flex items-center gap-2 mb-3">
          <input
            type="number"
            min={0}
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
            className="flex-1 bg-panel2 border border-border rounded-md px-2 py-1.5 text-sm outline-none focus:border-accent-dim transition"
          />
          <button
            onClick={saveBudget}
            disabled={saving}
            className="px-3 py-1.5 rounded-md bg-accent text-white text-sm font-medium disabled:opacity-40 hover:brightness-110 transition"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>

        <label className="micro-label block mb-1">Auto-reset</label>
        <select
          value={interval}
          onChange={(e) => changeInterval(Number(e.target.value))}
          disabled={saving}
          className="w-full bg-panel2 border border-border rounded-md px-2 py-1.5 text-sm outline-none focus:border-accent-dim transition disabled:opacity-50"
        >
          {RESET_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
          {!RESET_OPTIONS.some((o) => o.value === interval) && (
            <option value={interval}>Every {interval} hours</option>
          )}
        </select>
        <p className="text-[10px] text-muted mt-1">
          {nextReset
            ? `Usage resets ${intervalLabel.toLowerCase()} — next automatic reset ${nextReset.toLocaleString()}.`
            : "Usage never resets automatically."}
        </p>
      </div>

      <div className="border border-border rounded-xl px-3 py-2.5 bg-panel2/40">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-xs text-muted">Tokens used</span>
          <span className={`text-xs font-mono tabular-nums ${over ? "text-bad" : "text-ink/90"}`}>
            {formatTokens(used)} / {limitValue > 0 ? formatTokens(limitValue) : "∞"}
          </span>
        </div>
        <div className="h-2 rounded-full bg-sunken overflow-hidden">
          <div
            className={`h-full transition-all ${over ? "bg-bad" : "bg-accent"}`}
            style={{ width: `${limitValue > 0 ? Math.min(100, (used / limitValue) * 100) : 0}%` }}
          />
        </div>
        <button
          onClick={resetUsage}
          disabled={saving || used === 0}
          className="mt-2.5 text-[11px] text-muted hover:text-bad disabled:opacity-40 transition"
        >
          Reset usage to 0
        </button>
      </div>

      {(settings?.usage_by_model ?? []).length > 0 && (
        <div>
          <h3 className="micro-label mb-1.5">Usage by model</h3>
          <div className="border border-border rounded-xl divide-y divide-border overflow-hidden">
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
                <span className="font-mono text-muted shrink-0 tabular-nums" title="Model-weighted tokens">
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
