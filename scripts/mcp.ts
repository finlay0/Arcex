import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { apiUrl } from "./client";
import { createMcpServer } from "../packages/mcp/src/server";

await createMcpServer({ apiUrl, apiKey: process.env.ARCEX_API_KEY }).connect(
  new StdioServerTransport(),
);
