import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Renders the agent's reply as real markdown — bold, headings, code
// blocks, lists, tables — instead of raw `**asterisks**` text. Styling
// lives under `.markdown` in styles.css so it follows the theme.
export default function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}