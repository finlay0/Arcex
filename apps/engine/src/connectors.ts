import type * as acp from "@agentclientprotocol/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Connector } from "@arcex/contracts";

/**
 * MCP servers the user added in Settings › Connectors. Arcex hands them to each agent when a session starts; the agent
 * runs or reaches them itself, as it would from its own settings.
 */

const NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/i;
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
const HEADER = /^[A-Za-z0-9-]{1,100}$/;
const RESERVED = new Set(["arcex", "arcex-research"]);
export const MAX_CONNECTORS = 30;

type Pair = { name: string; value: string };

function pairs(raw: unknown, pattern: RegExp, what: string): Pair[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 20) throw new Error(`at most 20 ${what}`);
  return raw.map((entry) => {
    const name = String((entry as Pair)?.name ?? "").trim();
    const value = String((entry as Pair)?.value ?? "");
    if (!pattern.test(name)) throw new Error(`"${name.slice(0, 40)}" isn't a valid ${what.replace(/s$/, "")} name`);
    if (value.length > 4000) throw new Error(`the value of ${name} is too long`);
    return { name, value };
  });
}

/** Checks a connector from the client and returns a clean copy. */
export function cleanConnector(raw: unknown, others: Connector[], projectIds: Set<string>): Connector {
  if (!raw || typeof raw !== "object") throw new Error("invalid connector");
  const input = raw as Partial<Connector>;
  const id = typeof input.id === "string" && /^[\w-]{1,60}$/.test(input.id) ? input.id : crypto.randomUUID();
  const name = String(input.name ?? "").trim();
  if (!NAME.test(name)) throw new Error("name it with letters, numbers, dashes or underscores, up to 40 characters");
  if (RESERVED.has(name.toLowerCase())) throw new Error(`"${name}" is Arcex's own connector. Choose another name`);
  const scope = input.scope === "all" || (typeof input.scope === "string" && projectIds.has(input.scope)) ? input.scope : null;
  if (!scope) throw new Error("choose where to use it");
  const overlapping = others.find((other) => other.id !== id && other.name.toLowerCase() === name.toLowerCase() && (other.scope === "all" || scope === "all" || other.scope === scope));
  if (overlapping) throw new Error(`a connector named ${name} is already used there`);
  const on = input.on !== false;
  if (input.kind === "web") {
    const url = new URL(String(input.url ?? "").trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("the address must start with https:// or http://");
    return { id, name, scope, on, kind: "web", url: url.href, headers: pairs(input.headers, HEADER, "headers") };
  }
  if (input.kind !== "command") throw new Error("choose a command or a web address");
  const line = String(input.command ?? "").trim();
  if (!line || line.length > 2000) throw new Error("enter the command that starts the server");
  if (!splitCommand(line).length) throw new Error("enter the command that starts the server");
  return { id, name, scope, on, kind: "command", command: line, env: pairs(input.env, VARIABLE, "variables") };
}

/** Splits a command line into words, keeping "quoted parts" together. Backslashes stay as typed, for Windows paths. */
export function splitCommand(line: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const char of line) {
    if (quote) {
      if (char === quote) quote = null;
      else word += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started || word) words.push(word);
      word = "";
      started = false;
    } else word += char;
  }
  if (started || word) words.push(word);
  return words;
}

/** Package runners on Windows are .cmd scripts, which can't be started directly without a shell. */
function launch(line: string): { command: string; args: string[] } {
  const [command = "", ...args] = splitCommand(line);
  if (process.platform === "win32" && /^(npx|npm|pnpm|pnpx|yarn|bunx|uvx)$/i.test(command)) return { command: "cmd", args: ["/c", command, ...args] };
  return { command, args };
}

/** The servers for a session in this project, as ACP describes them. */
export function connectorServers(list: Connector[], projectId: string): acp.McpServer[] {
  return list
    .filter((connector) => connector.on && (connector.scope === "all" || connector.scope === projectId))
    .map((connector): acp.McpServer =>
      connector.kind === "web"
        ? { type: "http", name: connector.name, url: connector.url!, headers: connector.headers ?? [] }
        : { name: connector.name, ...launch(connector.command!), env: connector.env ?? [] },
    );
}

/** Starts or reaches the server and asks for its tools, so the user knows it works before an agent needs it. */
export async function testConnector(connector: Connector): Promise<{ tools: string[] }> {
  let stderr = "";
  const transport =
    connector.kind === "web"
      ? new StreamableHTTPClientTransport(new URL(connector.url!), { requestInit: { headers: Object.fromEntries((connector.headers ?? []).map((h) => [h.name, h.value])) } })
      : (() => {
          const { command, args } = launch(connector.command!);
          const env = { ...(process.env as Record<string, string>), ...Object.fromEntries((connector.env ?? []).map((v) => [v.name, v.value])) };
          const stdio = new StdioClientTransport({ command, args, env, stderr: "pipe" });
          stdio.stderr?.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-2000)));
          return stdio;
        })();
  const client = new Client({ name: "arcex", version: "0.1.0" });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("it didn't answer within 30 seconds")), 30_000);
  });
  try {
    await Promise.race([client.connect(transport), timeout]);
    const listed = await Promise.race([client.listTools(), timeout]);
    return { tools: listed.tools.map((tool) => tool.name).slice(0, 200) };
  } catch (error) {
    const reason = stderr.trim().split(/\r?\n/).filter(Boolean).pop() || (error instanceof Error ? error.message : String(error));
    throw new Error(`${connector.name} didn't start: ${reason.slice(0, 300)}`);
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => {});
  }
}
