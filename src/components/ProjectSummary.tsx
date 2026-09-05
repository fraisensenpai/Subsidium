import { IndexStats, ScanSummary } from "../types";

export default function ProjectSummary({
  summary,
  stats,
}: {
  summary: ScanSummary | null;
  stats: IndexStats | null;
}) {
  if (!summary) {
    return (
      <div className="text-sm text-muted p-4">
        Project intelligence will appear here after indexing.
      </div>
    );
  }

  const languages = Object.entries(summary.by_language).sort((a, b) => b[1] - a[1]);

  return (
    <div className="p-4 text-sm space-y-4">
      <div>
        <div className="text-muted text-xs mb-1">Workspace</div>
        <div className="text-ink/90 break-all">{summary.workspace_root}</div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Stat label="Files" value={summary.total_files} />
        <Stat label="Folders" value={summary.total_dirs} />
        <Stat label="Ignored" value={summary.ignored_count} />
        <Stat label="Scan time" value={`${summary.duration_ms} ms`} />
      </div>

      {stats && (
        <div className="grid grid-cols-2 gap-2">
          <Stat label="Symbols indexed" value={stats.symbol_count} />
          <Stat label="Relations" value={stats.edge_count} />
        </div>
      )}

      <div>
        <div className="text-muted text-xs mb-1.5">Languages</div>
        <div className="space-y-1">
          {languages.map(([lang, count]) => (
            <div key={lang} className="flex justify-between text-ink/80">
              <span>{lang}</span>
              <span className="text-muted">{count}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="bg-panel border border-border rounded-md px-3 py-2">
      <div className="text-muted text-[10px]">{label}</div>
      <div className="text-ink text-base font-medium">{value}</div>
    </div>
  );
}
