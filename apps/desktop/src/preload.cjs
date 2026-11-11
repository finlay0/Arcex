const { contextBridge, ipcRenderer } = require("electron");

// The only desktop ability the client gets directly. Everything else goes through the engine.
contextBridge.exposeInMainWorld("arcex", {
  pickFolder: () => ipcRenderer.invoke("pick-folder"),
});
