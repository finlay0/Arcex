// Builds the Windows installer (D1): `pnpm -C apps/desktop package`.
//
// 1. Builds the client (apps/ide/dist).
// 2. Copies the engine with only its production packages into build/stage/engine (flat node_modules, no links, so the
//    installer can carry them), then bundles the engine's own code into build/stage/engine/dist/main.js.
// 3. electron-builder packs the shell (src/) with build/stage as resources and writes the installer to build/out.
//
// Installed, Arcex.exe runs the engine in Node mode (ELECTRON_RUN_AS_NODE), so the user needs no Node of their own.
// Installed copies look for updates in the releases of github.com/finlay0/arcex-releases (`--publish` puts a build
// there). ARCEX_RELEASE_FEED points a local test build at another folder holding latest.yml instead.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.resolve(desktop, "../..");
const stage = path.join(desktop, "build", "stage");
const onlyStage = process.argv.includes("--stage-only");
// `--publish` uploads the build as a GitHub release of the public releases repository, where installed copies look for
// updates. Bump the version in apps/desktop/package.json first; `--notes "..."` sets what the release says.
const RELEASES = "finlay0/arcex-releases";
const publish = process.argv.includes("--publish");
const notesAt = process.argv.indexOf("--notes");
const notes = notesAt === -1 ? "" : String(process.argv[notesAt + 1] ?? "").slice(0, 2000);

function run(command, args, cwd = repo) {
  console.log(`> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
}

// Some packages ship read-only files, which Node's rmSync refuses on Windows; rd removes them.
try {
  rmSync(path.join(desktop, "build"), { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
} catch (error) {
  if (process.platform !== "win32") throw error;
  spawnSync("cmd.exe", ["/d", "/c", "rd", "/s", "/q", path.join(desktop, "build")], { stdio: "inherit" });
}
mkdirSync(stage, { recursive: true });

run("pnpm", ["--filter", "@arcex/ide", "build"]);
cpSync(path.join(repo, "apps", "ide", "dist"), path.join(stage, "ide", "dist"), { recursive: true });

// Production packages only, laid out flat the way npm would.
run("pnpm", ["--filter", "@arcex/engine", "deploy", "--prod", "--legacy", "--config.node-linker=hoisted", path.join(stage, "engine")]);
for (const extra of ["src", "tests", "tsconfig.json", "apps"]) rmSync(path.join(stage, "engine", extra), { recursive: true, force: true });
prune(path.join(stage, "engine"));
// Claude Code's and Codex's own programs (over 800 MB): the installed app runs the user's copies instead (vendorCli.ts).
for (const vendor of ["@anthropic-ai/claude-agent-sdk-win32-x64", "@anthropic-ai/claude-agent-sdk-win32-arm64", "@openai/codex", "@openai/codex-win32-x64", "@openai/codex-win32-arm64"]) {
  rmSync(path.join(stage, "engine", "node_modules", vendor), { recursive: true, force: true });
}

/**
 * pnpm's deploy can bring in packages the engine never loads (the workspace root's own). Keeps only what the engine's
 * dependencies reach, walking package.json files the way Node resolves them (nested node_modules first, then the top).
 */
function prune(root) {
  const top = path.join(root, "node_modules");
  const keep = new Set();
  // The folder whose node_modules holds `dir` (the package above it, or the root).
  const above = (dir) => {
    const at = dir.lastIndexOf(`${path.sep}node_modules${path.sep}`);
    return at === -1 ? null : dir.slice(0, at);
  };
  const visit = (from, name) => {
    for (let dir = from; dir && dir.startsWith(root); dir = above(dir)) {
      const candidate = path.join(dir, "node_modules", name);
      if (!existsSync(path.join(candidate, "package.json"))) continue;
      if (keep.has(candidate)) return;
      keep.add(candidate);
      const manifest = JSON.parse(readFileSync(path.join(candidate, "package.json"), "utf8"));
      for (const dep of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies })) visit(candidate, dep);
      return;
    }
  };
  const own = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  for (const dep of Object.keys(own.dependencies ?? {})) visit(root, dep);
  let removed = 0;
  for (const entry of readdirSync(top)) {
    if (entry.startsWith(".")) continue;
    const names = entry.startsWith("@") ? readdirSync(path.join(top, entry)).map((child) => path.join(entry, child)) : [entry];
    for (const name of names) {
      if (keep.has(path.join(top, name))) continue;
      rmSync(path.join(top, name), { recursive: true, force: true });
      removed++;
    }
  }
  for (const entry of readdirSync(top)) if (entry.startsWith("@") && !readdirSync(path.join(top, entry)).length) rmSync(path.join(top, entry), { recursive: true });
  rmSync(path.join(top, ".pnpm"), { recursive: true, force: true });
  console.log(`Pruned ${removed} packages the engine doesn't use; kept ${keep.size}.`);
}

// Every script the installed app runs becomes one file: the engine, its connector and both agent adapters. Thousands of
// small package files are what made installing (and so updating) slow. Only packages with native parts stay as folders.
const KEEP = ["@lydell", "transcribe-cpp", "@transcribe-cpp", "koffi"];
const esbuild = createRequire(path.join(repo, "apps", "engine", "package.json"))("esbuild");
// Packages written for CommonJS expect require, __filename and __dirname, which an ES module bundle lacks. The file names
// get their own identifiers (some packages declare a __dirname of their own); `define` points the undeclared uses at them.
const banner = [
  'import { createRequire as __arcexRequire } from "node:module";',
  'import { fileURLToPath as __arcexPath } from "node:url";',
  'import { dirname as __arcexDir } from "node:path";',
  "const require = __arcexRequire(import.meta.url);",
  "const __arcexFilename = __arcexPath(import.meta.url);",
  "const __arcexDirname = __arcexDir(__arcexFilename);",
].join("\n");
const engineDir = path.join(stage, "engine");
const bundle = (entry, outfile) => esbuild.buildSync({
  entryPoints: [entry], outfile, bundle: true, platform: "node", format: "esm", target: "node24",
  external: ["@lydell/node-pty", "transcribe-cpp", "koffi"], banner: { js: banner }, define: { __filename: "__arcexFilename", __dirname: "__arcexDirname" }, logLevel: "error", legalComments: "none",
  nodePaths: [path.join(engineDir, "node_modules")],
});
bundle(path.join(repo, "apps", "engine", "src", "main.ts"), path.join(engineDir, "dist", "main.js"));
bundle(path.join(repo, "apps", "engine", "src", "connector.mjs"), path.join(engineDir, "dist", "connector.mjs"));
for (const pkg of ["@agentclientprotocol/claude-agent-acp", "@agentclientprotocol/codex-acp"]) {
  const dir = path.join(engineDir, "node_modules", pkg);
  const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  for (const [name, file] of Object.entries(manifest.bin)) bundle(path.join(dir, file), path.join(engineDir, "adapters", `${name}.mjs`));
}
for (const entry of readdirSync(path.join(engineDir, "node_modules"))) {
  if (!KEEP.includes(entry)) rmSync(path.join(engineDir, "node_modules", entry), { recursive: true, force: true });
}

const version = JSON.parse(readFileSync(path.join(desktop, "package.json"), "utf8")).version;
writeFileSync(path.join(stage, "VERSION"), version);
if (onlyStage) process.exit(0);

const feed = process.env.ARCEX_RELEASE_FEED ?? `https://github.com/${RELEASES}/releases/latest/download`;
if (publish && process.env.ARCEX_RELEASE_FEED) throw new Error("A published build must use the public feed; unset ARCEX_RELEASE_FEED.");
const builder = ["exec", "electron-builder", "--win", "nsis", "--publish", "never", "-c.publish.provider=generic", `-c.publish.url=${feed}`];
// The notes go into latest.yml, which is where installed copies read them for the Update button's tooltip.
// A file, because electron-builder runs through the shell here and would split the text at its spaces.
if (notes) {
  const notesFile = path.join(desktop, "build", "release-notes.md");
  writeFileSync(notesFile, notes);
  builder.push(`-c.releaseInfo.releaseNotesFile=${notesFile}`);
}
run("pnpm", builder, desktop);
const out = path.join(desktop, "build", "out");
console.log(`\nInstaller: ${out}`);

if (publish) {
  // The installer, its blockmap (for smaller downloads later) and latest.yml, which installed copies check for updates.
  const assets = [`Arcex-Setup-${version}.exe`, `Arcex-Setup-${version}.exe.blockmap`, "latest.yml"].map((name) => path.join(out, name));
  for (const asset of assets) if (!existsSync(asset)) throw new Error(`missing ${asset}`);
  // gh is a real program, so it runs without a shell and the title and notes keep their spaces.
  const released = spawnSync("gh", ["release", "create", `v${version}`, "--repo", RELEASES, "--title", `Arcex ${version}`, "--notes", notes || `Arcex ${version}`, "--latest", ...assets], { stdio: "inherit" });
  if (released.status !== 0) throw new Error("gh release create failed (is the version already released?)");
  console.log(`Published v${version} to https://github.com/${RELEASES}/releases`);
}
