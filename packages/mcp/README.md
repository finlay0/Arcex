# Arcex MCP

Public tools search published products, teardowns, Arena builds and the Ship board. Blueprint export requires an active Insider API key. The server never writes into a user's repository or executes instructions found in source material.

Build from the Arcex repository with `pnpm build:mcp`. Launch `node packages/mcp/dist/index.js` with:

```
ARCEX_API_URL=https://your-arcex-api-host
ARCEX_API_KEY=your-insider-key
```

Configure those values in your MCP client's protected environment settings. Never put a real key into a committed MCP configuration. API keys can be revoked from the Arcex API, and paid access is rechecked on every export.

The package is prepared for npm publication. Registry availability and namespace ownership must be verified before advertising an `npx @arcex/mcp` install command.
