# Atelier conventions (read before changing code)

Several agents work in this tree at the same time. Stay inside the files you own (see SPEC "Module ownership").

## Shared-file etiquette
- `src-tauri/src/lib.rs`: add `module::cmd,` lines only inside your `// == <module> ==` block in
  `generate_handler![]`; managed state goes under `// == <module> == (state)`. Add `mod x;` near the top only if new.
- Dependencies: `cargo add <crate>` (in src-tauri) / `pnpm add <pkg>` — never hand-edit Cargo.toml/package.json/lockfiles.
  If a command or Edit fails because someone else changed the file, re-read and retry.
- Capabilities: `src-tauri/capabilities/default.json` (append only).
- Do NOT `git commit`, `git stash`, `git checkout`, or reformat files you don't own. Do not run `pnpm tauri dev`.
- Verify with `pnpm tsc --noEmit` and `cd src-tauri && cargo check`. If errors are in another module's files, report them; don't fix them.

## Rust
- Commands: `#[tauri::command] pub fn x(...)` in your module; structs `#[serde(rename_all = "camelCase")]`.
- Paths are `crate::Location { host, path }` — host `"local"` or an ssh alias such as `"mc"`.
- Every spawned child: `crate::procs::register(kind, label, child)` or `procs::register_killer(...)` (portable-pty).
- Remote hosts: ALWAYS go through `crate::remote::ssh` (`command(host, tty)`, `exec`, `exec_login`, `quote`,
  `login_wrap`). It multiplexes one ControlMaster connection per host. On `mc`, tools like `claude`/`gradle`/`rg`
  are only on the login PATH — use `exec_login` / `login_wrap`. `remote_hosts()` lists ~/.ssh/config aliases.
- Long work runs off the main thread (`tauri::async_runtime::spawn_blocking`) and is cancellable; stream results with events
  named `<module>://<event>`.

## Frontend
- IPC: `import { invoke, listen, fs, Location, local } from "src/lib/ipc"`; put your typed wrappers in your module.
  `fs.onChanged(cb)` receives `{root, paths, kind}` for `fs://changed`.
- Tool windows: in `src/components/<module>/register.tsx` call
  `registerToolWindow({id, title, icon, side, shortcut?, actionId?, order?, component: ({root}) => ..., headerActions?})`.
  `Activate<Id>ToolWindow` is auto-registered with IntelliJ toggle-focus semantics; mark the focus target `data-autofocus`.
  Status bar: `registerStatusWidget({id, side, order, component})`; branch: `setBranch(name)` from `lib/shell.ts`.
- Actions: `registerAction({id, title, run, intellijId?, defaultKeys?, isEnabled?, context?})` from `actions/registry`. Keys come from
  user override → `src/keymap/intellij-macos.json[intellijId]` → `defaultKeys`. `isEnabled() === false` lets the key fall
  through to Monaco. Chords, `"shift shift"` and `"alt alt DOWN"` (double-tap + hold) are supported.
- Action `context` (IntelliJ precedence **popup > focused tool window > editor > global**, default `"global"`):
  `"editor"` = only while focus is in an editor group; `{toolWindow: "<id>"}` = only while that tool window has focus (use this
  for ⌘D/⌘K/⌘W/⌘T style keys that clash with editor/global actions); `"popup"` = only while a popup is open. While a popup is open,
  editor and tool-window scoped actions are inactive. Keep `isEnabled` for extra conditions.
- Monaco keybindings: `src/keymap/monacoPolicy.ts` removes every Monaco default that IntelliJ binds differently (audit table in
  `docs/KEYMAP-AUDIT.md`, enforced by `src/keymap/monacoAudit.test.ts`). To give a key to a new editor action, register it with
  `context: "editor"`; if it should run a Monaco command add it to `src/editor/editorActionDefs.ts`.
- Popups: ids SearchEverywhere, GotoFile, GotoAction, FindInPath, RecentFiles, Switcher. `registerPopup(id, Component)`,
  `openPopup(id)`, frame with `<PopupShell>`. Also `promptDialog`, `confirmDialog`, `showContextMenu`.
- Editor: `openFile(loc, {line, col, select?})` (no polling needed: the caret moves when the model mounts; `select` = char count or
  `{endLine,endCol}`), `openDiff(spec: DiffSpec)` (diff as an editor tab; ⌘S saves the right/working side), `saveAll`,
  `splitActive("right"|"down")`, `navigateBack/Forward`, `editorStore`; `activeEditor()`, `triggerEditor(cmd)` in
  `editor/editorRegistry.ts`; Monaco instance from `editor/monacoSetup.ts`.
- Theme: Nord CSS variables in `src/styles/theme.css`. Match IntelliJ New UI spacing (24px rows, 13px UI font).

## Cross-module contracts
- Terminal (owned by terminal agent) exports from `src/components/terminal/api.ts`:
  `openTerminal(opts: { host: string; cwd: string; command?: string; title?: string; login?: boolean }): string` (tab id)
  — opens/focuses the Terminal tool window and starts a new tab. `command` runs in place of an interactive shell;
  for remote hosts it is run via `login_wrap` so `claude` resolves on mc.
- Terminal internals (splits, tabs, shell integration, Ghostty parity, key table): `docs/TERMINAL.md`. Terminal actions use `context: {toolWindow: "terminal"}`; test hooks for the
  automation harness are `await __qa.term()` (`src/components/terminal/qa.ts`), suite `scripts/qa/terminal.mjs`. The harness uses a private NSPasteboard (`ATELIER_AUTOMATION`).
- Claude sessions / notifications (flip ⌃⌥A, hook channel, transcript fallback): `docs/AI-SESSIONS.md`; test hooks `await __qa.ai()`, suite `scripts/qa/ai.mjs`. `setSpawnHook` (`terminal/spawnHook.ts`) lets a module add a `hookFile` to pty spawns; `tabDecor.badge` (terminal/sessions.ts) and `setToolBadge` (toolwindows/registry.ts) draw tab / stripe badges.
- Remote fs (owned by remote agent): `fs.*` commands work for any `Location` whose host is an ssh alias.

## Automation harness (for testing — NEVER drive the real keyboard)
Do not use osascript/System Events keystrokes or mouse automation: they hit whatever window Alex has focused.
Instead (being built by the harness agent; contract fixed here):
- Launch: `ATELIER_AUTOMATION=1 src-tauri/target/<profile>/atelier <path-or-host:/path>`. Only with that env var, the app
  listens on a unix socket (`$ATELIER_AUTOMATION_SOCK`, default `$TMPDIR/atelier-automation.sock`, mode 0600). Without it, no socket.
- `node scripts/qa/eval.mjs '<async JS body>'` (the request ends with a NUL byte; Node's `socket.end()` alone sometimes never delivers FIN, which used to surface as random "client timeout"s) runs JS in the webview and prints the JSON-serialised return value.
  Helpers on `window.__qa`: `key("meta L")` (IntelliJ keystroke syntax, dispatched as real-shaped keydown/keyup on the
  focused element), `tap("Shift")`, `type(text)` (Monaco: via `editor.trigger("keyboard","type",{text})`; inputs: value+input
  event), `waitFor(selectorOrFn, ms)`, `state()` (project, open tabs + dirty flags, active tool windows, focused area,
  open popup id, cursor position), `reset(path?)` (baseline: no popup, Project visible, no right/bottom tool window, `path` open + focused; smoke calls it before every check), `models(evict?)` (live Monaco models), `actions()` (registered action ids + resolved keys), `sleep(ms)`.
- Multi-project: one project per window (`project-<n>`), native macOS tabs. Requests may target a window with an optional FIRST line
  `{"window":"project-2"}` before the JS body (`node scripts/qa/eval.mjs --window project-2 '...'`, lib.mjs `app.evIn(label, body)` /
  `app.ev(body, {window})`); default = the active (last focused) project window. `__qa.windows()` lists windows (tab order, project,
  focused), `__qa.winDebug()` returns AppKit facts (tabbingIdentifier, tabbingMode, tabbedWindows, Window-menu titles), `__qa.openFlow(path, mode?)`
  is the user-level open (dedupe + This/New Window dialog), `__qa.runAction(id)`, `__qa.listen` (the window-scoped listen). Harness launches get their own
  `ATELIER_DATA_DIR` (session.json) and single-instance identity (derived from the automation socket), so they never touch a real Atelier;
  a second `atelier <path>` with the same env joins the first instance. `scripts/qa/multiproject.mjs` is the multi-project suite.
- `scripts/qa/shot.sh <name>` captures the Atelier window (works while unfocused) into `scripts/qa/out/<name>.png`.
- QA runs that open Alex's real projects must never save: check `state()` has no dirty tabs before closing, and
  `git -C <project> status --porcelain` before/after must be identical.

## Multi-project windows (read before adding events/commands)
- Frontend `listen` (from `src/lib/ipc.ts`) is window-scoped. Never import `listen` from `@tauri-apps/api/event`: its default `Any` target also receives `emit_to(other window)`.
- Rust: a command that spawns work or streams events takes `window: tauri::WebviewWindow` and emits with `windows::emit_window(app, label, event, payload)`
  (or `emit_windows` for a shared resource's label set). Children: `procs::register_for(label, ..)` / `register_killer_for`, so closing the window kills them
  (`procs::kill_owner`); plain `register*` = owner "app" (killed on quit only). Shared resources (fs watcher, search index, Godot per root, ssh master, claude
  watcher) keep a set of window labels and expose `release_window(label)`, which `windows::cleanup_window` calls on close.
- No menu accelerators for keys owned by the JS keymap (they would be consumed by AppKit before the webview). Window state/session: `src-tauri/src/windows.rs`.

## Repo config: `.ace/config.json`
Shared, repo-scoped settings (committed to git by the team) live in ONE file at the project root: `.ace/config.json` (local or remote). Everything else
Ace stores per project stays in the app data dir (`pstore`), never in the repo. Module: `src/lib/repoConfig.ts`.
- Schema: `{ "version": 1, "<section>": { ... } }`, one top-level section per feature (`gradle` today). Unknown keys/sections are kept.
- API: `ensureRepoConfig()` once (non-render code; starts the watcher + first read), then `repoSection<T>("key")` → `{get, set, subscribe}` or
  `useRepoSection<T>("key")` in React; `setRepoSection(key, value)` is a read-modify-write of the whole file (an edit made by git/an editor
  meanwhile is not lost), pretty-printed (2 spaces), `version` first, other keys in their existing order, trailing newline, so diffs stay clean.
- The file/dir is only created on the first write. A file that is not valid JSON is never overwritten (the error is in `repoConfigStore`).
- External edits (pull, editor) reload automatically through the existing fs watcher; our own writes do not echo.
- Never write other files into the project. Sections in use: `gradle.pinned`, `hotswap.onSave` (docs/GRADLE.md).
