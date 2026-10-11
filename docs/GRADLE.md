# Gradle (IntelliJ's Gradle tool window in Ace)

The **Gradle** tool window (right stripe) appears by itself for projects that have `settings.gradle(.kts)` / `build.gradle(.kts)` at the root
(local or `mc:`), like IntelliJ. Nothing Gradle-related runs for other projects (one directory listing at project open).

## Features
* Tree: root project > Tasks > groups (alphabetical, `other` last) > tasks; subprojects nested by path; task descriptions are tooltips.
* **Pinned** section at the top (and in the toolbar Run widget dropdown): context menu Pin / Unpin / Edit Arguments, toolbar pin button, drag to reorder.
  Pins live in the repo: `.ace/config.json` (see below) and reload when the file changes on disk.
* Run: double-click / Enter / context menu **Run** opens a *temporary Gradle run configuration* in the Run window (⌘4): output, clickable
  compile errors (`e: file:///x/Foo.kt:12:5`, `/x/Foo.java:12: error:`, `Build file '/x/build.gradle' line: 7`), Stop (⌘F2 = graceful cancel), Rerun.
  Context menu: Run, Create Run Configuration… (permanent config + Edit dialog), Pin/Unpin, Copy Task Path.
* **Execute Gradle Task** (Find Action; popup that fuzzy-matches the tasks of the build; text that matches nothing runs as a command line).
* Reload All Gradle Projects: toolbar button / Find Action / ⌘⇧I (`ExternalSystem.ProjectRefreshAction` from the keymap JSON).
* Sync errors show as an error node with the Gradle output (Retry).
* Status line: Gradle version, discovery time, `cached`, serving daemon pid.

## Keys
Everything comes from `src/keymap/intellij-macos.json` where an IntelliJ id exists. `ActivateGradleToolWindow` and Execute Gradle Task have no default key
in the keymap (IntelliJ's ⌃⌃ is *Run Anything*, not implemented), so none is bound.

| Keys | Action | Context |
|---|---|---|
| ⌘⇧I | Gradle.Refresh (Reload All Gradle Projects) | global (only in Gradle projects) |
| ⏎ | Gradle.RunSelected (task: run, container: expand) | Gradle window |
| ⌫ / ⌦ | Gradle.Unpin | Gradle window |
| ⌘C | Gradle.CopyPath | Gradle window |
| ⌘F2 / ⌘R / ⌘4 | Stop / Rerun / Run window | existing Run infra |
| – | Gradle.Pin, Gradle.ExecuteTask, ActivateGradleToolWindow | Find Action |

## `.ace/config.json`
```json
{
  "version": 1,
  "gradle": {
    "pinned": [
      { "task": ":app:run", "args": "--info", "name": "optional label" }
    ]
  }
}
```
`args` and `name` are optional. Created (with `.ace/`) on the first pin; pretty-printed with 2 spaces, `version` first, other keys keep their order, trailing newline.
Unknown keys and sections survive. An invalid file is never overwritten. Generic module and rules: docs/CONVENTIONS.md "Repo config".

## How discovery works (and why it is cheap)
1. `src-tauri/src/gradle/mod.rs` runs `./gradlew -q --console=plain --offline --no-configuration-cache -Dorg.gradle.configureondemand=false --init-script <ace-init.gradle> help`
   (else `gradle` from the login PATH; remote through `crate::remote::ssh` + login shell). The init script (`src-tauri/src/gradle/ace-init.gradle`) only reads
   projects/tasks/groups/descriptions in `projectsEvaluated` and prints one JSON line. Local: written to `<app data>/gradle/`; remote: a `mktemp -d` under `/tmp`, removed
   afterwards. Nothing is ever written into the project.
2. Fallbacks: no `--no-configuration-cache` for old Gradle; online retry only if the offline attempt failed with an offline/resolve-looking error.
3. **Daemons**: the normal shared daemon serves it. Never `--no-daemon`, never `--stop`, never `org.gradle.jvmargs`; the init script is not part of the daemon compatibility spec.
   One discovery per root at a time (Rust single-flight map); it is a tracked child of the window (`procs::register_killer_for`), so closing the window kills the client.
4. **Cache**: `pstore("gradle")` = model + fingerprint (cksum of settings/build/gradle.properties/wrapper properties, `gradle/*.gradle|kts|toml|properties|json`, buildSrc build files
   and the build files of every known subproject dir). On open the cache is shown instantly; discovery only starts when there is no cache or the fingerprint differs. The existing
   fs watcher (no polling) triggers a fingerprint check 500 ms after a build file changes. Files that only generate tasks indirectly (e.g. a `targets.json` read by a script) are
   not in the fingerprint: use Reload.
5. Run: the Run infra executes `if [ -x ./gradlew ]; then exec ./gradlew --console=plain <tasks> <args>; else exec gradle ...; fi` in the login shell. Stop sends SIGINT to the Gradle
   client pid only (the daemon cancels the build and survives), then SIGTERM/SIGKILL of that single pid after 10 s / 13 s. Remote: ^C through the pty, then the usual stop.
   Config type `gradle` fields: tasks, args, workingDir, env, enhancedHotswap (Debug only); the config may also carry `initScripts: string[]` (extra `--init-script` files).
   Debug mode: see "Debug runs & hot swap" below.

## Tests
`node scripts/qa/gradle.mjs` (scratch Gradle projects under TMPDIR, remote scratch dir on `mc` removed afterwards; `--no-remote`, `--thematic` = read-only discovery timing on
~/IdeaProjects/Thematic-Collections). Unit tests: `src/components/gradle/tree.test.ts`, `src/lib/repoConfig.test.ts`, `src/components/run/links.test.ts`.

## Not IntelliJ-faithful / missing
Included builds are listed in the model but not shown; no Dependencies node; no Run Configurations node; Run Anything (⌃⌃) is not implemented;
no task-selection-in-editor (gradle files), no "Show tasks from all projects" toggle. Debug runs: hot swap + a basic JDWP debugger (see below).

## Status
Verified (`node scripts/qa/gradle.mjs`, 29/29 incl. mc, against the release build): detection + stripe button, tree/groups/tooltips, no files written by discovery, cache hit without any
spawn (project switch and app restart), refresh on build-file change (and none for unrelated files), error node + recovery, run / rerun / Enter / compile-error links (Java, Kotlin file URL), graceful Stop with
daemons surviving, pin / unpin (exact JSON, key order, unknown keys kept, invalid file untouched, external edit reload), pinned tasks in the Run widget, Execute Gradle Task, actions + ⌘⇧I, remote discovery/run/pin on `mc`.
Idle memory (`scripts/qa/gradleperf.mjs`, 9 s idle, app + WebKit): plain 391 MB, Gradle project window closed 392 MB, window open 398 MB; no child processes, 0.0-0.1 % CPU.
Implemented but not exercised: online fallback after an offline failure, old Gradle without `--no-configuration-cache`, drag-to-reorder of pins, Edit Arguments dialog, Create Run Configuration, two windows on the same root.

## Debug runs & hot swap (Single Hotswap equivalent)
Debug (⌃D, ⌃⇧D on a Gradle task, gutter, Choose Debug Configuration) on a `gradle` configuration runs the build in the **Run window** as usual and opens a **Debug window** session
("Waiting for JVM…" until the game JVM opens its debug port, then "Attached to OpenJDK 64-Bit Server VM 21.0.4"). Then edit a `.java` file and press **⌘⇧F9** (IntelliJ `Compile`, title
"Compile and Reload File"; also "Reload Changed Classes" in Find Action and a button in the Debug window): only that file is compiled and its classes are redefined in the running JVM, no Gradle build.

### How the JVM gets the agent
`src/components/gradle/java` + `src-tauri/src/hotswap.rs` + `src-tauri/src/gradle/ace-debug.gradle`. For every Debug run Rust writes `<app data>/gradle/ace-debug-<port>.gradle` (removed when the session ends; never in the project) and the run
becomes `./gradlew --console=plain --init-script <it> <your tasks>`. The script uses `allprojects { tasks.withType(JavaExec).configureEach { … } }` only (no task is realized: Loom throws exclusive-lock errors when tasks are realized early):
* every `JavaExec`: `-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=127.0.0.1:<free port>` and `-Dace.jdwp=<port>` (the marker that identifies the game JVM). If another JVM of the same run already holds the port (parallel JavaExec), the agent is dropped at execution time instead of failing with "Address already in use".
* `Exec` tasks whose command is `gradlew` / `./gradlew` / `gradle` (the Forge layout `./gradlew -p versions/1.20.1/forge runClient`): `--init-script <same file>` is inserted right after the executable, so the nested build's JavaExec gets the agent too.
  `project.exec {}` / `ExecOperations` inside task actions are not covered.
* Ace polls 127.0.0.1:<port> with 150 ms → 2 s backoff for up to 30 minutes (Loom setup is slow), only while a debug session is waiting; handshakes and attaches; when the JVM exits it goes back to waiting (builds may run several JVMs), when the Gradle run ends the session ends.
Local projects only (a remote project reports an error). Configuration cache: the script is not configuration-cache friendly; Ace does not add `--no-configuration-cache` to your run (a cached configuration simply does not run the script, then the session times out).

### Compile and Reload File
1. Saves all, finds the Gradle build that owns the file (nearest ancestor with `settings.gradle[.kts]`, so a nested build such as `versions/1.20.1/forge` is its own build), and runs `aceDumpClasspath` there once per debug session and project
   (`ace-dump.gradle`: one task registered in the root project; offline first, online retry; `-q`, no other task runs). It reports, for the source set whose `java.srcDirs` contain the file: output dirs, `compileJava` classpath
   (Loom's named/mapped Minecraft jars included), release / source / target compatibility, `java.toolchain`, annotation processor path, `-parameters`/`--add-exports` args, encoding. Cached: later reloads take well under a second plus javac.
2. javac of the matching JDK (the toolchain major, else the smallest installed JDK that is new enough; `java_home -V`, ~/Library/Java, ~/.gradle/jdks, sdkman, IntelliJ's jbr) compiles ONLY that file into a temp dir:
   `-g --release N -proc:none -implicit:none -cp <source set output dirs>:<compile classpath>`; real annotation processors (Lombok …, i.e. a processor path that is not only Mixin's) run instead of `-proc:none`.
3. Every produced `.class` (outer, inner, anonymous) that is loaded in the VM is redefined in one atomic `RedefineClasses`; "Reloaded N classes" or the JVM error (ADD_METHOD_NOT_IMPLEMENTED etc. with a hint to enable Enhanced HotSwap). Classes not loaded yet are listed (a new class cannot be added to a running JVM).
4. **The build's own outputs are not touched** (nothing is copied into `build/classes`); the next Gradle build recompiles as usual. Compiler errors are printed with clickable `file:line` in the Debug window console and the Gradle run's Run console; the JVM is not touched.
5. `@Mixin` files compile (errors are reported) but are not redefined: a mixin class is merged into its target at load time, so reloading it changes nothing; a warning says so.
Unsaved edits: ⌘⇧F9 saves first. **Hot swap on save** (default off): Debug window button or Find Action "Toggle Hot Swap on Save"; stored per project in `.ace/config.json`: `{ "hotswap": { "onSave": true } }`.

### Enhanced HotSwap (per configuration)
"Use JetBrains Runtime with enhanced class redefinition" (Debug runs only): the JavaExec's `javaLauncher` becomes a JBR of the task's Java major (`java.toolchain`, else Gradle's own JVM major) found through the toolchain registry
(`-Dorg.gradle.java.installations.paths=<detected JBRs>`) and `-XX:+AllowEnhancedClassRedefinition` is added (`-XX:HotswapAgent=core` only if the JBR ships `lib/hotswap/hotswap-agent-core.jar`; nothing is downloaded). Detection: `java_home -V`, ~/Library/Java/JavaVirtualMachines,
~/.gradle/jdks, IntelliJ's bundled `Contents/jbr`. The dialog lists what was found; if a task's Java major has no JBR the task runs on its normal JDK and a note is printed. On a JBR, adding/removing methods and fields reloads; on a stock JDK only method bodies do.

### Stop and window close never kill a Gradle daemon
`procs.rs` filters the process table by command line (`org.gradle.launcher.daemon.bootstrap.GradleDaemon`, Kotlin compile daemon): the client and its non-daemon descendants are killed, the daemon and everything below it are skipped, and a process group that contains a daemon
is not `killpg`'d but signalled member by member. The game JVM (a child of the daemon, so not in the client's tree) is stopped by its `-Dace.jdwp=<port>` marker (`procs::kill_marked`, never a daemon); the same closure is registered per window, so closing the window stops it too.
Stop = Gradle cancel (SIGINT to the client) → marker kill of the JVM → session ends.

### Java debugger (basic)
The same JDWP connection drives the Debug window: **line breakpoints** (⌘F8 / gutter click in a `.java` file of a Gradle project; stored with the other breakpoints; breakpoints on classes that are not loaded yet are placed when the class loads via a ClassPrepare request;
invalid dots for lines without code), **stack frames** (source files found by package path in the project, shortest path wins; library frames are dimmed), **locals / `this` / fields / array elements** (primitives, `String`, boxed values inline, `Type@id` for objects, `int[3]@id` for arrays, first 300 children),
**Resume (F9) / Pause / Step Over (F8) / Step Into (F7) / Step Out (⇧F8)** (JDK classes are skipped when stepping into), the thread selector, simple evaluation (a local or field path such as `pt.x`, `arr[1]`, `this.items[0].name`) for hover and Watches.
The VM is suspended with SUSPEND_ALL (IntelliJ's default) and Compile and Reload File also works while stopped. Not supported: conditions, log messages, pass counts, exception breakpoints, arbitrary expression evaluation, Set Value, Run to Cursor, smart step into, field watchpoints.
Code: `src-tauri/src/jdwp_dbg.rs` (JDWP queries and the event worker), `src/components/gradle/java/session.ts` (adapter onto the Python debugger's session class and UI; the editor gutter and execution-line decorations are the shared ones, enabled for `java` once a Gradle project is detected).
The classpath/hot swap choice among several projects that compile the same shared source (Thematic's `src/common/java` is compiled by many) uses the running JVM's `java.class.path` (output dirs) first, then the projects whose tasks ran in the Run console; if neither tells, the deepest project is used and a warning says so.

### Not done (limitations vs Single Hotswap / IntelliJ)
No conditional / log breakpoints, exception breakpoints, general expression evaluation, Set Value, Run to Cursor, smart step into, or "reload all changed classes" (one file per invocation, like the plugin). Only project files that belong to a Java source set of the Gradle build can be reloaded (not library classes);
a class that is not loaded in the JVM yet is skipped (a new class cannot be added to a running JVM), `@Mixin` classes are compiled but not redefined, Kotlin/Groovy files are not handled, no remote (ssh) debugging. `project.exec {}` / `ExecOperations` that start gradlew inside a task action do not get the init script.

### Tests
`node scripts/qa/hotswap.mjs [--thematic]` (scratch project with a nested Exec build; `--thematic` = read-only classpath dump on ~/IdeaProjects/Thematic-Collections). Rust (`cd src-tauri && cargo test --lib`): `procs::tests` (daemon safety, marker kill), `jdwp::tests` (codec against a fake VM), `hotswap::tests` (JDK pick, nearest build, project choice, processors, init script rules); vitest: `src/components/gradle/java/pure.test.ts`.
`ATELIER_JDWP_TRACE=1` prints every JDWP packet to stderr.

### Status (debug runs / hot swap)
Verified with `node scripts/qa/hotswap.mjs --thematic` against the release build (43/43): Debug attaches ("Waiting for JVM…" then attached); method-body reload (same JVM pid) incl. inner + anonymous classes; classpath dump cached per session
(second reload ~0.4 s); build outputs untouched; compile error -> clickable `file:line` in the Debug and Run consoles, VM untouched; ADD_METHOD_NOT_IMPLEMENTED with the Enhanced HotSwap hint on a stock JDK; `@Mixin` warning; hot swap on save (+ persisted `.ace/config.json`, default off);
Enhanced HotSwap on a JBR 21 (add method / add field reload) and the fallback when no JBR exists for the Java version; nested `Exec ./gradlew -p nested` build attaches and reloads (own settings.gradle, own classpath dump); breakpoints (loaded class, not-yet-loaded class via ClassPrepare, ⌘F8),
frames, locals / arrays / objects, simple evaluate, Step Into / Over / Out, Pause, Resume, hot swap while stopped, Stop while stopped, Rerun; Stop and window close kill client + game JVM and leave every GradleDaemon alive (and `procs::tests::kill_spares_gradle_daemons`).
Read-only on ~/IdeaProjects/Thematic-Collections: the classpath dump + a dry-run javac of a file in `:1.20.1` (root main, Lombok + Mixin processor path), `src/common/java` (4 candidate projects), `:26.2:fabric` (Java 25) and the nested Forge build (Architectury Loom) all resolve and compile; git status and `.ace/` unchanged.
Implemented but not exercised: online dump retry, Gradle versions older than 7.3, Kotlin/Groovy build scripts for the nested Exec, `-XX:HotswapAgent=core` (no JBR here ships the agent jar), running the real Minecraft clients (not allowed in the QA), remote (ssh) projects (rejected with a message).
