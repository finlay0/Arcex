import { memo, useState, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { Icon } from "./shared.tsx";

/** Text inside a React subtree, for copying a code block. */
function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object" && "props" in node) return textOf((node.props as { children?: ReactNode }).children);
  return "";
}

function CodeBlock({ language, children }: { language: string | null; children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(textOf(children).replace(/\n$/, "")).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="codeblock">
      <div className="codehead">
        <span>{language ?? "code"}</span>
        <button type="button" onClick={copy} aria-label="Copy code">
          <Icon name={copied ? "check" : "copy"} /> {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}

/** Web links open in the user's browser. Anything else (a file path, a relative link) shows as its text for now. */
function openLink(href: string) {
  if (window.arcex?.openExternal) window.arcex.openExternal(href);
  else window.open(href, "_blank", "noopener,noreferrer");
}

const components: Components = {
  pre: ({ children }) => {
    const code = Array.isArray(children) ? children[0] : children;
    const className = code && typeof code === "object" && "props" in code ? String((code.props as { className?: string }).className ?? "") : "";
    return <CodeBlock language={/language-([\w+#.-]+)/.exec(className)?.[1] ?? null}>{children}</CodeBlock>;
  },
  a: ({ href, children }) =>
    href && /^https?:\/\//i.test(href) ? (
      <a href={href} title={href} onClick={(event) => { event.preventDefault(); openLink(href); }}>{children}</a>
    ) : (
      <code title={href}>{children}</code>
    ),
  // Remote images are not fetched: a reply should not make the app load things from the web on its own.
  img: ({ alt, src }) => <span className="mdimg" title={typeof src === "string" ? src : undefined}>{alt || "image"}</span>,
  table: ({ children }) => <div className="mdtable"><table>{children}</table></div>,
  h1: ({ children }) => <p className="h h1">{children}</p>,
  h2: ({ children }) => <p className="h h2">{children}</p>,
  h3: ({ children }) => <p className="h h3">{children}</p>,
  h4: ({ children }) => <p className="h">{children}</p>,
  h5: ({ children }) => <p className="h">{children}</p>,
  h6: ({ children }) => <p className="h">{children}</p>,
  input: ({ checked }) => <input type="checkbox" checked={!!checked} readOnly disabled />,
};

const plugins = [remarkGfm, remarkBreaks];

/** Agent replies and user messages as GitHub-flavoured Markdown. Raw HTML in the text is shown as text, never run. */
export const Md = memo(function Md({ text }: { text: string }) {
  return (
    <div className="md">
      <Markdown remarkPlugins={plugins} components={components}>{text}</Markdown>
    </div>
  );
});
