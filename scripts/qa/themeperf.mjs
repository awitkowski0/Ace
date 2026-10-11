#!/usr/bin/env node
// Keystroke p95 on a .py file with basedpyright semantic tokens ON vs OFF (same build), plus idle RSS (app + WebKit helpers).
// Usage: ATELIER_BIN=... node scripts/qa/themeperf.mjs
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, sleep } from "./lib.mjs";
const sh = (c) => execSync(c, { encoding: "utf8" }).trim();
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ace-themeperf-")));
fs.writeFileSync(path.join(scratch, "pyproject.toml"), "[project]\nname='p'\nversion='0'\n");
fs.writeFileSync(path.join(scratch, "m.py"), Array.from({ length: 200 }, (_, i) => `class C${i}:\n    def f${i}(self, a: int) -> int:\n        self.v = a\n        return self.v\n`).join("\n"));
const uv = sh("zsh -lc 'command -v uv'");
execFileSync(uv, ["venv", "--seed", path.join(scratch, ".venv")], { stdio: "ignore" });
execFileSync(uv, ["pip", "install", "--python", path.join(scratch, ".venv/bin/python"), "basedpyright"], { stdio: "ignore" });
const wk = () => new Set(sh(`ps -axo pid=,command= | grep -E 'com.apple.WebKit.(WebContent|GPU|Networking)' | grep -v grep | awk '{print $1}'`).split("\n").filter(Boolean));
const rss = (pids) => Math.round(pids.reduce((s, p) => s + (+sh(`ps -o rss= -p ${p} || true`) || 0), 0) / 1024);
const before = wk();
const app = await launch(scratch);
const f = path.join(scratch, "m.py");
try {
  await app.ev(`await __qa.openFile(${JSON.stringify(f)}); return 1`);
  for (let i = 0; i < 120; i++) { const s = await app.ev(`const L = await (await __qa.themes()).lsp(); try { return (await L.semantic(${JSON.stringify(f)})).tokens?.length ?? 0 } catch { return 0 }`).catch(() => 0); if (s > 50) break; await sleep(500); }
  await sleep(3000);
  const run = async (on) => {
    await app.ev(`__qa.editor().updateOptions({ "semanticHighlighting.enabled": ${on} }); return 1`);
    await sleep(1000);
    const r = [];
    for (let k = 0; k < 3; k++) r.push(await app.ev("return await __qa.measureKeystroke(60)", { timeout: 60000 }));
    return { p50: Math.min(...r.map((x) => x.p50)).toFixed(1), p95: r.map((x) => x.p95).sort((a, b) => a - b)[1].toFixed(1) };
  };
  const off = await run(false), on = await run(true);
  const mine = [...wk()].filter((p) => !before.has(p));
  const kids = sh("ps -axo pid=,ppid=").split("\n").map((l) => l.trim().split(/\s+/)).filter(([, pp]) => pp === String(app.pid)).map(([p]) => p);
  console.log(JSON.stringify({ semanticOff: off, semanticOn: on, rssMB: rss([String(app.pid), ...mine]), childrenMB: rss(kids) }));
} finally { await app.stop(); fs.rmSync(scratch, { recursive: true, force: true }); }
