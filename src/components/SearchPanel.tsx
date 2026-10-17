import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { SearchHit } from "../types";
import { SearchIcon } from "./icons";

const SOURCE_LABEL: Record<SearchHit["source"], string> = {
  symbol: "Symbol",
  file: "File",
  text: "Text",
};

const SOURCE_STYLE: Record<SearchHit["source"], string> = {
  symbol: "text-accent bg-accent/10 border-accent/20",
  file: "text-good bg-good/10 border-good/20",
  text: "text-muted bg-panel2 border-border",
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

  async function runQuery(raw: string) {
    const q = raw.trim();
    if (!q || !hasWorkspace) return;

    setSearching(true);
    setError(null);
    try {
      const result = await invoke<SearchHit[]>("search_workspace", { query: q });
      setHits(result);
      setRanAt(q);
    } catch (err) {
      setError(String(err));
    } finally {
      setSearching(false);
    }
  }

  async function runSearch(e: React.FormEvent) {
    e.preventDefault();
    await runQuery(query);
  }

  // Search as the user types (debounced), so they don't have to press Enter
  // for every attempt. Very short queries are skipped — they'd match almost
  // everything and just add noise.
  useEffect(() => {
    if (!hasWorkspace) return;
    const q = query.trim();
    if (q.length < 2) {
      setHits([]);
      setRanAt(null);
      return;
    }
    const timer = window.setTimeout(() => {
      runQuery(q);
    }, 300);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, hasWorkspace]);

  return (
    <div className="h-full flex flex-col min-h-0">
      <form onSubmit={runSearch} className="p-3 border-b border-border shrink-0">
        <div className="relative">
          <SearchIcon
            size={14}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            disabled={!hasWorkspace}
            placeholder={hasWorkspace ? "Search symbols, files, or code…" : "Select a workspace to search"}
            className="w-full bg-panel2 border border-border rounded-lg pl-8 pr-3 py-2 text-sm outline-none placeholder:text-muted/60 focus:border-accent-dim disabled:opacity-50 transition"
          />
        </div>
      </form>

      <div className="flex-1 overflow-y-auto min-h-0">
        {error && <div className="p-3 text-sm text-bad">{error}</div>}

        {!error && searching && <div className="p-3 text-sm text-muted">Searching…</div>}

        {!error && !searching && ranAt && hits.length === 0 && (
          <div className="p-3 text-sm text-muted">No results for “{ranAt}”.</div>
        )}

        {!error && !searching && !ranAt && (
          <div className="p-6 text-sm text-muted text-center max-w-sm mx-auto leading-relaxed">
            Combines symbol name, file name, and full-text search over the indexed workspace. Try a
            function name, a file fragment, or a plain-language phrase.
          </div>
        )}

        {!searching &&
          hits.map((hit, i) => (
            <div
              key={i}
              onClick={() => onSelectFile(hit.file)}
              className="px-3 py-2 border-b border-border/60 hover:bg-panel2/60 cursor-pointer transition"
            >
              <div className="flex items-center gap-2 text-xs mb-1">
                <span className={`px-1.5 py-0.5 rounded border text-[10px] font-medium ${SOURCE_STYLE[hit.source]}`}>
                  {SOURCE_LABEL[hit.source]}
                </span>
                <span className="text-muted truncate">{hit.file}</span>
                {hit.line !== null && <span className="text-muted/60 font-mono">:{hit.line}</span>}
              </div>
              <div className="text-[12.5px] text-ink/85 font-mono truncate">{hit.snippet}</div>
            </div>
          ))}
      </div>
    </div>
  );
}
