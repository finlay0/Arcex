import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server";

const apiUrl = process.env.ARCEX_API_URL;
if (!apiUrl) throw new Error("Set ARCEX_API_URL to your Arcex API deployment");
await createMcpServer({ apiUrl, apiKey: process.env.ARCEX_API_KEY }).connect(
  new StdioServerTransport(),
);
