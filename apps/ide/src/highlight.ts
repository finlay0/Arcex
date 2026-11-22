// A small syntax highlighter for reading files: comments, strings, numbers, keywords and tags, shown in shades of grey
// to keep the monochrome look. It reads common languages well enough to scan; it is not a parser.

export type Token = { kind: "comment" | "string" | "number" | "keyword" | "tag" | "plain"; text: string };

type Family = { comments: string[]; keywords: string[]; tags?: boolean; backtick?: boolean; triple?: boolean };

const C_LIKE = ["//", "/\\*[\\s\\S]*?(?:\\*/|$)"];
const HASH = ["#"];

const JS_WORDS = "abstract as async await break case catch class const continue debugger default delete do else enum export extends false finally for from function get if implements import in instanceof interface let new null of private protected public readonly return satisfies set static super switch this throw true try type typeof undefined var void while with yield".split(" ");
const PY_WORDS = "and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return self True try while with yield match case".split(" ");

const FAMILIES: Record<string, Family> = {
  js: { comments: C_LIKE, keywords: JS_WORDS, backtick: true },
  py: { comments: HASH, keywords: PY_WORDS, triple: true },
  css: { comments: ["/\\*[\\s\\S]*?(?:\\*/|$)"], keywords: "important media import from to and not only supports keyframes".split(" ") },
  html: { comments: ["<!--[\\s\\S]*?(?:-->|$)"], keywords: [], tags: true },
  json: { comments: [], keywords: ["true", "false", "null"] },
  shell: { comments: HASH, keywords: "if then else elif fi for while do done case esac function in return export local echo cd set".split(" ") },
  yaml: { comments: HASH, keywords: ["true", "false", "null", "yes", "no"] },
  sql: { comments: ["--", "/\\*[\\s\\S]*?(?:\\*/|$)"], keywords: "select from where insert into values update set delete create table index drop alter add primary key foreign references not null and or join left right inner outer on group by order having limit as distinct count default unique".split(" ") },
  go: { comments: C_LIKE, keywords: "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false".split(" "), backtick: true },
  rust: { comments: C_LIKE, keywords: "as async await break const continue crate else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while".split(" ") },
  c: { comments: C_LIKE, keywords: "auto break case char class const continue default do double else enum extern float for goto if inline int long namespace new private protected public register return short signed sizeof static struct switch template this typedef union unsigned using virtual void volatile while bool true false nullptr public static final package import throws extends implements interface boolean".split(" ") },
};

const BY_EXTENSION: Record<string, string> = {
  js: "js", jsx: "js", mjs: "js", cjs: "js", ts: "js", tsx: "js", mts: "js", cts: "js", vue: "html", svelte: "html",
  py: "py", rb: "py", css: "css", scss: "css", less: "css", html: "html", htm: "html", xml: "html", svg: "html",
  json: "json", jsonc: "js", sh: "shell", bash: "shell", zsh: "shell", ps1: "shell", yml: "yaml", yaml: "yaml", toml: "yaml",
  sql: "sql", go: "go", rs: "rust", c: "c", h: "c", cpp: "c", hpp: "c", cs: "c", java: "c", kt: "c", swift: "c", php: "c",
};

/** The highlighter family for a file name or a code block's language, or null for plain text. */
export function languageOf(name: string): string | null {
  const key = name.toLowerCase().split(/[./]/).pop() ?? "";
  if (FAMILIES[key]) return key;
  if (["dockerfile", "makefile"].includes(name.toLowerCase())) return "shell";
  return BY_EXTENSION[key] ?? ({ javascript: "js", typescript: "js", python: "py", bash: "shell", powershell: "shell" } as Record<string, string>)[key] ?? null;
}

const cache = new Map<string, RegExp>();

function patternFor(family: Family): RegExp {
  const strings = [
    ...(family.triple ? ['"""[\\s\\S]*?(?:"""|$)', "'''[\\s\\S]*?(?:'''|$)"] : []),
    '"(?:[^"\\\\\\n]|\\\\.)*"?',
    "'(?:[^'\\\\\\n]|\\\\.)*'?",
    ...(family.backtick ? ["`(?:[^`\\\\]|\\\\.)*`?"] : []),
  ];
  const comments = family.comments.map((start) => (start.includes("[") ? start : `${start}[^\\n]*`));
  const parts = [
    comments.length ? `(?<comment>${comments.join("|")})` : null,
    family.tags ? "(?<tag></?[A-Za-z][\\w:.-]*|/?>)" : null,
    `(?<string>${strings.join("|")})`,
    "(?<number>\\b(?:0x[\\da-fA-F_]+|\\d[\\d_]*(?:\\.\\d+)?(?:e[+-]?\\d+)?)\\b)",
    family.keywords.length ? `(?<keyword>\\b(?:${family.keywords.join("|")})\\b)` : null,
  ].filter(Boolean);
  return new RegExp(parts.join("|"), "g");
}

/** Splits text into lines of tokens. Files over 200,000 characters come back as plain lines, to stay quick. */
export function highlight(text: string, language: string | null): Token[][] {
  const family = language ? FAMILIES[language] : undefined;
  const tokens: Token[] = [];
  if (!family || text.length > 200_000) tokens.push({ kind: "plain", text });
  else {
    const key = language!;
    let pattern = cache.get(key);
    if (!pattern) cache.set(key, (pattern = patternFor(family)));
    pattern.lastIndex = 0;
    let at = 0;
    for (const match of text.matchAll(pattern)) {
      if (!match[0]) continue;
      if (match.index! > at) tokens.push({ kind: "plain", text: text.slice(at, match.index) });
      const groups = match.groups ?? {};
      const kind = (Object.keys(groups).find((name) => groups[name] !== undefined) ?? "plain") as Token["kind"];
      tokens.push({ kind, text: match[0] });
      at = match.index! + match[0].length;
    }
    if (at < text.length) tokens.push({ kind: "plain", text: text.slice(at) });
  }
  // Break tokens at line ends so each line renders on its own row.
  const lines: Token[][] = [[]];
  for (const token of tokens) {
    const pieces = token.text.split(/\r?\n/);
    pieces.forEach((piece, index) => {
      if (index > 0) lines.push([]);
      if (piece) lines.at(-1)!.push({ kind: token.kind, text: piece });
    });
  }
  // A file's final line break doesn't start another line.
  if (lines.length > 1 && !lines.at(-1)!.length) lines.pop();
  return lines;
}
