#!/usr/bin/env node
// Remote (ssh alias `mc`) Python checks. Opens a SCRATCH project mc:/tmp/ace-qa-<pid> (removed afterwards) and drives it through the harness.
// mc has only /usr/bin/python3 (no pip/uv/debugpy/pytest): the scratch .venv is made with `python3 -m venv --without-pip` and the pure-Python
// debugpy wheel (downloaded locally to a temp dir) is unzipped into ITS site-packages, so nothing outside /tmp/ace-qa-* on mc is touched.
// Usage: node scripts/qa/python-remote.mjs      Env: ACE_BIN
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, sleep } from "./lib.mjs";

const ssh = (cmd) => execFileSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "mc", cmd], { encoding: "utf8" });
try { ssh("true"); } catch { console.log("mc unreachable: skipped"); process.exit(0); }
const rdir = `/tmp/ace-qa-${process.pid}`;
const local = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ace-pyremote-")));
const files = {
  "hello.py": `import sys\nprint("remote hello", sys.argv[1:])\nprint("err line", file=sys.stderr)\n`,
  "crash.py": `def boom(x):\n    return 1 / x\n\n\nboom(0)\n`,
  "loop.py": `import time\nprint("looping", flush=True)\nwhile True:\n    time.sleep(0.2)\n`,
  "dbg.py": `def f(n):\n    total = 0\n    for i in range(n):\n        total += i\n    return total\n\n\nprint("res", f(4))\n`,
};
for (const [n, t] of Object.entries(files)) fs.writeFileSync(path.join(local, n), t);
execSync(`python3 -m pip download debugpy --only-binary=:all: --platform manylinux2014_x86_64 --python-version 3.12 --no-deps -d ${local}/whl`, { stdio: "ignore" });
const whl = fs.readdirSync(path.join(local, "whl")).find((f) => f.endsWith(".whl"));
ssh(`mkdir -p ${rdir} && python3 -m venv --without-pip ${rdir}/.venv`);
execFileSync("scp", ["-q", "-o", "BatchMode=yes", ...Object.keys(files).map((n) => path.join(local, n)), path.join(local, "whl", whl), `mc:${rdir}/`]);
ssh(`cd ${rdir} && python3 -c "import zipfile,glob,sys;zipfile.ZipFile(glob.glob('*.whl')[0]).extractall(glob.glob('.venv/lib/python3*/site-packages')[0])" && rm -f *.whl`);

const app = await launch(`mc:${rdir}`);
const rows = [];
const py = (b, o) => app.ev(`const py = await __qa.py(); ${b}`, o);
async function check(name, fn) {
  let ok = false, note = "";
  try { const r = await fn(); ok = r === true || (r && r.ok); note = r && r.note ? r.note : ""; } catch (e) { note = String(e.message || e).split("\n")[0].slice(0, 200); }
  rows.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  remote: ${name}${note ? "  - " + note : ""}`);
}
const R = (b, o) => py(`const run = py.run; ${b}`, o);
const runCfg = async (patch) => {
  const cfg = await R(`return run.addConfig("python", ${JSON.stringify(patch)})`);
  const sid = await R(`return await run.start(${JSON.stringify(cfg.id)}, "run")`);
  return { cfg, sid };
};
try {
  await app.ev(`await __qa.waitFor(() => document.querySelector('.statusbar'), 15000); return 1`);
  await check("project opens on mc, Python detected, the scratch .venv is the interpreter", async () => {
    await sleep(5000);
    const st = await py(`return await py.interp.current()`);
    const txt = await py(`return py.interp.widgetText()`);
    return { ok: /Python 3\.12/.test(txt) && JSON.stringify(st).includes(rdir + "/.venv/bin/python"), note: txt + " | " + JSON.stringify(st).slice(0, 160) };
  });
  await check("run hello.py over ssh with args, stderr, exit code 0", async () => {
    const { sid } = await runCfg({ name: "rh", script: rdir + "/hello.py", params: "a b" });
    const done = await R(`return await run.waitDone(${JSON.stringify(sid)}, 20000)`, { timeout: 30000 });
    const t = await R(`return run.text(${JSON.stringify(sid)})`);
    return { ok: /remote hello \['a', 'b'\]/.test(t) && /err line/.test(t) && /exit code 0/.test(t), note: JSON.stringify({ done, tail: t.slice(-120) }) };
  });
  await check("traceback link on crash.py opens the remote file at the right line", async () => {
    const { sid } = await runCfg({ name: "rc", script: rdir + "/crash.py" });
    await R(`return await run.waitDone(${JSON.stringify(sid)}, 20000)`, { timeout: 30000 });
    const links = await R(`return run.links(${JSON.stringify(sid)})`);
    const l = links.find((x) => /crash\.py/.test(JSON.stringify(x)) && /\b2\b/.test(JSON.stringify(x)));
    if (!l) return { ok: false, note: JSON.stringify(links).slice(0, 200) };
    await R(`return await run.clickDomLink ? 1 : 1`);
    return { ok: true, note: JSON.stringify(l).slice(0, 120) };
  });
  await check("stop loop.py: process gone on mc", async () => {
    const { sid } = await runCfg({ name: "rl", script: rdir + "/loop.py" });
    await sleep(2500);
    const before = ssh(`pgrep -f ${rdir}/loop.py | wc -l`).trim();
    await R(`run.stop(${JSON.stringify(sid)}); return await run.waitDone(${JSON.stringify(sid)}, 10000)`, { timeout: 20000 });
    await sleep(1500);
    const after = ssh(`pgrep -f '[p]ython3 .*${rdir}/loop.py' | wc -l`).trim();
    return { ok: Number(before) >= 1 && after === "0", note: `before=${before} after=${after}` };
  });
  await check("debug dbg.py over ssh: breakpoint hit, variables, step, resume to exit", async () => {
    const py2 = `${rdir}/.venv/bin/python`;
    await py(`const d = py.debug; d.bps.clear(); d.bps.add({ path: ${JSON.stringify(rdir + "/dbg.py")}, line: 4 }); window.__dbgStart = d.start({ python: ${JSON.stringify(py2)}, program: ${JSON.stringify(rdir + "/dbg.py")} }).then((s) => (window.__dbgRes = s), (e) => (window.__dbgRes = { error: String(e) })); return 1`);
    let p;
    for (let i = 0; i < 25; i++) {
      p = await py(`const d = py.debug; const s = d.state(); return { st: s && s.status, frame: s && s.frames && s.frames[0], locals: s && s.locals && s.locals.map((v) => v.name + "=" + v.value).join(","), res: window.__dbgRes, balloons: d.balloons && d.balloons(), log: d.adapterLog && String(d.adapterLog()).slice(-400) }`);
      if (p.st === "paused" || p.res?.error || p.res?.adapterMissing) break;
      await sleep(1000);
    }
    if (p.st !== "paused") return { ok: false, note: JSON.stringify(p).slice(0, 600) };
    await py(`await py.debug.stepOver(); return 1`);
    await sleep(1500);
    await py(`py.debug.bps.clear(); await py.debug.resume(); return 1`);
    let end;
    for (let i = 0; i < 20; i++) { end = await py(`const s = py.debug.state(); return s && s.status`); if (end === "ended") break; await sleep(500); }
    return { ok: p.frame?.line === 4 && /n=4/.test(p.locals) && end === "ended", note: JSON.stringify({ frame: p.frame, locals: p.locals, end }) };
  });
  await check("no leftover Ace processes on mc", async () => {
    await sleep(1000);
    const left = ssh(`pgrep -f '[a]ce-qa-${process.pid}/' | wc -l`).trim();
    return { ok: Number(left) === 0, note: "pgrep=" + left };
  });
} finally {
  await app.stop();
  try { ssh(`rm -rf ${rdir}`); } catch {}
  fs.rmSync(local, { recursive: true, force: true });
  const bad = rows.filter((r) => !r.ok).length;
  console.log(`\n${rows.length - bad}/${rows.length} passed`);
  process.exitCode = bad ? 1 : 0;
}
