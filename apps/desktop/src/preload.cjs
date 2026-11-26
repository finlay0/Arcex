const { contextBridge, ipcRenderer } = require("electron");

// The only desktop ability the client gets directly. Everything else goes through the engine.
contextBridge.exposeInMainWorld("arcex", {
  pickFolder: (title) => ipcRenderer.invoke("pick-folder", typeof title === "string" ? title.slice(0, 100) : undefined),
  ensureEngine: () => ipcRenderer.invoke("ensure-engine"),
  // Development builds run from source: check for newer code, and rebuild and restart onto it.
  checkForUpdate: () => ipcRenderer.invoke("update-check"),
  update: () => ipcRenderer.invoke("update-app"),
  // Lets the user click part of the page in the Browser tab; resolves with what they picked and their note, or null.
  pickElement: () => ipcRenderer.invoke("pick-element"),
  cancelPick: () => ipcRenderer.invoke("pick-element", true),
  // Opens a web address in the user's own browser.
  openExternal: (url) => ipcRenderer.send("open-external", String(url)),
  // Lets the window's own buttons match the theme the client is showing.
  setTheme: (theme) => ipcRenderer.send("set-theme", theme === "dark" ? "dark" : "light"),
});
