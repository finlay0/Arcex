import { build } from "esbuild";
await build({
  entryPoints: ["packages/mcp/src/cli.ts"],
  outfile: "packages/mcp/dist/index.js",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  packages: "external",
  banner: { js: "#!/usr/bin/env node" },
});
console.log("Built packages/mcp/dist/index.js");
