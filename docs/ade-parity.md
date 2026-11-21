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

## Handoff: start here

State on November 21, 2026, at commit `5b850fb` on `main`. Everything listed as done is pushed. The working tree is clean apart from `.claude/` and `branding-concepts/`, which stay untracked on purpose.

**Where things live**

- `packages/contracts/src/index.ts`: the only boundary between the engine and the client: types, requests and events. Change it first.
- `apps/engine/src/engine.ts`: request handlers, ACP session updates turned into timeline items (`say`, `step`, `think`, `plan`, `ask`, `result`, `end`), the message queue, and the approval flow (`onPermission`).
- `apps/engine/src/agents.ts`: starts each agent's ACP adapter, opens or reloads the session, reads models, config options (mode, effort, fast) and slash commands. `PLAN_NOTE` is Arcex's system prompt note to Claude.
- `apps/engine/src/db.ts`: SQLite. Threads hold `choices` and `queued` as JSON text.
- `apps/engine/src/speech.ts`: local dictation (transcribe-cpp plus Parakeet, downloaded once with a checksum).
- `apps/ide/src/views.tsx`: conversation, turns, work rows, docked plan, ask card, queue and composer. Also `ModelPicker.tsx` (model, mode and effort chips, and the shared agent cache), `SlashMenu.tsx`, `Dictation.tsx`, `store.ts` (client state and events), `ui.css` and `sprite.svg` (icons).

**What's true about the agents**

- Claude runs through `@agentclientprotocol/claude-agent-acp` and Codex through `@agentclientprotocol/codex-acp`, each with the user's own CLI sign-in.
- Claude's task tools only appear with env `CLAUDE_CODE_ENABLE_TODO_TOOLS=true` plus the prompt note. Both are already set.
- Both adapters report modes and effort as ACP `configOptions`, set with `session/set_config_option`. Claude sends its slash commands (`available_commands_update`) just after a session opens.

**Unverified or known gaps** (fix or verify before calling parity done)

- C5: thinking never seen live.
- A1: the Manual and Read-only approval paths, with Claude and Codex.
- K4: a picked slash command actually running, and Codex's list.
- K6: mode and effort picks reset for new threads after a restart.
- New files show +0 −0 in the Details changes list (G1).
- Nothing has been run with Codex in this stretch.

**Finlay's running copy** gets new builds when he presses Update in Arcex, and only when no thread is working. Tell him in each summary when there is something to update.

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
| C5 | Thinking shown folded | "Thought for 12s ›" with the reasoning inside | P0 | partial | Engine `think` item (from ACP `agent_thought_chunk`) and the folded row are shipped. Never seen live: Claude Haiku sent no thought chunks even at High effort. Find out whether the Claude adapter or SDK needs a setting to stream thinking summaries, then verify with Sonnet or Opus |
| C6 | Edit rows with line counts | "Edited views.tsx +96 −12 ›", opening to the diff | P0 | done | Line counts from ACP `diff` content, a "Show the change" patch view, +N −M on the group row |
| C7 | Command output in rows | The command and its output, folded | P1 | done | Last 4 KB of output under "Show the output" |
| C8 | Streaming markdown polish | Code blocks with copy, tables, file links that open the file | P1 | partial | `md.tsx` is minimal |
| C9 | Copy message, retry, edit and resend | Hover actions on messages. Retry a failed turn | P0 | partial | Copy exists. Retry and edit-resend are missing |
| C10 | Rewind / checkpoints | Restore the code and conversation to an earlier message | P1 | open | Needs per-turn snapshots (a git stash or shadow-ref design) |
| C11 | Find in thread (Ctrl+F) | Find bar with next and previous | P2 | open | |
| C12 | Turn outcome and elapsed time | "Worked for 2m 14s", failed or stopped badge | P1 | done | An `end` item closes every turn: "Worked for 1m 5s" or "Stopped after 25s" |
| C13 | Subagents | Rows for subagents working, with their progress | P2 | open | |
| C14 | Wrap-up / next-step box | Recap plus buttons (commit, PR, verify) at the end of a turn | P1 | open | Arcex version: summary plus Commit, Open preview and Undo |

### Composer

| ID | Feature | Claude / Codex behaviour | Pri | Status | Notes |
| --- | --- | --- | --- | --- | --- |
| K1 | Voice dictation | Mic button, live level, transcribe into the box | P0 | done | `Dictation.tsx` plus engine `speech.ts` (`transcribe-cpp`, Parakeet 110M, 135 MB on first press, checksum verified, unloads after 10 idle min). Streams 1 s chunks over the WebSocket. Enter finishes, Esc discards. Later: a keyboard shortcut, a bigger-model choice in Settings, dictation in the new-project box |
| K2 | Image and file attachments | Paste or drop images and files, thumbnails, sent to the agent | P0 | open | ACP prompt `image` and `resource_link` blocks, checked against `promptCapabilities` |
| K3 | @-mention files | `@` opens a fuzzy file picker and inserts a chip | P0 | open | `project.files` exists. Add a search request |
| K4 | Slash commands and skills | `/` menu from the agent's own commands and skills, ranked by name then word match; arrows, Enter or Tab, Esc | P0 | partial | Menu verified with Claude. Not yet checked: a command run end to end, Codex's list, project-only skills (the list is read in the data folder, then replaced by what a thread reports) |
| K5 | Queue while working | Enter while the agent works queues the message above the box (edit or remove); the next one sends when the turn finishes cleanly. Kept in the engine, so it survives reloads | P0 | done | Stops and failures leave the queue waiting |
| K6 | Permission / approval mode picker | Ask before edits · Auto-accept edits · Plan mode · Full access (Codex: read-only, auto, full) | P0 | done | Generic ACP config options (`AgentChoices` in `ModelPicker.tsx`). Mode chip uses the agent's own names (Claude: Manual, Accept edits, Plan, Auto, Bypass; Codex: Read-only, Workspace access, Auto review, Full access). Changeable mid-turn; the thread follows mode changes the agent makes itself. Still to do: remember the last picks for new threads across restarts |
| K7 | Reasoning effort / speed | Effort picker (low to max), fast mode | P1 | done | Effort chip with levels plus switches for fast mode and Codex plan-first. The user's pick is set again at each turn start, because the Claude adapter resets effort on a model switch |
| K8 | Prompt history | Up arrow recalls earlier prompts | P2 | open | |
| K9 | Context and usage meter | Context % used, plan usage limits | P1 | open | ACP `usage_update` |
| K10 | Stop and steer | Stop. Sending while working steers or queues | P0 | partial | Stop exists, and sending while working queues (K5). Steering (inject into the running turn) is missing |

### Approvals and safety

| ID | Feature | Behaviour | Pri | Status | Notes |
| --- | --- | --- | --- | --- | --- |
| A1 | Approval cards | Allow once, Always allow, Deny, with the exact command or diff | P0 | partial | Docked above the composer and shows the diff, command or plan as `body`. Still to verify with real Claude in Manual mode and Codex in Read-only |
| A2 | Plan mode approval | Agent proposes a plan, the user approves, then it executes | P0 | done | Claude `ExitPlanMode` arrives as a permission request with `rawInput.plan`; the card reads "Here's the plan. Go ahead?" with Claude's own options. Verified: approving into Auto moves the mode chip to Auto |

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

- 2026-11-21 · K4 slash command menu in the message box, from the agent's reported commands.
- 2026-11-21 · K5 queue while working: queued messages sit above the box and send in order when a turn finishes.
- 2026-11-21 · K6 mode, K7 effort and fast, A2 plan approval with the plan shown. Files outside the project (an agent's own plan notes) no longer count as changed.
- 2026-11-21 · C6, C7 and C12 shipped: edit line counts with patches, command output and turn duration. C5 thinking rendering is in.
- 2026-11-21 · K1 local voice dictation in the message box.
- 2026-11-21 · Arcex mark loader replaces the spinner (6bd6046).
- 2026-11-21 · Conversation rebuilt: narration, folded work rows, docked plan and ask, Claude task tools on (3b216aa).
- 2026-11-21 · Agents can drive the Browser tab (a885e7a).

## Next up

Work these in order unless Finlay redirects:

1. K2 image and file attachments (paste, drop, thumbnails; ACP `image` and `resource_link` blocks, checked against the agent's `promptCapabilities`).
2. K3 @-mention files (a `project.search` request in the engine, a fuzzy picker like `SlashMenu.tsx`).
3. Verify K4 end to end, plus A1 in Manual mode with Claude and Read-only with Codex.
4. G1 diff pane upgrade (counts for new files, per-turn scope) and C9 retry and edit-resend.
5. C5 thinking stream, then remember K6 and K7 picks for new threads across restarts.
6. C4 free-text answer, Skip and number keys in question cards; S1 unread dots; C14 wrap-up box.
7. Then the P1 items: C10/G5 rewind and undo, G3 "Save a version", P2 file viewer, P3 opt-in terminal, K9 usage meter, H1 instructions editor, H2 Codex instructions.

G4 (worktree per thread) needs Finlay's decision before any work.

## How to verify a change

- `pnpm -C apps/ide exec tsc --noEmit -p .`, `pnpm -C apps/engine exec tsc --noEmit -p .`, and `pnpm -C apps/ide build`.
- Start the `ade-engine` launch config in the in-app browser pane. It uses an isolated data dir and serves the built IDE on port 4517. Run a short real prompt with Claude Haiku in "Smoke test project" and check the change on screen.
- Use the smoke project at `C:\Users\finla\Arcex Projects\smoke-test-project` and delete any test files the agent makes there. Clear test text from the message box afterwards, so it is never sent with a later prompt.
- Restart the `ade-engine` preview after engine changes. IDE changes need only a rebuild and reload.
