import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import ProviderConfigForm from "./ProviderConfigForm";
import { ProviderConfig } from "../types";

const PROVIDER_LABELS: Record<ProviderConfig["provider"], string> = {
  anthropic: "Anthropic",
  gemini: "Google Gemini",
  openai_compatible: "OpenAI-compatible",
  ollama: "Ollama (local)",
};

export default function OnboardingScreen({ onDone }: { onDone: () => void }) {
  const [configs, setConfigs] = useState<ProviderConfig[]>([]);
  const [showForm, setShowForm] = useState(true);

  useEffect(() => {
    invoke<ProviderConfig[]>("list_provider_configs").then(setConfigs);
  }, []);

  function handleSaved(config: ProviderConfig) {
    setConfigs((prev) => {
      const rest = prev.filter((c) => c.id !== config.id);
      return [...rest, config];
    });
    setShowForm(false);
  }

  return (
    <div className="h-screen w-screen flex items-center justify-center bg-base text-ink px-4">
      <div className="w-full max-w-lg">
        <div className="text-center mb-6">
          <div className="text-xl font-semibold text-brand mb-1">Subsidium</div>
          <p className="text-sm text-muted">
            Add at least one AI provider to get started. You can add as many as you like — Anthropic,
            Gemini, an OpenAI-compatible API, or a local Ollama server — and switch between them later.
          </p>
        </div>

        {configs.length > 0 && (
          <div className="mb-4 border border-border rounded-lg divide-y divide-border overflow-hidden">
            {configs.map((c) => (
              <div key={c.id} className="px-3 py-2 flex items-center justify-between text-sm">
                <div>
                  <div className="text-ink/90">{c.label}</div>
                  <div className="text-[11px] text-muted">
                    {PROVIDER_LABELS[c.provider]} · {c.model || "no model set"}
                  </div>
                </div>
                <span className="text-good text-xs">Added</span>
              </div>
            ))}
          </div>
        )}

        {showForm ? (
          <div className="border border-border rounded-lg p-4 bg-panel">
            <ProviderConfigForm onSaved={handleSaved} onCancel={configs.length > 0 ? () => setShowForm(false) : undefined} />
          </div>
        ) : (
          <button
            onClick={() => setShowForm(true)}
            className="w-full px-3 py-2 rounded-md border border-border text-sm text-muted hover:text-ink hover:border-accent-dim transition mb-2"
          >
            + Add another provider
          </button>
        )}

        <button
          onClick={onDone}
          disabled={configs.length === 0}
          className="w-full mt-4 px-3 py-2.5 rounded-md bg-accent text-base font-medium text-sm disabled:opacity-30 disabled:cursor-not-allowed hover:brightness-110 transition"
        >
          Continue to Subsidium
        </button>
      </div>
    </div>
  );
}
