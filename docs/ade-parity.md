# Arcex ADE parity tracker

This file is the running ledger for one goal. Any agent picking up the work starts here, works the next open item, and updates this file in the same commit as the code.

## The goal (Finlay, November 21, 2026)

Bring the Arcex ADE up to the Claude desktop app (Code tab) and the Codex app in UX, styling, features, functionality, agent harness and agent instructions. Finlay wants near-exact feature parity first. Once he has validated it, the next step is a next-generation Arcex built on that base. He does not want to report each gap by hand. Find the gaps yourself from the references below, then close them.

Rules that still apply (from AGENTS.md and Finlay's standing decisions):

- **Match behaviour and features, keep Arcex's own look.** Arcex keeps its dark monochrome look: near-black surfaces, white ink, one green status colour, silver curved light art on empty screens only, and no blue or glow. Do not fork T3 Code or copy its UI or code. Read it to learn how things work underneath.
- **Vibe coders are the audience.** Terminal, git and raw CLI output stay hidden by default and are opt-in views. Where Claude or Codex shows developer detail up front, Arcex folds it one click away.
- **Credentials stay with the vendors.** Agents run as their vendor's own CLI with the user's own sign-in. Never read, store or proxy credentials.
- **Intelligence must just work.** No hidden spending of the user's agent usage, no manual model installs, nothing heavy on the machine. Ask Finlay before building background intelligence.
- **Never open visible windows on Finlay's PC during testing.** Test in the in-app browser pane with the `ade-engine` launch config (isolated data dir). Hidden Electron windows need `show: false`.
- Keep the ADE folders self-contained, with no imports from the platform `src/`. Work on `main` and push. Commits end with the Co-Authored-By line.

## References and how to study them

| Reference | Where | What to take from it |
| --- | --- | --- |
| Claude desktop app, Code tab | The app this work is done in. Its features are listed below from direct use. Finlay has asked that screen recordings stay private, so never commit or share them. | Conversation flow, tool rows, task list, wrap-up box, permission modes, plan mode, panes (diff, files, terminal, browser, tasks), sessions sidebar, git and PR flow |
| Codex app | Closed source. The Codex CLI and TUI are Apache-2.0: `git clone --depth 1 --filter=blob:none --sparse https://github.com/openai/codex` then `git -c core.longpaths=true sparse-checkout set codex-rs/tui/src codex-rs/core`. | Approval modes, question cards, voice strip, status line, slash commands, review mode, AGENTS.md handling, prompts |
| T3 Code | MIT. `git -c core.longpaths=true clone --depth 1 https://github.com/pingdotgg/t3code`. Clone into a scratch folder, never into this repo. | How a full ADE is wired: `apps/web/src/components/chat` (composer, timeline, work groups, approvals, plan card, queue, rewind, find), `diffs`, `files`, `settings`, `apps/server/src/speech` (local dictation via `transcribe-cpp`) |

## Status key

`done` shipped on main and checked in the in-app browser · `partial` some of it shipped, the note says what's left · `open` not started · `decide` needs Finlay's call first

## Feature ledger

Priority: **P0** core parity people notice in the first session · **P1** expected by regular users · **P2** depth and polish.

### Conversation and progress

| ID | Feature | Claude / Codex behaviour | Pri | Status | Notes |
| --- | --- | --- | --- | --- | --- |
| C1 | Narration with folded work rows | "Ran 2 commands, edited a file ›" rows between paragraphs, opening to each step | P0 | done | `views.tsx` `WorkGroup`, `summarize` (3b216aa) |
| C2 | Live status line and loader | Shimmering current step and an animated mark | P0 | done | Arcex mark loader `shared.tsx` `Loader` (6bd6046) |
| C3 | Agent plan / task checklist | Checklist above the composer while working | P0 | done | ACP `plan` updates. Claude needs `CLAUDE_CODE_ENABLE_TODO_TOOLS` plus the prompt note in `agents.ts` |
| C4 | Question cards docked above composer | Numbered options, write-your-own, skip | P0 | partial | Docked `AskCard` shipped. Still missing: a free-text answer, Skip, and number keys to pick |
| C5 | Thinking shown folded | "Thought for 12s ›" with the reasoning inside | P0 | open | Handle ACP `agent_thought_chunk` in `engine.ts` and add a `think` item |
| C6 | Edit rows with line counts | "Edited views.tsx +96 −12 ›", opening to the diff | P0 | open | Read the diff content from `tool_call` updates (ACP `content` type `diff`) |
| C7 | Command output in rows | The command and its output, folded | P1 | open | Keep bounded `tool_call_update` content, about 4 KB per step |
| C8 | Streaming markdown polish | Code blocks with copy, tables, file links that open the file | P1 | partial | `md.tsx` is minimal |
| C9 | Copy message, retry, edit and resend | Hover actions on messages. Retry a failed turn | P0 | partial | Copy exists. Retry and edit-resend are missing |
| C10 | Rewind / checkpoints | Restore the code and conversation to an earlier message | P1 | open | Needs per-turn snapshots (a git stash or shadow-ref design) |
| C11 | Find in thread (Ctrl+F) | Find bar with next and previous | P2 | open | |
| C12 | Turn outcome and elapsed time | "Worked for 2m 14s", failed or stopped badge | P1 | open | Ties to audit item "a failed turn can look finished" |
| C13 | Subagents | Rows for subagents working, with their progress | P2 | open | |
| C14 | Wrap-up / next-step box | Recap plus buttons (commit, PR, verify) at the end of a turn | P1 | open | Arcex version: summary plus Commit, Open preview and Undo |

### Composer

| ID | Feature | Claude / Codex behaviour | Pri | Status | Notes |
| --- | --- | --- | --- | --- | --- |
| K1 | Voice dictation | Mic button, live level, transcribe into the box | P0 | done | `Dictation.tsx` plus engine `speech.ts` (`transcribe-cpp`, Parakeet 110M, 135 MB on first press, checksum verified, unloads after 10 idle min). Streams 1 s chunks over the WebSocket. Enter finishes, Esc discards. Later: a keyboard shortcut, a bigger-model choice in Settings, dictation in the new-project box |
| K2 | Image and file attachments | Paste or drop images and files, thumbnails, sent to the agent | P0 | open | ACP prompt `image` and `resource_link` blocks, checked against `promptCapabilities` |
| K3 | @-mention files | `@` opens a fuzzy file picker and inserts a chip | P0 | open | `project.files` exists. Add a search request |
| K4 | Slash commands and skills | `/` menu from the agent's commands | P0 | open | ACP `available_commands_update` |
| K5 | Queue while working | Ctrl+Enter queues the next message, shown above the box, editable | P0 | open | |
| K6 | Permission / approval mode picker | Ask before edits · Auto-accept edits · Plan mode · Full access (Codex: read-only, auto, full) | P0 | open | ACP session modes (`current_mode_update`, `session/set_mode`). Pick friendly names for vibe coders |
| K7 | Reasoning effort / speed | Effort picker (low to max), fast mode | P1 | open | ACP session config options. The adapter exposes effort |
| K8 | Prompt history | Up arrow recalls earlier prompts | P2 | open | |
| K9 | Context and usage meter | Context % used, plan usage limits | P1 | open | ACP `usage_update` |
| K10 | Stop and steer | Stop. Sending while working steers or queues | P0 | partial | Stop exists. Steering is missing |

### Approvals and safety

| ID | Feature | Behaviour | Pri | Status | Notes |
| --- | --- | --- | --- | --- | --- |
| A1 | Approval cards | Allow once, Always allow, Deny, with the exact command or diff | P0 | partial | Card exists. Verify with real Claude and Codex in "ask" mode, and dock it above the composer |
| A2 | Plan mode approval | Agent proposes a plan, the user approves, then it executes | P0 | open | Claude `ExitPlanMode` arrives as a permission request with the plan |

### Review, git and shipping

| ID | Feature | Behaviour | Pri | Status | Notes |
| --- | --- | --- | --- | --- | --- |
| G1 | Diff pane | Changes +N −M per file, unified diff, per-turn and whole-branch views | P0 | partial | Changes list and diff exist (`project.diff`). Still missing: counts, per-turn scope and a better viewer |
| G2 | Inline review comments | Comment on a diff line and send it to the agent | P1 | open | |
| G3 | Commit, push and PR from the app | Buttons with a generated message, PR status and CI | P1 | open | Hidden by default for vibe coders. Show a "Save a version" button |
| G4 | Worktree per thread | Isolated working copies so parallel threads don't collide | P1 | decide | Ask Finlay. It's a big model change for vibe coders |
| G5 | Revert / undo a turn's changes | Undo a file or a whole turn | P1 | open | Pairs with C10 |
| G6 | Open in editor | Open the project or a file in VS Code, Cursor or Explorer | P1 | open | Desktop `shell.openPath` |

### Panes and layout

| ID | Feature | Behaviour | Pri | Status | Notes |
| --- | --- | --- | --- | --- | --- |
| P1 | Browser / preview pane with agent control | Preview with dev server start and agent browsing tools | P0 | done | a885e7a. Still missing: start the dev server from project config |
| P2 | File viewer | Click a file in the tree to read it, with syntax highlighting | P1 | open | Audit: file rows are static |
| P3 | Terminal pane (opt-in) | A real shell per project, hidden by default | P1 | open | node-pty or ConPTY in the engine. Opt-in only |
| P4 | Resizable and expandable panels | Drag to resize, expand a pane, split view | P1 | open | Audit: widths compete at 1100 px |
| P5 | Tasks / background processes pane | Running background commands with timers | P2 | open | |

### Sidebar and sessions

| ID | Feature | Behaviour | Pri | Status | Notes |
| --- | --- | --- | --- | --- | --- |
| S1 | Thread status in sidebar | Spinner while working, dot when unread, needs-you badge | P0 | partial | Loader in recent activity. Unread dots are missing |
| S2 | Rename, pin, archive and delete threads | Context menu and inline rename | P1 | partial | Archive and remove exist. Check rename and pin |
| S3 | Search threads | Search titles and transcripts | P1 | partial | Titles only |
| S4 | Notifications | Desktop notification when a thread finishes or needs you | P1 | partial | Exists. Audit says failures can read "Finished" |
| S5 | Keyboard shortcuts | New thread, switch thread, focus composer, toggle panes, with a cheat sheet | P1 | partial | |

### Agent harness and instructions

| ID | Feature | Behaviour | Pri | Status | Notes |
| --- | --- | --- | --- | --- | --- |
| H1 | Project instructions | AGENTS.md / CLAUDE.md respected and editable from the app | P1 | open | The vendor CLIs already read them. Add an editor in project settings |
| H2 | Arcex system prompt note | Tell agents about Arcex's UI (plan, browser tools, no terminal for the user) | P0 | partial | Claude gets `PLAN_NOTE` via `_meta.systemPrompt.append`. Codex needs the equivalent (AGENTS.md or config instructions) |
| H3 | MCP connectors | Add MCP servers per project or globally | P1 | partial | Toolbox plus the Arcex connector |
| H4 | Model list per agent | Live models from each agent | P0 | done | `agents.models` |
| H5 | Session resume across restarts | Reopen a thread and continue the same agent session | P0 | done | `session/load` |

### Settings and polish

| ID | Feature | Behaviour | Pri | Status | Notes |
| --- | --- | --- | --- | --- | --- |
| X1 | Settings sections | General, Agents, Voice, Notifications, Shortcuts, Projects, Archived, About | P1 | partial | |
| X2 | Light theme | Light and dark | P2 | partial | Check `sun` and `moon` |
| X3 | Accessibility | Keyboard paths, focus and contrast from the November 17 audit | P1 | open | See `ade-ux-audit-2026-11-17.md` |

## Work log

Newest first. One line per shipped change, with its commit.

- 2026-11-21 · K1 local voice dictation in the message box.
- 2026-11-21 · Arcex mark loader replaces the spinner (6bd6046).
- 2026-11-21 · Conversation rebuilt: narration, folded work rows, docked plan and ask, Claude task tools on (3b216aa).
- 2026-11-21 · Agents can drive the Browser tab (a885e7a).

## Next up

Work these in order unless Finlay redirects:

1. C5 thinking, C6 edit counts, C7 command output: engine update handling plus rows.
3. K6 permission modes and A2 plan approval.
4. K2 attachments, K3 @-mentions, K4 slash commands, K5 queue.
5. G1 diff pane upgrade, C9 retry and edit-resend, C12 turn outcome.

## How to verify a change

- `pnpm -C apps/ide exec tsc --noEmit -p .`, `pnpm -C apps/engine exec tsc --noEmit -p .`, and `pnpm -C apps/ide build`.
- Start the `ade-engine` launch config in the in-app browser pane. It uses an isolated data dir and serves the built IDE on port 4517. Run a short real prompt with Claude Haiku in "Smoke test project" and check the change on screen.
- Restart the `ade-engine` preview after engine changes. IDE changes need only a rebuild and reload.
