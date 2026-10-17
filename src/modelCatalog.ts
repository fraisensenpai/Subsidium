// Curated model fallbacks shown when a provider's live `/models` list can't
// be reached (offline, key without list permission, a local server with no
// catalog, …) so the picker still has sensible options. The user can always
// type an exact model id by hand, and a successful live fetch replaces
// these entirely.
//
// Fallbacks are keyed by preset (brand) first — that's the precise match —
// and by transport kind second, for configs that predate presets.

import type { ProviderConfig } from "./types";
import { PRESETS, presetForConfig, type ProviderKind } from "./providerPresets";

export const STATIC_MODELS: Partial<Record<ProviderKind, string[]>> = {
  anthropic: PRESETS.find((p) => p.id === "anthropic")?.models ?? [],
  gemini: PRESETS.find((p) => p.id === "gemini")?.models ?? [],
  openai_compatible: PRESETS.find((p) => p.id === "openai")?.models ?? [],
};

export function staticFallback(provider: ProviderKind): { id: string; display_name: string | null }[] {
  return (STATIC_MODELS[provider] ?? []).map((id) => ({ id, display_name: null }));
}

/// Preset-aware fallback: prefers the brand's curated list, then the
/// transport's generic list.
export function staticFallbackFor(config: {
  preset?: string | null;
  provider: ProviderKind;
  base_url?: string | null;
}): { id: string; display_name: string | null }[] {
  const preset = presetForConfig(config);
  const models = preset?.models?.length ? preset.models : STATIC_MODELS[config.provider] ?? [];
  return models.map((id) => ({ id, display_name: null }));
}

export function presetModels(config: ProviderConfig): { id: string; display_name: string | null }[] {
  return staticFallbackFor(config);
}
