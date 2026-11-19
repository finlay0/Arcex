// The Arcex connector: a small MCP server the engine hands to every agent session, whichever provider runs it.
// It is how agents reach what Arcex knows. Plain JavaScript so any agent can start it with `node` from any folder.
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const toolbox = JSON.parse(readFileSync(process.env.ARCEX_TOOLBOX, "utf8"));
const project = { name: process.env.ARCEX_PROJECT_NAME ?? "", goal: process.env.ARCEX_PROJECT_GOAL ?? "" };
const text = (value) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });

function search(query) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return toolbox
    .map((tool) => ({ tool, score: words.filter((word) => Object.values(tool).join(" ").toLowerCase().includes(word)).length }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map((entry) => entry.tool);
}

const server = new McpServer({ name: "arcex", version: "0.1.0" });

server.registerTool(
  "project_goal",
  {
    description: "What the user is building in this project, in their own words. Read this before making product or technology choices.",
    inputSchema: {},
  },
  async () => text(project.goal ? `Project "${project.name}". The user describes it as: ${project.goal}` : "The user has not described this project yet."),
);

server.registerTool(
  "search_toolbox",
  {
    description:
      "Search Arcex's curated list of development tools (design, frameworks, database, sign-in, payments, hosting, email, analytics, AI). " +
      "Use it before recommending or installing a service, and explain the trade-off to the user in plain words. " +
      "Entries carry no prices: read the tool's own page for current pricing and limits.",
    inputSchema: { query: z.string().min(1).max(200).describe("What is needed, for example: payments for a mobile app") },
  },
  async ({ query }) => {
    const found = search(query);
    return text(found.length ? found : "Nothing in the toolbox matches. Suggest a well-known option and say that it is your own suggestion.");
  },
);

server.registerTool(
  "list_toolbox",
  { description: "List every tool in Arcex's curated toolbox, grouped by category.", inputSchema: {} },
  async () => text(toolbox.map((tool) => `${tool.category}: ${tool.name} (${tool.id}). ${tool.what}`).join("\n")),
);

await server.connect(new StdioServerTransport());
