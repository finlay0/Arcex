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

// ── The Browser tab. The user sees it in Arcex, beside the conversation, while the agent works in it.
const engineUrl = process.env.ARCEX_ENGINE_URL;
const browserKey = process.env.ARCEX_BROWSER_KEY;
const projectId = process.env.ARCEX_PROJECT_ID;

async function browse(action, args = {}) {
  try {
    const response = await fetch(`${engineUrl}/agent/browser`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-arcex-key": browserKey },
      body: JSON.stringify({ projectId, action, args }),
    });
    const body = await response.json();
    if (!response.ok) return { content: [{ type: "text", text: body.error ?? "The browser didn't respond." }], isError: true };
    return body.result;
  } catch {
    return { content: [{ type: "text", text: "Couldn't reach Arcex. The app may have closed." }], isError: true };
  }
}
// ── Side threads. The agent suggests separate work; the user starts it with one click, or doesn't.
const threadId = process.env.ARCEX_THREAD_ID;
if (engineUrl && browserKey && threadId) {
  server.registerTool(
    "suggest_side_thread",
    {
      description:
        "Suggests a separate piece of work as a side thread the user can start with one click. It runs beside this conversation " +
        "in its own copy of the project, and you hear back when it finishes. Use it for work outside the current task that you " +
        "noticed, such as a bug elsewhere or a follow-up worth doing, not for steps of the current task. Nothing starts until " +
        "the user does, so carry on with your task. Write the prompt so it stands on its own: the side thread doesn't see this conversation.",
      inputSchema: {
        title: z.string().min(1).max(80).describe("A short name for the work, such as \"Fix the broken sign-up link\""),
        prompt: z.string().min(1).max(8000).describe("Everything the side thread needs to do the work on its own: files, what's wrong, what done looks like"),
      },
    },
    async ({ title, prompt }) => {
      try {
        const response = await fetch(`${engineUrl}/agent/side`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-arcex-key": browserKey },
          body: JSON.stringify({ threadId, title, prompt }),
        });
        const body = await response.json();
        if (!response.ok) return { content: [{ type: "text", text: body.error ?? "Arcex didn't respond." }], isError: true };
        return text(body.result);
      } catch {
        return { content: [{ type: "text", text: "Couldn't reach Arcex. The app may have closed." }], isError: true };
      }
    },
  );
}

const reply = (result, describe) => (result?.isError ? result : text(describe(result)));
const where = (result) => `Now on ${result.url}${result.title ? ` (${result.title})` : ""}. Use browser_snapshot to read it.`;

if (engineUrl && browserKey && projectId) {
  const about =
    "Arcex has a Browser tab beside the conversation that the user can watch. Use it to check the app you are building: " +
    "start the app's dev server, open its local address, then read the page, click, type and look for errors. ";
  server.registerTool(
    "browser_open",
    {
      description: about + "Opens an address, usually the local dev server such as http://localhost:3000. Opening the current address reloads it.",
      inputSchema: { url: z.string().min(1).max(2000).describe("Full address, starting with http:// or https://") },
    },
    async ({ url }) => reply(await browse("open", { url }), where),
  );
  server.registerTool(
    "browser_snapshot",
    {
      description: "Reads the page in the Browser tab: headings, text, and every link, button and field with a number like [4] to use with browser_click and browser_type. Take a new one after the page changes.",
      inputSchema: {},
    },
    async () => reply(await browse("snapshot"), (result) => `${result.title || "Untitled"} — ${result.url}\n\n${result.page || "(The page is empty.)"}`),
  );
  server.registerTool(
    "browser_click",
    {
      description: "Clicks a link, button or other element in the Browser tab, by its number from browser_snapshot.",
      inputSchema: { ref: z.number().int().min(1).describe("The element's number from the latest browser_snapshot") },
    },
    async ({ ref }) => reply(await browse("click", { ref }), (result) => `Clicked [${ref}]. ${where(result)}`),
  );
  server.registerTool(
    "browser_type",
    {
      description: "Replaces the text in a field in the Browser tab, by its number from browser_snapshot. Set submit to press Enter afterwards.",
      inputSchema: {
        ref: z.number().int().min(1).describe("The field's number from the latest browser_snapshot"),
        text: z.string().max(5000).describe("The text to enter; empty clears the field"),
        submit: z.boolean().optional().describe("Press Enter after typing"),
      },
    },
    async ({ ref, text: value, submit }) => reply(await browse("type", { ref, text: value, submit: submit === true }), (result) => `Typed into [${ref}]. ${where(result)}`),
  );
  server.registerTool(
    "browser_press",
    {
      description: "Presses a key in the Browser tab: Enter, Tab, Escape, Backspace, Delete, Space, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Home, End, PageUp or PageDown.",
      inputSchema: { key: z.string().min(1).max(20) },
    },
    async ({ key }) => reply(await browse("press", { key }), (result) => `Pressed ${key}. ${where(result)}`),
  );
  server.registerTool(
    "browser_screenshot",
    { description: "Takes a picture of the page in the Browser tab, to check how it looks.", inputSchema: {} },
    async () => {
      const result = await browse("screenshot");
      return result?.isError ? result : { content: [{ type: "image", data: result.image, mimeType: result.mimeType }] };
    },
  );
  server.registerTool(
    "browser_console",
    { description: "Lists what the page in the Browser tab logged since the last check, including errors.", inputSchema: {} },
    async () => reply(await browse("console"), (result) =>
      result.messages.length ? result.messages.map((m) => `${m.level}: ${m.message} (${m.source})`).join("\n") : "Nothing new in the page's console."),
  );
  server.registerTool(
    "browser_back",
    { description: "Goes back one page in the Browser tab.", inputSchema: {} },
    async () => reply(await browse("back"), where),
  );
  server.registerTool(
    "browser_reload",
    { description: "Reloads the page in the Browser tab.", inputSchema: {} },
    async () => reply(await browse("reload"), where),
  );
}

await server.connect(new StdioServerTransport());
