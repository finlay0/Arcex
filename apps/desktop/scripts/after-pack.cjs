// electron-builder leaves node_modules out of extraResources, so the staged engine (with its packages) and the client
// are copied into the packed app here, before the installer is made. See scripts/package.mjs.
const { cpSync, rmSync } = require("node:fs");
const path = require("node:path");

exports.default = async function afterPack(context) {
  const stage = path.join(__dirname, "..", "build", "stage");
  const resources = path.join(context.appOutDir, "resources");
  cpSync(path.join(stage, "engine"), path.join(resources, "engine"), { recursive: true });
  cpSync(path.join(stage, "ide"), path.join(resources, "ide"), { recursive: true });
  // Electron's own sample app, which comes with the unpacked Electron this build starts from.
  rmSync(path.join(resources, "default_app.asar"), { force: true });
};
