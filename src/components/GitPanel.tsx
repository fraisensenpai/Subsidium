import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { RefreshIcon } from "./icons";

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
      <div className="flex items-center justify-between px-3 h-10 border-b border-border shrink-0">
        <div className="flex gap-0.5 bg-panel2 border border-border rounded-lg p-0.5">
          {(["status", "diff"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`px-2.5 py-1 rounded-md text-xs capitalize transition ${
                view === v ? "bg-panel text-ink elev-1" : "text-muted hover:text-ink"
              }`}
            >
              {v}
            </button>
          ))}
        </div>
        <button
          onClick={refresh}
          disabled={!hasWorkspace || loading}
          title="Refresh"
          className="w-7 h-7 rounded-md border border-border text-muted hover:text-ink hover:border-border-strong disabled:opacity-40 transition flex items-center justify-center"
        >
          <RefreshIcon size={13} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0 p-3">
        {!hasWorkspace && <div className="text-sm text-muted">Select a workspace first.</div>}
        {error && <div className="text-xs text-bad mb-2">{error}</div>}
        {hasWorkspace && status === null && !error && (
          <div className="text-sm text-muted">Click refresh to check the working tree.</div>
        )}
        {view === "status" && status && (
          <pre className="text-xs font-mono whitespace-pre-wrap text-ink/85 leading-relaxed">{status}</pre>
        )}
        {view === "diff" && diff && (
          <pre className="text-xs font-mono whitespace-pre-wrap leading-relaxed">
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
