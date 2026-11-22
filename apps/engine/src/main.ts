// Engine entry point: serves the built client and one WebSocket that speaks @arcex/contracts.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { openDb } from "./db.ts";
import { createEngine } from "./engine.ts";
import { TOOLBOX } from "./toolbox.ts";
import { createAccountClient } from "./account.ts";

const clientDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../ide/dist");
const argv = process.argv.slice(2);
const flag = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const dataDir = flag("--data-dir") ?? process.env.ARCEX_DATA_DIR ?? path.join(process.env.APPDATA ?? os.homedir(), "Arcex");
// A scheduled task starts the engine with --run-schedule <id>. If Arcex is open, its engine runs the schedule, so two
// engines never share the database; otherwise this one runs it with no window and exits when the run is done.
const scheduleRun = flag("--run-schedule");
const handoffFile = path.join(dataDir, "engine.json");
if (scheduleRun) {
  try {
    const open = JSON.parse(readFileSync(handoffFile, "utf8")) as { pid: number; port: number; key: string };
    process.kill(open.pid, 0);
    const reply = await fetch(`http://127.0.0.1:${open.port}/schedule/run`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-arcex-key": open.key },
      body: JSON.stringify({ id: scheduleRun }),
    });
    if (reply.status !== 403) process.exit(0);
  } catch {
    // No engine is open. This one runs it.
  }
}
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
/** Asks the desktop shell to do something only it can, and waits for its answer. */
function desktopCall(channel: string, payload: Record<string, unknown>, waitMs: number) {
  return new Promise<unknown>((resolve, reject) => {
    const id = randomUUID();
    const finish = (error?: string, value?: unknown) => {
      clearTimeout(timeout);
      process.off("message", receive);
      if (error) reject(new Error(error));
      else resolve(value);
    };
    const receive = (message: unknown) => {
      if (!message || typeof message !== "object" || !("id" in message) || message.id !== id ||
        !("channel" in message) || message.channel !== channel) return;
      finish("error" in message && typeof message.error === "string" ? message.error : undefined, "result" in message ? message.result : undefined);
    };
    const timeout = setTimeout(() => finish("The Arcex window took too long to respond."), waitMs);
    process.on("message", receive);
    process.send?.({ channel, id, ...payload }, (error) => {
      if (error) finish("Couldn't reach the Arcex window.");
    });
  });
}

// Agents reach the Browser tab through the Arcex connector, which calls back into this engine.
// The key is made fresh for every run and only handed to the connector, so web pages can't use the route.
const browserKey = randomBytes(32).toString("hex");
// Lets a scheduled task hand its run to this engine. Kept in the data folder, which only this user can read.
const handoffKey = randomBytes(32).toString("hex");
const engineUrl = () => {
  const address = server.address();
  return address && typeof address === "object" ? `http://127.0.0.1:${address.port}` : "";
};
const browserBridge = process.send ? { act: (action: string, args: Record<string, unknown>) => desktopCall("browser", { action, args }, 45_000) } : undefined;

const account = createAccountClient(process.send ? {
  read: () => vaultRequest("read"),
  write: async (token) => { await vaultRequest("write", token); },
} : undefined, process.env.ARCEX_ACCOUNTS_API);
const engine = createEngine(openDb(dataDir), about, connector, (message) => {
  const data = JSON.stringify(message);
  for (const socket of sockets) socket.send(data);
}, account, {
  browser: browserBridge,
  // On Windows, schedules get a Task Scheduler task that starts this engine the same way it runs now.
  ...(process.platform === "win32" ? { launch: { node: process.execPath, cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), script: "src/main.ts", dataDir } } : {}),
  connectorEnv: () => [
    { name: "ARCEX_ENGINE_URL", value: engineUrl() },
    { name: "ARCEX_BROWSER_KEY", value: browserKey },
  ],
});

/** A connector call: the Browser tab, or a suggested side thread. */
function agentRoute(request: IncomingMessage, response: import("node:http").ServerResponse, act: (body: Record<string, unknown>) => Promise<unknown>, secret = browserKey) {
  const reply = (status: number, body: unknown) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
  const key = Buffer.from(String(request.headers["x-arcex-key"] ?? ""));
  if (key.length !== secret.length || !timingSafeEqual(key, Buffer.from(secret))) return reply(403, { error: "forbidden" });
  const chunks: Buffer[] = [];
  let size = 0;
  request.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > 64_000) request.destroy();
    else chunks.push(chunk);
  });
  request.on("end", () => {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!body || typeof body !== "object") throw new Error();
    } catch {
      return reply(400, { error: "invalid request" });
    }
    Promise.resolve().then(() => act(body)).then(
      (result) => reply(200, { result }),
      (error: unknown) => reply(400, { error: error instanceof Error ? error.message : String(error) }),
    );
  });
}

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
  if (pathname === "/agent/browser" && request.method === "POST") return agentRoute(request, response, (body) => engine.browse(body.projectId, body.action, body.args));
  if (pathname === "/schedule/run" && request.method === "POST") return agentRoute(request, response, async (body) => (await engine.runSchedule(String(body.id))).id, handoffKey);
  if (pathname === "/agent/side" && request.method === "POST") return agentRoute(request, response, async (body) => engine.suggest(body.threadId, body.title, body.prompt));
  const agentIcon = /^\/agent-icons\/([\w.-]{1,80})\.svg$/.exec(pathname);
  if (agentIcon && request.method === "GET") {
    // Directory icons are one-colour SVGs, used as masks. Served with a policy that blocks anything active in them.
    void engine.agentIcon(agentIcon[1]!).then((svg) => {
      if (!svg) return void response.writeHead(404).end("Not found");
      response.writeHead(200, { "content-type": "image/svg+xml", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'", "x-content-type-options": "nosniff", "cache-control": "private, max-age=86400" });
      response.end(svg);
    });
    return;
  }
  const attached = /^\/attachments\/([0-9a-f-]{36})$/.exec(pathname);
  if (attached && request.method === "GET") {
    // Thumbnails of images the user attached. Only plain image types are ever served.
    const image = engine.attachmentImage(attached[1]!);
    if (!image) return void response.writeHead(404).end("Not found");
    response.writeHead(200, { "content-type": image.mime, "x-content-type-options": "nosniff", "cache-control": "private, max-age=86400" });
    return void response.end(image.bytes);
  }
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
  // Room for one attached file (10 MB, base64) per message.
  maxPayload: 15_000_000,
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

server.listen(scheduleRun ? 0 : Number(process.env.ARCEX_ENGINE_PORT ?? 4517), "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address !== "object") return;
  writeFileSync(handoffFile, JSON.stringify({ pid: process.pid, port: address.port, key: handoffKey }));
  console.log(`ARCEX_ENGINE_READY http://127.0.0.1:${address.port}/`);
  if (scheduleRun) void runAndExit(scheduleRun);
});

/** A scheduled run with Arcex closed: start the thread, wait for it and its wrap-up, then stop. At most three hours. */
async function runAndExit(id: string) {
  const started = Date.now();
  await engine.runSchedule(id).catch((error: unknown) => console.error("[engine] scheduled run failed:", error));
  let quiet = 0;
  const check = setInterval(() => {
    quiet = engine.busy() ? 0 : quiet + 1;
    if (quiet >= 2 || Date.now() - started > 3 * 3_600_000) {
      clearInterval(check);
      shutdown();
    }
  }, 5000);
}

let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  engine.close();
  try {
    if ((JSON.parse(readFileSync(handoffFile, "utf8")) as { pid: number }).pid === process.pid) rmSync(handoffFile, { force: true });
  } catch {
    // Already gone.
  }
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
