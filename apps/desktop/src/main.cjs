// Desktop shell: starts the engine, then shows the client the engine serves.
const { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } = require("electron");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { mkdir, readFile, rename, rm, writeFile } = require("node:fs/promises");
const path = require("node:path");

const engineDir = path.resolve(__dirname, "../../engine");
let engine;
let engineUrl;
let starting;
let quitting = false;
// Recent unexpected exits, to stop restarting an engine that keeps crashing straight away.
const crashes = [];
const accountVaultFile = () => {
  const local = process.env.ARCEX_ACCOUNTS_API && new URL(process.env.ARCEX_ACCOUNTS_API).protocol === "http:";
  return path.join(app.getPath("userData"), local ? "account-local.enc" : "account.enc");
};

async function handleAccountVault(child, message) {
  if (engine !== child || message?.channel !== "account-vault" || typeof message.id !== "string") return;
  let reply;
  try {
    const file = accountVaultFile();
    if (message.action === "read") {
      const encrypted = await readFile(file).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      const result = encrypted && await safeStorage.decryptStringAsync(encrypted);
      reply = { token: result?.result ?? null };
    } else if (message.action === "write" && message.token === null) {
      await rm(file, { force: true });
      reply = {};
    } else if (message.action === "write" && /^[0-9a-f]{64}$/.test(message.token) &&
      ["win32", "darwin"].includes(process.platform) && await safeStorage.isAsyncEncryptionAvailable()) {
      const temp = file + "." + randomUUID();
      try {
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(temp, await safeStorage.encryptStringAsync(message.token), { flag: "wx" });
        await rename(temp, file);
      } finally {
        await rm(temp, { force: true });
      }
      reply = {};
    } else throw new Error("Unavailable credential storage");
  } catch {
    reply = { error: "Couldn't access your encrypted Arcex session. Try again from the desktop app." };
  }
  if (child.connected) child.send({ channel: "account-vault", id: message.id, ...reply }, () => {});
}

function startEngine(port) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["--import", "tsx", "src/main.ts"], {
      cwd: engineDir,
      env: { ...process.env, ARCEX_ENGINE_PORT: port },
      stdio: ["ignore", "pipe", "inherit", "ipc"],
    });
    engine = child;
    child.on("message", (message) => void handleAccountVault(child, message));
    const timer = setTimeout(() => {
      reject(new Error("The engine took too long to start."));
      child.kill();
    }, 12_000);
    const onFailure = (error) => {
      clearTimeout(timer);
      if (engine === child) engine = undefined;
      reject(error);
    };
    child.once("error", onFailure);
    child.once("exit", (code) => {
      onFailure(new Error(`The engine exited with code ${code}.`));
      // A running engine that stops on its own is brought straight back on the same address,
      // so the open window reconnects without the user noticing.
      if (quitting || !engineUrl) return;
      const now = Date.now();
      crashes.push(now);
      while (crashes.length && now - crashes[0] > 60_000) crashes.shift();
      if (crashes.length > 5) return console.error("[desktop] the engine keeps stopping; waiting for the window to ask again");
      setTimeout(() => ensureEngine().catch((error) => console.error("[desktop] engine restart failed:", error.message)), 300);
    });
    let buffered = "";
    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      if (buffered === null) return;
      buffered += chunk;
      const match = buffered.match(/ARCEX_ENGINE_READY (\S+)/);
      if (match) {
        buffered = null;
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
  });
}

function ensureEngine() {
  if (starting) return starting;
  if (engine && engineUrl) return Promise.resolve(engineUrl);
  const port = engineUrl ? new URL(engineUrl).port : process.env.ARCEX_ENGINE_PORT ?? "0";
  starting = startEngine(port).then((url) => (engineUrl = url)).finally(() => (starting = undefined));
  return starting;
}

app.whenReady().then(async () => {
  let url;
  while (!url) {
    try {
      url = await ensureEngine();
    } catch (error) {
      const result = await dialog.showMessageBox({
        type: "error",
        title: "Arcex couldn't start",
        message: "Arcex couldn't start its local engine.",
        detail: error.message,
        buttons: ["Retry", "Close"],
        cancelId: 1,
      });
      if (result.response !== 0) return app.quit();
    }
  }
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 680,
    backgroundColor: "#0b0b0c",
    title: "Arcex",
    // The client draws the title bar. Windows keeps its own minimise, maximise and close buttons on top of it.
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#0e0e10", symbolColor: "#f4f4f5", height: 63 },
    webPreferences: { contextIsolation: true, sandbox: true, preload: path.join(__dirname, "preload.cjs") },
  });
  win.setMenuBarVisibility(false);

  ipcMain.handle("ensure-engine", async (event) => {
    const frame = event.senderFrame;
    if (event.sender !== win.webContents || !frame || frame.parent !== null || !frame.url.startsWith(engineUrl)) throw new Error("Only the Arcex workspace can reconnect.");
    // The window asking is a fresh start for the crash guard.
    crashes.length = 0;
    await ensureEngine();
  });
  ipcMain.handle("pick-folder", async () => {
    const result = await dialog.showOpenDialog(win, { title: "Choose your project folder", properties: ["openDirectory"] });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  ipcMain.on("set-theme", (_event, theme) => {
    const dark = theme === "dark";
    win.setTitleBarOverlay({ color: dark ? "#0e0e10" : "#fafafa", symbolColor: dark ? "#f4f4f5" : "#111113" });
    win.setBackgroundColor(dark ? "#0b0b0c" : "#f1f1f2");
  });
  // Web links open in the user's own browser, never inside the app window. Only http and https are passed on.
  const openOutside = (url) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  };
  ipcMain.on("open-external", (_event, url) => openOutside(url));
  win.webContents.on("will-navigate", (event, target) => {
    if (new URL(target).origin === new URL(url).origin) return;
    event.preventDefault();
    openOutside(target);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    openOutside(url);
    return { action: "deny" };
  });
  await win.loadURL(url);
  // ARCEX_SHOT=<file.png> saves a picture of the window and quits. Used to check the desktop build.
  if (process.env.ARCEX_SHOT) {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    // ARCEX_SHOT_JS runs first, to move the app to the screen being checked.
    if (process.env.ARCEX_SHOT_JS) await win.webContents.executeJavaScript(process.env.ARCEX_SHOT_JS);
    require("node:fs").writeFileSync(process.env.ARCEX_SHOT, (await win.webContents.capturePage()).toPNG());
    app.quit();
  }
});

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => (quitting = true));
app.on("quit", () => {
  if (engine?.connected) engine.disconnect();
});
