#!/usr/bin/env node
// node perf-report.mjs bench.json docs/PERF.md  -> renders the measured numbers vs SPEC budgets.
import fs from "node:fs";
const [, , inp, out] = process.argv;
const r = JSON.parse(fs.readFileSync(inp, "utf8"));
const f = (n, d = 0) => (n == null ? "n/a" : Number(n).toFixed(d));
const row = (metric, value, budget, pass, method, fix = "") => {
  const v = pass ? value : `**${value}**`;
  return `| ${metric} | ${v} | ${budget} | ${pass ? "ok" : "**MISS**"} | ${method}${!pass && fix ? `<br>**Fix:** ${fix}` : ""} |`;
};
const rows = [];
rows.push(row("Cold start to interactive editor", `${r.cold.medianMs} ms (runs: ${r.cold.runs.join(", ")})`, "< 1000 ms", r.cold.medianMs < 1000,
  "T0 = wall clock just before `spawn(atelier <project>)`; as soon as `window.__qa` answers on the socket the harness opens a file and waits for Monaco to hold its content + one presented frame (rAF + MessageChannel); end = `performance.timeOrigin + performance.now()` of that frame. Median of N runs, warm disk cache (first run is the coldest). Includes <=~20 ms of socket polling skew. Webview+React ready (harness available) at median " + r.cold.qaReadyMedianMs + " ms.",
  "lazy-load Monaco workers/languages, trim the 3.9 MB monaco chunk, defer non-visible tool windows"));
const t = r.rss10Tabs;
rows.push(row("RSS: app + WebKit helpers, 10 tabs, idle", `${f(t.totalNoChildrenMB)} MB (app ${f(t.appMB)} + WebKit ${f(t.webkitMB)} over ${t.webkitProcs} procs)`, "< 250 MB", t.totalNoChildrenMB < 250,
  "`ps -o rss=` summed over the app pid and the WebKit helper processes (WebContent, GPU, Networking) that appeared after launch (they are XPC services with ppid 1, so a before/after process-snapshot diff is used; `responsibility_get_pid_responsible_for_pid` does not attribute them). RSS double-counts shared system pages, so true footprint is lower. 10 Thematic .gd tabs, 13 s settle.",
  "WebContent dominates; cut Monaco model/worker memory (dispose models of background tabs, lazy language workers), avoid xterm/webgl addons until Terminal is opened"));
rows.push(row("RSS incl. spawned children (headless Godot LSP)", `${f(t.totalMB)} MB (children ${f(t.childrenMB)} MB in ${t.childProcs} proc: ${(r.childList || []).map((c) => c.cmd.split("/").pop().split(" ")[0] + " " + f(c.rssMB) + "MB").join(", ")})`, "< 250 MB (SPEC: all processes)", t.totalMB < 250,
  "Same as above plus direct children of the app pid (`ps -axo pid,ppid`). The child is an external `Godot --editor --headless` started for the GDScript LSP; its footprint is Godot's, not Atelier's.",
  "Godot loads the whole Thematic project in editor mode; consider excluding Godot from the 250 MB budget (SPEC amendment), starting it lazily/only for open .gd, or stopping it after N idle minutes"));
rows.push(row("Idle CPU (30 s, 10 tabs open)", `app ${f(r.idleCpu.appPct, 1)}% + WebKit ${f(r.idleCpu.webkitPct, 1)}% = ${f(r.idleCpu.appPlusWebkitPct, 1)}% (children/Godot ${f(r.idleCpu.childrenPct, 1)}%)`, "~0%", r.idleCpu.appPlusWebkitPct < 1,
  "delta of `ps -o time=` cumulative CPU over 30 s for app, WebKit helpers and children, as % of one core.",
  "find the idle wakeups (timers/rAF loops/watchers: sample with `sample <pid>`), pause polling when window unfocused"));
rows.push(row("Open file latency", `median ${f(r.openFile.medianMs)} ms, max ${f(r.openFile.maxMs)} ms (largest file ${f(r.largestFile.bytes / 1024)} KB: ${f(r.largestFile.ms)} ms)`, "< 50 ms", r.openFile.medianMs < 50 && r.largestFile.ms < 50,
  "`__qa.measureOpen`: `openFile()` call -> Monaco model for it is the active editor + one presented frame. 10 Thematic .gd files spread by size, each first open. First sample (" + f(r.openFile.allMs[0]) + " ms) includes lazy Monaco/editor initialisation.",
  "pre-warm Monaco during project load"));
const k = r.keystroke;
rows.push(row("Keystroke-to-paint (Monaco)", `p50 ${f(k.p50, 1)} ms, p95 ${f(k.p95, 1)} ms, max ${f(k.max, 1)} ms (n=${k.n})`, "< 16 ms (one 60 Hz frame; judged on p95 <= 16.7)", k.p95 <= 16.7,
  "`editor.trigger('keyboard','type')` on a 100-line Thematic .gd with LSP attached -> next rAF -> following task (frame presented). Resolution ~1 ms (WebKit timer coarsening); typed text is undone afterwards, never saved.",
  "check LSP didChange/diagnostic work on the main thread, throttle decorations"));
rows.push(row("Search Everywhere first results", `median ${f(r.searchEverywhere.medianMs)} ms (backend search_files ${f(r.searchFilesBackend.backendMs, 2)} ms, IPC round trip ${f(r.searchFilesBackend.roundtripMs)} ms)`, "< 100 ms", r.searchEverywhere.medianMs < 100,
  "`__qa.measureSearchEverywhere`: popup open, text inserted into `.se-input`, time until a result row containing the query is in the DOM (includes UI debounce). Queries: " + "player, inventory, catalog."));
const fif = r.findInFiles;
const worst = fif.reduce((a, b) => (b.doneMs > a.doneMs ? b : a));
rows.push(row("Find in Files over Thematic", fif.map((x) => `\`${x.q}\`${x.mask ? " " + x.mask : ""}: first ${x.firstMs == null ? "-" : f(x.firstMs)} / done ${f(x.doneMs)} ms (${x.total} matches)`).join("; "), "< 300 ms", worst.doneMs < 300,
  "`searchText()` streaming API from the webview: call -> first batch event / `done` batch. Real Thematic tree, ripgrep-internals backend."));
const tr = r.tree10k;
rows.push(row("File tree, 10k files in one dir", `${f(tr.ms)} ms to expand; ${tr.domRows} DOM rows for ${tr.logicalRows} logical rows`, "virtualized (no full DOM render)", tr.domRows < 200,
  "synthetic dir of 10 000 files; project opened on it, the `flat` dir clicked; time to the tree's scroll height reflecting all rows + painted frame; DOM `.tree-row` count read back."));
const s = r.sizes;
rows.push(`| Binary size (release, LTO, strip) | ${f(s.binaryMB, 1)} MB | n/a | info | \`ls -l src-tauri/target/release/atelier\` |`);
rows.push(`| Frontend bundle (dist/, embedded in binary) | ${f(s.distMB, 1)} MB (Monaco chunk ${f(s.monacoChunkMB, 1)} MB) | n/a | info | \`du -sk dist\`. No .app bundle is produced by \`--no-bundle\`${s.bundleAppMB ? `; Atelier.app = ${f(s.bundleAppMB, 1)} MB` : ""} |`);

const md = `# Atelier performance (generated by \`scripts/bench.sh\`)

Measured ${r.when.slice(0, 10)} on ${r.machine}, release build (\`pnpm tauri build --no-bundle\`), project \`${r.project}\` (git status unchanged: ${r.gitClean}).
Driven entirely through the automation harness (\`scripts/qa/bench.mjs\`, no OS-level input). Budgets from docs/SPEC.md "Efficiency budgets".
Re-run: \`scripts/bench.sh\` (add \`SKIP_BUILD=1\` to reuse the current binary).

| Metric | Measured | Budget | Status | Method |
|---|---|---|---|---|
${rows.join("\n")}

## Memory attribution notes
- WebKit helpers (\`com.apple.WebKit.WebContent\`, \`.GPU\`, \`.Networking\`) are XPC services launched by launchd (ppid 1), so they cannot be found by parent pid, and
  \`responsibility_get_pid_responsible_for_pid\` (see \`scripts/qa/resp.swift\`) did not attribute them to the app either. The bench snapshots the helper pids before launching and counts the ones that appear afterwards; run it with no other WebKit app starting at the same time (other Tauri/Safari launches would be counted).
- Children of the app (LSP servers, ptys, rg, git) are found with \`ps -axo pid,ppid\` on the app pid.

## Raw
\`\`\`json
${JSON.stringify(r, null, 1)}
\`\`\`
`;
fs.writeFileSync(out, md);
