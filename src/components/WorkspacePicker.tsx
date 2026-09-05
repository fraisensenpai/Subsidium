import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { FileNode, ScanSummary, IndexStats } from "../types";

interface Props {
  onWorkspaceLoaded: (root: string, tree: FileNode, summary: ScanSummary, stats: IndexStats) => void;
  onStart: () => void;
  onError: (message: string) => void;
  busy: boolean;
}

export default function WorkspacePicker({ onWorkspaceLoaded, onStart, onError, busy }: Props) {
  async function pickWorkspace() {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Select a workspace folder",
    });

    if (!selected || Array.isArray(selected)) return;

    onStart();
    try {
      // Phase 1 pipeline, run server-side (Rust) in one command:
      // discover files -> apply ignore rules -> parse -> build/update index.
      const [tree, summary, stats] = await invoke<[FileNode, ScanSummary, IndexStats]>(
        "open_workspace",
        { root: selected }
      );
      onWorkspaceLoaded(selected, tree, summary, stats);
    } catch (err) {
      onError(String(err));
    }
  }

  return (
    <button
      onClick={pickWorkspace}
      disabled={busy}
      className="px-4 py-2 rounded-md bg-accent text-base font-medium text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed hover:brightness-110 transition"
    >
      {busy ? "Indexing…" : "Select Workspace"}
    </button>
  );
}
