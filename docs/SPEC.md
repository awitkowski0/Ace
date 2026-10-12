# Ace — spec (v1)

A Tauri 2 desktop IDE for macOS that feels like IntelliJ IDEA for Alex's projects
(Thematic = Godot/GDScript at ~/thematic-kyf, plus Rust/TS/Python/Java side projects),
with first-class remote work on the `mc` SSH host and a built-in Claude Code session manager.

Not a goal: parity with IntelliJ. Never decompile or copy JetBrains proprietary code.
IntelliJ Community (Apache-2.0) and the keymap XML shipped in the app bundle are fine to reference.

## Stack
- Tauri 2, Rust backend (`src-tauri/`), React 18 + TypeScript + Vite frontend (`src/`), pnpm.
- Editor: Monaco (`@monaco-editor/react`). Terminal: xterm.js + `portable-pty` in Rust.
- SSH/SFTP: `russh` + `russh-sftp` (or shell out to system `ssh`/`sftp` using ~/.ssh/config — the
  `mc` alias is `alexw@87.86.80.32`, key auth already works via `ssh mc`). Prefer system `ssh`
  with ControlMaster multiplexing for v1: it honours ~/.ssh/config, agent and known_hosts for free.
- Search: `ignore` + `grep-searcher` crates (ripgrep internals).
- Git: shell out to `git` (status, diff, stage, commit, branch).
- Theme: Nord (dark default) — Alex uses nord-jetbrains.

## Core concept: Workspace roots are local OR remote
Every path in the app is a `Location { host: "local" | "mc" | <ssh alias>, path: string }`.
A single `fs` Rust module implements read/write/list/stat/rename/delete/watch for both backends
(local = std::fs + notify; remote = SFTP over ssh, watch = polling or `inotifywait` over ssh if present).
The editor, file tree, search, terminal and Claude panel all take a Location so the same UI works
"hybrid": e.g. edit Thematic locally while a Claude session runs on mc against a server repo.

## Features (v1)
1. Project window: open folder (local or `mc:/path`), recent projects, file tree (create/rename/delete/drag).
2. Editor tabs with Monaco, split right/down, dirty markers, save, reload-on-external-change.
3. Language support: Monaco built-ins for TS/JS/JSON/CSS/HTML/MD; LSP bridge in Rust (stdio or TCP)
   for GDScript (Godot editor LSP on TCP 127.0.0.1:6005), rust-analyzer, pyright, gopls when present.
   Features: diagnostics, hover, go-to-definition, completion, rename.
4. Search Everywhere (double ⇧), Go to File (⌘⇧O), Find in Files (⌘⇧F) with results panel, Find Action (⌘⇧A).
5. Terminal tool window (⌥F12), multiple tabs, local or `ssh mc` shells.
6. Git tool window (⌘9 / commit ⌘K): changes list, diff view (Monaco diff editor), commit, branch switch.
7. Remote Files tool window ("Cyberduck built in"): two-pane local ⇄ remote browser over SFTP for any
   ~/.ssh/config host; upload/download (drag between panes), progress, rename, delete, chmod,
   new folder, open remote file in editor (edits saved back over SFTP), bookmarks.
8. Claude tool window:
   - Lists sessions for local (`~/.claude/projects/<path-with-slashes-as-dashes>/*.jsonl`) AND mc
     (same layout under remote `~`), grouped by project, showing first user prompt, last activity, size.
   - Actions: New session (in project root), Resume (`claude --resume <id>`), Continue (`claude -c`),
     open in a terminal tab; remote ones run via `ssh -t mc 'bash -lc "cd <dir> && claude --resume <id>"'`
     (claude is not on non-login PATH on mc — always use a login shell).
   - Sessions view auto-refreshes; badges for currently-running sessions.
  - AI Sessions is the 2nd view of the Project window; ⌃⌥A flips Files <-> AI; "Claude finished / needs input" notifications: docs/AI-SESSIONS.md.
9. Keymap = IntelliJ "Mac OS X 10.5+" plus Alex's overrides from
   ~/Library/Application Support/JetBrains/IntelliJIdea2025.1/keymaps/macOS copy.xml
   (RenameElement: shift F6 and `p`; only the first is applied in-editor, `p` only when editor not focused).
   Keymap is data: `src/keymap/intellij-macos.json` (actionId -> shortcuts), mapped to Ace
   actions via a registry. Unmapped IntelliJ actions are ignored. Settings UI can rebind.
10. Tool window layout like IntelliJ: left (Project ⌘1 with its second view AI Sessions ⌃⌥C, Remote Files), bottom (Terminal, Find, Git,
    Problems ⌘6), stripes with toggles, resizable, state persisted per project.

## Module ownership (parallel agents must stay inside their files)
- `src-tauri/src/fs/`, `src-tauri/src/remote/` — Location, local+SFTP backends, transfers
- `src-tauri/src/pty.rs`, `src/components/terminal/`
- `src-tauri/src/search.rs`, `src/components/search/`
- `src-tauri/src/git.rs`, `src/components/git/`
- `src-tauri/src/lsp/`, `src/editor/lsp/`
- `src-tauri/src/claude.rs`, `src/components/claude/`
- `src/components/remote-files/`
- `src/keymap/`, `src/actions/`
- Shared/central (scaffold owner only, others append via clearly marked registration points):
  `src-tauri/src/lib.rs` command registration, `src/App.tsx` layout, `src/toolwindows/registry.ts`.

## Feel parity with IntelliJ (hard requirement)
Alex wants it to *feel* exactly like IntelliJ IDEA 2026.1 New UI. Every agent must match:
- Layout/chrome: New UI main toolbar (project widget, VCS branch widget, run widget slot), 40px tool window
  stripes with icon-only buttons, tool window headers with title + options/hide buttons, thin 1px Nord separators,
  status bar with breadcrumbs/line:col/encoding/branch.
- Popups: Search Everywhere/Go to File/Find Action are centered-top floating popups with tabs
  (All, Classes, Files, Symbols, Actions, Text), fuzzy camel-hump matching, ↑↓/Enter/Esc, ⇥ cycles tabs,
  recent files when empty. Find in Files is a resizable popup with live preview pane, not a sidebar.
- Behaviour: ⌘E Recent Files switcher, ⌃⇥ Switcher, Esc returns focus to editor, ⌘1/⌥F12 toggle-focus semantics
  (pressing again hides the tool window), ⇧Esc hides active tool window, double-⇧ timing ~300ms,
  editor tabs: ⌘W close, middle-click close, ⌃⇧→ etc., caret/selection/multi-caret (⌥⌥↓) like IntelliJ,
  ⌘D duplicate line, ⌘⌫ delete line, ⌥↑ extend selection, ⌘/ comment, ⌥⌘L reformat.
- Typography: JetBrains Mono 13px editor, Inter/SF 13px UI, IntelliJ spacing and row heights (24px tree rows).
- Interactions use the keymap JSON; no browser-default shortcuts leak (disable webview context menu, reload, zoom).

## Efficiency budgets (validated before "done")
Measured on Alex's Mac against ~/thematic-kyf, with `scripts/bench.sh` producing `docs/PERF.md`:
- Cold start to interactive editor < 1.0s; idle RSS of Ace + its WebKit helpers < 500MB with 10 tabs open; idle CPU
  < 0.3% (app + WebKit) while the window is unfocused.
  Amended after the final perf pass (docs/PERF.md): (a) the original 250MB "all processes" figure is below WKWebView's own
  floor (a bare window is ~355MB: ~245MB WebKit + ~110MB app; the first Monaco editor adds ~50MB), and external tools Ace
  launches (headless Godot ~2GB on Thematic, rust-analyzer, gradle, ...) are excluded the way IntelliJ's JVM children are not
  counted against the IDE: they are suspended when idle (Godot: SIGSTOP after 20s without LSP traffic or a focused .gd editor)
  and reaped after 5 minutes without a session. (b) A focused editable element in WKWebView on macOS 26 costs ~2-7% of a core
  (display-link driven caret animation, reproduced with a bare <textarea>), so "idle CPU" is judged with the window unfocused.
- Open file < 50ms; keystroke-to-paint < 16ms; Search Everywhere first results < 100ms; Find in Files over
  Thematic < 300ms; file tree for 10k files virtualized (no full DOM render).
- No polling when idle (fs watchers/events only; remote watch backs off); background work cancellable.
- Release build: LTO, `opt-level=3`, `strip`, `panic=abort`; Monaco workers lazy-loaded; bundle size reported.
- Every spawned child (pty, ssh, LSP, claude) is tracked in a process registry and killed on window/app close.

## Processes & Daemons tool window (⌘⇧D)
Local + `mc` (over ssh), refreshed on open and every 5s only while visible:
- Gradle daemons (`org.gradle.launcher.daemon.bootstrap.GradleDaemon`), Kotlin compile daemons, other JVMs,
  language servers, Claude CLI processes, Ace's own children. Columns: PID, kind, version, RSS, CPU, uptime,
  idle/busy, project dir (from cwd via `lsof -a -d cwd -p` / `/proc/<pid>/cwd`).
- Actions: Stop (graceful: `gradle --stop` with the matching wrapper version, else SIGTERM → SIGKILL after 5s),
  Stop all idle, Kill selected, Stop all Gradle on host.
- Cleanup panel: sizes of ~/.gradle/daemon/<ver> (logs/registries for versions no longer running),
  ~/.gradle/caches (with per-subdir breakdown), wrapper dists unused by any project in IdeaProjects/;
  "Clean" buttons with a confirmation listing exactly what gets deleted. Never delete caches for running daemons.
- Status bar widget: total daemon count + RSS, click to open the window.
