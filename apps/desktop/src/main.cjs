// Desktop shell: starts the engine, then shows the client the engine serves.
const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");

const engineDir = path.resolve(__dirname, "../../engine");
let engine;

function startEngine() {
  return new Promise((resolve, reject) => {
    engine = spawn("node", ["--import", "tsx", "src/main.ts"], {
      cwd: engineDir,
      env: { ...process.env, ARCEX_ENGINE_PORT: process.env.ARCEX_ENGINE_PORT ?? "0" },
      stdio: ["ignore", "pipe", "inherit"],
    });
    engine.once("error", reject);
    engine.once("exit", (code) => reject(new Error(`engine exited with code ${code}`)));
    let buffered = "";
    engine.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      buffered += chunk;
      const match = buffered.match(/ARCEX_ENGINE_READY (\S+)/);
      if (match) resolve(match[1]);
    });
  });
}

app.whenReady().then(async () => {
  const url = await startEngine();
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 680,
    backgroundColor: "#e9dfcd",
    title: "Arcex",
    webPreferences: { contextIsolation: true, sandbox: true, preload: path.join(__dirname, "preload.cjs") },
  });
  win.setMenuBarVisibility(false);

  ipcMain.handle("pick-folder", async () => {
    const result = await dialog.showOpenDialog(win, { title: "Choose your project folder", properties: ["openDirectory"] });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  // Links the agents or the app produce open in the user's browser, never inside the shell.
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  await win.loadURL(url);
});

app.on("window-all-closed", () => app.quit());
app.on("quit", () => engine?.kill());
