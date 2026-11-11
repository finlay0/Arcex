# Arcex ADE: architecture and plan of attack

Drafted November 10, 2026. Status: proposed, not yet approved. Nothing here is built.

## The decision in one paragraph

Build the Arcex ADE as an Electron desktop app written in TypeScript, split into a local engine process and a thin React client that talk over a typed WebSocket contract. Integrate coding agents through the Agent Client Protocol (ACP) instead of writing one adapter per provider. Do not write it in Rust, and do not fork T3 Code. Build it inside this repository next to the existing platform, which stays as it is.

## Why Electron and TypeScript, not Rust or Tauri

- **The integrated browser decides it.** Electron embeds real Chromium views (`WebContentsView`) and exposes the Chrome DevTools Protocol on them, which is what element picking, screenshots, console capture and agent-driven testing need. Tauri uses the system webview (WebView2 on Windows, WebKit on macOS), so the browser would behave differently per platform and agent control would be much harder.
- **Everything we want to reuse is TypeScript.** The ACP SDK, the Claude and Codex adapters, the MCP SDK, the terminal stack and the diff and markdown renderers are all Node packages. A Rust core would mean bridging to them or rewriting them.
- **The field already ran this experiment.** OpenCode shipped its desktop app on Tauri, then moved to Electron in 2026, citing slower and inconsistent WebKit rendering, slow and unreliable startup of the bundled server on Windows, and wanting the server inside Electron's Node process. T3 Code, Cursor and VS Code are Electron too.
- **Cost of the choice:** a larger download (roughly 100 MB or more against roughly 10 MB) and higher idle memory. For a tool people leave open all day next to coding agents, that is acceptable.
- **Rust stays available** for a specific hot path later (file indexing, for example) as a native module. Nothing in the first phases needs it.

Mobile and web later are not a reason to pick Tauri. Because the engine and the client are separate, a web app and a mobile companion are additional clients of the same contract, connecting to the engine on the user's machine through a relay. That is how T3 Code does its iOS, Android and web apps.

## Shape of the system

```
apps/desktop   Electron shell: window, browser views, updater, starts the engine
apps/engine    Node process: projects, threads, agent sessions, git, terminals,
               SQLite, project intelligence. Serves a WebSocket RPC.
apps/ide       React client (Vite, Tailwind 4, shadcn). Talks only to the engine.
packages/contracts   zod schemas for every RPC method and event
packages/ui          Arcex design tokens and shared components
```

Unchanged: `src/` (the Cloudflare Worker platform), `apps/web` (Radar web app), `packages/mcp`, `migrations/`.

Rules that keep later platforms cheap:

1. The client never touches the filesystem, git or agent processes. It asks the engine.
2. The engine never assumes a desktop window exists.
3. Everything crossing the boundary is defined in `packages/contracts`.

### Data model, with project intelligence at the centre

SQLite file per user, owned by the engine. Core tables: `projects`, `goals`, `milestones`, `threads`, `turns`, `events`, `evidence`, `decisions`, `memories`.

The `events` table is an append-only record of what happened: agent messages, tool calls, file changes, permission decisions, commits, test and build results. `evidence` rows point at events that prove something (a passing test run, a successful build). Milestone status is derived, never typed in by a model:

- **Verified:** linked to evidence.
- **Reported:** an agent said so, no evidence yet.
- **Blocked:** a known failure or unmet dependency.
- **Planned:** agreed, not started.

This is the reason not to fork: the evidence layer has to be in the engine's core model, not bolted onto someone else's orchestrator.

### Background intelligence

An event-driven service in the engine. It wakes on turn end, commit, test or build result, and thread close. It writes structured output only (thread recap, proposed memories, proposed milestone changes), which the user can inspect, edit and delete. It sits behind one interface with three implementations, in this order:

1. A cheap model run through an agent the user is already signed into. No new keys, no cost to Arcex.
2. A local model through Ollama or llama.cpp, optional download.
3. Off. The ADE works fully without it.

## What we bring in instead of building

| Need | Bring in | Notes |
| --- | --- | --- |
| Agent providers | `@agentclientprotocol/sdk` as client | One integration covers Claude (`claude-agent-acp`), Codex (`codex-acp`), Gemini CLI, OpenCode, Cursor, Copilot and about 50 others |
| Agent install and discovery | ACP agent registry | Lists installable agents |
| Sessions, streaming, tool calls, permission prompts, diffs | ACP | Defined by the protocol |
| Connectors | `@modelcontextprotocol/sdk` (already in this repo) | Engine passes MCP servers to agents through ACP |
| Terminal | xterm.js and node-pty | |
| Diff and file view | Monaco diff editor | |
| Chat rendering | A markdown renderer and Shiki | |
| Git and worktrees | The git CLI | One worktree per thread, optional |
| Checkpoints and undo | Hidden git refs | T3 Code's approach, MIT licensed; reimplement the idea |
| Storage | SQLite | |
| Installer and updates | electron-builder and electron-updater | Windows NSIS installer |
| UI kit | shadcn, Tailwind 4, Geist, the tokens in `apps/web/src/index.css` | Already in this repo |
| Arcex research data | The existing hosted MCP at `/public/mcp` | Later Explore panel, no new backend |

What we write ourselves: the engine (thread and session orchestration, event log), the project intelligence layer, the client UI, the browser pane and its agent tools.

Each provider sits behind a small adapter interface in the engine. ACP is the default implementation. If the ACP route for one provider turns out to lag its native features, that provider can get a native adapter without touching anything else.

### Provider sign-in

Arcex never handles provider credentials. Each agent runs as its vendor's unmodified CLI, signed in by the user through the vendor's own flow. This matches Anthropic's published rules: third parties may not offer Claude.ai login or route requests through subscription credentials, but an end user may sign in to the unmodified Claude Code binary with their own subscription. One thing to verify in the spike: reports from mid 2026 say Agent SDK usage on a subscription draws from a separate credit pool, and the Claude ACP adapter is built on that SDK.

## Look and feel

Light mode first. Cream paper with fine grain, large soft curved planes in greige shadow, the solid black pinwheel mark, Geist type, no accent colour beyond warm neutrals. The grain and curved planes go on the window chrome, sidebar, empty states and onboarding. Reading surfaces (chat, diffs, terminal) stay flat and quiet so long sessions are comfortable.

The dark tokens already exist in `apps/web/src/index.css` with a hook for a light theme. Move them into `packages/ui`, add the cream values, and have both the ADE and the web app read from there. Dark mode follows once light is right.

Needed asset: a vector version of the mark for the app icon. The repo only has PNGs.

## Product principles (Finlay, November 10, 2026)

- **For vibe coders, not developers.** Terminal, git, worktrees and provider CLIs run underneath and stay out of sight by default. Each is available as an opt-in view. The default surface is threads and the project.
- **Many threads at once.** An optional tiled view shows several threads side by side (around six), resizing to fit the window, so parallel agents can be watched together. The single-thread view stays the default.
- **Voice control** is a planned input, so thread actions must be addressable by command, not only by pointer.
- **The UI gets designed before it gets built.** It should not resemble T3 Code, Codex or Cursor, and it must use the Arcex aesthetic as a system, not paste the banner artwork onto a standard layout.

## Phases

**UI design track (starts alongside Phase 0, finishes before Phase 2).** Layout model, the tiled multi-thread view, how hidden developer surfaces are revealed, the project overview, and the light theme, worked out as mockups and approved before any production UI is written. Phase 0 and Phase 1 use throwaway UI and do not wait on it.

**Phase 0. Spike (prove the provider path).** Electron shell, engine, ACP client. One project, one Claude thread and one Codex thread, both streaming, with permission prompts and file diffs showing. Throwaway UI. Also answers the subscription credit question above. If ACP falls short for either provider, we learn it here.

**Phase 1. The critical prototype.** Create a project with a goal. Run two threads on different providers doing real work. Close both. Reopen the project and check that Arcex correctly shows what each agent changed, which milestones are verified, what is unresolved, and the context a new thread needs to continue. This is the differentiator, so it is tested before polish.

**Phase 2. A daily-driver workspace.** Project sidebar, thread view, diff review, terminal, worktrees, checkpoints, the cream theme, the browser pane with live preview, element picking, screenshots and console errors, and a Windows installer with updates.

**Phase 3. Compass and guided building.** Thread recaps on hover, the compact project overview above the workspace, memory inspection and editing, curated MCP connectors with visible permissions, Build Kits, and the Explore panel backed by the existing Arcex data.

**Phase 4. Expansion.** Dark mode, macOS build, local model option, web and mobile clients through a relay, paid sync.

## Spike results (November 10, 2026)

Run it with `pnpm --filter @arcex/desktop dev`. Drive it without a window with `tsx apps/engine/scripts/spike.ts <project folder>` against a running engine.

- **Works: shell and Codex.** The Electron window starts the engine and loads its UI. Codex, through `@agentclientprotocol/codex-acp`, made a real file edit and answered a follow-up in the same thread, on Windows, using the existing Codex sign-in. Streaming text and tool call status arrive as ACP updates.
- **Works: Claude.** After a one-time `claude auth login`, a Claude thread through `@agentclientprotocol/claude-agent-acp` edited a file in the same project while the Codex thread was running. Its edits arrive as structured diffs (path, old text, new text).
- **Claude usage:** updates report the subscription five-hour limit and its utilization, with overage off, so usage counted against the Pro plan limit in this run, not a separate pay-per-use balance. One tiny edit loaded about 40,000 tokens of context. This is one observation, not a statement of Anthropic policy.
- **Not yet exercised:** permission prompts. Claude ran in the auto mode set in the local Claude settings and Codex edited without asking. The engine needs to set each agent to an ask-first mode and the prompt flow needs a test. Codex wrote its file through a shell command, so it sent no structured diff; the engine will need to derive Codex changes from git.
- **Lesson:** the Claude adapter moved from `@zed-industries/claude-agent-acp` (deprecated, rejected a current settings value) to `@agentclientprotocol/claude-agent-acp`. Adapter versions need pinning and a regular update check.
- **For the product:** agents show raw shell commands as tool call titles. The client must translate these into plain language for this audience, and "Authentication required" must become a guided sign-in step.

## Build status (November 10, 2026)

The spike UI is gone. The real pieces now exist:

- `packages/contracts`: the typed requests and events between engine and client.
- `apps/engine`: projects, threads and timelines saved in SQLite (`%APPDATA%/Arcex/arcex.db`, or `ARCEX_DATA_DIR`). Agent tool calls are turned into plain-language steps with the raw detail kept alongside. Approval requests, a git-based list of changes, and reopening a saved agent conversation after a restart are in.
- `apps/ide`: the React client in the approved design, with Start, Focus and Board on live data, the changes drawer, and a preview pane that shows an address you give it.
- `apps/desktop`: loads the client the engine serves and adds a native folder picker.

Run it: `pnpm --filter @arcex/ide build`, then `pnpm --filter @arcex/desktop dev`.

Checked by hand with real agents: creating a project from an existing folder, a Claude thread and a Codex thread running at once, both views updating live, the changes drawer showing real diffs, and Claude recalling its earlier work after an engine restart.

Not built yet: goals broken into milestones and the evidence behind them (the Compass), thread recaps, voice, the embedded browser with element picking (the preview is a plain frame), ask-first permission modes (the approval card exists but no agent has triggered it), restore points, packaging and updates.

## Decisions and risks to settle

- **Repository.** Build here now. The ADE is meant to be open source and this repo holds the private platform, so the ADE folders get split into a public repo before release. They are kept self-contained to make that a clean cut.
- **`AGENTS.md` is out of date.** It says the ADE is retired, the scope is backend only, and no desktop fork. It needs rewriting when this plan is approved.
- **Windows code signing.** Unsigned installers trigger SmartScreen warnings. Signing costs money (a certificate or a monthly signing service). Not needed until public release.
- **Competition.** Cursor Projects and T3 Code cover parts of this. The plan's bet is the evidence-backed project state across providers, which is why Phase 1 comes before polish.
- **ACP coverage.** Adapters can trail native features such as newer permission modes or subagents. The adapter interface is the mitigation.

## Verification per phase

- Phase 0: both providers complete a real edit in the same project from the app, on Windows, signed in through their own CLIs.
- Phase 1: the reopen test above, judged against the actual git history and test results of the project.
- Phase 2 onward: use Arcex to build Arcex.

## Sources

- T3 Code repository and internals: https://github.com/pingdotgg/t3code
- ACP agents list: https://agentclientprotocol.com/overview/agents
- ACP TypeScript SDK: https://agentclientprotocol.com/libraries/typescript
- OpenCode's move to Electron: https://dev.to/brendonovich/moving-opencode-desktop-to-electron-4hip
- Anthropic's rules on Claude Code in other products: https://code.claude.com/docs/en/legal-and-compliance
