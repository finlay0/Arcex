import type { ReactNode } from "react";

/** The small part of Markdown that agents actually use in replies: paragraphs, lists, headings, bold and code. */
function inline(text: string): ReactNode[] {
  // Links are shown as their text: the app has nowhere to send a click yet.
  const plain = text.replace(/\[([^\]\n]+)\]\([^)\n]+\)/g, "`$1`");
  return plain.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/).map((part, index) =>
    part.startsWith("`") && part.length > 2 ? <code key={index}>{part.slice(1, -1)}</code>
    : part.startsWith("**") && part.length > 4 ? <strong key={index}>{part.slice(2, -2)}</strong>
    : part,
  );
}

export function Md({ text }: { text: string }) {
  const out: ReactNode[] = [];
  text.split(/```[^\n]*\n?/).forEach((chunk, index) => {
    if (index % 2 === 1) {
      out.push(<pre key={index}>{chunk.replace(/\n$/, "")}</pre>);
      return;
    }
    chunk.split(/\n{2,}/).forEach((block, at) => {
      const lines = block.split("\n").filter((line) => line.trim());
      if (lines.length === 0) return;
      const key = `${index}-${at}`;
      const bullets = lines.every((line) => /^\s*[-*] /.test(line));
      const numbers = lines.every((line) => /^\s*\d+[.)] /.test(line));
      if (bullets || numbers) {
        const items = lines.map((line, n) => <li key={n}>{inline(line.replace(/^\s*([-*]|\d+[.)]) /, ""))}</li>);
        out.push(bullets ? <ul key={key}>{items}</ul> : <ol key={key}>{items}</ol>);
      } else if (/^#{1,4} /.test(lines[0]!) && lines.length === 1) {
        out.push(<p key={key}><strong>{inline(lines[0]!.replace(/^#{1,4} /, ""))}</strong></p>);
      } else {
        out.push(<p key={key}>{lines.flatMap((line, n) => (n ? [<br key={`b${n}`} />, ...inline(line)] : inline(line)))}</p>);
      }
    });
  });
  return <div className="md">{out}</div>;
}
