# Backlog (from integration testing, 2026-10-10)

## Found by driving the release build on ~/thematic-kyf
- [editor/keymap] ⌘L (GotoLine) not mapped → falls through to Monaco's expandLineSelection and typed text replaced line 1. Systemic: audit EVERY Monaco default keybinding against the IntelliJ macOS keymap; remove/override any whose meaning differs; map every IntelliJ editor action with a Monaco equivalent; swallow (no-op) IntelliJ-bound keys we don't implement rather than letting Monaco reinterpret them.
- [editor/keymap] double-⇧ (Search Everywhere) did not open (synthetic System Events shift taps; verify with the automation harness and with real keydown/keyup "Shift" sequences incl. repeat=false, no other key between, 300ms window).
- [editor] JetBrains Mono ligatures are ON; IntelliJ default is OFF (fontLigatures: false).
- [search] weak fuzzy matches shown (e.g. `audsaf` → `tools/audio_cache/say_f…aiff`). IntelliJ requires word-start/camel-hump anchored matches; drop scattered matches.
- [search] highlighted path segments render with gaps ("tools/ aud io/_cache") — inline highlight span has padding/margin.
- [shell] two identical magnifier icons in the left stripe (Find + Usages) — merge Usages into Find tool window (IntelliJ shows usages in Find) or give distinct icons.
- [tree] no VCS/ignored colouring in the Project tree (IntelliJ colours modified/new files and dims ignored dirs like .godot/build).

- [procs] CRITICAL: tracked children (headless Godot) survive when Ace gets SIGTERM/SIGINT/SIGHUP or crashes — RunEvent::Exit never fires. Fix: signal handler (signal-hook) → procs::kill_all + ssh::close_all → exit; spawn children in their own process group and kill the group; write a pidfile of tracked children (pid + start time) in the app data dir and reap stale ones on next launch (verify start time to avoid killing a reused pid).

## Carried over from module reports
- [terminal] add tauri-plugin-opener; route xterm web-links + any external URLs through it
- [terminal] verify ssh mc pty path for real (claude --resume over login_wrap)
- [terminal] backpressure on heavy output (e.g. `yes | head -c 200M`) — check UI stays responsive
- [terminal] per-project tab persistence (nice-to-have)
- [scaffold] actually render UI and exercise tree/editor/shortcuts (never seen running)
- [scaffold] ⌘K/⌘W precedence: terminal-focused capture vs global — confirm in app
- [claude] first local scan 3.5s (debug, 4.8GB JSONL): measure in release; persist (path,mtime,size) cache to app cache dir so cold start is warm; ensure it runs off main thread and UI shows cached list immediately
- [claude] "running" badge for plain `claude` (no --resume) is a heuristic — maybe match by most recently modified jsonl in cwd within last N seconds instead
- [lsp] src/editor/lsp/manager.ts had 2 tsc errors mid-build — recheck when LSP agent reports
- [remote] Remote Files panes don't watch their dirs (refresh on ops/focus only) — consider reusing remote::watch for the visible remote pane
- [remote] transfers: overwrite has no conflict prompt; add "Replace / Skip / Rename" like Cyberduck; speed+ETA
- [remote] non-GNU hosts unsupported (ls fallback not implemented) — fine for mc (Linux)
- [remote] fs_* commands are now async — check scaffold callers still behave (they were awaited anyway)
- [lsp] manager.ts:238 tsc errors reported by two agents — LSP agent says clean now; recheck
- [git] diff must be an editor TAB (IntelliJ parity): add doc.diff kind in EditorArea mounting git/DiffPopup.tsx DiffView; ⌘S inside diff saves the right side
- [actions] key conflicts resolved by registration order (runFirst) — make dispatcher context-aware: focused tool window actions > editor actions > global (⌘D in Commit = diff, in editor = duplicate; ⌘K/⌘W in terminal)
- [git] gutter markers vs unsaved buffer: diff HEAD content against model text in the frontend (cheap, already have git_show)
- [git] log graph (nice-to-have)
- [search] bench.rs:74 borrow error blocks cargo test for everyone
- [lsp] Godot headless cold start 10–17s: pre-warm when a project with project.godot at root opens (low priority background), not on first .gd open
- [lsp] Godot hover text starts with \t → strip leading whitespace before markdown render
- [lsp] run Rust bridge path (lsp_start/events) inside the real app once search bench compiles
- [daemons] mc reference scan hardcodes /opt/mc — make extra roots a setting
- [daemons] mc runs 2 Minecraft server JVMs: label them distinctly ("minecraft server") and require typed confirmation to kill; never included in any bulk action
- [daemons] status widget local-only — add mc count when a remote project/session is active
- [daemons] verify Stop on a throwaway daemon (start one in a scratch gradle project, then stop via UI)

## Final perf pass (done 2026-10-10, numbers in docs/PERF.md)
- [x] [lsp] headless Godot SIGSTOP after 20s without LSP traffic / focused .gd editor, SIGCONT before the next message; never touches a user-launched Godot on 6005; widget "GDScript: paused". Verified on Thematic: Godot 7% -> 0.00% CPU, resume + first completion 167 ms (warm 159 ms). Pause is skipped while a .gd tab is focused (Godot then idles at ~3-13%; it is an external tool).
- [x] [perf] re-measured with no other Ace/WebKit instance running (bench now locks the WebKit helper set 1.5 s after launch and records `webkitAlreadyRunning`).
- [x] [editor] clean background tabs beyond the 3 most recent lose their Monaco model (text + view state kept; edited/dirty models are kept so undo survives). Language workers were already lazy (only the editor worker exists with .gd/.md open). Saves little RSS (~10 MB), see PERF notes.
- [x] [terminal] webgl/canvas addons were already dynamic `import()`s loaded on first visible Terminal attach (separate chunks); xterm core stays in the main chunk (making `createSession` async would change the openTerminal contract).
- [x] [perf] sampled app + WebContent idle: remaining wakeups are WebKit's caret animation for a focused editable (not fixable from app code); unfocused window = 0.1% app+WebKit. Daemons/Claude/Processes pollers now also skip when the window is unfocused and catch up on focus.
- [x] [editor] Monaco hover/document links -> tauri-plugin-opener (`registerLinkOpener`, http(s)/mailto only).
- [x] [daemons] Stop live-tested on a throwaway Gradle 8.14 daemon (isolated GRADLE_USER_HOME): SIGTERM path terminated it in 669 ms, Alex's 9.8.0 daemon untouched. The `gradle --stop` path (UI default when a version is known) was not live-tested because it stops every daemon of that version in the real ~/.gradle.
- [ ] [git] log graph (deferred).
- [ ] [perf] keystroke p95 is 16-18 ms against a 16.7 ms budget (resolution ~1 ms); investigate LSP didChange work if it matters.
