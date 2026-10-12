#!/usr/bin/env node
// Idle memory with a Python project open vs a plain project (docs/PYTHON.md). Usage: ACE_BIN=... node scripts/qa/pyperf.mjs
import { execSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, sleep } from "./lib.mjs";
const sh = (c) => execSync(c, { encoding: "utf8" }).trim();
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ace-pyperf-")));
const plain = path.join(scratch, "plain"), pyp = path.join(scratch, "pyproj");
fs.mkdirSync(plain); fs.mkdirSync(pyp);
fs.writeFileSync(path.join(plain, "README.md"), "# plain\n");
fs.writeFileSync(path.join(pyp, "main.py"), "import os\n\ndef f(x):\n    return os.path.join(x, 'a')\n\nprint(f('b'))\n");
fs.writeFileSync(path.join(pyp, "pyproject.toml"), "[project]\nname='p'\nversion='0'\n");
const uv = sh("zsh -lc 'command -v uv'");
execFileSync(uv, ["venv", "--seed", path.join(pyp, ".venv")], { stdio: "ignore" });
execFileSync(uv, ["pip", "install", "--python", path.join(pyp, ".venv/bin/python"), "basedpyright", "ruff"], { stdio: "ignore" });
const wk = () => new Set(sh(`ps -axo pid=,command= | grep -E 'com.apple.WebKit.(WebContent|GPU|Networking)' | grep -v grep | awk '{print $1}'`).split("\n").filter(Boolean));
const rss = (pids) => Math.round(pids.reduce((s, p) => s + (+sh(`ps -o rss= -p ${p} || true`) || 0), 0) / 1024);
const descendants = (pid) => { const t = sh("ps -axo pid=,ppid=").split("\n").map((l) => l.trim().split(/\s+/)); const out = []; const st = [String(pid)]; while (st.length) { const p = st.pop(); for (const [c, pp] of t) if (pp === p) { out.push(c); st.push(c); } } return out; };
async function measure(project, openFile) {
  const before = wk();
  const app = await launch(project);
  try {
    await sleep(2500);
    if (openFile) { await app.ev(`await __qa.openFile(${JSON.stringify(openFile)}); return 1`); await app.ev(`const py = await __qa.py(); await py.lang.start?.(); return 1`, { timeout: 30000 }).catch(() => {}); }
    await sleep(9000);
    const mine = [...wk()].filter((p) => !before.has(p));
    const kids = descendants(app.pid);
    return { appAndWebkitMB: rss([String(app.pid), ...mine]), childrenMB: rss(kids), children: kids.map((p) => sh(`ps -o comm= -p ${p} || true`).split("/").pop()).join(",") };
  } finally { await app.stop(); }
}
const a = await measure(plain);
const b = await measure(pyp, path.join(pyp, "main.py"));
console.log(JSON.stringify({ plainProject: a, pythonProjectWithLsp: b }, null, 1));
fs.rmSync(scratch, { recursive: true, force: true });
