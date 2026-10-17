import { IndexStats, ScanSummary } from "../types";

const LANG_COLOR: Record<string, string> = {
  typescript: "#3b82f6",
  tsx: "#3b82f6",
  javascript: "#eab308",
  jsx: "#eab308",
  python: "#3572a5",
  rust: "#d08770",
  css: "#8b5cf6",
  html: "#e34c26",
  json: "#a3a3a3",
  markdown: "#6b7280",
};

export default function ProjectSummary({
  summary,
  stats,
}: {
  summary: ScanSummary | null;
  stats: IndexStats | null;
}) {
  if (!summary) {
    return (
      <div className="p-4 text-sm text-muted leading-relaxed">
        Project intelligence will appear here after indexing.
      </div>
    );
  }

  const languages = Object.entries(summary.by_language).sort((a, b) => b[1] - a[1]);
  const totalLang = languages.reduce((acc, [, n]) => acc + n, 0) || 1;

  return (
    <div className="p-4 text-sm space-y-5">
      <div>
        <div className="micro-label mb-1">Workspace</div>
        <div className="text-ink/90 break-all font-mono text-xs">{summary.workspace_root}</div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Stat label="Files" value={summary.total_files} />
        <Stat label="Folders" value={summary.total_dirs} />
        <Stat label="Ignored" value={summary.ignored_count} />
        <Stat label="Scan time" value={`${summary.duration_ms} ms`} />
      </div>

      {stats && (
        <div className="grid grid-cols-2 gap-2">
          <Stat label="Symbols" value={stats.symbol_count} />
          <Stat label="Relations" value={stats.edge_count} />
        </div>
      )}

      {languages.length > 0 && (
        <div>
          <div className="micro-label mb-2">Languages</div>
          <div className="space-y-2">
            {languages.map(([lang, count]) => (
              <div key={lang} className="space-y-1">
                <div className="flex justify-between text-ink/80 text-xs">
                  <span className="flex items-center gap-1.5">
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ background: LANG_COLOR[lang] ?? "rgb(var(--c-muted))" }}
                    />
                    {lang}
                  </span>
                  <span className="text-muted tabular-nums">{count}</span>
                </div>
                <div className="h-1 rounded-full bg-sunken overflow-hidden">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${Math.max(3, (count / totalLang) * 100)}%`,
                      background: LANG_COLOR[lang] ?? "rgb(var(--c-muted))",
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="bg-panel border border-border rounded-lg px-3 py-2">
      <div className="micro-label">{label}</div>
      <div className="text-ink text-base font-semibold tabular-nums mt-0.5">{value}</div>
    </div>
  );
}
