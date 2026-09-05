// Curated fallbacks shown when a provider's models API can't be reached
// (offline, key without list permission, …) so the model picker still has
// sensible options — the user can always type an exact id manually too.
// The live API list (when fetch succeeds) replaces these entirely.
import type { ProviderConfig } from "./types";

export const STATIC_MODELS: Partial<Record<ProviderConfig["provider"], string[]>> = {
  gemini: [
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.5-pro",
    "gemini-2.0-flash",
    "gemini-2.0-flash-lite",
    "gemini-1.5-flash",
    "gemini-1.5-flash-8b",
    "gemini-1.5-pro",
  ],
  anthropic: [
    "claude-sonnet-4-20250514",
    "claude-opus-4-20250514",
    "claude-3-7-sonnet-20250219",
    "claude-3-5-sonnet-20241022",
    "claude-3-5-haiku-20241022",
    "claude-3-opus-20240229",
  ],
};

export function staticFallback(provider: ProviderConfig["provider"]): { id: string; display_name: string | null }[] {
  return (STATIC_MODELS[provider] ?? []).map((id) => ({ id, display_name: null }));
}