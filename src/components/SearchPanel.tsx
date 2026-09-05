import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { SearchHit } from "../types";

const SOURCE_LABEL: Record<SearchHit["source"], string> = {
  symbol: "Symbol",
  file: "File",
  text: "Text",
};

const SOURCE_COLOR: Record<SearchHit["source"], string> = {
  symbol: "text-accent",
  file: "text-good",
  text: "text-muted",
};

export default function SearchPanel({
  hasWorkspace,
  onSelectFile,
}: {
  hasWorkspace: boolean;
  onSelectFile: (path: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ranAt, setRanAt] = useState<string | null>(null);

  async function runSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim() || !hasWorkspace) return;

    setSearching(true);
    setError(null);
    try {
      const result = await invoke<SearchHit[]>("search_workspace", { query });
      setHits(result);
      setRanAt(query);
    } catch (err) {
      setError(String(err));
    } finally {
      setSearching(false);
    }
  }

  return (
    <div className="h-full flex flex-col min-h-0">
      <form onSubmit={runSearch} className="p-3 border-b border-border shrink-0">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          disabled={!hasWorkspace}
          placeholder={
            hasWorkspace
              ? "Search symbols, files, or code…"
              : "Select a workspace to search"
          }
          className="w-full bg-panel border border-border rounded-md px-3 py-2 text-sm outline-none focus:border-accent disabled:opacity-50"
        />
      </form>

      <div className="flex-1 overflow-y-auto min-h-0">
        {error && (
          <div className="p-3 text-sm text-bad">{error}</div>
        )}

        {!error && searching && (
          <div className="p-3 text-sm text-muted">Searching…</div>
        )}

        {!error && !searching && ranAt && hits.length === 0 && (
          <div className="p-3 text-sm text-muted">No results for “{ranAt}”.</div>
        )}

        {!error && !searching && !ranAt && (
          <div className="p-6 text-sm text-muted text-center max-w-sm mx-auto">
            Combines symbol name, file name, and full-text search over the
            indexed workspace. Try a function name, a file fragment, or a
            plain-language phrase.
          </div>
        )}

        {!searching &&
          hits.map((hit, i) => (
            <div
              key={i}
              onClick={() => onSelectFile(hit.file)}
              className="px-3 py-2 border-b border-border/60 hover:bg-panel/60 cursor-pointer"
            >
              <div className="flex items-center gap-2 text-xs mb-0.5">
                <span className={`font-medium ${SOURCE_COLOR[hit.source]}`}>
                  {SOURCE_LABEL[hit.source]}
                </span>
                <span className="text-muted truncate">{hit.file}</span>
                {hit.line !== null && (
                  <span className="text-muted/70">:{hit.line}</span>
                )}
              </div>
              <div className="text-sm text-ink/90 font-mono truncate">
                {hit.snippet}
              </div>
            </div>
          ))}
      </div>
    </div>
  );
}
