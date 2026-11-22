import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

/** An app the user can open a project in: their code editor or the system's file manager. */
export type Editor = { id: string; name: string };

/** `folders` are the usual Windows install folders, under the user's or the machine's programs, for when PATH lacks them. */
type Known = { id: string; name: string; command: string; macApp: string; folders: string[] };
const KNOWN: Known[] = [
  { id: "code", name: "VS Code", command: "code", macApp: "Visual Studio Code", folders: ["Microsoft VS Code/bin/code.cmd"] },
  { id: "cursor", name: "Cursor", command: "cursor", macApp: "Cursor", folders: ["cursor/resources/app/bin/cursor.cmd"] },
  { id: "windsurf", name: "Windsurf", command: "windsurf", macApp: "Windsurf", folders: ["Windsurf/bin/windsurf.cmd"] },
  { id: "zed", name: "Zed", command: "zed", macApp: "Zed", folders: ["Zed/bin/zed.exe"] },
];
const FILES: Editor = { id: "files", name: process.platform === "win32" ? "File Explorer" : process.platform === "darwin" ? "Finder" : "Files" };

const run = (command: string, args: string[]) =>
  new Promise<string | null>((resolve) => {
    execFile(command, args, { timeout: 5000, windowsHide: true }, (error, stdout) => resolve(error ? null : String(stdout)));
  });

/** Where each editor's launcher is, found once per engine run. */
let found: Promise<Map<string, string>> | null = null;
function locate(): Promise<Map<string, string>> {
  found ??= (async () => {
    const located = new Map<string, string>();
    await Promise.all(
      KNOWN.map(async (editor) => {
        if (process.platform === "darwin") {
          if ((await run("open", ["-Ra", editor.macApp])) !== null) located.set(editor.id, editor.macApp);
          return;
        }
        const out = await run(process.platform === "win32" ? "where.exe" : "which", [editor.command]);
        const lines = (out ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        // On Windows the launcher is a .cmd; the extensionless file beside it is a shell script for Git Bash.
        let launcher = process.platform === "win32" ? lines.find((line) => /\.(cmd|exe)$/i.test(line)) : lines[0];
        if (!launcher && process.platform === "win32") {
          const roots = [process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs"), process.env.ProgramFiles].filter((root): root is string => !!root);
          launcher = roots.flatMap((root) => editor.folders.map((folder) => path.join(root, folder))).find((file) => existsSync(file));
        }
        if (launcher) located.set(editor.id, launcher);
      }),
    );
    return located;
  })();
  return found;
}

export async function listEditors(): Promise<Editor[]> {
  const located = await locate();
  return [...KNOWN.filter((editor) => located.has(editor.id)).map(({ id, name }) => ({ id, name })), FILES];
}

/** Characters cmd.exe would still read inside quotes. Paths with them are refused rather than risk running something. */
const UNSAFE = /["%!^\r\n]/;

/** Opens `target` (a folder or a file, already checked to be inside the project) in the chosen app. Starts it detached. */
export async function openIn(editorId: string, target: string, isFile: boolean): Promise<void> {
  const detached = (command: string, args: string[], verbatim = false) => {
    // Only cmd.exe is hidden (so no console flashes up). The app it starts shows its own window.
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: command === "cmd.exe", windowsVerbatimArguments: verbatim });
    child.on("error", () => {});
    child.unref();
  };
  if (editorId === FILES.id) {
    if (process.platform === "win32") {
      if (UNSAFE.test(target)) throw new Error("that path has characters File Explorer can't be given safely");
      detached("explorer.exe", [isFile ? `/select,"${target}"` : `"${target}"`], true);
    } else if (process.platform === "darwin") detached("open", isFile ? ["-R", target] : [target]);
    else detached("xdg-open", [isFile ? path.dirname(target) : target]);
    return;
  }
  const located = await locate();
  const launcher = located.get(editorId);
  if (!launcher) throw new Error("that editor isn't installed on this computer");
  if (process.platform === "darwin") return detached("open", ["-a", launcher, target]);
  if (process.platform !== "win32") return detached(launcher, [target]);
  if (UNSAFE.test(target) || UNSAFE.test(launcher)) throw new Error("that path has characters the editor can't be given safely");
  // Editor launchers on Windows are .cmd files, which only run through cmd.exe. Both paths are quoted whole.
  detached("cmd.exe", ["/d", "/s", "/c", `""${launcher}" "${target}""`], true);
}
