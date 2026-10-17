import { useState } from "react";
import { FileNode } from "../types";
import { ChevronRight, FileIcon, FolderIcon } from "./icons";

// A muted, distinct hue per language so files are scannable at a glance
// without turning the tree into a rainbow.
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

function Node({
  node,
  depth,
  onSelect,
  selectedPath,
}: {
  node: FileNode;
  depth: number;
  onSelect: (path: string) => void;
  selectedPath: string | null;
}) {
  const [open, setOpen] = useState(depth < 1);

  if (!node.is_dir) {
    const isSelected = node.path === selectedPath;
    const dot = node.language ? LANG_COLOR[node.language] : undefined;
    return (
      <div
        onClick={() => onSelect(node.path)}
        title={node.path}
        className={`relative flex items-center gap-1.5 py-[3px] pr-2 text-[13px] cursor-pointer group ${
          isSelected ? "bg-accent/10 text-ink" : "text-ink/75 hover:text-ink hover:bg-panel2/70"
        }`}
        style={{ paddingLeft: depth * 13 + 8 }}
      >
        {isSelected && <span className="absolute left-0 top-0 bottom-0 w-[2px] bg-accent" />}
        <FileIcon
          size={14}
          className="shrink-0"
          style={{ color: dot ?? "rgb(var(--c-muted))" }}
        />
        <span className="truncate">{node.name}</span>
      </div>
    );
  }

  return (
    <div>
      <div
        className="flex items-center gap-0.5 py-[3px] pr-2 text-[13px] text-ink/85 cursor-pointer select-none hover:bg-panel2/70 rounded-sm"
        style={{ paddingLeft: depth * 13 + 4 }}
        onClick={() => setOpen((o) => !o)}
      >
        <ChevronRight
          size={13}
          className={`shrink-0 text-muted transition-transform ${open ? "rotate-90" : ""}`}
        />
        <FolderIcon size={14} className="shrink-0 text-muted/90" />
        <span className="font-medium truncate ml-0.5">{node.name}</span>
      </div>
      {open && node.children && (
        <div>
          {node.children.map((child) => (
            <Node
              key={child.path}
              node={child}
              depth={depth + 1}
              onSelect={onSelect}
              selectedPath={selectedPath}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function FileExplorer({
  tree,
  onSelect,
  selectedPath,
}: {
  tree: FileNode | null;
  onSelect: (path: string) => void;
  selectedPath: string | null;
}) {
  if (!tree) {
    return (
      <div className="p-4 text-sm text-muted leading-relaxed">
        No workspace open. Use <span className="text-ink/80 font-medium">Select Workspace</span> to
        open a folder.
      </div>
    );
  }

  return (
    <div className="overflow-y-auto h-full py-1.5">
      <Node node={tree} depth={0} onSelect={onSelect} selectedPath={selectedPath} />
    </div>
  );
}
