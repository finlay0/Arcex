# Arcex ADE parity tracker

This file is the running ledger for one goal. Any agent picking up the work starts here, works the next open item, and updates this file in the same commit as the code.

## The goal (Finlay, November 21, 2026)

Bring the Arcex ADE up to the Claude desktop app (Code tab) and the Codex app in UX, styling, features, functionality, agent harness and agent instructions. Finlay wants near-exact feature parity first. Once he has validated it, the next step is a next-generation Arcex built on that base. He does not want to report each gap by hand. Find the gaps yourself from the references below, then close them.

Rules that still apply (from AGENTS.md and Finlay's standing decisions):

- **Match behaviour and features, keep Arcex's own look.** Arcex keeps its dark monochrome look: near-black surfaces, white ink, one green status colour, silver curved light art on empty screens only, and no blue or glow. Do not fork T3 Code or copy its UI or code. Read it to learn how things work underneath.
- **Vibe coders are the audience.** Terminal, git and raw CLI output stay hidden by default and are opt-in views. Where Claude or Codex shows developer detail up front, Arcex folds it one click away.
- **Credentials stay with the vendors.** Agents run as their vendor's own CLI with the user's own sign-in. Never read, store or proxy credentials.
- **Agents always run with full access** (Finlay, November 21, 2026). No approval modes and no mode picker: Claude runs in "Bypass permissions" and Codex in "Full access" on every model. The engine enforces it at each turn start and when an agent changes mode itself (`modeFor` and `followChoices` in `engine.ts`). The only other mode kept is planning first, offered as a "Plan first" switch. Do not build Manual, Read-only or Accept-edits paths.
- **Intelligence must just work.** No hidden spending of the user's agent usage, no manual model installs, nothing heavy on the machine. Ask Finlay before building background intelligence.
- **Never open visible windows on Finlay's PC during testing.** Test in the in-app browser pane with the `ade-engine` launch config (isolated data dir). Hidden Electron windows need `show: false`.
- Keep the ADE folders self-contained, with no imports from the platform `src/`. Work on `main` and push. Commits end with the Co-Authored-By line.

## References and how to study them

| Reference | Where | What to take from it |
| --- | --- | --- |
| Claude desktop app, Code tab | The app this work is done in. Its features are listed below from direct use. Finlay has asked that screen recordings stay private, so never commit or share them. UI and UX count toward parity as much as features: compare against live screenshots of this app taken with computer use (kept private, same rule). | Conversation flow, tool rows, task list, wrap-up box, permission modes, plan mode, panes (diff, files, terminal, browser, tasks), sessions sidebar, git and PR flow |
| Codex app | Closed source. The Codex CLI and TUI are Apache-2.0: `git clone --depth 1 --filter=blob:none --sparse https://github.com/openai/codex` then `git -c core.longpaths=true sparse-checkout set codex-rs/tui/src codex-rs/core`. | Approval modes, question cards, voice strip, status line, slash commands, review mode, AGENTS.md handling, prompts |
| T3 Code | MIT. `git -c core.longpaths=true clone --depth 1 https://github.com/pingdotgg/t3code`. Clone into a scratch folder, never into this repo. | How a full ADE is wired: `apps/web/src/components/chat` (composer, timeline, work groups, approvals, plan card, queue, rewind, find), `diffs`, `files`, `settings`, `apps/server/src/speech` (local dictation via `transcribe-cpp`) |

Study log: November 21, 2026, a pass over T3 Code `apps/web/src/components` (including `chat`) and the Codex TUI `codex-rs/tui/src` (including `bottom_pane`) added C15 to C19, K11 to K14, A3, A4, G7, G8, P6, S6 to S10, H6 to H10, X4 and X5. Repeat a pass like this whenever the "Next up" list runs short, and log it here.

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
- Codex hit its usage limit on November 21 (it resets at 10:32 PM), so full access, `$` skills, K2 and K3 are still untried with Codex.
- Plan first with Claude: the switch is shown, but a plan approved into full access has not been run since the mode menu was removed.
- C5: thinking now seen live with OpenCode. Still never seen with Claude.
- K7: effort and fast picks reset for new threads after a restart.
- New files show +0 −0 in the Details changes list (G1).
- Nothing has been run with Codex in this stretch, including K2 attachments.
- K3: not tried with Codex. Mentions stay plain text in the box (no chip yet).
- K2: a PDF or other binary file (sent as `resource_link`) is untested, and stored attachments are never pruned.

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
| C4 | Question cards docked above composer | Numbered options, write-your-own, skip | P0 | done | Arcex now tells agents it answers form questions (ACP `elicitation.form`); without that, Claude turned its AskUserQuestion tool off entirely. The agent's questions show as a card above the message box: numbered options (press 1–9), several picks where allowed, "Or type your own answer", Send answer and Skip (declines, so the agent carries on). A single one-pick question sends on the first pick. Verified November 21 with Claude Haiku: picked Blue with the 3 key, then typed "purple". URL questions are declined |
| C5 | Thinking shown folded | "Thought for 12s ›" with the reasoning inside | P0 | done | Engine `think` item (from ACP `agent_thought_chunk`) and the folded row. Current Claude models omit thinking unless asked, so Arcex starts the Claude adapter with `CLAUDE_CODE_THINKING_DISPLAY=summarized`. Verified November 21 with Claude Sonnet 5.5 ("Thought for 1s" with the summary inside) and OpenCode |
| C6 | Edit rows with line counts | "Edited views.tsx +96 −12 ›", opening to the diff | P0 | done | Line counts from ACP `diff` content, a "Show the change" patch view, +N −M on the group row |
| C7 | Command output in rows | The command and its output, folded | P1 | done | Last 4 KB of output under "Show the output" |
| C8 | Streaming markdown polish | Code blocks with copy, tables, file links that open the file | P1 | partial | `md.tsx` now uses `react-markdown` with GFM and line breaks: tables, task lists, headings, quotes, code blocks with a language label and Copy, web links that open in the browser. Raw HTML stays text and remote images are not loaded. Verified with Claude (`/context` tables, code, link, checklist). Still to do: syntax highlighting, file paths that open the file (needs P2) |
| C9 | Copy message, retry, edit and resend | Hover actions on messages. Retry a failed turn | P0 | done | Hovering your message shows Copy and "Edit and send again" (text and attached files go back in the message box). A failed, stopped or interrupted turn shows "Try again" (resends the same message and files) and "Edit message". Verified November 21 with Codex and OpenCode. Rewinding the agent's own history isn't possible over ACP, so an edit is sent as a new message |
| C10 | Rewind / checkpoints | Restore the code and conversation to an earlier message | P1 | partial | Code: per-turn snapshots and undo exist (G1, G5). Conversation: ACP can't rewind an agent's history, so a rewind would need a new session started from a summary |
| C11 | Find in thread (Ctrl+F) | Find bar with next and previous | P2 | open | |
| C12 | Turn outcome and elapsed time | "Worked for 2m 14s", failed or stopped badge | P1 | done | An `end` item closes every turn: "Worked for 1m 5s" or "Stopped after 25s" |
| C13 | Subagents | Rows for subagents working, with their progress | P2 | open | |
| C14 | Wrap-up / next-step box | Recap plus buttons (commit, PR, verify) at the end of a turn | P1 | open | Arcex version: summary plus Commit, Open preview and Undo |
| C15 | Side question | Ask a quick question beside the thread without derailing the running turn (T3 `useSideChat`, `SideThreadPane`) | P2 | open | |
| C16 | Quote part of a reply | Select text in a reply to quote it into the message box (T3 `AssistantSelectionToolbar`) | P2 | open | |
| C17 | Rich media in replies | Mermaid diagrams, math, zoomable images, rendered HTML preview (T3 `MermaidDiagram`, `MathTypeset`, `HtmlRenderDialog`) | P2 | open | Pairs with C8 |
| C18 | Context compaction | Summarise a long thread to free context, by hand or automatically (Claude `/compact`, T3 `compaction.logic`) | P1 | open | Check what each ACP adapter exposes first |
| C19 | Timeline minimap | A strip beside long threads to jump to any turn (T3 `TimelineMinimap`) | P2 | open | |

### Composer

| ID | Feature | Claude / Codex behaviour | Pri | Status | Notes |
| --- | --- | --- | --- | --- | --- |
| K1 | Voice dictation | Mic button, live level, transcribe into the box | P0 | done | `Dictation.tsx` plus engine `speech.ts` (`transcribe-cpp`, Parakeet 110M, 135 MB on first press, checksum verified, unloads after 10 idle min). Streams 1 s chunks over the WebSocket. Enter finishes, Esc discards. Later: a keyboard shortcut, a bigger-model choice in Settings, dictation in the new-project box |
| K2 | Image and file attachments | Paste or drop images and files, thumbnails, sent to the agent | P0 | done | `Attachments.tsx` (paste, drop, paperclip picker, chips with thumbnails, per draft) plus engine `attachments.ts`. Files up to 10 MB, 10 per message, copied to `<data>/attachments/<id>/<name>`. Sent as ACP `image` (PNG, JPEG, GIF, WebP), embedded `resource` for text up to 256 KB, otherwise `resource_link` to the stored copy, checked against the agent's `promptCapabilities`. Thumbnails served at `/attachments/<id>` (images only, nosniff). Queued messages keep their files. Verified with Claude Haiku: image and text file read correctly, image-only message works. Not yet: Codex, a binary file (PDF) via `resource_link`, pruning old stored files |
| K3 | @-mention files | `@` opens a fuzzy file picker and inserts a chip | P0 | done | `MentionMenu.tsx` plus engine `mentions.ts` and `project.search` (breadth-first index of up to 20,000 entries, skips build and dependency folders, kept 15 s, fuzzy ranked by name, word starts and runs). Arrows, Enter or Tab, Esc. Inserts `@path` (quoted when it has spaces) at the caret. On send, small text files (256 KB) go in whole as embedded resources, the way Claude Code includes them; folders and other files go as `resource_link`. Verified with Claude Haiku: two mentions including a quoted path, and an inlined file answered with no tool call. Inserts text, not a chip; a chip is P2 polish |
| K4 | Slash commands and skills | `/` menu from the agent's own commands and skills, ranked by name then word match; arrows, Enter or Tab, Esc | P0 | done | Verified with Claude: `/context` picked from the menu ran and returned its report. Codex lists its skills as `$name`; they now insert as `$name`, not `/$name`. Not yet: running one with Codex (usage limit), project-only skills (the list is read in the data folder, then replaced by what a thread reports) |
| K5 | Queue while working | Enter while the agent works queues the message above the box (edit or remove); the next one sends when the turn finishes cleanly. Kept in the engine, so it survives reloads | P0 | done | Stops and failures leave the queue waiting |
| K6 | Permission / approval mode picker | Ask before edits · Auto-accept edits · Plan mode · Full access | P0 | done | Replaced by Finlay's decision: always full access, no picker. Claude's plan mode is a "Plan first" switch in the effort menu, beside Codex's own plan-first switch. Existing threads in Manual mode were verified to switch to full access on their next turn |
| K7 | Reasoning effort / speed | Effort picker (low to max), fast mode | P1 | done | Effort chip with levels plus switches for fast mode and Codex plan-first. The user's pick is set again at each turn start, because the Claude adapter resets effort on a model switch. The last agent, model and options picked for a new thread are remembered across restarts (verified November 21) |
| K8 | Prompt history | Up arrow recalls earlier prompts | P2 | open | |
| K9 | Context and usage meter | Context % used, plan usage limits | P1 | open | ACP `usage_update` |
| K10 | Stop and steer | Stop. Sending while working steers or queues | P0 | partial | Stop exists, and sending while working queues (K5). Steering (inject into the running turn) is missing |
| K11 | Stash a draft | Put the current draft aside and bring it back later (T3 `ComposerStash`) | P2 | open | |
| K12 | Suggested next prompts | One-click follow-ups after a turn (T3 `usePromptSuggestion`, Claude next-step buttons) | P1 | decide | Generating them spends usage. Ask Finlay (background intelligence rule) |
| K13 | Expand an attached image | Click a thumbnail to see it full size (T3 `ExpandedImageDialog`) | P2 | open | K2 follow-up |
| K14 | Send to several models | Run one prompt on two agents or models side by side (T3 `useMultipleModelSend`) | P2 | open | |

### Approvals and safety

| ID | Feature | Behaviour | Pri | Status | Notes |
| --- | --- | --- | --- | --- | --- |
| A1 | Approval cards | Allow once, Always allow, Deny, with the exact command or diff | P0 | done | With full access they appear only for plans and for whatever an agent still asks. Verified with Claude in Manual before modes were removed: Yes wrote the file, No refused it and Claude said so. Plan cards now offer only "Yes, go ahead" (or start fresh with just the plan) and keep planning. A refused edit no longer reads "Edited +1 −0": it reads "Couldn't edit" with no line counts |
| A2 | Plan mode approval |
 Agent proposes a plan, the user approves, then it executes | P0 | done | Claude `ExitPlanMode` arrives as a permission request with `rawInput.plan`; the card reads "Here's the plan. Go ahead?" with Claude's own options. Verified: approving into Auto moves the mode chip to Auto |
| A3 | MCP input requests | Forms an MCP server asks the user to fill in mid-turn (Codex `mcp_server_elicitation`) | P2 | open | |
| A4 | Approvals across threads | One place listing every thread waiting on the user (Codex `pending_thread_approvals`, Claude "needs you") | P1 | open | Pairs with S1 |

### Review, git and shipping

| ID | Feature | Behaviour | Pri | Status | Notes |
| --- | --- | --- | --- | --- | --- |
| G1 | Diff pane | Changes +N −M per file, unified diff, per-turn and whole-branch views | P0 | partial | Changes list with +N −M per file and in total, including line counts for new files Git doesn't track yet. The diff shows old and new line numbers and a ⋯ gap where unchanged lines are skipped. Verified November 21. Per turn: Arcex snapshots the folder as a Git tree before and after each turn, with its own index file so the user's staging, branch and history are untouched, and "Changed N files +X −Y" in the conversation opens that turn's files and diffs alone, including changes made by commands. Verified November 21 with two OpenCode turns (+3 −0, then +1 −1). Skipped for folders without Git or over 50 MB of new untracked files. Two threads working in one folder at once see each other's changes. Still missing: whole-branch view |
| G2 | Inline review comments | Comment on a diff line and send it to the agent | P1 | open | |
| G3 | Commit, push and PR from the app | Buttons with a generated message, PR status and CI | P1 | open | Hidden by default for vibe coders. Show a "Save a version" button |
| G4 | Worktree per thread | Isolated working copies so parallel threads don't collide | P1 | decide | Ask Finlay. It's a big model change for vibe coders |
| G5 | Revert / undo a turn's changes | Undo a file or a whole turn | P1 | done | "Undo" beside a turn's "Changed N files" puts only that turn's files back the way they were before it (from the G1 snapshots, through a scratch index, so staging is untouched), after a confirm. Files changed again since are named and need "Undo anyway". The turn then reads "Undid N files", and the agent is told with the next message. Verified November 21: both paths, the file restored and then removed. Each file in a multi-file turn has its own Undo, and undone changes have Redo (whole turn or one file); redo also checks for later changes. Verified November 21: redo of two turns, then undo of one file out of two |
| G6 | Open in editor | Open the project or a file in VS Code, Cursor or Explorer | P1 | open | Desktop `shell.openPath` |
| G7 | Review mode | Ask the agent to review uncommitted changes or a branch and list findings (Codex `/review`, Claude code review) | P1 | open | |
| G8 | Start from a pull request | Open a thread on a PR, with its description and diff as context (T3 `PullRequestThreadDialog`) | P2 | open | Hidden by default |

### Panes and layout

| ID | Feature | Behaviour | Pri | Status | Notes |
| --- | --- | --- | --- | --- | --- |
| P1 | Browser / preview pane with agent control | Preview with dev server start and agent browsing tools | P0 | done | a885e7a. Still missing: start the dev server from project config |
| P2 | File viewer | Click a file in the tree to read it, with syntax highlighting | P1 | open | Audit: file rows are static |
| P3 | Terminal pane (opt-in) | A real shell per project, hidden by default | P1 | open | node-pty or ConPTY in the engine. Opt-in only |
| P4 | Resizable and expandable panels | Drag to resize, expand a pane, split view | P1 | open | Audit: widths compete at 1100 px |
| P5 | Tasks / background processes pane | Running background commands with timers | P2 | open | |
| P6 | Project scripts as buttons | Run dev, test or build with one click, from package.json or the user's own list (T3 `ProjectScriptsControl`) | P1 | open | Ties into P1 starting the dev server |

### Sidebar and sessions

| ID | Feature | Behaviour | Pri | Status | Notes |
| --- | --- | --- | --- | --- | --- |
| S1 | Thread status in sidebar | Spinner while working, dot when unread, needs-you badge | P0 | done | Working, needs-you and failed dots in the sidebar. A thread that moves on while you're in another one turns bold with a white dot until you open it (last-seen times kept per thread on this computer). Verified November 21 |
| S2 | Rename, pin, archive and delete threads | Context menu and inline rename | P1 | partial | Archive and remove exist. Check rename and pin |
| S3 | Search threads | Search titles and transcripts | P1 | partial | Titles only |
| S4 | Notifications | Desktop notification when a thread finishes or needs you | P1 | partial | Exists. Audit says failures can read "Finished" |
| S5 | Keyboard shortcuts | New thread, switch thread, focus composer, toggle panes, with a cheat sheet | P1 | partial | |
| S6 | Command palette | Ctrl+K to jump to any thread, project, setting or action (T3 `CommandPalette`) | P1 | partial | Ctrl+K finds active thread titles today. Add actions, projects and settings |
| S7 | Thread titles that fit | Titles written from the conversation, renamed as it develops (T3 title regeneration) | P1 | decide | `titleFrom` is a stopgap. A model call spends usage: ask Finlay |
| S8 | Pin and snooze | Pin projects and threads; snooze a thread until later (T3 `ProjectPinButton`, `Sidebar.snooze`) | P2 | open | |
| S9 | Parallel sessions with linked status | Start a side session for separate work and see its state from the parent (Claude side sessions) | P2 | open | Depends on G4 |
| S10 | Follow from another device | Watch and answer a thread from a phone (Claude Remote Control, T3 device pairing) | P2 | decide | Large. Ask Finlay |

### Agent harness and instructions

| ID | Feature | Behaviour | Pri | Status | Notes |
| --- | --- | --- | --- | --- | --- |
| H1 | Project instructions | AGENTS.md / CLAUDE.md respected and editable from the app | P1 | open | The vendor CLIs already read them. Add an editor in project settings |
| H2 | Arcex system prompt note | Tell agents about Arcex's UI (plan, browser tools, no terminal for the user) | P0 | partial | Claude gets `PLAN_NOTE` via `_meta.systemPrompt.append`. Codex needs the equivalent (AGENTS.md or config instructions) |
| H3 | MCP connectors | Add MCP servers per project or globally | P1 | partial | Toolbox plus the Arcex connector |
| H4 | Model list per agent | Live models from each agent | P0 | done | `agents.models` |
| H5 | Session resume across restarts | Reopen a thread and continue the same agent session | P0 | done | `session/load` |
| H6 | Skills and hooks manager | See, turn on or off and add skills and hooks per project (Codex `skills_toggle_view`, `hooks_browser`) | P1 | open | |
| H7 | Agent memory | View and edit what the agent remembers across sessions (Codex `memories_settings_view`, Claude memory) | P2 | open | |
| H8 | Extra folders | Let a thread read and write a second folder (Codex `additional_dirs`, Claude added directories) | P2 | open | |
| H9 | Agent CLI updates | Notice when Claude or Codex has an update and offer it (T3 `ProviderUpdatesAction`) | P1 | open | |
| H10 | Scheduled and recurring runs | Run a prompt on a schedule (Claude routines and `/loop`, T3 `ThreadAutomationsPanel`) | P2 | decide | Spends usage unattended. Ask Finlay |

### Agents and model makers

Finlay, November 21, 2026: Arcex must work with every major model maker, not only Claude and Codex. Each one still runs as its maker's own CLI (or an open agent like OpenCode) with the user's own sign-in.

| ID | Feature | Behaviour | Pri | Status | Notes |
| --- | --- | --- | --- | --- | --- |
| M1 | Gemini (Google) | Gemini CLI as a built-in agent: models, sign-in status, full access ("yolo"), attachments, mentions | P0 | partial | Arcex now sees that Gemini needs sign-in and offers Gemini's own "Log in with Google" in Settings › Agents (ACP `authenticate`; the API key, Vertex and gateway methods are left out because they would need Arcex to handle a secret). Not pressed in testing, because it opens the browser on Finlay's PC. Nothing run through Gemini yet |
| M2 | OpenCode for everyone else | One open agent that reaches OpenAI, Anthropic, Google, xAI, DeepSeek, Mistral, Groq, OpenRouter and local models | P0 | partial | Verified November 21 with its default free model: ready with no sign-in, read an @-mentioned file, wrote a file with no approval (its "build" mode counts as full access), and showed folded thinking. Its free model can't see images and said so. Its edits carry no diff, so no line counts. Settings › Agents › OpenCode › Other model makers: "Connect a provider" opens a terminal with OpenCode's own provider picker (`opencode auth login`; OpenCode keeps the sign-in), and "Refresh models" asks OpenCode again (verified: 11 models). Not pressed in testing, since it opens a window on Finlay's PC, so a real provider and the grouped list are unverified |
| M3 | More makers' own agents | Built-ins for other ACP agents, such as Qwen Code (Alibaba), GitHub Copilot CLI, Cursor's agent, Goose and Kimi (Moonshot) | P1 | partial | Settings › Agents › Agent directory lists the official ACP registry (46 agents, cached for a day), with the makers' own agents first and their icons. Adding one stores its npx/uvx command at the pinned version, or downloads its Windows build over HTTPS, checks the registry's checksum and unpacks it into Arcex's data folder. Verified November 21: GitHub Copilot added, Ready with the existing GitHub sign-in, wrote a file with no approval card (its autopilot mode and allow_all switch are turned on). Copilot reports no model list over ACP, so it shows Default model. Binary (download) installs and uvx agents are untested |
| M4 | Agent setup that just works | For every agent: installed or not, signed in or not, the one command to install or sign in, and a retry | P0 | partial | Agents without a status command (Gemini, OpenCode, any added agent) are asked directly: Arcex opens a session without sending anything, and "auth required" means sign-in is needed. The agent's own sign-in methods show as buttons. Sign-ins that only work in a terminal get an "Open a terminal" button that runs the maker's fixed sign-in command (Windows console; macOS Terminal and Linux untested), with the command to copy as well. Verified: OpenCode Ready, Gemini "Sign in needed" with "Log in with Google" |
| M5 | Models grouped by maker | The model picker groups by maker (OpenCode exposes many) with search | P1 | done | Models whose ids carry a provider prefix ("anthropic/…", "openai/…") are grouped under the maker's name when an agent offers more than one maker; the filter matches maker names too. The redundant "OpenCode/" prefix is dropped from names. Verified November 21 with OpenCode's free list (one maker, so no groups); a mixed list waits on OpenCode provider sign-in (M2) |

### Settings and polish

| ID | Feature | Behaviour | Pri | Status | Notes |
| --- | --- | --- | --- | --- | --- |
| X1 | Settings sections | General, Agents, Voice, Notifications, Shortcuts, Projects, Archived, About | P1 | partial | |
| X2 | Light theme | Light and dark | P2 | partial | Check `sun` and `moon` |
| X3 | Accessibility | Keyboard paths, focus and contrast from the November 17 audit | P1 | open | See `ade-ux-audit-2026-11-17.md` |
| X4 | Send feedback | Report a problem with the thread attached (Codex `feedback_view`) | P2 | open | |
| X5 | Usage limits | Show plan limits and when they reset, with a banner when near (T3 `ComposerUsageLimits`, `UsageLimitRecoveryBanner`) | P1 | partial | A usage limit now ends the turn with one plain line, "Codex has reached its usage limit until 10:32 PM. Try again then, or switch…", instead of "Internal error" (verified with Codex). Still to do: limits shown before they are hit (with K9) |

## Work log

Newest first. One line per shipped change, with its commit.

- 2026-11-21 · M4 sign-in status and the agent's own sign-in buttons for every agent; M2 OpenCode verified end to end; agents with no full-access mode run in their first unrestricted mode.
- 2026-11-21 · M3 agent directory from the ACP registry: add any maker's agent in one click; GitHub Copilot verified end to end with full access.
- 2026-11-21 · M5 models grouped by maker; a note when an image goes to an agent that can't see images.
- 2026-11-21 · M2 OpenCode provider connect and model refresh; M4 sign-ins open a terminal for the user.
- 2026-11-21 · C9 copy, edit and resend, try again.
- 2026-11-21 · G1 numbered diff viewer and line counts for new files.
- 2026-11-21 · G1 per-turn changes from before/after snapshots, opened from the conversation.
- 2026-11-21 · G5 undo a turn's changes, with a warning when files changed again since.
- 2026-11-21 · G5 undo one file, and redo.
- 2026-11-21 · C5 Claude thinking summaries; K7 last pick remembered for new threads.
- 2026-11-21 · C4 the agent's own questions as a card (options, number keys, own answer, skip); the main column no longer grows past the window.
- 2026-11-21 · S1 unread dots.
- 2026-11-21 · C8 GitHub-flavoured markdown (tables, code with Copy, links, checklists) and X5 a plain usage-limit line. Gemini "yolo" counts as full access.
- 2026-11-21 · Full access always: mode picker removed, "Plan first" switch, plan cards trimmed. K4 and A1 verified with Claude. Codex `$` skills insert correctly. Refused edits no longer read as done.
- 2026-11-21 · Reference study: 25 new ledger rows from T3 Code and the Codex TUI.
- 2026-11-21 · K3 @-mention project files: fuzzy picker in the message box; mentioned text files go to the agent in full.
- 2026-11-21 · K2 image and file attachments: paste, drop or pick files; thumbnails in the box and the thread; queued messages keep them.
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

1. Every major model maker (Finlay, November 21): try a binary-download agent from the directory (M3), connect a real provider to OpenCode and check grouped models (M2, needs Finlay). Run Gemini (M1) once Finlay has signed in. Image warning: Arcex notes when the agent reports no image support, but ACP reports this per agent, not per model, so OpenCode's text-only free model isn't caught (it says so itself). Find a per-model signal.
2. G1 whole-branch view (waits on G4, since threads share one branch today).
3. C14 wrap-up box with G3 "Save a version".
4. Re-run with Codex after its limit resets: full access, `$` skills, K2 attachments, K3 mentions.
5. Then the P1 items: C10 conversation rewind, G3 "Save a version", P2 file viewer, P3 opt-in terminal, K9 usage meter, H1 instructions editor, H2 Codex instructions, then the P1 rows from the study: A4 approvals across threads, G7 review mode, P6 project scripts, S6 command palette, C18 compaction, H6 skills and hooks, H9 CLI updates, X5 usage limits.

G4 (worktree per thread), K12 (suggested prompts), S7 (model-written titles), S10 (phone follow) and H10 (scheduled runs) need Finlay's decision before any work.

## How to verify a change

- `pnpm -C apps/ide exec tsc --noEmit -p .`, `pnpm -C apps/engine exec tsc --noEmit -p .`, and `pnpm -C apps/ide build`.
- Start the `ade-engine` launch config in the in-app browser pane. It uses an isolated data dir and serves the built IDE on port 4517. Run a short real prompt with Claude Haiku in "Smoke test project" and check the change on screen.
- Use the smoke project at `C:\Users\finla\Arcex Projects\smoke-test-project` and delete any test files the agent makes there. Clear test text from the message box afterwards, so it is never sent with a later prompt.
- Restart the `ade-engine` preview after engine changes. IDE changes need only a rebuild and reload.
