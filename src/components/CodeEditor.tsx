import { useEffect, useRef, useState, useCallback } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { vscodeDark, vscodeLight } from "@uiw/codemirror-theme-vscode";
import { EditorView } from "@codemirror/view";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { json } from "@codemirror/lang-json";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { markdown } from "@codemirror/lang-markdown";
import { invoke } from "@tauri-apps/api/core";
import { FileIcon } from "./icons";

// Above this size the editor gets sluggish — CodeMirror tokenizes the whole
// buffer — so we stop short of mounting it and say so instead of freezing.
const MAX_EDITABLE_CHARS = 1_500_000;

function languageExtensionFor(path: string) {
  const ext = path.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "ts":
    case "tsx":
      return javascript({ jsx: true, typescript: true });
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return javascript({ jsx: true });
    case "py":
      return python();
    case "rs":
      return rust();
    case "json":
      return json();
    case "html":
      return html();
    case "css":
      return css();
    case "md":
    case "mdx":
      return markdown();
    default:
      return [];
  }
}

export default function CodeEditor({
  path,
  theme,
  externalVersion = 0,
  onDirtyChange,
}: {
  path: string | null;
  theme: "light" | "dark";
  /** Bumped by the app when the file may have changed on disk (the agent
   *  wrote it) — triggers a reload, or a conflict prompt if the buffer is
   *  dirty. */
  externalVersion?: number;
  /** Reports whether the buffer has unsaved changes, so the app can warn
   *  before switching files. */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [content, setContent] = useState("");
  const [original, setOriginal] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when the file changed on disk while we hold unsaved edits. We never
  // silently overwrite the buffer in that case — the user chooses.
  const [conflict, setConflict] = useState(false);

  const dirty = content !== original;
  // Read inside the external-change effect without making it a dependency
  // (which would reload on every keystroke).
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const load = useCallback(() => {
    if (!path) return;
    setLoading(true);
    setError(null);
    setConflict(false);
    invoke<string>("read_file", { relativePath: path })
      .then((text) => {
        setContent(text);
        setOriginal(text);
      })
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }, [path]);

  useEffect(() => {
    load();
  }, [load]);

  // React to an external change (the agent rewrote the file). Skip the very
  // first run — that's just the initial mount, not a change.
  const seenExternal = useRef(externalVersion);
  useEffect(() => {
    if (externalVersion === seenExternal.current) return;
    seenExternal.current = externalVersion;
    if (!path) return;
    if (dirtyRef.current) setConflict(true);
    else load();
  }, [externalVersion, path, load]);

  // Surface the dirty flag to the app (used to confirm before file switches).
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const save = useCallback(async () => {
    if (!path || !dirty || saving) return;
    setSaving(true);
    setError(null);
    try {
      await invoke("write_file", { relativePath: path, content });
      setOriginal(content);
      setConflict(false);
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }, [path, content, dirty, saving]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        save();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [save]);

  if (!path) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-2 text-sm text-muted">
        <FileIcon size={22} className="text-border-strong" />
        Select a file in the Explorer to start editing.
      </div>
    );
  }

  const tooLarge = content.length > MAX_EDITABLE_CHARS;

  return (
    <div className="h-full flex flex-col min-h-0 min-w-0">
      <div className="h-9 flex items-center justify-between px-3 bg-panel border-b border-border shrink-0 text-xs">
        <div className="flex items-center gap-1.5 text-muted min-w-0">
          <FileIcon size={13} className="shrink-0 text-muted" />
          <span className="text-ink/85 truncate font-mono text-[11.5px]">{path}</span>
          {dirty && (
            <span className="text-warn shrink-0 flex items-center gap-1" title="Unsaved changes">
              <span className="w-1.5 h-1.5 rounded-full bg-warn" /> unsaved
            </span>
          )}
        </div>
        <button
          onClick={save}
          disabled={!dirty || saving}
          className="px-2.5 py-1 rounded-md bg-accent text-white text-[11px] font-medium disabled:opacity-35 disabled:cursor-not-allowed hover:brightness-110 shrink-0 transition"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>

      {error && <div className="px-3 py-1.5 text-xs bg-bad/10 text-bad">{error}</div>}

      {conflict && (
        <div className="px-3 py-1.5 text-xs bg-warn/10 text-warn border-b border-warn/20 flex items-center justify-between gap-3">
          <span className="min-w-0">This file changed on disk (the agent wrote it) and you have unsaved edits.</span>
          <div className="flex gap-2 shrink-0">
            <button
              onClick={load}
              className="px-2 py-0.5 rounded border border-warn/40 hover:bg-warn/15 transition"
            >
              Reload from disk
            </button>
            <button
              onClick={() => setConflict(false)}
              className="px-2 py-0.5 rounded border border-border text-muted hover:text-ink hover:border-border-strong transition"
            >
              Keep mine
            </button>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-auto min-h-0 min-w-0">
        {loading ? (
          <div className="p-4 text-sm text-muted">Loading…</div>
        ) : tooLarge ? (
          <div className="p-4 text-sm text-muted leading-relaxed">
            This file is too large to open in the built-in editor (
            {Math.round(content.length / 1024).toLocaleString("en-US")} KB). Open it in your own editor
            instead.
          </div>
        ) : (
          <CodeMirror
            value={content}
            height="100%"
            theme={theme === "light" ? vscodeLight : vscodeDark}
            // Long lines wrap instead of forcing the editor (and the
            // panel around it) wider than the viewport — without this a
            // single long line could push sibling panels out of view.
            extensions={[EditorView.lineWrapping, languageExtensionFor(path)].flat()}
            onChange={(value) => setContent(value)}
          />
        )}
      </div>
    </div>
  );
}
