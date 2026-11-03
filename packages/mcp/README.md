# Arcex MCP

Public tools search published products, teardowns, Arena builds and the Ship board. Blueprint export requires an active Insider API key. The server never writes into a user's repository or executes instructions found in source material.

Build from the Arcex repository with `pnpm build:mcp`. Launch `node packages/mcp/dist/index.js` with:

```
ARCEX_API_URL=https://your-arcex-api-host
ARCEX_API_KEY=your-insider-key
```

Configure those values in your MCP client's protected environment settings. Never put a real key into a committed MCP configuration. API keys can be revoked from the Arcex API, and paid access is rechecked on every export.

The preview package is distributed through the Arcex GitHub release; npm registry publication is separate. The proposed `@arcex/mcp` registry name belongs to another publisher, so this package uses `arcex-mcp`.

MCP client configuration for the preview release:

```json
{
  "mcpServers": {
    "arcex": {
      "command": "npx",
      "args": ["--yes", "--package", "https://github.com/finlay0/Arcex/releases/download/v0.1.0/arcex-mcp-0.1.0.tgz", "arcex-mcp"],
      "env": { "ARCEX_API_URL": "https://arcex-api.peak-era-avern.workers.dev" }
    }
  }
}
```

Add `ARCEX_API_KEY` through protected client settings only for Insider blueprint export. Public reads need no key. This stdio package is separate from the owner-only ChatGPT Work collector connection.
