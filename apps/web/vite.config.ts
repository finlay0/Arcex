import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// Defaults to the local Worker. Set ARCEX_API_PROXY=https://api.arcex.dev to read live data.
const target = process.env.ARCEX_API_PROXY ?? "http://localhost:8791";

export default defineConfig(({ mode }) => ({
  ...(mode === "accounts" ? {
    base: "/_arcex-account/",
    build: { outDir: "dist/account-site/_arcex-account" },
  } : {}),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    proxy: Object.fromEntries(["/api", "/auth"].map((path) => [path, { target, changeOrigin: true }])),
  },
}));
