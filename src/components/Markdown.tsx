import { useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { invoke } from "@tauri-apps/api/core";

// Renders the agent's reply as real markdown — bold, headings, code
// blocks, lists, tables — instead of raw `**asterisks**` text. Styling
// lives under `.markdown` in styles.css so it follows the theme.
//
// Links go through `open_external_url`: a Tauri webview won't follow an
// external link on its own, so a plain click would otherwise do nothing.
export default function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a
              href={href}
              onClick={(e) => {
                if (!href) return;
                e.preventDefault();
                invoke("open_external_url", { url: href }).catch(() => {});
              }}
            >
              {children}
            </a>
          ),
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

// A fenced code block with a copy button in the corner. The text is read
// straight off the rendered <pre> via a ref rather than re-derived from the
// markdown AST — simpler, and always exactly what's on screen.
function CodeBlock({ children }: { children?: React.ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);

  async function copy() {
    const text = ref.current?.innerText ?? "";
    if (!text) return;
    if (await copyText(text)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    }
  }

  return (
    <div className="code-block">
      <button type="button" className="code-copy" onClick={copy}>
        {copied ? "Copied" : "Copy"}
      </button>
      <pre ref={ref}>{children}</pre>
    </div>
  );
}

// `navigator.clipboard` isn't guaranteed inside a Tauri webview, so fall
// back to the classic hidden-textarea trick when it's missing or throws.
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the execCommand path below
  }
  try {
    const el = document.createElement("textarea");
    el.value = text;
    el.style.position = "fixed";
    el.style.top = "-1000px";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}
