import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { FileNode, ScanSummary, IndexStats } from "../types";
import { FolderIcon } from "./icons";

interface Props {
  onWorkspaceLoaded: (root: string, tree: FileNode, summary: ScanSummary, stats: IndexStats) => void;
  onStart: () => void;
  /** Returns false to abort the switch — e.g. the user declined to discard
   *  unsaved editor changes after picking a folder. */
  onConfirmSwitch?: () => boolean;
  onError: (message: string) => void;
  busy: boolean;
}

export default function WorkspacePicker({
  onWorkspaceLoaded,
  onStart,
  onConfirmSwitch,
  onError,
  busy,
}: Props) {
  async function pickWorkspace() {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Select a workspace folder",
    });

    if (!selected || Array.isArray(selected)) return;

    // Confirm *before* doing any work, so a declined switch is a clean no-op.
    if (onConfirmSwitch && !onConfirmSwitch()) return;

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
      className="h-8 px-3.5 rounded-md bg-accent text-white font-medium text-xs disabled:opacity-50 disabled:cursor-not-allowed hover:brightness-110 transition flex items-center gap-1.5"
    >
      <FolderIcon size={13} />
      {busy ? "Indexing…" : "Select Workspace"}
    </button>
  );
}
