// Engine entry point: serves the built client and one WebSocket that speaks @arcex/contracts.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { openDb } from "./db.ts";
import { createEngine } from "./engine.ts";
import { TOOLBOX } from "./toolbox.ts";
import { createAccountClient } from "./account.ts";

const clientDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../ide/dist");
const dataDir = process.env.ARCEX_DATA_DIR ?? path.join(process.env.APPDATA ?? os.homedir(), "Arcex");
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png",
  ".svg": "image/svg+xml", ".woff2": "font/woff2", ".ico": "image/x-icon",
};

const sockets = new Set<WebSocket>();
const about = { version: "0.1.0", dataDir, projectsDir: path.join(os.homedir(), "Arcex Projects") };
// The connector runs as its own process, so it reads the toolbox from a file.
mkdirSync(dataDir, { recursive: true });
const toolboxFile = path.join(dataDir, "toolbox.json");
writeFileSync(toolboxFile, JSON.stringify(TOOLBOX));
const connector = { script: path.join(path.dirname(fileURLToPath(import.meta.url)), "connector.mjs"), toolboxFile };

function vaultRequest(action: "read" | "write", token?: string | null) {
  return new Promise<string | null>((resolve, reject) => {
    const id = randomUUID();
    const finish = (error?: string, value?: string | null) => {
      clearTimeout(timeout);
      process.off("message", receive);
      if (error) reject(new Error(error));
      else resolve(value ?? null);
    };
    const receive = (message: unknown) => {
      if (!message || typeof message !== "object" || !("id" in message) || message.id !== id ||
        !("channel" in message) || message.channel !== "account-vault") return;
      finish("error" in message && typeof message.error === "string" ? message.error : undefined,
        "token" in message && typeof message.token === "string" ? message.token : null);
    };
    const timeout = setTimeout(() => finish("Arcex credential storage took too long to respond."), 4000);
    process.on("message", receive);
    process.send?.({ channel: "account-vault", id, action, token }, (error) => {
      if (error) finish("Couldn't reach Arcex credential storage.");
    });
  });
}
const account = createAccountClient(process.send ? {
  read: () => vaultRequest("read"),
  write: async (token) => { await vaultRequest("write", token); },
} : undefined, process.env.ARCEX_ACCOUNTS_API);
const engine = createEngine(openDb(dataDir), about, connector, (message) => {
  const data = JSON.stringify(message);
  for (const socket of sockets) socket.send(data);
}, account);

function localHost(host: string | undefined) {
  const address = server.address();
  return address && typeof address === "object" &&
    (host === `127.0.0.1:${address.port}` || host === `localhost:${address.port}`);
}

const server = createServer((request, response) => {
  if (!localHost(request.headers.host)) {
    response.writeHead(403).end("Arcex is available on localhost.");
    return;
  }
  const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
  const file = path.join(clientDir, pathname === "/" ? "index.html" : pathname);
  // Stay inside the client folder.
  if (!file.startsWith(clientDir + path.sep) || !existsSync(file) || !statSync(file).isFile()) {
    response.writeHead(404).end("Not found. Build the client with: pnpm --filter @arcex/ide build");
    return;
  }
  response.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
  response.end(readFileSync(file));
});

// Only the engine's own page may connect, plus the client dev server when one is named.
const wss = new WebSocketServer({
  server,
  maxPayload: 1_000_000,
  verifyClient: ({ origin, req }: { origin: string; req: IncomingMessage }) =>
    !!localHost(req.headers.host) && (origin === `http://${req.headers.host}` || (!!process.env.ARCEX_DEV_ORIGIN && origin === process.env.ARCEX_DEV_ORIGIN)),
});
wss.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
  socket.on("message", (raw) => {
    let message: { id?: unknown; method?: unknown; params?: unknown };
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    const { id } = message;
    if (typeof id !== "number" || typeof message.method !== "string") return;
    engine.handle(message.method, message.params).then(
      (result) => socket.send(JSON.stringify({ id, result })),
      (error: unknown) => socket.send(JSON.stringify({ id, error: String(error instanceof Error ? error.message : error) })),
    );
  });
});

server.listen(Number(process.env.ARCEX_ENGINE_PORT ?? 4517), "127.0.0.1", () => {
  const address = server.address();
  if (address && typeof address === "object") console.log(`ARCEX_ENGINE_READY http://127.0.0.1:${address.port}/`);
});

let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  engine.close();
  for (const socket of sockets) socket.terminate();
  wss.close();
  server.close();
  if (process.connected) process.disconnect?.();
  setTimeout(() => process.exit(0), 3000).unref();
}
// One agent or request going wrong must never take the whole workspace down. Log it and keep serving.
process.on("uncaughtException", (error) => console.error("[engine] unexpected error:", error));
process.on("unhandledRejection", (error) => console.error("[engine] unhandled rejection:", error));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("disconnect", shutdown);
