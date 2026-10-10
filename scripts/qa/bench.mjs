#!/usr/bin/env node
// Performance bench driver (see scripts/bench.sh, docs/PERF.md). Release build, real project, automation harness only.
// Env: PROJ (default ~/thematic-kyf), ATELIER_BIN, BENCH_TMP (synthetic 10k dir parent), RUNS (cold-start runs, default 5), OUT (json path)
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, sleep, repo, BIN } from "./lib.mjs";

const proj = process.env.PROJ || path.join(os.homedir(), "thematic-kyf");
const tmp = process.env.BENCH_TMP || path.join(process.env.TMPDIR || os.tmpdir(), "atelier-bench");
const RUNS = +(process.env.RUNS || 5);
const sh = (c) => { try { return execSync(c, { encoding: "utf8", maxBuffer: 1 << 28 }).trim(); } catch { return ""; } };
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const r1 = (n) => Math.round(n * 10) / 10;
const before = sh(`git -C ${JSON.stringify(proj)} status --porcelain`);

// ---- files to open (real project) ----
const gd = sh(`git -C ${JSON.stringify(proj)} ls-files '*.gd'`).split("\n").filter(Boolean).map((f) => path.join(proj, f)).filter((f) => fs.existsSync(f));
const bySize = gd.map((f) => [f, fs.statSync(f).size]).sort((a, b) => a[1] - b[1]);
const pick = (n) => Array.from({ length: n }, (_, i) => bySize[Math.floor(((i + 0.5) / n) * bySize.length)][0]);
const files10 = pick(10);
const firstFile = files10[3];

// ---- synthetic 10k tree ----
const synth = path.join(tmp, "synth10k");
if (!fs.existsSync(path.join(synth, "flat", "f09999.txt"))) {
  fs.rmSync(synth, { recursive: true, force: true });
  fs.mkdirSync(path.join(synth, "flat"), { recursive: true });
  for (let i = 0; i < 10000; i++) fs.writeFileSync(path.join(synth, "flat", `f${String(i).padStart(5, "0")}.txt`), `file ${i}\n`);
}

// ---- process accounting ----
const wkPids = () => new Set(sh(`ps -axo pid=,command= | grep -E 'com.apple.WebKit.(WebContent|GPU|Networking)' | grep -v grep | awk '{print $1}'`).split("\n").filter(Boolean));
const rssKB = (pids) => pids.reduce((s, p) => s + (+sh(`ps -o rss= -p ${p}`) || 0), 0);
const cpuSec = (p) => { const t = sh(`ps -o time= -p ${p}`); if (!t) return 0; const [m, s] = t.split(":"); return +m * 60 + parseFloat(s); };
const kids = (pid) => sh(`ps -axo pid=,ppid= | awk '$2==${pid}{print $1}'`).split("\n").filter(Boolean);
const mb = (kb) => r1(kb / 1024);

async function procs(app, wk0) {
  const wk = [...wkPids()].filter((p) => !wk0.has(p));
  const children = kids(app.pid);
  return { app: String(app.pid), webkit: wk, children };
}
const sizes = (ps) => ({
  appMB: mb(rssKB([ps.app])), webkitMB: mb(rssKB(ps.webkit)), childrenMB: mb(rssKB(ps.children)),
  get totalNoChildrenMB() { return r1(this.appMB + this.webkitMB); }, get totalMB() { return r1(this.appMB + this.webkitMB + this.childrenMB); },
});

const res = { project: proj, build: BIN, when: new Date().toISOString(), machine: sh("sysctl -n machdep.cpu.brand_string") + ", " + sh("sw_vers -productVersion") };

// ---- 1. cold start (N runs) ----
const cold = [], ready = [];
for (let i = 0; i < RUNS; i++) {
  const wk0 = wkPids();
  const app = await launch(proj);
  // first paint of an editor with content: opened via harness as soon as __qa answers
  const tPaint = await app.ev(`await __qa.openFile(${JSON.stringify(firstFile)}); await __qa.waitFor(()=>__qa.editor()?.getValue().length>0, 8000); await __qa.afterPaint(); return performance.timeOrigin + performance.now();`);
  cold.push(tPaint - app.t0); ready.push(app.ready - app.t0);
  await app.stop();
  await sleep(1500);
}
res.cold = { runs: cold.map(Math.round), medianMs: Math.round(median(cold)), qaReadyMedianMs: Math.round(median(ready)) };

// ---- main session ----
const wk0 = wkPids();
const app = await launch(proj);
await sleep(1500);
const procsIdle0 = await procs(app, wk0);
res.rssFresh = sizes(procsIdle0);

// 10 tabs
const openMs = [];
for (const f of files10) openMs.push(await app.ev(`return await __qa.measureOpen(${JSON.stringify(f)})`));
await sleep(8000); // let LSP / indexing settle
const big = bySize[bySize.length - 1][0];
res.openFile = { n: openMs.length, medianMs: r1(median(openMs)), maxMs: r1(Math.max(...openMs)), allMs: openMs.map(r1), note: "Thematic .gd files, smallest..largest by size, first open (read + model + paint)" };
res.largestFile = { path: big, bytes: bySize[bySize.length - 1][1], ms: r1(await app.ev(`return await __qa.measureOpen(${JSON.stringify(big)})`)) };
const tabs = await app.ev("return __qa.state().tabs.flatMap(g=>g.tabs).length");
await sleep(5000);
const pi = await procs(app, wk0);
res.childList = pi.children.map((p) => ({ pid: p, rssMB: mb(rssKB([p])), cmd: sh(`ps -o command= -p ${p}`).slice(0, 90) }));
res.rss10Tabs = { tabs, ...sizes(pi), webkitProcs: pi.webkit.length, childProcs: pi.children.length };
Object.assign(res.rss10Tabs, { totalMB: sizes(pi).totalMB, totalNoChildrenMB: sizes(pi).totalNoChildrenMB });

// idle CPU 30s
const all = [pi.app, ...pi.webkit, ...pi.children];
const c0 = Object.fromEntries(all.map((p) => [p, cpuSec(p)]));
const t0 = Date.now();
await sleep(30000);
const el = (Date.now() - t0) / 1000;
const grp = (ps) => ps.reduce((s, p) => s + (cpuSec(p) - (c0[p] ?? 0)), 0);
res.idleCpu = { seconds: r1(el), appPct: r1((100 * grp([pi.app])) / el), webkitPct: r1((100 * grp(pi.webkit)) / el), childrenPct: r1((100 * grp(pi.children)) / el), appPlusWebkitPct: r1((100 * grp([pi.app, ...pi.webkit])) / el) };

// keystroke-to-paint
await app.ev(`await __qa.openFile(${JSON.stringify(files10[5])}); __qa.editor().focus(); await __qa.sleep(300); return 1`);
res.keystroke = await app.ev("return await __qa.measureKeystroke(60)");
const dirty = await app.ev("return __qa.state().dirty.length");
res.keystroke.dirtyAfter = dirty;

// Search Everywhere
await app.ev(`__qa.editor().focus(); return 1`);
const se = [];
for (const q of ["player", "inventory", "catalog", "player"]) se.push(await app.ev(`return await __qa.measureSearchEverywhere(${JSON.stringify(q)})`));
res.searchEverywhere = { allMs: se.map((s) => r1(s.ms)), medianMs: r1(median(se.map((s) => s.ms))), note: "type -> first matching result row painted-in-DOM (includes UI debounce); first sample is warmest-index-miss" };
const sf = await app.ev(`const root=${JSON.stringify(proj)}; const t=performance.now(); const r=await __qa.invoke('search_files',{root:{host:'local',path:root},query:'player',limit:50,recent:[]}); return {roundtripMs: performance.now()-t, backendMs:r.elapsedMs, hits:r.hits.length}`).catch((e) => ({ error: String(e) }));
res.searchFilesBackend = sf;

// Find in Files
const fif = [];
for (const [q, mask] of [["func", "*.gd"], ["extends", ""], ["TODO", ""], ["func", "*.gd"]]) fif.push({ q, mask, ...(await app.ev(`return await __qa.measureFindInFiles(${JSON.stringify(q)}, ${JSON.stringify(mask)})`)) });
res.findInFiles = fif;

// file tree 10k
res.tree10k = await app.ev(`return await __qa.measureTree(${JSON.stringify(synth)}, 'flat')`);
await sleep(500);

await app.ev("const d=__qa.state().dirty; if(d.length) throw new Error('dirty tabs: '+d); return 1");
await app.stop();

// ---- sizes ----
const du = (p) => (fs.existsSync(p) ? +sh(`du -sk ${JSON.stringify(p)} | cut -f1`) : null);
const bundleApp = path.join(repo, "src-tauri/target/release/bundle/macos/Atelier.app");
res.sizes = { binaryMB: r1(fs.statSync(BIN).size / 1048576), distMB: r1(du(path.join(repo, "dist")) / 1024), bundleAppMB: du(bundleApp) ? r1(du(bundleApp) / 1024) : null, monacoChunkMB: r1(sh(`ls -l ${repo}/dist/assets/monacoSetup-*.js | awk '{print $5}'`) / 1048576) };

res.gitClean = sh(`git -C ${JSON.stringify(proj)} status --porcelain`) === before;
fs.writeFileSync(process.env.OUT || path.join(tmp, "bench.json"), JSON.stringify(res, null, 2));
console.log(JSON.stringify(res, null, 2));
