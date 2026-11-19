const { contextBridge, ipcRenderer } = require("electron");

// The only desktop ability the client gets directly. Everything else goes through the engine.
contextBridge.exposeInMainWorld("arcex", {
  pickFolder: () => ipcRenderer.invoke("pick-folder"),
  ensureEngine: () => ipcRenderer.invoke("ensure-engine"),
  // Opens a web address in the user's own browser.
  openExternal: (url) => ipcRenderer.send("open-external", String(url)),
  // Lets the window's own buttons match the theme the client is showing.
  setTheme: (theme) => ipcRenderer.send("set-theme", theme === "dark" ? "dark" : "light"),
});
