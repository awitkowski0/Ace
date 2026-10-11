# Godot (run, debug and tools for GDScript projects in Ace)

For projects with `project.godot` at the root (local only). Nothing spawns until you run something; the Godot and Structure tool windows only exist in such projects.
Test hooks: `await __qa.godot()` (+ `__qa.py().debug` for the debugger). Suite: `node scripts/qa/godot.mjs` (scratch project, all games headless),
`node scripts/qa/godot.mjs --thematic` (read-only acceptance on ~/thematic-kyf).

## Run configuration types
`Godot: Run Project`, `Godot: Run Scene`, `Godot: Run Script` (`--script res://x.gd`, args after `--`). Fields: scene / script, program arguments, headless, **time limit**
(seconds; only that process is stopped, like `tools/run_godot.sh`), **instances** + **per-instance arguments** (one line per instance, e.g. `host` / `client`; each instance gets its
own Run tab, Stop / Rerun on any tab act on the whole group), extra Godot arguments, `--verbose`, window size / position, "connect the debugger" (live reload), env, project
directory, Godot executable (default: login PATH, `/opt/homebrew/bin/godot`, `Godot.app`; project-wide override: Godot > Set Godot Executable…). Debug runs the first instance only.

## Presets, scripts, pinning
Godot tool window (right stripe): Pinned, Project (Run Project), Scenes (main scene, recent, All Scenes), Presets, Scripts. Enter / double-click / context menu runs; context menu has Debug,
Create Run Configuration…, Pin / Unpin, Open in Godot Editor, Copy res:// path.
* **Presets** come from the README "Dev tools" code block: `tools/run_godot.sh <secs> <args>  # comment`. The comment is the name, `<secs>` the time limit, `--headless`, `--script`,
  scene, `--` arguments are parsed; one `a|b` token among the script arguments (`host|client`) becomes one instance per alternative.
* **Scripts**: every `.gd` under a `tools/` directory (outside `addons/`) whose head has `extends SceneTree` / `MainLoop`. Scripts under `tools/sim/` default to headless.
* **Pins** live in `.ace/config.json`, section `godot` (`{"pinned": [...]}`, each entry self-contained: `type` project|scene|script, `name`, `scene`, `script`, `headless`, `timeLimit`, `args`,
  `scriptArgs`, `instanceArgs`, `resolution`, `verbose`) and are also in the toolbar Run widget dropdown. With no configuration but pinned items the widget opens the dropdown (Pinned section);
  picking one selects it so ⌃R runs it.

## Output
`res://path.gd:123` is a link in the Run window (res:// = the project directory). `ERROR:` / `WARNING:` / `SCRIPT ERROR:` / `Parse Error:` blocks are coloured and collected into the
Problems window's **Run** tab, grouped by run (click to jump). ANSI colours pass through.

## Debugging: the remote debugger, not DAP
Godot's DAP server (`--dap-port`) only exists inside the editor process and launches games through the editor. It does work headless (verified: breakpoint stop over DAP with
`godot --editor --headless --dap-port N`) but needs a second ~2 GB editor next to the LSP one, only launches scenes (no `--script` sims), prints `Dictionary::operator[]` engine bugs while
doing it, and merges stdout/stderr. Ace therefore speaks Godot's **remote debugger protocol** (what the editor uses with a running game): Ace listens on a localhost port,
the game is started as an ordinary Run process with `--remote-debug tcp://127.0.0.1:<port> --breakpoints res://a.gd:12,...`. `src-tauri/src/godot/` decodes/encodes Godot's binary Variants;
`src/components/godot/dapShim.ts` presents it as a DAP client so the existing Debug window, gutter (⌘F8), stepping and watches are reused. The SIGSTOP/idle logic of the LSP's headless editor is
irrelevant (no editor involved).
Supported: gutter breakpoints (set before launch via the command line, later via messages), conditional breakpoints (evaluated on hit), stack frames, locals / members / globals, expandable
arrays / dictionaries / vectors / objects (inspector), evaluate / watches / hover, step over / into / out (F8 / F7 / ⇧F8), resume (⌥⌘R), run to cursor, runtime script errors stop like exceptions
(Stop kills the game). Works for scenes and `--script` runs. Not supported: log-message / pass-count breakpoints, changing variables, pause-on-error toggle.

## Conveniences
* **Open in Godot Editor** (`godot --path . -e <current scene>`), detached and never killed by Ace.
* **Reimport Godot Assets**: `godot --headless --path . --import` in the Run window.
* **Reload Scripts in Running Game** (⌘F10, IntelliJ "Update Running Application"): saves, then sends the `.gd` files changed since the game connected / last reload to every connected game
  (debug sessions and runs with "connect the debugger", default for project / scene runs). A plain run attaches with `--ignore-error-breaks` and auto-continues `breakpoint` statements.
* **Structure** (⌘7) and **File Structure** (⌘F12): node tree of a `.tscn` (types, scripts, instanced scenes); other files show the language server's symbols.
* ⌃R / ⌃D run / debug the selected configuration; ⌃⇧R / ⌃⇧D on an open `.tscn` run it, on a `SceneTree` script run the script, on a script attached to a scene run that scene.

## Not in Ace (vs the Godot editor)
No remote scene tree / live property edits, no profiler / monitors, no break-on-error toggle, no breakpoint on `.tscn`/`.tres` resources, remote (`mc`) projects, per-script hot reload of
exports state. Reimporting while the LSP's headless editor has the project open shares `.godot/`.
