#!/usr/bin/env node
// Python suite (docs/PYTHON.md). Launches Ace under the automation harness on a SCRATCH project that has its own venv
// (created with uv; pytest, debugpy, basedpyright, ruff installed THERE only). Drives the app only through window.__qa / __qa.py().
// Areas live in scripts/qa/py/<area>.mjs and export `async function checks(c)`.
// Usage: node scripts/qa/python.mjs [--only <area|substring of check name>] [--no-ssh] [--keep]     Env: ACE_BIN
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launch, sleep } from "./lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (n) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : null);
const only = arg("--only");
const ALL_AREAS = ["lang", "run", "debug", "console", "tests", "packages", "interp", "keys"];
const one = arg("--area");
const AREAS = one ? [one] : ALL_AREAS;
// Default: every area gets its own app + scratch project + venv (no state leaks between areas); `--area X` runs one in this process.
if (!one) {
  const { spawnSync } = await import("node:child_process");
  let pass = 0, total = 0;
  const failedAreas = [];
  for (const a of ALL_AREAS) {
    if (only && !fs.existsSync(path.join(here, "py", `${a}.mjs`))) continue;
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--area", a, ...process.argv.slice(2)], { encoding: "utf8", env: process.env, maxBuffer: 64 * 1024 * 1024 });
    const out = (r.stdout || "") + (r.stderr || "");
    process.stdout.write(out.split("\n").filter((l) => /^(PASS|FAIL)/.test(l)).join("\n") + "\n");
    const m = /(\d+)\/(\d+) passed/.exec(out);
    if (m) { pass += +m[1]; total += +m[2]; if (m[1] !== m[2]) failedAreas.push(a); }
  }
  console.log(`\n${pass}/${total} passed${failedAreas.length ? ", failing areas: " + failedAreas.join(", ") : ""}`);
  process.exit(pass === total ? 0 : 1);
}

const scratch = fs.realpathSync(fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "ace-py-")));
const proj = path.join(scratch, "proj");
const W = (rel, text) => { const f = path.join(proj, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };

// ---------------------------------------------------------------- fixture project (+ its own venv, created with uv)
W("pyproject.toml", `[project]\nname = "demo"\nversion = "0.1.0"\n\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n`);
W("app/__init__.py", "");
W("app/util.py", `def add(a: int, b: int) -> int:\n    """Add two numbers."""\n    return a + b\n\n\ndef greet(name: str) -> str:\n    return f"hello {name}"\n`);
W("app/main.py", `from app.util import add, greet\n\n\nclass Counter:\n    """A tiny counter."""\n\n    def __init__(self) -> None:\n        self.value = 0\n\n    def bump(self, by: int = 1) -> int:\n        self.value = add(self.value, by)\n        return self.value\n\n\ndef compute(n):\n    total = 0\n    for i in range(n):\n        total = add(total, i)\n    return total\n\n\nif __name__ == "__main__":\n    c = Counter()\n    c.bump(2)\n    result = compute(5)\n    print("result", result)\n    print(greet("ace"))\n`);
W("hello.py", `import sys\nprint("hello from hello.py", sys.argv[1:])\nprint("to stderr", file=sys.stderr)\n`);
W("crash.py", `def boom(x):\n    return 1 / x\n\n\ndef main():\n    boom(0)\n\n\nmain()\n`);
W("loop.py", `import time\nprint("looping", flush=True)\nwhile True:\n    time.sleep(0.2)\n`);
W("ask.py", `name = input("name? ")\nprint("hi", name)\n`);
W("messy.py", `import sys\nimport os\nfrom app.util import greet\nx=1\ndef f( a,b ):\n  return a+b\nprint(greet("x"),x)\n`);
W("tests/__init__.py", "");
W("tests/test_math.py", `import pytest\nfrom app.util import add\n\n\ndef test_add():\n    assert add(1, 2) == 3\n\n\ndef test_add_fails():\n    assert add(1, 2) == 4\n\n\n@pytest.mark.skip(reason="not now")\ndef test_skipped():\n    pass\n\n\nclass TestGroup:\n    def test_inner_ok(self):\n        assert add(2, 2) == 4\n\n    def test_inner_prints(self):\n        print("captured text")\n        assert True\n`);
W("tests/test_unit.py", `import unittest\nfrom app.util import add\n\n\nclass AddTests(unittest.TestCase):\n    def test_ok(self):\n        self.assertEqual(add(1, 1), 2)\n\n    def test_bad(self):\n        self.assertEqual(add(1, 1), 3)\n`);
const uv = execSync("zsh -lc 'command -v uv'").toString().trim();
const venv = path.join(proj, ".venv");
const venvPython = path.join(venv, "bin/python");
let setupMs = Date.now();
execFileSync(uv, ["venv", "--seed", venv], { stdio: "ignore" });
execFileSync(uv, ["pip", "install", "--python", venvPython, "pytest", "debugpy", "basedpyright", "ruff"], { stdio: "ignore" });
setupMs = Date.now() - setupMs;
execSync("git init -q . && printf '.venv/\\n__pycache__/\\n' > .gitignore && git add -A && git -c user.email=q@q -c user.name=qa commit -qm init", { cwd: proj });
console.log(`scratch project ${proj} (venv ready in ${setupMs} ms)`);

const app = await launch(proj);
const rows = [];
const S = () => app.ev("return __qa.state()");
const key = (k) => app.ev(`return await __qa.key(${JSON.stringify(k)})`);
const P = (rel) => path.join(proj, rel);
/** run JS in the app with `py` = the Python test hooks */
const py = (body, o) => app.ev(`const py = await __qa.py(); ${body}`, o);
const reset = async (rel = "hello.py") => { for (let i = 0; ; i++) { try { return await app.ev(`return await __qa.reset(${JSON.stringify(P(rel))})`, { timeout: 15000 }); } catch (e) { if (i) throw e; await sleep(500); } } };
let area = "";
async function check(name, fn, { fresh = true } = {}) {
  const full = `${area}: ${name}`;
  if (only && !(area === only || full.toLowerCase().includes(only.toLowerCase()))) return;
  let ok = false, note = "";
  try { if (fresh) await reset(typeof fresh === "string" ? fresh : "hello.py"); const r = await fn(); ok = r === true || (r && r.ok); note = r && r.note ? r.note : ""; } catch (e) { note = String(e.message || e).split("\n")[0].slice(0, 200); }
  rows.push({ name: full, ok, note });
  console.log(`${ok ? "PASS" : "FAIL"}  ${full}${note ? "  - " + note : ""}`);
  if (!ok) app.shot("python_fail_" + full.replace(/[^a-z0-9]+/gi, "_").toLowerCase());
}
const ctx = { app, proj, scratch, venv, venvPython, uv, S, key, P, py, W, reset, sleep, check, fs, path, execSync, execFileSync, noSsh: process.argv.includes("--no-ssh"),
  waitFor: (cond, ms = 10000) => app.ev(`return await __qa.waitFor(${typeof cond === "string" ? JSON.stringify(cond) : `async () => { const py = await __qa.py(); return (${cond.toString()})(py); }`}, ${ms})`, { timeout: ms + 5000 }) };

let failed = 0;
try {
  for (const a of AREAS) {
    const f = path.join(here, "py", `${a}.mjs`);
    if (!fs.existsSync(f)) continue;
    area = a;
    // baseline between areas: the project venv is the interpreter (the interp area switches it around)
    try { await py(`await py.interp.switchTo(${JSON.stringify(venvPython)}); return 1`); await sleep(1500); } catch {}
    try { await (await import(f)).checks(ctx); } catch (e) { console.log(`FAIL  ${a}: suite error - ${String(e.stack || e).split("\n").slice(0, 3).join(" | ")}`); rows.push({ name: `${a}: suite`, ok: false, note: String(e.message) }); }
  }
} finally {
  await app.stop();
  const left = execSync("pgrep -fl 'ace-py-' || true").toString().trim();
  if (!process.argv.includes("--keep")) fs.rmSync(scratch, { recursive: true, force: true });
  failed = rows.filter((r) => !r.ok).length;
  console.log(`\n${rows.length - failed}/${rows.length} passed${failed ? `, ${failed} FAILED` : ""}${left ? "\nleftover processes:\n" + left : ""}`);
}
process.exit(failed ? 1 : 0);
