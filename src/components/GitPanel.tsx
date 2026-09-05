import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export default function GitPanel({ hasWorkspace }: { hasWorkspace: boolean }) {
  const [status, setStatus] = useState<string | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [view, setView] = useState<"status" | "diff">("status");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const [s, d] = await Promise.all([
        invoke<string>("git_status"),
        invoke<string>("git_diff", { path: null }),
      ]);
      setStatus(s);
      setDiff(d);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex items-center justify-between px-3 h-9 border-b border-border shrink-0">
        <div className="flex gap-3 text-xs">
          <button
            onClick={() => setView("status")}
            className={view === "status" ? "text-ink" : "text-muted hover:text-ink"}
          >
            Status
          </button>
          <button
            onClick={() => setView("diff")}
            className={view === "diff" ? "text-ink" : "text-muted hover:text-ink"}
          >
            Diff
          </button>
        </div>
        <button
          onClick={refresh}
          disabled={!hasWorkspace || loading}
          className="text-xs text-muted hover:text-ink disabled:opacity-40"
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0 p-3">
        {!hasWorkspace && <div className="text-sm text-muted">Select a workspace first.</div>}
        {error && <div className="text-xs text-bad mb-2">{error}</div>}
        {hasWorkspace && status === null && !error && (
          <div className="text-sm text-muted">Click Refresh to check the working tree.</div>
        )}
        {view === "status" && status && (
          <pre className="text-xs font-mono whitespace-pre-wrap text-ink/85">{status}</pre>
        )}
        {view === "diff" && diff && (
          <pre className="text-xs font-mono whitespace-pre-wrap text-ink/85">
            {diff.split("\n").map((line, i) => (
              <div
                key={i}
                className={
                  line.startsWith("+") && !line.startsWith("+++")
                    ? "text-good"
                    : line.startsWith("-") && !line.startsWith("---")
                    ? "text-bad"
                    : "text-muted"
                }
              >
                {line || " "}
              </div>
            ))}
          </pre>
        )}
      </div>
    </div>
  );
}
