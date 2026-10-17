// Catalog of AI providers Subsidium can talk to.
//
// Every cloud brand below except Anthropic and Google speaks the same
// OpenAI-compatible wire format, so they all reuse the `openai_compatible`
// transport and only differ by base URL + default model. Anthropic, Gemini
// and local Ollama have their own transports. A preset is therefore mostly
// presentation data: a name, an endpoint, and a curated model list to show
// before (or instead of) a live `/models` response.
//
// Adding a new brand is a one-line addition to PRESETS — no backend change.

import type { ProviderConfig } from "./types";

export type ProviderKind = ProviderConfig["provider"];

export interface ProviderPreset {
  /** Stable id persisted on the saved config as `preset`. */
  id: string;
  /** Brand shown in the UI, e.g. "Groq". */
  label: string;
  /** Which transport the backend uses for this brand. */
  provider: ProviderKind;
  /** Endpoint prefilled into the form. `null` = fixed endpoint (no field). */
  base_url: string | null;
  /** Whether an API key is required. Local servers and custom endpoints
   *  are keyless (the field still shows, but is optional). */
  needs_key: boolean;
  /** Grouping in the picker. */
  group: "popular" | "cloud" | "local" | "custom";
  /** One-line description shown under the name in the picker. */
  hint: string;
  /** Where to get an API key, if applicable. */
  key_url?: string;
  /** Placeholder model id used when the user hasn't picked one yet. */
  default_model: string;
  /** Curated fallback models (shown when the live list can't be fetched). */
  models: string[];
}

export const PRESETS: ProviderPreset[] = [
  // ── Popular ─────────────────────────────────────────────────────────
  {
    id: "anthropic",
    label: "Anthropic",
    provider: "anthropic",
    base_url: null,
    needs_key: true,
    group: "popular",
    hint: "Claude models",
    key_url: "https://console.anthropic.com/settings/keys",
    default_model: "claude-sonnet-4-5",
    models: [
      "claude-sonnet-4-5",
      "claude-opus-4-1",
      "claude-haiku-4-5",
      "claude-3-7-sonnet-20250219",
      "claude-3-5-sonnet-20241022",
      "claude-3-5-haiku-20241022",
    ],
  },
  {
    id: "openai",
    label: "OpenAI",
    provider: "openai_compatible",
    base_url: "https://api.openai.com/v1",
    needs_key: true,
    group: "popular",
    hint: "GPT & o-series",
    key_url: "https://platform.openai.com/api-keys",
    default_model: "gpt-4o-mini",
    models: [
      "gpt-4o-mini",
      "gpt-4o",
      "gpt-4.1",
      "gpt-4.1-mini",
      "gpt-4.1-nano",
      "o3",
      "o4-mini",
      "o3-mini",
    ],
  },
  {
    id: "gemini",
    label: "Google Gemini",
    provider: "gemini",
    base_url: null,
    needs_key: true,
    group: "popular",
    hint: "Gemini models",
    key_url: "https://aistudio.google.com/app/apikey",
    default_model: "gemini-2.5-flash",
    models: [
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
      "gemini-2.5-pro",
      "gemini-2.0-flash",
      "gemini-2.0-flash-lite",
    ],
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    provider: "openai_compatible",
    base_url: "https://openrouter.ai/api/v1",
    needs_key: true,
    group: "popular",
    hint: "One key, hundreds of models",
    key_url: "https://openrouter.ai/keys",
    default_model: "openai/gpt-4o-mini",
    models: [
      "openai/gpt-4o-mini",
      "anthropic/claude-sonnet-4",
      "google/gemini-2.5-flash",
      "deepseek/deepseek-chat",
      "meta-llama/llama-3.3-70b-instruct",
      "qwen/qwen-2.5-72b-instruct",
    ],
  },
  {
    id: "groq",
    label: "Groq",
    provider: "openai_compatible",
    base_url: "https://api.groq.com/openai/v1",
    needs_key: true,
    group: "popular",
    hint: "Very fast open models",
    key_url: "https://console.groq.com/keys",
    default_model: "llama-3.3-70b-versatile",
    models: [
      "llama-3.3-70b-versatile",
      "llama-3.1-8b-instant",
      "deepseek-r1-distill-llama-70b",
      "qwen-2.5-32b",
      "gemma2-9b-it",
      "mixtral-8x7b-32768",
    ],
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    provider: "openai_compatible",
    base_url: "https://api.deepseek.com/v1",
    needs_key: true,
    group: "popular",
    hint: "Cheap coding models",
    key_url: "https://platform.deepseek.com/api_keys",
    default_model: "deepseek-chat",
    models: ["deepseek-chat", "deepseek-reasoner"],
  },
  {
    id: "xai",
    label: "xAI Grok",
    provider: "openai_compatible",
    base_url: "https://api.x.ai/v1",
    needs_key: true,
    group: "popular",
    hint: "Grok models",
    key_url: "https://console.x.ai",
    default_model: "grok-3",
    models: ["grok-4", "grok-3", "grok-3-mini", "grok-2-1212"],
  },

  // ── More cloud brands ───────────────────────────────────────────────
  {
    id: "mistral",
    label: "Mistral AI",
    provider: "openai_compatible",
    base_url: "https://api.mistral.ai/v1",
    needs_key: true,
    group: "cloud",
    hint: "Mistral & Codestral",
    key_url: "https://console.mistral.ai/api-keys",
    default_model: "mistral-large-latest",
    models: [
      "mistral-large-latest",
      "mistral-medium-latest",
      "mistral-small-latest",
      "codestral-latest",
      "open-mistral-nemo",
    ],
  },
  {
    id: "together",
    label: "Together AI",
    provider: "openai_compatible",
    base_url: "https://api.together.xyz/v1",
    needs_key: true,
    group: "cloud",
    hint: "Open-weight models",
    key_url: "https://api.together.ai/settings/api-keys",
    default_model: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    models: [
      "meta-llama/Llama-3.3-70B-Instruct-Turbo",
      "Qwen/Qwen2.5-72B-Instruct-Turbo",
      "deepseek-ai/DeepSeek-V3",
      "mistralai/Mixtral-8x7B-Instruct-v0.1",
    ],
  },
  {
    id: "perplexity",
    label: "Perplexity",
    provider: "openai_compatible",
    base_url: "https://api.perplexity.ai",
    needs_key: true,
    group: "cloud",
    hint: "Search-augmented Sonar",
    key_url: "https://www.perplexity.ai/settings/api",
    default_model: "sonar",
    models: ["sonar", "sonar-pro", "sonar-reasoning", "sonar-reasoning-pro"],
  },
  {
    id: "fireworks",
    label: "Fireworks AI",
    provider: "openai_compatible",
    base_url: "https://api.fireworks.ai/inference/v1",
    needs_key: true,
    group: "cloud",
    hint: "Fast model serving",
    key_url: "https://fireworks.ai/account/api-keys",
    default_model: "accounts/fireworks/models/llama-v3p3-70b-instruct",
    models: [
      "accounts/fireworks/models/llama-v3p3-70b-instruct",
      "accounts/fireworks/models/deepseek-v3",
      "accounts/fireworks/models/qwen2p5-72b-instruct",
    ],
  },
  {
    id: "cerebras",
    label: "Cerebras",
    provider: "openai_compatible",
    base_url: "https://api.cerebras.ai/v1",
    needs_key: true,
    group: "cloud",
    hint: "Ultra-low latency inference",
    key_url: "https://cloud.cerebras.ai",
    default_model: "llama3.3-70b",
    models: ["llama3.3-70b", "llama3.1-8b", "qwen-2.5-72b"],
  },
  {
    id: "sambanova",
    label: "SambaNova",
    provider: "openai_compatible",
    base_url: "https://api.sambanova.ai/v1",
    needs_key: true,
    group: "cloud",
    hint: "Fast open models",
    key_url: "https://cloud.sambanova.ai/apis",
    default_model: "Meta-Llama-3.3-70B-Instruct",
    models: ["Meta-Llama-3.3-70B-Instruct", "Meta-Llama-3.1-8B-Instruct"],
  },
  {
    id: "nebius",
    label: "Nebius AI Studio",
    provider: "openai_compatible",
    base_url: "https://api.studio.nebius.ai/v1",
    needs_key: true,
    group: "cloud",
    hint: "Open-weight inference",
    key_url: "https://studio.nebius.ai",
    default_model: "meta-llama/Llama-3.3-70B-Instruct",
    models: [
      "meta-llama/Llama-3.3-70B-Instruct",
      "Qwen/Qwen2.5-Coder-32B-Instruct",
      "deepseek-ai/DeepSeek-V3",
    ],
  },
  {
    id: "hyperbolic",
    label: "Hyperbolic",
    provider: "openai_compatible",
    base_url: "https://api.hyperbolic.xyz/v1",
    needs_key: true,
    group: "cloud",
    hint: "Open-weight models",
    key_url: "https://app.hyperbolic.xyz/settings",
    default_model: "meta-llama/Llama-3.3-70B-Instruct",
    models: [
      "meta-llama/Llama-3.3-70B-Instruct",
      "Qwen/Qwen2.5-72B-Instruct",
      "deepseek-ai/DeepSeek-V3",
    ],
  },
  {
    id: "github_models",
    label: "GitHub Models",
    provider: "openai_compatible",
    base_url: "https://models.inference.ai.azure.com",
    needs_key: true,
    group: "cloud",
    hint: "Models via a GitHub PAT",
    key_url: "https://github.com/settings/tokens",
    default_model: "gpt-4o-mini",
    models: [
      "gpt-4o-mini",
      "gpt-4o",
      "meta/Llama-3.3-70B-Instruct",
      "Mistral-large",
    ],
  },

  // ── Local ───────────────────────────────────────────────────────────
  {
    id: "ollama",
    label: "Ollama",
    provider: "ollama",
    base_url: "http://localhost:11434",
    needs_key: false,
    group: "local",
    hint: "Local models via ollama serve",
    default_model: "llama3.2",
    models: ["llama3.2", "qwen2.5-coder", "deepseek-r1", "mistral", "phi4"],
  },
  {
    id: "lmstudio",
    label: "LM Studio",
    provider: "openai_compatible",
    base_url: "http://localhost:1234/v1",
    needs_key: false,
    group: "local",
    hint: "Local server on :1234",
    default_model: "",
    models: [],
  },
  {
    id: "vllm",
    label: "vLLM",
    provider: "openai_compatible",
    base_url: "http://localhost:8000/v1",
    needs_key: false,
    group: "local",
    hint: "Self-hosted on :8000",
    default_model: "",
    models: [],
  },
  {
    id: "localai",
    label: "LocalAI",
    provider: "openai_compatible",
    base_url: "http://localhost:8080/v1",
    needs_key: false,
    group: "local",
    hint: "Local server on :8080",
    default_model: "",
    models: [],
  },

  // ── Custom ──────────────────────────────────────────────────────────
  {
    id: "custom_openai",
    label: "Custom (OpenAI-compatible)",
    provider: "openai_compatible",
    base_url: "",
    needs_key: false,
    group: "custom",
    hint: "Any /v1 chat-completions endpoint",
    default_model: "",
    models: [],
  },
];

export function getPreset(id: string | null | undefined): ProviderPreset | null {
  if (!id) return null;
  return PRESETS.find((p) => p.id === id) ?? null;
}

/// Best-effort preset match for a saved config that predates presets (or has
/// none) — matches on provider kind + base URL so an old "OpenAI-compatible,
/// api.groq.com" account still shows as Groq.
export function presetForConfig(config: {
  preset?: string | null;
  provider: ProviderKind;
  base_url?: string | null;
}): ProviderPreset | null {
  const byId = getPreset(config.preset);
  if (byId) return byId;
  const norm = (u: string | null | undefined) => (u ?? "").replace(/\/+$/, "").toLowerCase();
  const base = norm(config.base_url);
  if (base) {
    const match = PRESETS.find((p) => norm(p.base_url) === base);
    if (match) return match;
  }
  // An OpenAI-compatible account whose endpoint matches no known brand
  // (or that predates presets): treat it as a custom endpoint rather than
  // mislabelling it as OpenAI, which happens to be the first such preset.
  if (config.provider === "openai_compatible") return getPreset("custom_openai");
  return PRESETS.find((p) => p.provider === config.provider) ?? null;
}

export const PRESET_GROUPS: { key: ProviderPreset["group"]; label: string }[] = [
  { key: "popular", label: "Popular" },
  { key: "cloud", label: "More providers" },
  { key: "local", label: "Local & self-hosted" },
  { key: "custom", label: "Custom" },
];
