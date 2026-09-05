import { useEffect, useState, useCallback } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { vscodeDark } from "@uiw/codemirror-theme-vscode";
import { EditorView } from "@codemirror/view";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { json } from "@codemirror/lang-json";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { markdown } from "@codemirror/lang-markdown";
import { invoke } from "@tauri-apps/api/core";

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

export default function CodeEditor({ path }: { path: string | null }) {
  const [content, setContent] = useState("");
  const [original, setOriginal] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = content !== original;

  useEffect(() => {
    if (!path) return;
    setLoading(true);
    setError(null);
    invoke<string>("read_file", { relativePath: path })
      .then((text) => {
        setContent(text);
        setOriginal(text);
      })
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }, [path]);

  const save = useCallback(async () => {
    if (!path || !dirty || saving) return;
    setSaving(true);
    setError(null);
    try {
      await invoke("write_file", { relativePath: path, content });
      setOriginal(content);
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
      <div className="h-full flex items-center justify-center text-sm text-muted">
        Select a file in the Explorer to start editing.
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col min-h-0 min-w-0">
      <div className="h-9 flex items-center justify-between px-3 border-b border-border shrink-0 text-xs">
        <div className="flex items-center gap-2 text-muted min-w-0">
          <span className="text-ink/90 truncate">{path}</span>
          {dirty && <span className="text-accent shrink-0">● unsaved</span>}
        </div>
        <button
          onClick={save}
          disabled={!dirty || saving}
          className="px-2 py-1 rounded bg-accent text-base text-xs font-medium disabled:opacity-40 disabled:cursor-not-allowed hover:brightness-110 shrink-0"
        >
          {saving ? "Saving…" : "Save (Ctrl+S)"}
        </button>
      </div>

      {error && <div className="px-3 py-1.5 text-xs bg-bad/10 text-bad">{error}</div>}

      <div className="flex-1 overflow-auto min-h-0 min-w-0">
        {loading ? (
          <div className="p-4 text-sm text-muted">Loading…</div>
        ) : (
          <CodeMirror
            value={content}
            height="100%"
            theme={vscodeDark}
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
