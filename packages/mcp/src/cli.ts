import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { runInit } from "./init";
import { createMcpServer } from "./server";

const DEFAULT_API_URL = "https://arcex-api.peak-era-avern.workers.dev";
const [command, ...args] = process.argv.slice(2);

if (command === "init") {
  try {
    runInit(args);
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
} else if (command) {
  console.error("Usage: npx arcex init, or npx arcex to start the MCP server");
  process.exitCode = 1;
} else {
  // Clients can pass an unexpanded placeholder when no key is set, so only real keys count.
  const key = process.env.ARCEX_API_KEY?.trim();
  await createMcpServer({
    apiUrl: process.env.ARCEX_API_URL ?? DEFAULT_API_URL,
    apiKey: key?.startsWith("arcex_") ? key : undefined,
  }).connect(new StdioServerTransport());
}
