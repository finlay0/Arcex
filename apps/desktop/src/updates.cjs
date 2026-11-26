// Updates for the installed app (D2). New versions download in the background from the release feed; the client shows
// "Update ready" once one is downloaded, and Restart installs it silently and opens Arcex again. Quitting also installs
// a downloaded update. The feed is set at build time (electron-builder `publish`); ARCEX_UPDATE_URL points a build at
// another feed, which is how updates are tested against a local folder.
const CHECK_EVERY = 30 * 60_000;

function createInstalledUpdates(getWindow) {
  const { autoUpdater } = require("electron-updater");
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  if (process.env.ARCEX_UPDATE_URL) autoUpdater.setFeedURL({ provider: "generic", url: process.env.ARCEX_UPDATE_URL });

  const state = { version: null, percent: 0, ready: false, notes: null, error: null };
  autoUpdater.on("update-available", (info) => Object.assign(state, { version: info.version, percent: 0, error: null }));
  autoUpdater.on("download-progress", (progress) => (state.percent = Math.round(progress.percent)));
  autoUpdater.on("update-downloaded", (info) => {
    const notes = Array.isArray(info.releaseNotes) ? info.releaseNotes.map((note) => note.note).join("\n") : info.releaseNotes;
    Object.assign(state, { version: info.version, ready: true, percent: 100, notes: typeof notes === "string" ? notes.replace(/<[^>]+>/g, "").slice(0, 2000) : null });
    // Tell the window straight away, so "Update ready" shows without waiting for its next check.
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send("update-ready");
  });
  autoUpdater.on("error", (error) => (state.error = String(error?.message ?? error).slice(0, 300)));

  let lastCheck = 0;
  const look = () => {
    lastCheck = Date.now();
    autoUpdater.checkForUpdates().catch((error) => (state.error = String(error?.message ?? error).slice(0, 300)));
  };
  setTimeout(look, 10_000);

  return {
    /** The same shape as a source build's check, plus what the installed app knows. */
    check() {
      if (!state.ready && Date.now() - lastCheck > CHECK_EVERY) look();
      return { behind: 0, changed: false, version: state.version, ready: state.ready, percent: state.percent, notes: state.notes };
    },
    install() {
      if (!state.ready) return { error: "No update is downloaded yet." };
      // Silent install, then open Arcex again. Runs after this reply reaches the window.
      setImmediate(() => autoUpdater.quitAndInstall(true, true));
      return { ok: true };
    },
  };
}

module.exports = { createInstalledUpdates };
