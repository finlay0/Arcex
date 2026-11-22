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
- Codex re-run on November 21 after its limit reset: full access (wrote a file with no prompt), K3 "@" mention (read the mentioned file), K2 pasted image ("Orange"), the K9 meter (Codex sends usage too) and H2 all work. Running a `$` skill is still untried.
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
| C8 | Streaming markdown polish | Code blocks with copy, tables, file links that open the file | P1 | done | `md.tsx` now uses `react-markdown` with GFM and line breaks: tables, task lists, headings, quotes, code blocks with a language label and Copy, web links that open in the browser. Raw HTML stays text and remote images are not loaded. Verified with Claude (`/context` tables, code, link, checklist). Code blocks in a known language get the file viewer's grey syntax tones (verified November 22 with a JS block). File paths in replies (`src/app.ts`, `calc.js:3`, full Windows paths, or markdown links to files) open in the side panel's file viewer at that line, marked; domains, versions and phrases are left alone. Verified November 22 with Claude Haiku naming `calc.js:3` |
| C9 | Copy message, retry, edit and resend | Hover actions on messages. Retry a failed turn | P0 | done | Hovering your message shows Copy and "Edit and send again" (text and attached files go back in the message box). A failed, stopped or interrupted turn shows "Try again" (resends the same message and files) and "Edit message". Verified November 21 with Codex and OpenCode. Rewinding the agent's own history isn't possible over ACP, so an edit is sent as a new message |
| C10 | Rewind / checkpoints | Restore the code and conversation to an earlier message | P1 | done | "Rewind to here" on any of your messages puts back the files later turns changed (warning first if they changed again since), removes that message and everything after it, and returns the message to the box. ACP can't trim an agent's memory, so the agent starts fresh with a recap of the kept conversation. Verified November 21 with Claude Haiku: b.txt removed, a.txt restored, and the fresh agent recalled only the kept turn |
| C11 | Find in thread (Ctrl+F) | Find bar with next and previous | P2 | done | `Find.tsx`: Ctrl+F in a thread opens a find bar that marks every match with the CSS Custom Highlight API (no change to the page), shows "2 of 7", Enter or Shift+Enter or the arrows step through, Esc closes. Text inside folded work rows is skipped. Verified November 22 |
| C12 | Turn outcome and elapsed time | "Worked for 2m 14s", failed or stopped badge | P1 | done | An `end` item closes every turn: "Worked for 1m 5s" or "Stopped after 25s" |
| C13 | Subagents | Rows for subagents working, with their progress | P2 | done | Claude's Agent and Task calls read "Subagent: <task>" (a turn's line says "Used a subagent" or "Used 3 subagents"). The subagent's own steps, tagged by the adapter with their parent call, fold under it as "Subagent · N steps · <current step>", opening to each step; the live line says "Subagent: <its current step>". A subagent's own words and reasoning stay out of the reply. Verified November 22 with Haiku: two subagent runs, each with its command folded under it and the reply showing only the main agent's answer. Codex has no subagents over ACP |
| C14 | Wrap-up / next-step box | Recap plus buttons (commit, PR, verify) at the end of a turn | P1 | partial | A turn that changed files ends with "Changed N files +X −Y", Undo/Redo and, on the last turn, "Save a version" and "Open preview" (when the project has a running-app address; opens the side panel's Browser tab). Verified November 21. Still missing: a recap (the agent's last reply serves for now) |
| C15 | Side question | Ask a quick question beside the thread without derailing the running turn (T3 `useSideChat`, `SideThreadPane`) | P2 | done | "Ask aside" (chat icon in the message box tools) opens a small box over the composer. The engine forks the thread's saved conversation (ACP `session/fork`) in its own agent process, in plan mode where the agent has one, refuses any change it asks to make, and streams the answer into the box. The thread, its history and a running turn are untouched; the fork is closed after answering, and the answer is gone when the box closes. Agents without fork say they can't answer side questions yet. Verified November 22 with Haiku: asked which colour an earlier tool call returned, it answered Purple from the thread's history, and the thread itself still ended at its last reply. Not tried during a running turn, or with Codex |
| C16 | Quote part of a reply | Select text in a reply to quote it into the message box (T3 `AssistantSelectionToolbar`) | P2 | done | Selecting text in an agent reply shows a Quote button above it; it puts the text in that thread's message box as "> " lines (in split view, the right pane's box). Verified November 22 |
| C17 | Rich media in replies | Mermaid diagrams, math, zoomable images, rendered HTML preview (T3 `MermaidDiagram`, `MathTypeset`, `HtmlRenderDialog`) | P2 | done | `mermaid` code blocks draw as diagrams in the app's greys (Mermaid strict mode, loaded only when a reply has one, redrawn on theme change, source shown while it is half written or fails), with Code to see the source and a click to view full size. Math between `$$…$$` renders with KaTeX, inline or as a block; single dollar signs stay text so prices read normally. `html` code blocks get Preview: a sealed frame that runs the page's own scripts but can't load anything from the network or reach the app. Remote images in replies still don't load (C8). Verified November 22: a flowchart, inline and block math, "$5 or $10" left alone, the preview's button working with its remote image blocked, and the full-size diagram |
| C18 | Context compaction | Summarise a long thread to free context, by hand or automatically (Claude `/compact`, T3 `compaction.logic`) | P1 | done | Arcex advertises ACP `session.compaction` (and `notices`), so a compaction shows as a plain note, "Summarising older messages…" then "Summarised older messages to free up the agent's memory", instead of a fake tool call. By hand: click the context meter (K9) and confirm, which sends the agent's own `/compact` (only offered when the agent lists that command). Agent notices show as notes too. Verified November 21 with Claude Haiku. Codex's own compaction not yet seen |
| C19 | Timeline minimap | A strip beside long threads to jump to any turn (T3 `TimelineMinimap`) | P2 | done | Threads taller than one and a half screens with three or more of your messages get a thin strip on the right: a mark per message (hover shows its start, click scrolls there) and a shaded block for what's on screen. Verified November 22 |

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
| K8 | Prompt history | Up arrow recalls earlier prompts | P2 | done | Up in an empty message box brings back this thread's earlier messages, newest first; Down steps forward and ends at an empty box. Typing stops the stepping. Verified November 22 |
| K9 | Context and usage meter | Context % used, plan usage limits | P1 | partial | Context: a thin grey ring by the message box fills from the agent's ACP `usage_update` (Claude and Codex both send it); hover gives "3% of the agent's memory for this thread used (30k of 1M tokens)", the percentage shows from 50% and the ring brightens from 80%. Verified November 21 with Claude Haiku. Still to do: plan usage limits (X5), which ACP doesn't report |
| K10 | Stop and steer | Stop. Sending while working steers or queues | P0 | done | While a turn runs, agents that advertise the ACP `_session/steering` extension (Claude and Codex adapters both do) take the message into that turn: Enter sends it now and it shows in the thread where it went in; Tab queues it for after the turn instead. If no turn can take it, it queues. Other agents queue as before (K5). Verified November 22 with Claude Haiku (a 1-to-1500 count steered to stop and say STEERED in the same turn). Codex steering not run yet |
| K11 | Stash a draft | Put the current draft aside and bring it back later (T3 `ComposerStash`) | P2 | done | A box button in the message box puts the draft aside; "N aside" lists them (newest first, up to 20, kept on this computer, shared by every message box). Picking one puts it back and sets aside whatever was in the box; each can be deleted. Verified November 22 |
| K12 | Suggested next prompts | One-click follow-ups after a turn (T3 `usePromptSuggestion`, Claude next-step buttons) | P1 | decide | Generating them spends usage. Ask Finlay (background intelligence rule) |
| K13 | Expand an attached image | Click a thumbnail to see it full size (T3 `ExpandedImageDialog`) | P2 | done | Clicking a sent image opens it full size over the app; a click or Esc closes it. Verified November 22 with a pasted image (Claude Haiku answered "Orange") |
| K14 | Send to several models | Run one prompt on two agents or models side by side (T3 `useMultipleModelSend`) | P2 | done | On a new thread, the Compare button (layers icon) adds "and <agent · model>" to the message box. Sending starts two threads with the same message and attachments, the first on screen and the second beside it in split view. Both work in the same project folder. Compare switches off after sending. Verified November 22: "Reply with only your model name" to Haiku 5.5 and Sonnet 5.5 answered side by side. Two models only, for now |

### Approvals and safety

| ID | Feature | Behaviour | Pri | Status | Notes |
| --- | --- | --- | --- | --- | --- |
| A1 | Approval cards | Allow once, Always allow, Deny, with the exact command or diff | P0 | done | With full access they appear only for plans and for whatever an agent still asks. Verified with Claude in Manual before modes were removed: Yes wrote the file, No refused it and Claude said so. Plan cards now offer only "Yes, go ahead" (or start fresh with just the plan) and keep planning. A refused edit no longer reads "Edited +1 −0": it reads "Couldn't edit" with no line counts |
| A2 | Plan mode approval |
 Agent proposes a plan, the user approves, then it executes | P0 | done | Claude `ExitPlanMode` arrives as a permission request with `rawInput.plan`; the card reads "Here's the plan. Go ahead?" with Claude's own options. Verified: approving into Auto moves the mode chip to Auto |
| A3 | MCP input requests | Forms an MCP server asks the user to fill in mid-turn (Codex `mcp_server_elicitation`) | P2 | done | Already covered by the question form (C-row for the agent's own questions): the Claude adapter turns an MCP server's form request into ACP `elicitation/create`, which Arcex shows as a "Claude has a question" card and answers back. Verified November 22 with a test MCP server whose tool asked "Which colour do you like best?" (Red, Green, Purple): the card showed mid-turn, picking Purple returned it to the server, and Claude replied Purple. URL requests (an MCP server asking the user to open a sign-in page) are not offered; Arcex advertises forms only |
| A4 | Approvals across threads | One place listing every thread waiting on the user (Codex `pending_thread_approvals`, Claude "needs you") | P1 | done | Threads waiting on you are the first group, "Needs you", in Ctrl+K, as well as the sidebar dots (S1). Not yet seen with a real waiting thread, since full access makes them rare |

### Review, git and shipping

| ID | Feature | Behaviour | Pri | Status | Notes |
| --- | --- | --- | --- | --- | --- |
| G1 | Diff pane | Changes +N −M per file, unified diff, per-turn and whole-branch views | P0 | done | Changes list with +N −M per file and in total, including line counts for new files Git doesn't track yet. The diff shows old and new line numbers and a ⋯ gap where unchanged lines are skipped. Verified November 21. Per turn: Arcex snapshots the folder as a Git tree before and after each turn, with its own index file so the user's staging, branch and history are untouched, and "Changed N files +X −Y" in the conversation opens that turn's files and diffs alone, including changes made by commands. Verified November 21 with two OpenCode turns (+3 −0, then +1 −1). Skipped for folders without Git or over 50 MB of new untracked files. Two threads working in one folder at once see each other's changes. Whole branch (November 22): on a branch with saved versions beyond its base, the branch row's "Show changes" lists every file the branch changed since it split from the base (counted from the merge base, so work that landed on the base later doesn't show), with the total, +N −M per file and each file's diff (with comment boxes, as G2). Verified on a scratch repository: feature's two files listed, main's later file left out, a.txt's diff correct |
| G2 | Inline review comments | Comment on a diff line and send it to the agent | P1 | done | Click any line in a diff (side panel Unsaved changes or a turn's changes), or reach it with the arrow keys and press Enter, to open a comment box. "Add to message" (or Enter) puts "`file:line` comment" on its own line in the open thread's message box and marks the line, so several comments go to the agent in one message. Removed lines say so. Verified November 22 |
| G3 | Commit, push and PR from the app | Buttons with a generated message, PR status and CI | P1 | done | "Save a version" in the side panel (now "Unsaved changes") and on the last turn commits everything in the project, with the thread's name or "Save N changed files" as the message, using the user's Git identity (or the computer's user name when Git has none). Refused while an agent in the project is working. "Saved versions" lists them (newest first, five then Show all) with "Go back" after a confirm: the folder returns to that version, files added since are removed, untracked files are left alone, history and staging are untouched, and the difference shows as unsaved changes to save or undo. Verified November 21. November 22: when the project already has a remote, the side panel shows a "GitHub" (or "Remote") section: the branch, how many saved versions are not pushed, and Push (the user's own Git sign-in, prompts off, plain messages for rejected or unsigned pushes). With the GitHub CLI installed it shows the branch's pull request (number, open/merged/closed, checks running/passing/failing, Open) or offers "Create pull request" on a branch other than the default (pushes first, title and body from the first saved version). No remote means nothing shows. Push verified against a local bare remote; the pull request read checked against this repository's PR #1. Still missing: creating a GitHub repository for a project that has none |
| G4 | Worktree per thread | Isolated working copies so parallel threads don't collide | P1 | done | Finlay chose: only when asked, work comes back as unsaved changes. The branch switch beside the composer starts a new thread in its own copy (a Git worktree on a hidden branch, kept in Arcex's data folder, made from the last saved version). The side panel's Separate copy section lists its changes with diffs; Bring changes in writes them into the project folder as unsaved changes (both sides changed one file: merged, overlapping lines marked with both versions) and removes the copy; Discard copy asks first. The agent then continues in the project folder with a recap. Verified with Haiku editing only the copy, a bring-in, an overlap merge and a discard |
| G5 | Revert / undo a turn's changes | Undo a file or a whole turn | P1 | done | "Undo" beside a turn's "Changed N files" puts only that turn's files back the way they were before it (from the G1 snapshots, through a scratch index, so staging is untouched), after a confirm. Files changed again since are named and need "Undo anyway". The turn then reads "Undid N files", and the agent is told with the next message. Verified November 21: both paths, the file restored and then removed. Each file in a multi-file turn has its own Undo, and undone changes have Redo (whole turn or one file); redo also checks for later changes. Verified November 21: redo of two turns, then undo of one file out of two |
| G6 | Open in editor | Open the project or a file in VS Code, Cursor or Explorer | P1 | done | "Open in" on the side panel's project card and in the file viewer lists the editors found on this computer (VS Code, Cursor, Windsurf, Zed, from PATH or their usual install folders) plus File Explorer or Finder. Done by the engine (`editors.ts`): launchers start detached, paths stay inside the project, and paths with characters cmd.exe would read are refused. Verified November 22: the menu lists Cursor and File Explorer. Not pressed in testing, since it opens a window on Finlay's PC |
| G7 | Review mode | Ask the agent to review uncommitted changes or a branch and list findings (Codex `/review`, Claude code review) | P1 | done | "Review changes" beside "Save a version" in the side panel starts a thread with the picked agent that reviews every unsaved change (including new untracked files), lists findings most serious first with file, line, when it goes wrong and the fix, and changes nothing. Verified November 22 with Claude Haiku: found the off-by-one in a test file. November 22: on a branch other than main (or the remote's default), Unsaved changes shows "On <branch> · N saved versions beyond main · Review branch", which starts a review of `git diff main...HEAD` plus unsaved changes. Findings name file:line, which already open the file at that line (C8). Verified with a test branch |
| G8 | Start from a pull request | Open a thread on a PR, with its description and diff as context (T3 `PullRequestThreadDialog`) | P2 | done | In the side panel's GitHub section (shown only with a GitHub remote and the GitHub CLI): "Start from a pull request · Choose" lists open PRs (`gh pr list`). Picking one switches the project to it (`gh pr checkout`, refused while tracked files have unsaved changes or an agent is working) and opens a new thread whose message box holds the PR's title, author, branches, description and "Run `gh pr diff N`". Nothing is sent until the user adds their ask. Verified November 22 on a scratch clone of this repository: the list (no open PRs) and the plain error for a merged PR whose branch was deleted. A successful switch was not tried (no open PR to use). Also fixed: the panel header (Details, Browser, Terminal) overflowed the window at narrow widths |

### Panes and layout

| ID | Feature | Behaviour | Pri | Status | Notes |
| --- | --- | --- | --- | --- | --- |
| P1 | Browser / preview pane with agent control | Preview with dev server start and agent browsing tools | P0 | done | a885e7a. The dev server starts from the project's own scripts (P6); the first local address it prints becomes the preview when none is set |
| P2 | File viewer | Click a file in the tree to read it, with syntax highlighting | P1 | done | Click a file in the side panel's Files list to read it there: line numbers, grey syntax tones for common languages (own small highlighter, no blue), Copy, Back or Esc. Binary files and files over 1 MB say so. Reads stay inside the project folder, also through links. Verified November 21 |
| P3 | Terminal pane (opt-in) | A real shell per project, hidden by default | P1 | done | Settings › General › Terminal adds a Terminal tab to the side panel (Ctrl+` and the palette open it). Engine runs PowerShell 7 or Windows PowerShell through @lydell/node-pty (ConPTY, no window), one per project, keeps the last 100 KB so reopening shows it; client is xterm.js in grey tones. Refused when the setting is off |
| P4 | Resizable and expandable panels | Drag to resize, expand a pane, split view | P1 | done | Drag the sidebar's and the side panel's inner edge (or focus it and use the arrow keys); double-click resets. The panel keeps separate widths for its normal and wide (browser, file, output) views, and the conversation always keeps at least 440 px. Widths are remembered on this computer. Expand already existed. Verified November 22. November 22: split view. A thread's menu has "Open beside", which shows it next to the open thread, each with its own message box, draft and find (Ctrl+F answers in the pane you're in). The second pane has "Open on its own" and close. Threads from any project can sit side by side. Verified November 22 |
| P5 | Tasks / background processes pane | Running background commands with timers | P2 | done | Scripts the user runs (P6) show running time, Stop and their output. November 22: background work an agent starts itself is now shown too. Arcex declares the AIR extension's `asyncTasks` capability, so Claude reports each background command (and other background work) with its start, end and a stop control. Those updates aren't in the ACP schema, so the engine takes them out of the stream before the SDK checks it. The side panel's Background work section lists them across the project's threads: name, "Running for 12s" or how it ended, the thread (click to open), and Stop. Work still running when the agent's process closes is marked stopped. Verified with Haiku: `sleep 120` in the background appeared with a live timer, and Stop ended it. Codex doesn't report background work over ACP |
| P6 | Project scripts as buttons | Run dev, test or build with one click, from package.json or the user's own list (T3 `ProjectScriptsControl`) | P1 | done | "Run" in the side panel lists package.json scripts (dev, start, preview, build, test and lint first; four, then Show all) with the lock file's package manager. The engine (`processes.ts`) runs one hidden with `BROWSER=none`, keeps 200 KB of output without colour codes, and Stop ends the whole process tree. A local address it prints shows as "Running at …" with Preview, and becomes the project's preview if none is set. Output opens in the panel and follows along. Runs stop when the engine closes or the project is removed. Verified November 22: dev server previewed, build finished, test failed with exit 1, Stop freed the port. Still missing: a user's own script list for projects without package.json |

### Sidebar and sessions

| ID | Feature | Behaviour | Pri | Status | Notes |
| --- | --- | --- | --- | --- | --- |
| S1 | Thread status in sidebar | Spinner while working, dot when unread, needs-you badge | P0 | done | Working, needs-you and failed dots in the sidebar. A thread that moves on while you're in another one turns bold with a white dot until you open it (last-seen times kept per thread on this computer). Verified November 21 |
| S2 | Rename, pin, archive and delete threads | Context menu and inline rename | P1 | done | The thread menu has Rename (inline), Pin to top / Unpin, Archive and Delete. Pinned threads sit at the top of their project with a pin mark. Verified November 22 |
| S3 | Search threads | Search titles and transcripts | P1 | done | Ctrl+K (or Search in the sidebar) matches thread titles and, through the engine's `thread.search`, what was said in any thread (yours and the agent's messages), with a snippet around the match under "In messages". Verified November 22: "kelp" found a thread by its message and Enter opened it |
| S4 | Notifications | Desktop notification when a thread finishes or needs you | P1 | done | "Finished" only after a clean finish. A failed or interrupted turn has its own state and its notification reads "Failed: <reason>" from the turn's error line. Needs you reads "Needs your OK to continue" |
| S5 | Keyboard shortcuts | New thread, switch thread, focus composer, toggle panes, with a cheat sheet | P1 | done | Ctrl N new thread, Alt ↑/↓ previous or next thread (sidebar order), Ctrl K palette, Ctrl F find, Ctrl L message box, Ctrl B sidebar, Ctrl J panel, Ctrl ` terminal (when on), Ctrl , Settings, Ctrl / the cheat sheet (Settings › Shortcuts, with a message-box list: Enter, /, @, ↑). Verified November 22 |
| S6 | Command palette | Ctrl+K to jump to any thread, project, setting or action (T3 `CommandPalette`) | P1 | done | `Palette.tsx`: Needs you, Actions (new thread or project, review changes, sidebar, details, browser, toolbox, theme), Threads, Projects (new thread there), Settings sections, then matches in messages. Ranked by start, word start, substring, then letters in order. Arrows, Enter, Esc. Replaces the sidebar's title filter. Verified November 22 |
| S7 | Thread titles that fit | Titles written from the conversation, renamed as it develops (T3 title regeneration) | P1 | decide | `titleFrom` is a stopgap. A model call spends usage: ask Finlay |
| S8 | Pin and snooze | Pin projects and threads; snooze a thread until later (T3 `ProjectPinButton`, `Sidebar.snooze`) | P2 | done | Projects have a menu (Pin to top / Unpin, New thread, Project settings); pinned projects lead the list with a pin mark. Threads can snooze for an hour or until 9 AM tomorrow: they leave the sidebar behind a "N snoozed threads" line (which shows them, marked snoozed) and come back when the time is up or the thread needs you; "Wake now" ends it early. Both are kept on this computer. Verified November 22 |
| S9 | Parallel sessions with linked status | Start a side session for separate work and see its state from the parent (Claude side sessions) | P2 | done | Agents get a `suggest_side_thread` tool on the Arcex connector: it puts a card in the conversation (title, prompt, Start side thread, Dismiss; at most three waiting). Nothing runs until the user starts it, which opens the side thread beside the parent, in its own copy of the project (in the project folder when there is no saved version yet). The side panel's Side threads section lists each one with its live state and has Start one for the user's own side work; a side thread links back to its parent. Side threads sit indented under their parent in the sidebar. When one finishes, the parent shows a note and its agent hears the last reply with the user's next message there, so no usage is spent unseen. Verified November 22 with Haiku: suggested, started, wrote hello.txt in its copy only, parent showed Finished and answered from the report. The user-started path shares the same code and was not run separately |
| S10 | Follow from another device | Watch and answer a thread from a phone (Claude Remote Control, T3 device pairing) | P2 | decide | Large. Ask Finlay |

### Agent harness and instructions

| ID | Feature | Behaviour | Pri | Status | Notes |
| --- | --- | --- | --- | --- | --- |
| H1 | Project instructions | AGENTS.md / CLAUDE.md respected and editable from the app | P1 | done | Settings → Projects → "Instructions for agents" edits AGENTS.md in place (Ctrl+S saves, Esc cancels). Claude reads CLAUDE.md rather than AGENTS.md, so when there is none Arcex adds a one-line CLAUDE.md that imports AGENTS.md. A CLAUDE.md or GEMINI.md with its own content gets its own tab. Verified November 21: Claude Haiku answered from a rule saved this way |
| H2 | Arcex system prompt note | Tell agents about Arcex's UI (plan, browser tools, no terminal for the user) | P0 | done | The note (task list as a checklist, no terminal for the user so describe results in plain words, Arcex shows changed files) goes through ACP's standard `systemPrompt` (append) to every agent that advertises it, which includes Claude and Codex; older Claude adapters get it from `_meta`. Verified November 21: Claude Haiku and Codex both quoted it |
| H3 | MCP connectors | Add MCP servers per project or globally | P1 | done | Settings › Connectors: add an MCP server as a command (with environment variables) or a web address (with headers), for every project or one, with an on/off switch, Edit and Remove. Test starts or reaches it and lists its tools ("Works. 1 tool: secret_word"), or shows the server's own error. Arcex hands enabled ones to each agent through ACP when a session starts; npx, uvx and other package runners go through cmd on Windows. Web connectors only reach agents that support them over ACP. Removing a project drops its connectors. Values stay in Arcex's local settings. Verified November 22 with a local test server: Test listed its tool, and Haiku called it and returned the value from its variable |
| H4 | Model list per agent | Live models from each agent | P0 | done | `agents.models` |
| H5 | Session resume across restarts | Reopen a thread and continue the same agent session | P0 | done | `session/load` |
| H6 | Skills and hooks manager | See, turn on or off and add skills and hooks per project (Codex `skills_toggle_view`, `hooks_browser`) | P1 | done | Settings › Skills and hooks (and the palette): per project, the skills each agent loads from the project (`.claude/skills`, `.agents/skills`, `.gemini/skills`, `.opencode/skill(s)`) and from the home folder, with name, description and a switch. Off renames SKILL.md to SKILL.md.off, so every agent skips it and on restores it. Project skills open in the file viewer. "Write a skill" starts a thread asking the agent to write one with you. Claude Code hooks from the project and user settings files are listed (event, matcher, command, file), each with a switch. Claude Code has no per-hook off flag, so off takes the hook out of its settings file and keeps it in Arcex's data folder; on puts it back under its event and matcher (verified November 22: off and on again left the file exactly as it was, and the row reads "off, kept aside by Arcex"). Other agents' hooks are not shown: Codex, Gemini and OpenCode keep theirs in their own formats |
| H7 | Agent memory | View and edit what the agent remembers across sessions (Codex `memories_settings_view`, Claude memory) | P2 | done | Settings › Memory: each set-up agent's personal instructions file, read in every project (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`), with word count, path and an editor (only those three paths can be written). Below, per project, the notes Claude Code saved for itself (its auto memory under `~/.claude/projects/<project>/memory`), index first, each folding open, read only. Verified November 22: the section in the test app, and the notes reader on this repository (26 notes, MEMORY.md first). Codex's own memories feature isn't read yet |
| H8 | Extra folders | Let a thread read and write a second folder (Codex `additional_dirs`, Claude added directories) | P2 | done | Each thread keeps up to five folders outside the project ("Add a folder…" in the thread menu, or Other folders in the side panel, each removable). They go to the agent as ACP `additionalDirectories` on new and reopened sessions when it advertises `sessionCapabilities.additionalDirectories`. A change reopens an idle session (the conversation resumes), or waits for a running turn to finish. An agent without the capability shows "This agent can't use extra folders". Verified November 22: Haiku read a note from the added folder by name only, the folder survived a reload, and removing it worked. Codex not tried |
| H9 | Agent CLI updates | Notice when Claude or Codex has an update and offer it (T3 `ProviderUpdatesAction`) | P1 | done | Settings › Agents compares each built-in agent's installed version with the maker's latest npm release (public registry, cached six hours, nothing about the user sent) and shows "Update to x.y.z" with "Update <agent>" (opens a terminal running the maker's own command: `claude update`, `opencode upgrade`, or npm for Codex and Gemini) and the command to copy. Verified November 22: all four showed updates. Not pressed in testing (opens a window). Note: Claude and Codex threads run through adapters bundled with Arcex, so their CLI updates matter mostly for sign-in; Arcex's own dependency updates move the bundled versions |
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
| X1 | Settings sections | General, Agents, Voice, Notifications, Shortcuts, Projects, Archived, About | P1 | done | Profile, General, Appearance, Agents, Voice (dictation status, Set up to fetch the model ahead of time), Notifications (with a line when the system blocks them), Projects, Archived threads, Shortcuts, About. Each is in the palette. Verified November 22 |
| X2 | Light theme | Light and dark | P2 | done | Settings › Appearance offers Light, Dark or System. Checked November 22 in light: sidebar, selected thread, header buttons, conversation, message box, side panel and Settings (Skills and hooks) all read correctly; find highlights have their own light colours |
| X3 | Accessibility | Keyboard paths, focus and contrast from the November 17 audit | P1 | done | Rechecked November 22 against `ade-ux-audit-2026-11-17.md`: thread rows are real buttons beside a separate menu button; menus focus their first item, move with the arrow keys and close on Esc back to the button; panel tabs move with the arrow keys, Home and End; message boxes have names; placeholder and secondary text measure 5.4:1 or better; the animated composer outline is gone (steady ring) and reduced motion stops all animation. A page sweep finds no unnamed controls or fields; icon buttons all have hover labels; links, summaries and focusable custom controls now get the focus ring too. A 30-stop Tab walk shows a ring on every stop. Screen-reader and Windows-scaling checks on the packaged build stay with Finlay |
| X4 | Send feedback | Report a problem with the thread attached (Codex `feedback_view`) | P2 | open | |
| X5 | Usage limits | Show plan limits and when they reset, with a banner when near (T3 `ComposerUsageLimits`, `UsageLimitRecoveryBanner`) | P1 | partial | A usage limit now ends the turn with one plain line, "Codex has reached its usage limit until 10:32 PM. Try again then, or switch…", instead of "Internal error" (verified with Codex). November 22: Claude reports its plan limit with each turn (the adapter's `_claude/rateLimit` on `usage_update`); Arcex keeps the latest per agent. Settings › Agents shows "Plan limit: Claude is within its 5-hour limit. It resets at 4:00 AM" (or the percentage when Claude sends one), and the message box shows a notice when the agent is close to ("has used 85% of its weekly limit…") or at its limit ("…until 4:00 AM. Switch to another agent or model, or wait"). Verified the Settings row with a real Haiku turn and after a reload. The warning notice was seen live on November 22: "Claude has used 90% of its 5-hour limit. It resets at 4:00 AM." under the message box. Still missing: Codex and other agents, which don't report limits over ACP |

## Work log

Newest first. One line per shipped change, with its commit.

- 2026-11-22 · H6 per-hook on/off switches.
- 2026-11-22 · H3 Settings › Connectors: your own MCP servers, tested and handed to every agent.
- 2026-11-22 · S9 side threads: agent-suggested or user-started, nested under the parent with live state.
- 2026-11-22 · G4 separate copies per thread (worktrees), brought back as unsaved changes.
- 2026-11-22 · G1 whole-branch changes view.
- 2026-11-22 · P5 background work agents start, with timers and Stop.
- 2026-11-22 · K14 compare: one message to two models, side by side.
- 2026-11-22 · C13 subagent rows with their steps folded under them.
- 2026-11-22 · C15 ask aside: side questions on a forked copy of the thread.
- 2026-11-22 · C17 diagrams, math and HTML previews in replies.
- 2026-11-22 · A3 checked: MCP server forms already work through the question card; X5 warning seen live.
- 2026-11-22 · G8 start a thread from a pull request; panel header fits narrow windows.
- 2026-11-22 · H8 extra folders per thread.
- 2026-11-22 · H7 Settings › Memory: personal instructions per agent and Claude's project notes.
- 2026-11-22 · S8 pin projects, snooze threads.
- 2026-11-22 · C19 timeline strip beside long threads.
- 2026-11-22 · K11 put drafts aside.
- 2026-11-22 · C16 quote selected reply text.
- 2026-11-22 · P4 split view of two threads.
- 2026-11-22 · X5 Claude plan limits in Settings › Agents and a notice near the limit.
- 2026-11-22 · K10 steer a running turn (Enter), Tab queues.
- 2026-11-22 · G7 review a branch against main.
- 2026-11-22 · G2 comment on diff lines into the message box.
- 2026-11-22 · G3 push and pull requests in the side panel when a project has a remote.
- 2026-11-22 · H6 Settings › Skills and hooks: list, switch, open and write skills; list hooks.
- 2026-11-22 · X3 accessibility recheck: hover labels, focus ring on every focusable control.
- 2026-11-22 · S5 thread switching, Ctrl L, Ctrl / cheat sheet; X1 Voice and Notifications sections.
- 2026-11-22 · S2 pin threads; S4 failure notifications give the reason.
- 2026-11-22 · P3 opt-in terminal tab in the side panel.
- 2026-11-22 · C11 find in thread, K8 Up-arrow prompt history, K13 full-size images.
- 2026-11-22 · H9 agent updates in Settings › Agents.
- 2026-11-22 · P4 drag to resize the sidebar and the side panel.
- 2026-11-22 · C8 file paths in replies open the file at that line.
- 2026-11-22 · C8 syntax tones in reply code blocks.
- 2026-11-22 · P6 run project scripts from the side panel; a dev server's address becomes the preview.
- 2026-11-22 · S6 command palette, S3 search in messages, A4 "Needs you" first in it.
- 2026-11-22 · G7 "Review changes" starts a review thread for the unsaved changes.
- 2026-11-22 · G6 open the project or a file in an editor or File Explorer.
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
- 2026-11-21 · G3 "Save a version" and C14 end-of-turn actions; the side panel refreshes when the window regains focus.
- 2026-11-21 · G3 saved versions list with Go back.
- 2026-11-21 · C14 "Open preview" on the last turn.
- 2026-11-21 · C10 rewind the conversation and files to before any message.
- 2026-11-21 · P2 file viewer in the side panel.
- 2026-11-21 · K9 context meter by the message box.
- 2026-11-21 · C18 compaction notes, and summarise on request from the meter.
- 2026-11-21 · H1 project instructions editor.
- 2026-11-21 · H2 Arcex note to Codex and Claude through ACP's standard system prompt.
- 2026-11-21 · Codex re-run: full access, K2 image, K3 mention and K9 meter verified.
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
2. Run a Codex `$` skill end to end.
3. Remaining partial rows: X5 limits for agents other than Claude, C14 recap (a written recap would need a model call, so it waits on Finlay like K12).

K12 (suggested prompts), S7 (model-written titles), S10 (phone follow) and H10 (scheduled runs) need Finlay's decision before any work.

## How to verify a change

- `pnpm -C apps/ide exec tsc --noEmit -p .`, `pnpm -C apps/engine exec tsc --noEmit -p .`, and `pnpm -C apps/ide build`.
- Start the `ade-engine` launch config in the in-app browser pane. It uses an isolated data dir and serves the built IDE on port 4517. Run a short real prompt with Claude Haiku in "Smoke test project" and check the change on screen.
- Use the smoke project at `C:\Users\finla\Arcex Projects\smoke-test-project` and delete any test files the agent makes there. Clear test text from the message box afterwards, so it is never sent with a later prompt.
- Restart the `ade-engine` preview after engine changes. IDE changes need only a rebuild and reload.
