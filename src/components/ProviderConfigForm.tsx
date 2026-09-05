import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { staticFallback } from "../modelCatalog";
import { AiResponse, ModelSummary, ProviderConfig } from "../types";

const PROVIDER_LABELS: Record<ProviderConfig["provider"], string> = {
  anthropic: "Anthropic",
  gemini: "Google Gemini",
  openai_compatible: "OpenAI-compatible",
  ollama: "Ollama (local)",
};

const DEFAULT_LABELS: Record<ProviderConfig["provider"], string> = {
  anthropic: "Anthropic",
  gemini: "Google Gemini",
  openai_compatible: "OpenAI-compatible",
  ollama: "Ollama",
};



export default function ProviderConfigForm({
  initial,
  onSaved,
  onCancel,
}: {
  initial?: ProviderConfig;
  onSaved: (config: ProviderConfig) => void;
  onCancel?: () => void;
}) {
  const [provider, setProvider] = useState<ProviderConfig["provider"]>(initial?.provider ?? "anthropic");
  const [label, setLabel] = useState(initial?.label ?? DEFAULT_LABELS["anthropic"]);
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

  useEffect(() => {
    if (initial?.id) {
      invoke<boolean>("has_provider_key", { id: initial.id }).then(setHasStoredKey);
    }
  }, [initial?.id]);

  function changeProvider(next: ProviderConfig["provider"]) {
    setProvider(next);
    setModels([]);
    setModelsError(null);
    if (!labelTouched) setLabel(DEFAULT_LABELS[next]);
  }

  async function fetchModels() {
    setFetchingModels(true);
    setModelsError(null);
    try {
      const result = await invoke<ModelSummary[]>("list_provider_models", {
        provider,
        baseUrl: baseUrl || null,
        apiKey: apiKey || null,
      });
      if (result.length > 0) {
        setModels(result);
      } else {
        const fallback = staticFallback(provider);
        if (fallback.length > 0) {
          setModels(fallback);
          setModelsError("Provider returned no models — showing common ones instead.");
        } else {
          setModels([]);
          setModelsError("No models returned for this account.");
        }
      }
    } catch (err) {
      const fallback = staticFallback(provider);
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

  // Auto-fetch the model list once the key is present (Gemini and
  // Anthropic return everything with just the key), so the picker fills in
  // without a manual click. Debounced so typing a key doesn't fire a
  // request per keystroke.
  useEffect(() => {
    if (!canFetchModels || fetchingModels) return;
    const timer = setTimeout(() => {
      fetchModels();
    }, 600);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, hasStoredKey, provider, baseUrl]);

  function currentDraft(): ProviderConfig {
    return {
      id: initial?.id ?? "",
      label: label || DEFAULT_LABELS[provider],
      provider,
      base_url: baseUrl || null,
      model,
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

  const needsBaseUrl = provider === "openai_compatible" || provider === "ollama";
  const needsApiKey = provider !== "ollama";
  const canFetchModels =
    (provider === "ollama" || apiKey || hasStoredKey) && (provider !== "openai_compatible" || baseUrl);

  return (
    <div className="space-y-3">
      <div>
        <label className="block text-xs text-muted mb-1">Provider</label>
        <select
          value={provider}
          onChange={(e) => changeProvider(e.target.value as ProviderConfig["provider"])}
          className="w-full bg-base border border-border rounded-md px-2 py-1.5 text-sm"
        >
          {Object.entries(PROVIDER_LABELS).map(([value, text]) => (
            <option key={value} value={value}>
              {text}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="block text-xs text-muted mb-1">Name</label>
        <input
          value={label}
          onChange={(e) => {
            setLabel(e.target.value);
            setLabelTouched(true);
          }}
          placeholder="e.g. Work OpenRouter"
          className="w-full bg-base border border-border rounded-md px-2 py-1.5 text-sm"
        />
      </div>

      {needsBaseUrl && (
        <div>
          <label className="block text-xs text-muted mb-1">
            Base URL {provider === "ollama" && "(default: http://localhost:11434)"}
          </label>
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={provider === "ollama" ? "http://localhost:11434" : "https://…/v1"}
            className="w-full bg-base border border-border rounded-md px-2 py-1.5 text-sm"
          />
        </div>
      )}

      {needsApiKey && (
        <div>
          <label className="block text-xs text-muted mb-1">
            API Key {hasStoredKey && "(a key is already saved — leave blank to keep it)"}
          </label>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={hasStoredKey ? "••••••••" : "sk-…"}
            className="w-full bg-base border border-border rounded-md px-2 py-1.5 text-sm"
          />
          <p className="text-[10px] text-muted mt-1">
            Stored in your OS keychain — never written to disk in plain text.
          </p>
        </div>
      )}

      <div>
        <button
          onClick={fetchModels}
          disabled={!canFetchModels || fetchingModels}
          className="w-full px-2 py-1.5 rounded-md border border-border text-xs text-muted hover:text-ink hover:border-accent-dim disabled:opacity-40 disabled:cursor-not-allowed transition"
        >
          {fetchingModels ? "Fetching models…" : "Fetch available models"}
        </button>
        {modelsError && <p className="text-[10px] text-bad mt-1">{modelsError}</p>}
      </div>

      {models.length > 0 && (
        <div className="max-h-40 overflow-y-auto border border-border rounded-md divide-y divide-border">
          {models.map((m) => (
            <button
              key={m.id}
              onClick={() => setModel(m.id)}
              className={`w-full text-left px-2 py-1.5 text-xs hover:bg-base transition ${
                model === m.id ? "bg-accent/15 text-ink" : "text-muted"
              }`}
            >
              <div className="font-mono">{m.id}</div>
              {m.display_name && m.display_name !== m.id && (
                <div className="text-[10px] text-muted/70">{m.display_name}</div>
              )}
            </button>
          ))}
        </div>
      )}

      <div>
        <label className="block text-xs text-muted mb-1">Model</label>
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="Fetch models above, or type an id manually"
          className="w-full bg-base border border-border rounded-md px-2 py-1.5 text-sm font-mono"
        />
      </div>

      {error && <div className="text-xs text-bad">{error}</div>}
      {testResult && (
        <div className="text-xs text-good space-y-0.5">
          <div>Connected — model replied: "{testResult.text.trim()}"</div>
          <div className="text-muted">
            Model: <span className="text-ink/80">{testResult.model}</span>
            {(testResult.input_tokens !== null || testResult.output_tokens !== null) && (
              <>
                {" "}
                · Tokens:{" "}
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
            className="px-3 py-1.5 rounded-md border border-border text-sm text-muted hover:text-ink"
          >
            Cancel
          </button>
        )}
        <button
          onClick={save}
          disabled={saving || !model}
          className="px-3 py-1.5 rounded-md bg-panel2 border border-border text-sm disabled:opacity-40 hover:border-accent-dim"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          onClick={testConnection}
          disabled={testing || !model || (!apiKey && !hasStoredKey && provider !== "ollama")}
          className="px-3 py-1.5 rounded-md bg-accent text-base font-medium text-sm disabled:opacity-40 hover:brightness-110"
        >
          {testing ? "Testing…" : "Test Connection"}
        </button>
      </div>
    </div>
  );
}
