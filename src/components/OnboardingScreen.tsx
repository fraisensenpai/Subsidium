import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import ProviderConfigForm from "./ProviderConfigForm";
import { ProviderConfig } from "../types";
import { presetForConfig } from "../providerPresets";
import { ArrowRightIcon, CheckIcon } from "./icons";
import crescendoLogo from "../../assets/crescendo.png";

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
    <div className="h-screen w-screen bg-base text-ink flex">
      {/* Left: brand / value panel */}
      <div className="hidden lg:flex w-[42%] min-w-[360px] flex-col justify-between p-10 bg-panel border-r border-border">
        <div className="flex items-center gap-2.5">
          <Logo size={26} />
          <span className="font-semibold tracking-tight text-base text-ink">Subsidium</span>
        </div>

        <div className="space-y-5">
          <h1 className="text-2xl font-semibold leading-snug tracking-tight text-ink">
            A workspace-first
            <br />
            coding environment.
          </h1>
          <p className="text-sm text-muted leading-relaxed max-w-sm">
            Explorer, editor, terminal, search and Git in one place — with an agent that reads your
            project and asks before it changes anything.
          </p>
          <ul className="space-y-2 pt-1">
            {[
              "Ask before it writes or runs things",
              "Local index, local history, local terminal",
              "Bring your own model provider",
            ].map((line) => (
              <li key={line} className="flex items-center gap-2 text-[13px] text-ink/80">
                <CheckIcon size={14} className="text-accent shrink-0" />
                {line}
              </li>
            ))}
          </ul>
        </div>

        <div className="space-y-2">
          <div className="flex items-center gap-1.5 text-[11px] text-muted/70">
            <img src={crescendoLogo} alt="" className="w-3.5 h-3.5 rounded-[3px]" />
            <span>Made by Crescendo Technologies</span>
          </div>
          <p className="text-[11px] text-muted/70">
            Your API keys are stored in the operating system keychain.
          </p>
        </div>
      </div>

      {/* Right: setup */}
      <div className="flex-1 flex items-center justify-center p-6 overflow-y-auto">
        <div className="w-full max-w-lg">
          <div className="lg:hidden text-center mb-6">
            <div className="text-lg font-semibold text-ink mb-1">Subsidium</div>
          </div>

          <h2 className="text-lg font-semibold text-ink mb-1">Connect a model provider</h2>
          <p className="text-sm text-muted mb-5 leading-relaxed">
            Add at least one provider to get started. You can add as many as you like — Anthropic,
            Google, OpenAI, OpenRouter, Groq, DeepSeek, a local server — and switch between them
            later.
          </p>

          {configs.length > 0 && (
            <div className="mb-4 border border-border rounded-xl divide-y divide-border overflow-hidden bg-panel2/40">
              {configs.map((c) => (
                <div key={c.id} className="px-3 py-2.5 flex items-center justify-between text-sm">
                  <div className="min-w-0">
                    <div className="text-ink truncate">{c.label}</div>
                    <div className="text-[11px] text-muted truncate">
                      {presetForConfig(c)?.label ?? c.provider} · {c.model || "no model set"}
                    </div>
                  </div>
                  <span className="text-good text-xs flex items-center gap-1 shrink-0">
                    <CheckIcon size={12} /> Added
                  </span>
                </div>
              ))}
            </div>
          )}

          {showForm ? (
            <div className="border border-border rounded-xl p-4 bg-panel elev-1">
              <ProviderConfigForm
                onSaved={handleSaved}
                onCancel={configs.length > 0 ? () => setShowForm(false) : undefined}
              />
            </div>
          ) : (
            <button
              onClick={() => setShowForm(true)}
              className="w-full px-3 py-2.5 rounded-lg border border-dashed border-border-strong text-sm text-muted hover:text-ink hover:border-accent-dim transition mb-2"
            >
              + Add another provider
            </button>
          )}

          <button
            onClick={onDone}
            disabled={configs.length === 0}
            className="w-full mt-4 px-3 py-2.5 rounded-lg bg-accent text-white font-medium text-sm disabled:opacity-30 disabled:cursor-not-allowed hover:brightness-110 transition flex items-center justify-center gap-2"
          >
            Continue to Subsidium
            <ArrowRightIcon size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}

function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="text-brand">
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
