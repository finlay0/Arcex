> Most people should use the hosted connection instead of this package: add `https://arcex-api.peak-era-avern.workers.dev/public/mcp` to your agent as a remote MCP server. This package isn't on npm. It's only for clients that can't use remote servers.

# Arcex MCP

Public tools search published products, teardowns, Arena builds and the Ship board. Blueprint export requires a free Arcex API key. The server never writes into a user's repository or executes instructions found in source material.

Build from the Arcex repository with `pnpm build:mcp`. Launch `node packages/mcp/dist/index.js` with:

```
ARCEX_API_URL=https://your-arcex-api-host
ARCEX_API_KEY=your-arcex-key
```

Configure those values in your MCP client's protected environment settings. Never put a real key into a committed MCP configuration. API keys can be revoked from the Arcex API, and revoked keys stop working immediately.

## Set up

Run this in your project:

```sh
npx arcex init
```

This adds Arcex to `.mcp.json` for Claude Code, and to `.cursor/mcp.json` if your project has a `.cursor` folder. Existing entries are left alone. Use `--client claude`, `--client cursor` or `--client codex` to choose one. Codex prints a snippet for you to add.

Public search needs no key. To export blueprints, set `ARCEX_API_KEY` in your environment. Free keys get 10 exports a day, and Insider is unlimited. Keys are never written to config files. This package is separate from the owner-only ChatGPT Work collector connection.

`ARCEX_API_URL` overrides the API address.
