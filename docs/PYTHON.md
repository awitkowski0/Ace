# Python (PyCharm features in Ace)

Ace replaces PyCharm for Alex: interpreters, Python language intelligence, run configurations with a toolbar widget, a debugger
(debugpy over DAP), a Python Console, pytest/unittest runner, a Packages window. IntelliJ's macOS keymap is PyCharm's keymap
(no `~/Library/Application Support/JetBrains/PyCharm*/keymaps` exists on this Mac), so every key below comes from
`src/keymap/intellij-macos.json`; only `ExecuteInPyConsoleAction` (⌥⇧E, PyCharm's documented default) is added as a `defaultKeys` fallback.

> Sections marked (status) are kept up to date at the end of the work: what is verified by tests, what is implemented but unexercised, what is missing.

## Architecture

```
Rust (src-tauri/src)                       TS (src/components)
 pstore.rs   per-project JSON (app data)    python/api.ts        typed wrappers for every command below
 runner.rs   run_start/run_write/run_stop   python/interpreter.ts pyStore: interpreters, selected one, probe, tools
             proc_exec (one-shot)           run/                 generic Run infra: config model, widget, Run window, console
 dap.rs      dap_start/send/stop            python/runtypes/     python-script, python-module, pytest, unittest, shell types
 python/     discovery, probe, tools,       python/interp/       status widget + popup + Add Interpreter dialog + terminal venv
             venv/conda, PyPI, scripts      python/lang/         LSP glue (basedpyright), ruff diagnostics, reformat, imports
 lsp/mod.rs  (bin override for pyright)     python/debug/        DAP client, breakpoints, Debug window, editor decorations
                                            python/console/      Python Console window + Execute Selection (+ notebook view)
                                            python/packages/     Packages window
                                            python/qa.ts         __qa.py() hooks (registerQa(area, obj))
```

* **Nothing Python spawns until it is needed.** `watchPythonProject()` (python/interpreter.ts) only stats marker files
  (pyproject.toml, setup.py, requirements.txt, Pipfile, .venv ...) or looks for an open `.py` doc. Only then `ensurePython()` runs
  discovery (a few `python --version` calls), probe and tool lookup. Language servers start on the first `.py` model (existing LSP manager),
  the debugger/console/test processes only on user action. No polling anywhere.
* **Per window.** Every child goes through `procs::register_for(window label)` (all Rust commands take `WebviewWindow`); events are window-scoped
  (`listen` from `lib/ipc`). Closing the window kills them (`windows::cleanup_window`).
* **Local and remote.** A `Spec { host, cwd, argv | shell, env, pathPrepend }` runs locally (piped child in its own process group) or on an ssh alias:
  `ssh -tt host bash -lc 'cd cwd && export ... && exec argv'` through `crate::remote::ssh` (login PATH), so killing the local ssh hangs the remote
  command up. Paths in a remote project are remote paths; the same code serves both.
* **Persistence.** `pstore.get/set(root, name)`: JSON in `<app data dir>/projects/<fnv(host:path)>/<name>.json` (NOT in the project, honours
  `ATELIER_DATA_DIR`). Names in use: `python` (interpreter choice + custom interpreters), `runconfigs`, `breakpoints`.
* **Bundled helpers** (never installed into an environment): `src-tauri/src/python/scripts/ace_pytest.py` (pytest plugin, loaded with `-p ace_pytest`,
  directory on PYTHONPATH via `pyApi.scriptsDir()`), `ace_unittest.py`, `ace_console.py`. They emit control events as lines
  `\x1e##ace:{json}` on the real stdout; the Run window strips these from the console.

## Rust commands (see python/api.ts)

| Command | Purpose |
|---|---|
| `py_discover(host, root)` | project venvs (.venv, venv, env; uv/poetry/pipenv aware), poetry/pipenv caches, conda (`~/.conda/environments.txt` + base), pyenv, uv pythons, system (login PATH, python.org, brew); remote: one ssh script |
| `py_probe(host, python)` | version, prefix, site-packages, module availability (pip, debugpy, pytest, IPython, ruff, ...) |
| `py_tools(host, python?)` | absolute paths: basedpyright-langserver, pyright-langserver, ruff, black, isort, uv, pipx, conda, poetry, pipenv (the interpreter's bin dir wins, then login PATH, ~/.local/bin) |
| `py_create_venv`, `py_create_conda` | `uv venv --seed` (else `python -m venv`, retry `--without-pip` remotely); `conda create -y -p` |
| `py_pypi_search/info` | exact JSON lookup + best-effort scrape of the search page; version list |
| `py_scripts_dir / py_script_source` | bundled helper scripts |
| `py_filter(root, argv, stdin)` | pipe text through ruff/black/isort |
| `run_start/run_write/run_close_stdin/run_stop/run_interrupt/run_alive`, `proc_exec` | processes (runner.rs) |
| `dap_start/send/stop` | DAP bridge (dap.rs); events `dap://msg|log|closed/<id>` |
| `lsp_start(serverId, root, autoGodot?, bin?, pathPrepend?)` | `bin` overrides the server executable (basedpyright from the venv) |

## Keys (all from the IntelliJ macOS keymap JSON unless noted)

| Keys | Action id | Context |
|---|---|---|
| ⌃R | Run | editor / tool windows (NOT the terminal: ⌃R stays shell history search) |
| ⌃D | Debug | same |
| ⌃⇧R / ⌃⇧D | RunClass / DebugClass (run/debug the config for the current file or test) | same |
| ⌃⌥R / ⌃⌥D | ChooseRunConfiguration / ChooseDebugConfiguration | same |
| ⌘F2 | Stop | global |
| ⌘R | Rerun | Run / Debug tool window (⌘R stays Replace in the editor) |
| ⌃⌘R | RerunTests | global |
| ⌘4 / ⌘5 | Run / Debug tool windows | global |
| ⌘F8 / ⌘⇧F8 | ToggleLineBreakpoint / ViewBreakpoints | editor |
| F8 / F7 / ⇧F8 / ⌥⇧F7 / ⇧F7 | Step Over / Into / Out / Force Step Into / Smart Step Into | while debugging |
| ⌥⌘R (F9) | Resume | while debugging |
| ⌥F9 / ⌥⌘F9 | Run to Cursor / Force Run to Cursor | while debugging |
| ⌥F8 | Evaluate Expression | while debugging |
| ⌥F10 | Show Execution Point | while debugging |
| ⌥⇧E | ExecuteInPyConsoleAction (Execute Selection in Python Console) | editor |
| ⌥⌘L / ⌃⌥O | Reformat Code (ruff format, else black) / Optimize Imports (ruff I, else isort) | editor |
| F1, ⌃J / ⌘P / ⌘B / ⌥F7 / ⇧F6 / ⌘F12 | Quick Documentation / Parameter Info / Go to Declaration / Find Usages / Rename / File Structure | editor (existing LSP actions) |
| Find Action (⌘⇧A) | Python Console, Python Packages, Edit Configurations…, Select Python Interpreter, Add Python Interpreter | – |

Verified by `scripts/qa/python.mjs` (see Status below).

## Run configuration infra (src/components/run)

Shared by Python now and Gradle / Godot configs later.

* `registerConfigType({ id, label, icon, fields, defaults, suggestName, resolve })`: `fields` is declarative (the Edit Configurations dialog renders
  them); `resolve(cfg, mode)` returns a `ResolvedRun` (`spec: RunSpec`, `title`, optional `debug: PythonDebugTarget`, `onOutput` stream filter,
  `panel` side component for tests).
* Config model `{ id, type, name, ...type fields }`, list + selected id persisted per project with `pstore("runconfigs")`.
* Toolbar widget replaces the `#run-widget-slot` placeholder: `[config ▾] ▶ 🐞 ■`. Run window (⌘4): tab per run, console with ANSI colours and
  clickable `File "x.py", line N` / `path:line` links, Rerun/Stop, stdin line input, multiple runs. Debug mode calls the launcher the debugger registered
  with `setDebugLauncher` (run/hooks.ts).

## Test hooks

`await __qa.py()` returns `{ <area>: {...} }` (each area calls `registerQa("area", {...})` from python/qa.ts). Suite: `node scripts/qa/python.mjs`
(areas in `scripts/qa/py/<area>.mjs`). Fast QA build: `scripts/qa/qabuild.sh` (separate target dir `src-tauri/target-qa`, serialised with a lock),
then `ATELIER_BIN=src-tauri/target-qa/release/atelier node scripts/qa/python.mjs --only <area>`.

## Interpreters and language intelligence (status, Agent D)

* Verified (scripts/qa/py/interp.mjs 18/18, lang.mjs 28/28): status widget, switcher popup, Add Interpreter dialog (Existing/Virtualenv/Conda-existing, remote mc venv),
  terminal venv activation (zsh via harness, bash via cargo test; setting `atelier.python.terminalActivate`), basedpyright from the interpreter's venv
  (completion/hover/F1/⌘B project + site-packages/⌥F7/⇧F6 multi-file/⌘P/⌘F12/Go to Symbol/diagnostics), ruff diagnostics + quick fixes, Reformat Code
  (ruff, range, black fallback), Optimize Imports (ruff, isort fallback), interpreter switch restarts the server, explicit "Install basedpyright" flow.
* Not exercised: creating a NEW conda env, remote ruff/black (mc has neither), bash activation in the app (cargo test only), terminal activation for remote hosts (skipped by design).
* Missing vs PyCharm: LSP for remote projects, no LSP formatter fallback in practice (basedpyright has none), semantic highlighting.

## Status (final build)

Suites against `pnpm tauri build --bundles app`: smoke 12/12, multiproject 24/24, terminal 35/35 (incl. ssh), `node scripts/qa/python.mjs` 167/167
(each area in its own app + scratch venv: lang 28, run 29, tests 21, debug 32, console 21, packages 13, interp 18, keys 5), `node scripts/qa/python-remote.mjs` 6/6
(mc: project detection, run over ssh, traceback link, stop leaves nothing, debugpy session with breakpoint/step/resume on mc via a scratch venv), vitest 136, cargo 26 (+4 ignored).
The suite is timing sensitive when the Mac is loaded (an IntelliJ build pushed load to ~25 and made a few checks flake; they pass on retry).

Idle memory (`scripts/qa/pyperf.mjs`, 9 s idle): plain project 382 MB (app + WebKit), Python project with a .py open and basedpyright running 429 MB + ~203 MB for the language server
(node) and its launcher. No Python process exists until a Python project/file is open; the server stops after the existing 10 minute idle timeout.

Not done / different from PyCharm: Jupyter notebook view (stretch, not started); LSP for remote projects (mc has no Python tooling; the bridge is local-only); remote
pytest uses the plugin passed through `python -c` (verified locally only); Force Step Into = Step Into; Run to Cursor via a one-shot breakpoint; no coverage, no "Run with
Python Console", no profiler, no Django/Flask run types, no debug "suspend policy", no remote interpreters over SFTP deployment mapping (a remote project simply uses the host's
interpreters); the console has only word-based completion; the interpreter widget sits left of line:col.
