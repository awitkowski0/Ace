#!/usr/bin/env node
// node perf-report.mjs bench.json docs/PERF.md  -> renders the measured numbers vs SPEC budgets.
import fs from "node:fs";
const [, , inp, out, beforeInp] = process.argv;
const r = JSON.parse(fs.readFileSync(inp, "utf8"));
const b = beforeInp && fs.existsSync(beforeInp) ? JSON.parse(fs.readFileSync(beforeInp, "utf8")) : null; // baseline run from before the perf pass
const f = (n, d = 0) => (n == null ? "n/a" : Number(n).toFixed(d));
const row = (metric, value, budget, pass, method, fix = "", before = "") => {
  const v = pass ? value : `**${value}**`;
  return `| ${metric} | ${before || "-"} | ${v} | ${budget} | ${pass ? "ok" : "**MISS**"} | ${method}${!pass && fix ? `<br>**Fix:** ${fix}` : ""} |`;
};
const rows = [];
rows.push(row("Cold start to interactive editor", `${r.cold.medianMs} ms (runs: ${r.cold.runs.join(", ")})`, "< 1000 ms", r.cold.medianMs < 1000,
  "T0 = wall clock just before `spawn(atelier <project>)`; as soon as `window.__qa` answers on the socket the harness opens a file and waits for Monaco to hold its content + one presented frame (rAF + MessageChannel); end = `performance.timeOrigin + performance.now()` of that frame. Median of N runs, warm disk cache (first run is the coldest). Includes <=~20 ms of socket polling skew. Webview+React ready (harness available) at median " + r.cold.qaReadyMedianMs + " ms.",
  "lazy-load Monaco workers/languages, trim the 3.9 MB monaco chunk, defer non-visible tool windows",
  b && `${b.cold.medianMs} ms`));
const t = r.rss10Tabs;
const bt = b?.rss10Tabs;
rows.push(row("RSS: app + WebKit helpers, 10 tabs, idle", `${f(t.totalNoChildrenMB)} MB (app ${f(t.appMB)} + WebKit ${f(t.webkitMB)} over ${t.webkitProcs} procs; ${r.liveModels ?? "?"} live Monaco models)`, "< 500 MB (was < 250 MB, see SPEC)", t.totalNoChildrenMB < 500,
  "`ps -o rss=` summed over the app pid and the WebKit helper processes (WebContent, GPU, Networking) that appeared between just before launch and 1.5 s after the window was ready (XPC services with ppid 1; the set is locked then, so a WebKit app started later cannot be counted; `webkitAlreadyRunning`=" + (r.webkitAlreadyRunning ?? "?") + " other WebKit helpers existed before launch). RSS double-counts shared system pages, so the true footprint is lower. 10 Thematic .gd tabs, 13 s settle. A fresh window with no file open is already " + f(r.rssFresh.totalNoChildrenMB) + " MB (WebKit " + f(r.rssFresh.webkitMB) + " MB: WebContent + Monaco runtime), so 250 MB is below WebKit's own floor.",
  "WebKit floor dominates; further cuts need a smaller Monaco bundle",
  bt && `${f(bt.totalNoChildrenMB)} MB (app ${f(bt.appMB)} + WebKit ${f(bt.webkitMB)}; ${b.liveModels ?? 10} Monaco models)`));
rows.push(row("RSS of spawned children (headless Godot LSP)", `${f(t.childrenMB)} MB (${t.childProcs} proc: ${(r.childList || []).map((c) => c.cmd.split("/").pop().split(" ")[0] + " " + f(c.rssMB) + "MB").join(", ")}); total incl. Atelier ${f(t.totalMB)} MB`, "excluded (external tool, like IntelliJ's JVM children)", true,
  "Direct children of the app pid (`ps -axo pid,ppid`). The child is an external `Godot --editor --headless` started for the GDScript LSP; it loads the whole Thematic project in editor mode, so its footprint is Godot's, not Atelier's. It is SIGSTOPped after 20 s idle and killed after 5 min with no GDScript session.",
  "",
  bt && `${f(bt.childrenMB)} MB (total ${f(bt.totalMB)} MB)`));
const ic = r.idleCpu, ip = r.idleCpuPaused;
rows.push(row("Idle CPU, 30 s, 10 tabs, .gd focused (LSP live)", `app ${f(ic.appPct, 1)}% + WebKit ${f(ic.webkitPct, 1)}% = ${f(ic.appPlusWebkitPct, 1)}% (Godot ${f(ic.childrenPct, 1)}%)`, "info (WebKit caret animation, see below)", true,
  "delta of `ps -o time=` cumulative CPU over 30 s for app, WebKit helpers and children, as % of one core. A .gd editor is focused, so headless Godot stays awake and its LSP traffic reaches the UI. Most of the app+WebKit figure is WebKit itself: a focused editable element (even a bare `<textarea>`, with `caret-color: transparent`, `opacity: 0` or `readonly`) keeps a display-link-driven caret animation alive on macOS 26, ~2-7% of a core depending on the display's current refresh rate; a focused `<button>` or a blurred page costs ~0. Not fixable from app code.",
  "",
  b && `app ${f(b.idleCpu.appPct, 1)}% + WebKit ${f(b.idleCpu.webkitPct, 1)}% = ${f(b.idleCpu.appPlusWebkitPct, 1)}% (Godot ${f(b.idleCpu.childrenPct, 1)}%)`));
if (ip) rows.push(row("Idle CPU, 30 s, 10 tabs, window unfocused (Godot paused)", `app ${f(ip.appPct, 1)}% + WebKit ${f(ip.webkitPct, 1)}% = ${f(ip.appPlusWebkitPct, 1)}% (Godot ${f(ip.childrenPct, 1)}%, ps stat \`${ip.godotStat}\`)`, "< 0.3% app+WebKit", ip.appPlusWebkitPct < 0.3,
  "Same measurement after a README.md tab has been active for 25 s and the editor was blurred (`document.activeElement.blur()`; stands in for the window losing focus, which the harness cannot do without OS input): the backend SIGSTOPs the headless Godot process group after 20 s without LSP traffic and without a focused .gd editor (stat `T`), so Godot costs 0% and the widget reads \"GDScript: paused\".",
  "",
  b && `app ${f(b.idleCpu.appPct, 1)}% + WebKit ${f(b.idleCpu.webkitPct, 1)}% = ${f(b.idleCpu.appPlusWebkitPct, 1)}% (Godot ${f(b.idleCpu.childrenPct, 1)}%, never paused)`));
rows.push(row("Open file latency", `median ${f(r.openFile.medianMs)} ms, max ${f(r.openFile.maxMs)} ms (largest file ${f(r.largestFile.bytes / 1024)} KB: ${f(r.largestFile.ms)} ms)`, "< 50 ms", r.openFile.medianMs < 50 && r.largestFile.ms < 50,
  "`__qa.measureOpen`: `openFile()` call -> Monaco model for it is the active editor + one presented frame. 10 Thematic .gd files spread by size, each first open. First sample (" + f(r.openFile.allMs[0]) + " ms) includes lazy Monaco/editor initialisation.",
  "pre-warm Monaco during project load",
  b && `median ${f(b.openFile.medianMs)} ms, max ${f(b.openFile.maxMs)} ms`));
const k = r.keystroke;
rows.push(row("Keystroke-to-paint (Monaco)", `p50 ${f(k.p50, 1)} ms, p95 ${f(k.p95, 1)} ms, max ${f(k.max, 1)} ms (n=${k.n})`, "< 16 ms (one 60 Hz frame; judged on p95 <= 16.7)", k.p95 <= 16.7,
  "`editor.trigger('keyboard','type')` on a 100-line Thematic .gd with LSP attached -> next rAF -> following task (frame presented). Resolution ~1 ms (WebKit timer coarsening); typed text is undone afterwards, never saved.",
  "check LSP didChange/diagnostic work on the main thread, throttle decorations",
  b && `p50 ${f(b.keystroke.p50, 1)} ms, p95 ${f(b.keystroke.p95, 1)} ms`));
rows.push(row("Search Everywhere first results", `median ${f(r.searchEverywhere.medianMs)} ms (backend search_files ${f(r.searchFilesBackend.backendMs, 2)} ms, IPC round trip ${f(r.searchFilesBackend.roundtripMs)} ms)`, "< 100 ms", r.searchEverywhere.medianMs < 100,
  "`__qa.measureSearchEverywhere`: popup open, text inserted into `.se-input`, time until a result row containing the query is in the DOM (includes UI debounce). Queries: " + "player, inventory, catalog.", "", b && `median ${f(b.searchEverywhere.medianMs)} ms`));
const fif = r.findInFiles;
const worst = fif.reduce((a, b) => (b.doneMs > a.doneMs ? b : a));
rows.push(row("Find in Files over Thematic", fif.map((x) => `\`${x.q}\`${x.mask ? " " + x.mask : ""}: first ${x.firstMs == null ? "-" : f(x.firstMs)} / done ${f(x.doneMs)} ms (${x.total} matches)`).join("; "), "< 300 ms", worst.doneMs < 300,
  "`searchText()` streaming API from the webview: call -> first batch event / `done` batch. Real Thematic tree, ripgrep-internals backend.", "", b && `worst done ${f(b.findInFiles.reduce((a, c) => Math.max(a, c.doneMs), 0))} ms`));
const tr = r.tree10k;
rows.push(row("File tree, 10k files in one dir", `${f(tr.ms)} ms to expand; ${tr.domRows} DOM rows for ${tr.logicalRows} logical rows`, "virtualized (no full DOM render)", tr.domRows < 200,
  "synthetic dir of 10 000 files; project opened on it, the `flat` dir clicked; time to the tree's scroll height reflecting all rows + painted frame; DOM `.tree-row` count read back."));
const s = r.sizes;
rows.push(`| Binary size (release, LTO, strip) | ${b ? f(b.sizes.binaryMB, 1) + " MB" : "-"} | ${f(s.binaryMB, 1)} MB | n/a | info | \`ls -l src-tauri/target/release/atelier\` |`);
rows.push(`| Frontend bundle (dist/, embedded in binary) | ${b ? f(b.sizes.distMB, 1) + " MB" : "-"} | ${f(s.distMB, 1)} MB (Monaco chunk ${f(s.monacoChunkMB, 1)} MB) | n/a | info | \`du -sk dist\`. No .app bundle is produced by \`--no-bundle\`${s.bundleAppMB ? `; Atelier.app = ${f(s.bundleAppMB, 1)} MB` : ""} |`);

const md = `# Atelier performance (generated by \`scripts/bench.sh\`)

Measured ${r.when.slice(0, 10)} on ${r.machine}, release build (\`pnpm tauri build --no-bundle\`), project \`${r.project}\` (git status unchanged: ${r.gitClean}).
Driven entirely through the automation harness (\`scripts/qa/bench.mjs\`, no OS-level input). Budgets from docs/SPEC.md "Efficiency budgets".
Re-run: \`scripts/bench.sh\` (add \`SKIP_BUILD=1\` to reuse the current binary).

| Metric | Before perf pass | Measured | Budget | Status | Method |
|---|---|---|---|---|---|
${rows.join("\n")}

## Notes
- Idle CPU is only meaningful for an unfocused window; a focused editor pays WebKit's caret animation (see the focused-row method). All Atelier-owned timers are gated on window focus/visibility (\`src/lib/activity.ts\`): daemons status 30 s, Processes window 5 s, Claude sessions 30/60 s.
- Monaco model eviction (clean background tabs beyond the 3 most recent) frees little RSS by itself (~10 MB at 10 tabs): per-tab growth is mostly retained JavaScriptCore heap, and the first editor mount costs ~50 MB; the point is fewer LSP documents and worker mirrors.

## Memory attribution notes
- WebKit helpers (\`com.apple.WebKit.WebContent\`, \`.GPU\`, \`.Networking\`) are XPC services launched by launchd (ppid 1), so they cannot be found by parent pid, and
  \`responsibility_get_pid_responsible_for_pid\` (see \`scripts/qa/resp.swift\`) did not attribute them to the app either. The bench snapshots the helper pids before launching and counts the ones that appear afterwards; the set is locked 1.5 s after the window is ready, so a WebKit app started later in the run cannot be counted; \`webkitAlreadyRunning\` in the raw JSON records helpers of other apps that existed before launch (Alex's Chrome/Discord are not WebKit).
- Children of the app (LSP servers, ptys, rg, git) are found with \`ps -axo pid,ppid\` on the app pid.

## Raw
\`\`\`json
${JSON.stringify(r, null, 1)}
\`\`\`
`;
fs.writeFileSync(out, md);
