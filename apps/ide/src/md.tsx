import { memo, useMemo, useState, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { Diagram, HtmlPreview } from "./rich.tsx";
import { highlight, languageOf } from "./highlight.ts";
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
  // The same quiet grey tones as the file viewer, for languages the highlighter knows.
  const source = textOf(children).replace(/\n$/, "");
  const family = language ? languageOf(language) : null;
  const lines = useMemo(() => (family ? highlight(source, family) : null), [source, family]);
  const copy = () => {
    void navigator.clipboard.writeText(source).then(() => {
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
      <pre>
        {lines ? (
          <code>
            {lines.map((line, index) => (
              <span key={index}>
                {line.map((token, at) => (token.kind === "plain" ? token.text : <span key={at} className={`tk-${token.kind}`}>{token.text}</span>))}
                {index < lines.length - 1 ? "\n" : ""}
              </span>
            ))}
          </code>
        ) : children}
      </pre>
    </div>
  );
}

/** Asks the app to show a project file in the side panel. `detail` is { path, line }. */
export const OPEN_FILE = "arcex:open-file";

// Words that look like files but are web addresses when there is no folder in front of them.
const DOMAINS = new Set(["com", "org", "net", "io", "dev", "ai", "app", "co", "me", "so", "sh", "xyz"]);

/** A file path the agent mentioned, such as `src/app.ts`, `calc.js:3` or a full path, or null. */
export function fileRef(text: string): { path: string; line: number | null } | null {
  const trimmed = text.trim();
  if (trimmed.length > 300 || /\s/.test(trimmed.replace(/ /g, "")) || trimmed.includes("://")) return null;
  const match = /^((?:[A-Za-z]:[\\/]|\.{0,2}[\\/])?(?:[\w@()[\]+ .-]+[\\/])*[\w@()[\]+.-]+\.([A-Za-z][A-Za-z0-9]{0,9}))(?::(\d+)(?::\d+)?)?$/.exec(trimmed);
  if (!match) return null;
  const [, file, extension, line] = match;
  if (!/[\\/]/.test(file!) && DOMAINS.has(extension!.toLowerCase())) return null;
  if (/ /.test(file!) && !/[\\/]/.test(file!)) return null;
  return { path: file!, line: line ? Number(line) : null };
}

function FileLink({ target, children }: { target: { path: string; line: number | null }; children: ReactNode }) {
  return (
    <button
      type="button"
      className="filelink"
      title={`Open ${target.path}${target.line ? ` at line ${target.line}` : ""}`}
      onClick={() => window.dispatchEvent(new CustomEvent(OPEN_FILE, { detail: target }))}
    >
      <code>{children}</code>
    </button>
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
    const language = /language-([\w+#.-]+)/.exec(className)?.[1] ?? null;
    const block = <CodeBlock language={language}>{children}</CodeBlock>;
    if (language === "mermaid") return <Diagram source={textOf(children).replace(/\n$/, "")} fallback={block} />;
    if (language === "html") return <HtmlPreview source={textOf(children)} code={block} />;
    return block;
  },
  a: ({ href, children }) => {
    if (href && /^https?:\/\//i.test(href)) return <a href={href} title={href} onClick={(event) => { event.preventDefault(); openLink(href); }}>{children}</a>;
    const target = href ? fileRef(decodeURIComponent(href)) : null;
    return target ? <FileLink target={target}>{children}</FileLink> : <code title={href}>{children}</code>;
  },
  // Inline code that names a file opens it. Code inside a block (with a language or several lines) stays as it is.
  code: ({ className, children }) => {
    const text = typeof children === "string" ? children : Array.isArray(children) && children.every((part) => typeof part === "string") ? children.join("") : null;
    const target = !className && text && !text.includes("\n") ? fileRef(text) : null;
    return target ? <FileLink target={target}>{children}</FileLink> : <code className={className}>{children}</code>;
  },
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

// Math only between double dollar signs, so prices such as "$5 or $10" stay plain text.
const plugins = [remarkGfm, remarkBreaks, [remarkMath, { singleDollarTextMath: false }]] as NonNullable<Parameters<typeof Markdown>[0]["remarkPlugins"]>;
const rehype = [[rehypeKatex, { throwOnError: false, strict: "ignore", trust: false, maxSize: 50, maxExpand: 500 }]] as NonNullable<Parameters<typeof Markdown>[0]["rehypePlugins"]>;

/** Agent replies and user messages as GitHub-flavoured Markdown. Raw HTML in the text is shown as text, never run. */
export const Md = memo(function Md({ text }: { text: string }) {
  return (
    <div className="md">
      <Markdown remarkPlugins={plugins} rehypePlugins={rehype} components={components}>{text}</Markdown>
    </div>
  );
});
