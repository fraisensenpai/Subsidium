import { useState } from "react";
import { FileNode } from "../types";

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
    return (
      <div
        onClick={() => onSelect(node.path)}
        title={node.path}
        className={`flex items-center gap-1.5 py-[3px] text-sm cursor-pointer group ${
          isSelected
            ? "bg-accent/12 text-ink shadow-[inset_2px_0_0_0_rgb(var(--c-accent))]"
            : "text-muted hover:text-ink hover:bg-panel2/40"
        }`}
        style={{ paddingLeft: depth * 14 + 8 }}
      >
        <span
          className={`w-3.5 text-center text-xs shrink-0 ${
            isSelected ? "text-accent opacity-100" : "opacity-40 group-hover:opacity-70"
          }`}
        >
          {isSelected ? "●" : "•"}
        </span>
        <span className="truncate">{node.name}</span>
        {node.language && (
          <span className="ml-auto text-[10px] uppercase tracking-wide text-muted/50 pr-2 shrink-0">
            {node.language}
          </span>
        )}
      </div>
    );
  }

  return (
    <div>
      <div
        className="flex items-center gap-1.5 py-0.5 text-sm text-ink/90 cursor-pointer select-none"
        style={{ paddingLeft: depth * 14 + 8 }}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="w-3.5 text-center text-xs">{open ? "▾" : "▸"}</span>
        <span className="font-medium">{node.name}</span>
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
      <div className="text-sm text-muted p-4">
        No workspace loaded yet. Select a folder to begin.
      </div>
    );
  }

  return (
    <div className="overflow-y-auto h-full py-2">
      <Node node={tree} depth={0} onSelect={onSelect} selectedPath={selectedPath} />
    </div>
  );
}

