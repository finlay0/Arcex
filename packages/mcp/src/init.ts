import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const CLIENTS = ["claude", "cursor", "codex"] as const;
type ClientName = (typeof CLIENTS)[number];

// API keys stay out of these files. Each client reads the key from the environment.
const KEY_REFERENCE: Record<"claude" | "cursor", string> = {
  claude: "${ARCEX_API_KEY:-}",
  cursor: "${env:ARCEX_API_KEY}",
};
const CONFIG_PATH: Record<"claude" | "cursor", string> = {
  claude: ".mcp.json",
  cursor: join(".cursor", "mcp.json"),
};

/** On native Windows, MCP clients need cmd to launch npx. */
function launch(platform: string) {
  return platform === "win32"
    ? { command: "cmd", args: ["/c", "npx", "-y", "arcex"] }
    : { command: "npx", args: ["-y", "arcex"] };
}

function writeClientConfig(
  client: "claude" | "cursor",
  cwd: string,
  platform: string,
): string {
  const relative = CONFIG_PATH[client];
  const path = join(cwd, relative);
  let config: { mcpServers?: Record<string, unknown> } = {};
  if (existsSync(path)) {
    try {
      config = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new Error(`${relative} isn't valid JSON, so it was left unchanged`);
    }
    if (typeof config !== "object" || config === null || Array.isArray(config))
      throw new Error(
        `${relative} isn't a JSON object, so it was left unchanged`,
      );
  }
  if (config.mcpServers?.arcex)
    return `${relative}: already set up, left unchanged`;
  config.mcpServers = {
    ...config.mcpServers,
    arcex: {
      ...launch(platform),
      env: { ARCEX_API_KEY: KEY_REFERENCE[client] },
    },
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
  return `${relative}: added Arcex`;
}

function codexSnippet(platform: string) {
  const { command, args } = launch(platform);
  return [
    "Add this to ~/.codex/config.toml:",
    "",
    "[mcp_servers.arcex]",
    `command = ${JSON.stringify(command)}`,
    `args = ${JSON.stringify(args)}`,
    'env_vars = ["ARCEX_API_KEY"]',
  ].join("\n");
}

export function runInit(
  args: string[],
  options: {
    cwd?: string;
    platform?: string;
    log?: (line: string) => void;
  } = {},
) {
  const cwd = options.cwd ?? process.cwd();
  const platform = options.platform ?? process.platform;
  const log = options.log ?? console.log;

  let requested: ClientName | undefined;
  if (args.length) {
    const [flag, value] = args;
    if (
      flag !== "--client" ||
      args.length !== 2 ||
      !CLIENTS.includes(value as ClientName)
    )
      throw new Error(`Usage: npx arcex init [--client ${CLIENTS.join("|")}]`);
    requested = value as ClientName;
  }

  if (requested === "codex") log(codexSnippet(platform));
  else if (requested) log(writeClientConfig(requested, cwd, platform));
  else {
    log(writeClientConfig("claude", cwd, platform));
    if (existsSync(join(cwd, ".cursor")))
      log(writeClientConfig("cursor", cwd, platform));
  }

  log("");
  log("Restart your agent, then ask it to use Arcex to find paywall patterns.");
  log(
    "Search works straight away. To pull blueprints, create a free API key in",
  );
  log("your Arcex account and set it as ARCEX_API_KEY in your environment.");
}
