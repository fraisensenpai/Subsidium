import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { staticFallbackFor } from "../modelCatalog";
import { PRESETS, PRESET_GROUPS, getPreset, presetForConfig, type ProviderPreset } from "../providerPresets";
import { AiResponse, ModelSummary, ProviderConfig } from "../types";
import { CheckIcon, ChevronRight } from "./icons";

export default function ProviderConfigForm({
  initial,
  onSaved,
  onCancel,
}: {
  initial?: ProviderConfig;
  onSaved: (config: ProviderConfig) => void;
  onCancel?: () => void;
}) {
  const initialPreset = initial ? presetForConfig(initial) : null;

  const [presetId, setPresetId] = useState<string>(initialPreset?.id ?? "");
  const [showPicker, setShowPicker] = useState(!initial);
  const [label, setLabel] = useState(initial?.label ?? "");
  const [baseUrl, setBaseUrl] = useState(initial?.base_url ?? "");
  const [model, setModel] = useState(initial?.model ?? "");
  const [apiKey, setApiKey] = useState("");
  const [hasStoredKey, setHasStoredKey] = useState(false);
  const [labelTouched, setLabelTouched] = useState(!!initial);

  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<AiResponse | null>(null);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [models, setModels] = useState<ModelSummary[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);

  const preset = getPreset(presetId);

  useEffect(() => {
    if (initial?.id) {
      invoke<boolean>("has_provider_key", { id: initial.id }).then(setHasStoredKey);
    }
  }, [initial?.id]);

  function choosePreset(p: ProviderPreset) {
    setPresetId(p.id);
    setModels([]);
    setModelsError(null);
    setBaseUrl(p.base_url ?? "");
    if (!labelTouched) setLabel(p.label);
    // Keep the existing model only if the user re-picked the *same* preset;
    // switching brands/reset to a new endpoint means the old id is wrong.
    setModel((m) => (initialPreset?.id === p.id && m ? m : p.default_model));
    setShowPicker(false);
  }

  const needsBaseUrl = preset ? preset.provider === "openai_compatible" || preset.provider === "ollama" : false;
  // The key field shows for every non-Ollama transport — a custom or
  // self-hosted endpoint may still want a bearer token — but it's only
  // *required* when the preset says so.
  const showApiKey = !!preset && preset.provider !== "ollama";
  const apiKeyRequired = preset ? preset.needs_key : true;
  const canFetchModels = preset
    ? (!apiKeyRequired || !!apiKey || hasStoredKey) && (!needsBaseUrl || !!baseUrl)
    : false;

  async function fetchModels() {
    if (!preset) return;
    setFetchingModels(true);
    setModelsError(null);
    // When editing a saved account and the user hasn't typed a new key, ask
    // the backend to reuse the keychain key for that account (`..._for_config`)
    // rather than connecting keyless. Only do that while the endpoint still
    // matches what's saved — otherwise the edits in the form take precedence.
    const reuseStoredKey =
      !apiKey &&
      hasStoredKey &&
      !!initial?.id &&
      preset.provider === initial.provider &&
      (baseUrl || "") === (initial.base_url ?? "");
    try {
      const result = reuseStoredKey
        ? await invoke<ModelSummary[]>("list_models_for_config", { id: initial!.id })
        : await invoke<ModelSummary[]>("list_provider_models", {
            provider: preset.provider,
            baseUrl: baseUrl || null,
            apiKey: apiKey || null,
          });
      if (result.length > 0) {
        setModels(result);
      } else {
        const fallback = staticFallbackFor({ preset: preset.id, provider: preset.provider, base_url: baseUrl });
        if (fallback.length > 0) {
          setModels(fallback);
          setModelsError("Provider returned no models — showing common ones instead.");
        } else {
          setModels([]);
          setModelsError("No models returned — type an id below.");
        }
      }
    } catch (err) {
      const fallback = staticFallbackFor({ preset: preset.id, provider: preset.provider, base_url: baseUrl });
      if (fallback.length > 0) {
        setModels(fallback);
        setModelsError(`${String(err)} — showing common models instead.`);
      } else {
        setModels([]);
        setModelsError(String(err));
      }
    } finally {
      setFetchingModels(false);
    }
  }

  // Auto-fetch the model list once the key is present, debounced so typing a
  // key doesn't fire a request per keystroke.
  useEffect(() => {
    if (!canFetchModels || fetchingModels) return;
    const timer = setTimeout(() => {
      fetchModels();
    }, 600);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, hasStoredKey, presetId, baseUrl]);

  function currentDraft(): ProviderConfig {
    return {
      id: initial?.id ?? "",
      label: label || preset?.label || "Provider",
      provider: preset?.provider ?? "openai_compatible",
      base_url: baseUrl || null,
      model,
      preset: preset?.id ?? null,
    };
  }

  async function save(): Promise<ProviderConfig | null> {
    setSaving(true);
    setError(null);
    try {
      const saved = await invoke<ProviderConfig>("save_provider_config", {
        config: currentDraft(),
        apiKey: apiKey || null,
      });
      if (apiKey) {
        setHasStoredKey(true);
        setApiKey("");
      }
      onSaved(saved);
      return saved;
    } catch (err) {
      setError(String(err));
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function testConnection() {
    setTesting(true);
    setTestResult(null);
    setError(null);
    try {
      const reply = await invoke<AiResponse>("test_provider_connection", {
        config: currentDraft(),
        apiKey: apiKey || null,
      });
      setTestResult(reply);
    } catch (err) {
      setError(String(err));
    } finally {
      setTesting(false);
    }
  }

  // ── Preset picker ─────────────────────────────────────────────────
  if (showPicker) {
    const grouped = PRESET_GROUPS.map((g) => ({
      ...g,
      items: PRESETS.filter((p) => p.group === g.key),
    })).filter((g) => g.items.length > 0);

    return (
      <div className="space-y-4">
        <p className="text-xs text-muted leading-relaxed">
          Pick a provider. Any OpenAI-compatible endpoint works — Subsidium ships presets for the
          popular cloud brands plus local servers.
        </p>
        {grouped.map((g) => (
          <div key={g.key}>
            <div className="micro-label mb-1.5">{g.label}</div>
            <div className="grid grid-cols-2 gap-1.5">
              {g.items.map((p) => (
                <button
                  key={p.id}
                  onClick={() => choosePreset(p)}
                  className="text-left px-2.5 py-2 rounded-lg border border-border bg-panel hover:border-accent-dim hover:bg-panel2/70 transition"
                >
                  <div className="text-[13px] text-ink/90 font-medium truncate">{p.label}</div>
                  <div className="text-[10.5px] text-muted truncate">{p.hint}</div>
                </button>
              ))}
            </div>
          </div>
        ))}
        {onCancel && (
          <button
            onClick={onCancel}
            className="w-full px-3 py-1.5 rounded-md border border-border text-sm text-muted hover:text-ink transition"
          >
            Cancel
          </button>
        )}
      </div>
    );
  }

  // ── Config form ───────────────────────────────────────────────────
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[13px] font-medium text-ink truncate">{preset?.label ?? "Provider"}</span>
          <span className="text-[10.5px] text-muted truncate">{preset?.hint}</span>
        </div>
        <button
          onClick={() => setShowPicker(true)}
          className="text-[11px] text-muted hover:text-accent shrink-0 flex items-center gap-0.5"
        >
          Change
        </button>
      </div>

      <div>
        <label className="micro-label block mb-1">Name</label>
        <input
          value={label}
          onChange={(e) => {
            setLabel(e.target.value);
            setLabelTouched(true);
          }}
          placeholder={preset?.label ?? "e.g. Work OpenRouter"}
          className="w-full bg-panel2 border border-border rounded-md px-2 py-1.5 text-sm outline-none focus:border-accent-dim transition"
        />
      </div>

      {needsBaseUrl && (
        <div>
          <label className="micro-label block mb-1">Base URL</label>
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={preset?.provider === "ollama" ? "http://localhost:11434" : "https://…/v1"}
            className="w-full bg-panel2 border border-border rounded-md px-2 py-1.5 text-sm font-mono outline-none focus:border-accent-dim transition"
          />
        </div>
      )}

      {showApiKey && (
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="micro-label">
              API key{!apiKeyRequired && <span className="normal-case font-normal"> (optional)</span>}
            </label>
            {preset?.key_url && (
              <a
                href={preset.key_url}
                onClick={(e) => {
                  // A Tauri webview won't follow external links itself, so
                  // hand the URL to the OS browser. The href stays so
                  // right-click → "Copy link" still works.
                  e.preventDefault();
                  invoke("open_external_url", { url: preset.key_url }).catch(() => {});
                }}
                className="text-[10.5px] text-accent hover:underline flex items-center gap-0.5 cursor-pointer"
              >
                Get a key <ChevronRight size={10} />
              </a>
            )}
          </div>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={hasStoredKey ? "••••••••  (saved)" : "sk-…"}
            className="w-full bg-panel2 border border-border rounded-md px-2 py-1.5 text-sm outline-none focus:border-accent-dim transition"
          />
          <p className="text-[10px] text-muted mt-1">
            {hasStoredKey
              ? "A key is already saved — leave blank to keep it."
              : "Stored in your OS keychain, never written to disk in plain text."}
          </p>
        </div>
      )}

      <div>
        <button
          onClick={fetchModels}
          disabled={!canFetchModels || fetchingModels}
          className="w-full px-2 py-1.5 rounded-md border border-border bg-panel hover:bg-panel2 text-xs text-muted hover:text-ink hover:border-accent-dim disabled:opacity-40 disabled:cursor-not-allowed transition"
        >
          {fetchingModels ? "Fetching models…" : "Fetch available models"}
        </button>
        {modelsError && <p className="text-[10px] text-warn mt-1">{modelsError}</p>}
      </div>

      {models.length > 0 && (
        <div className="max-h-40 overflow-y-auto border border-border rounded-md divide-y divide-border bg-panel2">
          {models.map((m) => (
            <button
              key={m.id}
              onClick={() => setModel(m.id)}
              className={`w-full text-left px-2.5 py-1.5 text-xs hover:bg-panel transition flex items-center gap-2 ${
                model === m.id ? "bg-accent/10 text-ink" : "text-muted"
              }`}
            >
              {model === m.id && <CheckIcon size={12} className="text-accent shrink-0" />}
              <span className="min-w-0">
                <span className="font-mono block truncate">{m.id}</span>
                {m.display_name && m.display_name !== m.id && (
                  <span className="text-[10px] text-muted/70 block truncate">{m.display_name}</span>
                )}
              </span>
            </button>
          ))}
        </div>
      )}

      <div>
        <label className="micro-label block mb-1">Model</label>
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="Fetch models above, or type an id manually"
          className="w-full bg-panel2 border border-border rounded-md px-2 py-1.5 text-sm font-mono outline-none focus:border-accent-dim transition"
        />
      </div>

      {error && (
        <div className="text-xs text-bad bg-bad/10 border border-bad/20 rounded-md px-2.5 py-1.5">
          {error}
        </div>
      )}
      {testResult && (
        <div className="text-xs text-good bg-good/10 border border-good/20 rounded-md px-2.5 py-1.5 space-y-0.5">
          <div>Connected — model replied: “{testResult.text.trim()}”</div>
          <div className="text-muted">
            Model: <span className="text-ink/80">{testResult.model}</span>
            {(testResult.input_tokens !== null || testResult.output_tokens !== null) && (
              <>
                {" "}
                · Tokens{" "}
                <span className="text-ink/80">
                  {testResult.input_tokens ?? "?"} in / {testResult.output_tokens ?? "?"} out
                </span>
              </>
            )}
          </div>
        </div>
      )}

      <div className="flex items-center gap-2 pt-1">
        {onCancel && (
          <button
            onClick={onCancel}
            className="px-3 py-1.5 rounded-md border border-border text-sm text-muted hover:text-ink transition"
          >
            Cancel
          </button>
        )}
        <div className="flex-1" />
        <button
          onClick={testConnection}
          disabled={testing || !model || (apiKeyRequired && !apiKey && !hasStoredKey)}
          className="px-3 py-1.5 rounded-md border border-border bg-panel text-sm text-ink/90 disabled:opacity-40 hover:border-accent-dim transition"
        >
          {testing ? "Testing…" : "Test"}
        </button>
        <button
          onClick={save}
          disabled={saving || !model}
          className="px-3.5 py-1.5 rounded-md bg-accent text-white text-sm font-medium disabled:opacity-40 hover:brightness-110 transition"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}
