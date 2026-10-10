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
- Remote fs (owned by remote agent): `fs.*` commands work for any `Location` whose host is an ssh alias.

## Automation harness (for testing — NEVER drive the real keyboard)
Do not use osascript/System Events keystrokes or mouse automation: they hit whatever window Alex has focused.
Instead (being built by the harness agent; contract fixed here):
- Launch: `ATELIER_AUTOMATION=1 src-tauri/target/<profile>/atelier <path-or-host:/path>`. Only with that env var, the app
  listens on a unix socket (`$ATELIER_AUTOMATION_SOCK`, default `$TMPDIR/atelier-automation.sock`, mode 0600). Without it, no socket.
- `node scripts/qa/eval.mjs '<async JS body>'` runs JS in the webview and prints the JSON-serialised return value.
  Helpers on `window.__qa`: `key("meta L")` (IntelliJ keystroke syntax, dispatched as real-shaped keydown/keyup on the
  focused element), `tap("Shift")`, `type(text)` (Monaco: via `editor.trigger("keyboard","type",{text})`; inputs: value+input
  event), `waitFor(selectorOrFn, ms)`, `state()` (project, open tabs + dirty flags, active tool windows, focused area,
  open popup id, cursor position), `actions()` (registered action ids + resolved keys), `sleep(ms)`.
- `scripts/qa/shot.sh <name>` captures the Atelier window (works while unfocused) into `scripts/qa/out/<name>.png`.
- QA runs that open Alex's real projects must never save: check `state()` has no dirty tabs before closing, and
  `git -C <project> status --porcelain` before/after must be identical.
