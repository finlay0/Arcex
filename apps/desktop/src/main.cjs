// Desktop shell: starts the engine, then shows the client the engine serves.
const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
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
    backgroundColor: "#0b0b0c",
    title: "Arcex",
    // The client draws the title bar. Windows keeps its own minimise, maximise and close buttons on top of it.
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#0e0e10", symbolColor: "#f4f4f5", height: 63 },
    webPreferences: { contextIsolation: true, sandbox: true, preload: path.join(__dirname, "preload.cjs") },
  });
  win.setMenuBarVisibility(false);

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
app.on("quit", () => engine?.kill());
