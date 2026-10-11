# AI sessions: Files <-> AI flip and "done / needs input" notifications

Code: `src/components/claude/` (`ai.ts` state + notification pipeline, `flip.ts`, `ClaudePanel.tsx`, `register.tsx`, `qa.ts`),
`src-tauri/src/claude_hooks.rs` (hook channel, transcript fallback), `src-tauri/src/claude.rs` (sessions list + shared watcher),
`src-tauri/src/pty.rs` (`hookFile` spawn option) and the `claude` wrapper in `src-tauri/src/shell_integration/`.
Tests: `node scripts/qa/ai.mjs` (needs the automation harness; uses `scripts/qa/ai/fake-claude.py`, never a real Claude), `cargo test claude_hooks`.

## Flip (⌃⌥A, action `Claude.FlipFilesAI`, "Flip Between Files and AI Sessions")

- "AI Sessions" is the **second view of the left Project tool window** (IntelliJ's Project view switcher): one stripe button, header tabs
  `Project | AI Sessions` (`TOOL_GROUPS` in `shell/toolGroups.ts`). The old right-hand Claude window is gone (same component, same id `claude`,
  `⌃⌥C` still opens it; asking for the other member switches the tab, `⌘1` goes back to Project). Why merged: sessions are something you
  work *with* the files, not a second sidebar on the other side of the editor, and the flip needs one place to flip from/to.
- Files -> AI: left view becomes AI Sessions and the bottom Terminal shows and focuses the **most recently focused Claude session**
  (a pane Ace launched or saw reporting hooks); with no session the sessions list gets focus.
- AI -> files (from the AI list or from a Claude terminal pane): Project view again, focus back to where the flip started (the editor with its
  caret untouched, or the Project tree); a Terminal that the flip opened is hidden again. Repeated presses toggle.
- Also: `Claude: Back to Files`, `Claude: Show AI Sessions and Last Session`, `Claude: Go to Session Needing Attention`, and a
  `Claude: Toggle "<setting>"` action per setting (Find Action). Header gear in the AI view = the same toggles.
- Why ⌃⌥A: not bound in `intellij-macos.json` (⌃⌥C/⌃⌥F/... are, ⌃⌥A is free), no Ghostty terminal key uses ⌃⌥ (they are ⌘/⌥⌘), and the action
  is global so it works from the editor, the tree, the list and the terminal. Terminal keys are not affected (the pty receives nothing).
- Enter / double-click on a session row: focuses the Ace terminal that already runs it (never starts `--resume` twice), otherwise resumes it.
  Rows show `terminal` (open in Ace), `finished` / `needs input`, `notify` (opted in). Single click only selects, so arrow keys keep working.
- State is per project window (one webview each); the left/bottom layout is persisted per project like every tool window.

## Where signals come from

1. **Hooks** (sessions Ace starts: New / Resume / Continue / Fork in the AI view, and plain `claude` typed in an Ace shell).
   `claude --settings '<json>'` (flag verified in `claude --help`: "Path to a settings JSON file or a JSON string"; it is additive to the
   user's own settings, nothing under `~/.claude` or any dotfile is touched) registers `Stop`, `Notification` (permission request, question,
   idle) and `UserPromptSubmit` hooks. The hook command appends one line `"<pane id> <hook json>"` to the window's hook file.
   - Hooks cannot write to the session's tty (they run with captured stdio and no controlling terminal; stdout is parsed as hook output), so an
     OSC 9/777 sequence from a hook is not available. A FIFO would block Claude when Ace is not reading; a socket needs `nc` and a wakeable
     listener. An O_APPEND file never blocks, survives a restarted reader and is the same on `mc`.
   - Reader: `sh -c 'create file; echo READY; tail -n +1 -F file & cat >/dev/null'`, run locally or through the multiplexed ssh connection
     (`/tmp/ace-claude-hooks-<nonce>.log` on the host, `$TMPDIR/ace-claude-hooks-<uid>/<window>-<nonce>.log` locally, mode 0600/0700). One per
     window and host, created when the first terminal for that host spawns, registered with `procs::register_for(window, "claude-hooks", ..)`,
     killed with the window. stdin EOF (window closed, Ace crashed) also ends it and the script's trap removes the file. No polling anywhere:
     `tail -F` is inotify/kqueue driven. Rust parses lines and emits `claude://hook` to that window only.
   - Plain `claude` in an Ace shell: the pty gets `ATELIER_HOOK_FILE`, `ATELIER_PANE`, `ATELIER_CLAUDE_SETTINGS`; the zsh/bash integration (private
     ZDOTDIR / rcfile, loaded after the user's rc files) defines a `claude` function that adds `--settings` (not for subcommands such as `mcp`,
     `update`, nor for `-p/--print/-h/-v`; not defined when the user has their own `claude` alias/function). Remote bash gets the same
     function through the existing pipe-fed rcfile and an `export` prefix; nothing is written on the remote host except the /tmp hook file.
   - `ATELIER_CLAUDE_BIN` (local) / `ATELIER_CLAUDE_BIN_<HOST>` (e.g. `_MC`) replace the `claude` binary in hook-wrapped launches (tests).
2. **Transcript fallback** (sessions Ace did not launch, e.g. your own Ghostty): the shared notify watcher on `~/.claude/projects` (already used by
   the sessions list) feeds changed `*.jsonl` files to `claude_hooks::on_paths`; the last 256 KB are analysed: assistant `stop_reason: end_turn`
   = finished; trailing `AskUserQuestion`/`ExitPlanMode` tool_use = question; any other trailing `tool_use` = "pending", which becomes
   "May be waiting for permission (Tool)" only after N seconds (setting, default 30) without another record, because a long Bash looks the same.
   Scope (noise control): only sessions whose project folder is the **current project's** local cwd, plus sessions you opt in to
   (session context menu "Notify When Done / Needs Input"; for `mc` sessions that is a `tail -F` over ssh, since mc has no inotify tools).
   A state that is already old when first seen (> 20 s) is not announced; sessions that report through hooks are ignored here.
   `ATELIER_CLAUDE_PROJECTS` overrides the projects dir (tests; it also disables the on-disk session cache so synthetic data never lands in it).

## Delivery rules

- One notification per turn: a `Stop` is announced once until the next `UserPromptSubmit` (or "working" in the transcript); the same kind for the
  same session within 3 s is dropped; Claude's idle reminder after a Stop is dropped; hook events beat the transcript (1.5 s grace).
- A session is *viewed* when the window is focused and its pane is on screen. Never notify for the focused visible terminal. Default
  ("only when Ace is in the background or the session's terminal is not on screen"): notify iff not viewed. Setting off: also notify when the
  terminal is visible but something else has focus.
- Title `Claude finished` / `Claude needs input`, body `<project>: <first line of the last message | the question | permission message>`,
  optional sound, through `desktopNotify` (the tauri notification plugin; tests intercept it with `qaHooks.notify`).
- Badges (set when not viewed, cleared when viewed: window focus, tab/tool-window changes, flipping to it, clicking its row): count on the
  Project/AI stripe button and on the AI Sessions header tab, `✓` / `?` on the terminal tab, `finished` / `needs input` on the session row.
- **Click on the notification**: the plugin has no click callback on macOS desktop. The window that showed the last notification records it
  (`claude_note_shown`); when Ace is activated within 25 s the activated window claims it (`claude_note_claim`) and the owning window is focused
  and flipped to that session. Alt-tabbing to Ace within 25 s does the same (setting "Jump to the session when Ace is activated by its
  notification"); `Claude: Go to Session Needing Attention` does it on demand.
- Terminal tab titles: `Claude: <session title>` (from the transcript once it has one); a title you set yourself is never overwritten.

## Cost

Per window and host with a terminal: one `sh` + one `tail` (about 1-2 MB RSS together, 0 CPU while idle), plus one `ssh` client per remote host
(it shares the ControlMaster connection). The JS side is a few Maps and two listeners. The shared watcher only runs while the Claude list is
open or the fallback is enabled for some window; it was already used by the list.

## Limits

- Claude's real `--settings` hook delivery was not exercised against a real Claude session (tests use a fake that executes the configured
  hook commands with realistic payloads); the hook JSON shape (`hooks.<Event>[].hooks[] = {type: "command", command, timeout}`) is Claude Code's.
- Transcript heuristics can misjudge a long-running tool as a permission prompt (hence the delay) and miss a prompt that is answered quickly.
- No click callback for OS notifications (see above).
- Remote (mc) non-Ace sessions are only watched after an explicit opt-in.
