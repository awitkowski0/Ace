// Python Console + Execute Selection checks (docs/PYTHON.md). Drives the app only through __qa / __qa.py().
export async function checks(c) {
  const { check, py, S, key, P, app, sleep, venvPython, noSsh } = c;
  const J = JSON.stringify;
  const st = () => py("return py.console.state()");
  const out = async (code) => (await py(`return await py.console.execute(${J(code)})`)).out;
  const tr = () => py("return py.console.transcript()");

  await check("nothing runs before the console is opened", async () => {
    const s = await st();
    return { ok: s.status === "stopped" && s.entries === 0, note: JSON.stringify(s) };
  });

  await check("open starts the project interpreter's console (scratch venv, no IPython)", async () => {
    const status = await py("return await py.console.open()");
    const s = await st();
    const tw = (await S()).toolWindows.bottom;
    return { ok: status === "ready" && s.interp === venvPython && !s.ipython && tw === "pyconsole", note: JSON.stringify({ status, s, tw }) };
  });

  await check("expression result, print and statements", async () => {
    const a = await out("1 + 1");
    const b = await out("print('hi there')\nx = 5");
    const d = await out("x * 2");
    return { ok: a.trim() === "2" && b.includes("hi there") && d.trim() === "10", note: JSON.stringify([a, b, d]) };
  });

  await check("multi-line block executes as one cell", async () => {
    const o = await out("for i in range(3):\n    print('row', i)\n");
    return { ok: o === "row 0\nrow 1\nrow 2\n", note: JSON.stringify(o) };
  });

  await check("check protocol: complete / incomplete", async () => {
    await py("await py.console.setInput('def f(x):'); return 1");
    await key("ENTER");
    await sleep(400);
    const v1 = await py("return await py.console.getInput()");
    return { ok: v1 === "def f(x):\n    ", note: JSON.stringify(v1) }; // incomplete -> newline with auto-indent
  });

  await check("Enter runs a complete statement, input editor clears, echo + result in transcript", async () => {
    await py("await py.console.setInput('40 + 2'); return 1");
    await key("ENTER");
    await app.ev("await __qa.waitFor(async () => { const py = await __qa.py(); return py.console.transcript().includes('42'); }, 5000); return 1", { timeout: 9000 });
    const t = await tr();
    const inp = await py("return await py.console.getInput()");
    return { ok: /^>>> 40 \+ 2$/m.test(t) && /^42$/m.test(t) && inp === "", note: JSON.stringify([t.slice(-80), inp]) };
  });

  await check("history: Up recalls the previous input, persisted in the project store", async () => {
    await py("await py.console.setInput(''); return 1");
    await key("UP");
    await sleep(150);
    const v = await py("return await py.console.getInput()");
    const disk = await py("return await py.console.historyDisk()");
    return { ok: v === "40 + 2" && disk.includes("40 + 2"), note: JSON.stringify([v, disk]) };
  });

  await check("Shift+Enter always inserts a newline", async () => {
    await py("await py.console.setInput('1 + 1'); return 1");
    await key("shift ENTER");
    await sleep(200);
    const v = await py("return await py.console.getInput()");
    await py("await py.console.setInput(''); return 1");
    return { ok: v === "1 + 1\n", note: JSON.stringify(v) };
  });

  await check("traceback has clickable File links that open the editor", async () => {
    await py("await py.console.open(); return 1");
    const o = await out("import crash");
    const link = await app.ev(`await __qa.waitFor('.pyc-link', 5000); const a = document.querySelector('.pyc-link[data-path$="crash.py"][data-line="2"]'); if (!a) return null; const r = [a.dataset.path, a.dataset.line]; a.click(); return r;`, { timeout: 9000 });
    await app.ev(`await __qa.waitFor(() => __qa.state().tabs.some(g => g.tabs.some(t => t.name === 'crash.py')), 5000); return 1`, { timeout: 9000 });
    const s = await S();
    const line = await app.ev(`await __qa.waitFor(() => __qa.state().cursor && __qa.state().cursor.line === 2, 5000); return __qa.state().cursor.line`, { timeout: 9000 }).catch(() => -1);
    return { ok: o.includes("ZeroDivisionError") && link && link[0].endsWith("crash.py") && line === 2, note: JSON.stringify({ link, line, tabs: s.tabs }) };
  }, { fresh: "hello.py" });

  await check("variables panel lists user variables after an execution (no polling)", async () => {
    await py("await py.console.open(); py.console.showVars(true); return 1");
    await out("abc = [1, 2, 3]\nname = 'ace'");
    const found = await app.ev(`await __qa.waitFor('.pyc-var[data-name="abc"]', 5000); const g = n => { const e = document.querySelector('.pyc-var[data-name="'+n+'"]'); return e && [e.querySelector('.t').textContent, e.querySelector('.v').textContent]; }; return [g('abc'), g('name')];`, { timeout: 9000 });
    return { ok: found[0][0] === "list" && found[0][1] === "[1, 2, 3]" && found[1][1] === "'ace'", note: JSON.stringify(found) };
  }, { fresh: "hello.py" });

  await check("Ctrl+C interrupts a running cell, console stays alive", async () => {
    await py("await py.console.open(); return 1");
    await app.ev(`window.__long = (await __qa.py()).console.execute("import time\\nprint('sleeping', flush=True)\\ntime.sleep(60)"); return 1`);
    await app.ev(`await __qa.waitFor(async () => (await __qa.py()).console.transcript().includes('sleeping'), 5000); return 1`, { timeout: 9000 });
    await py("await py.console.setInput(''); return 1"); // focus the input editor
    await key("control C");
    const r = await app.ev(`return await Promise.race([window.__long.then(r => r.out), new Promise(res => setTimeout(() => res('TIMEOUT'), 8000))])`, { timeout: 12000 });
    const again = await out("2 + 2");
    return { ok: r.includes("KeyboardInterrupt") && again.trim() === "4", note: JSON.stringify([r.slice(-120), again]) };
  });

  await check("Execute Selection action is registered on alt shift E (editor context) and unique", async () => {
    const acts = await app.ev("return __qa.actions()");
    const mine = acts.find((a) => a.id === "ExecuteInPyConsoleAction");
    const dup = acts.filter((a) => a.keys.includes("alt shift E") && a.id !== "ExecuteInPyConsoleAction");
    const tw = acts.find((a) => a.id === "ActivatePythonConsoleToolWindow");
    return { ok: !!mine && mine.keys.includes("alt shift E") && dup.length === 0 && !!tw, note: JSON.stringify({ mine, dup: dup.map((d) => d.id), tw: !!tw }) };
  });

  await check("Execute Selection: real editor selection (multi-line) via the real key, one cell, editor keeps focus", async () => {
    await py("await py.console.stop(); return py.console.clear()"); // so we also prove the action starts the console itself
    await c.reset("app/util.py");
    await py("return py.console.select(1, 1, 3, 100)"); // def add(...) ... return a + b (lines 1-3)
    await key("alt shift E");
    await app.ev(`await __qa.waitFor(async () => (await __qa.py()).console.transcript().includes('def add'), 8000); await new Promise(r => setTimeout(r, 400)); return 1`, { timeout: 12000 });
    const s = await S();
    const t = await tr();
    const r = await out("add(2, 3)");
    const entries = await py("return py.console.entries()");
    const inCells = entries.filter((e) => e.kind === "in");
    return { ok: s.toolWindows.bottom === "pyconsole" && s.focused === "editor" && /^>>> def add\(a: int, b: int\) -> int:$/m.test(t) && /^\.\.\.     return a \+ b$/m.test(t) && r.trim() === "5" && inCells[0].code.split("\n").length === 3, note: JSON.stringify({ tw: s.toolWindows.bottom, focused: s.focused, t: t.slice(0, 200), r }) };
  });

  await check("Execute Selection with no selection runs the whole statement/block at the caret", async () => {
    await c.reset("app/util.py");
    await py("return py.console.caret(6, 5)"); // inside `def greet(name: str) -> str:` header line
    await key("alt shift E");
    await app.ev(`await __qa.waitFor(async () => (await __qa.py()).console.transcript().includes('def greet'), 8000); await new Promise(r => setTimeout(r, 300)); return 1`, { timeout: 12000 });
    const r = await out('greet("x")');
    const entries = await py("return py.console.entries()");
    const cell = entries.filter((e) => e.kind === "in").find((e) => e.code.startsWith("def greet"));
    return { ok: r.includes("hello x") && cell && cell.code === 'def greet(name: str) -> str:\n    return f"hello {name}"', note: JSON.stringify({ r, cell }) };
  });

  await check("Execute Selection does nothing on a blank line and in non-Python editors", async () => {
    await c.reset("app/util.py");
    const before = (await py("return py.console.entries()")).length;
    await py("return py.console.caret(5, 1)"); // blank line
    await key("alt shift E");
    await sleep(500);
    const after = (await py("return py.console.entries()")).length;
    return { ok: before === after, note: `${before} -> ${after}` };
  });

  await check("interpreter change offers a restart (dialog -> restart clears the session)", async () => {
    await py("await py.console.open(); return 1");
    await out("keepme = 1");
    const res = await app.ev(`const py = await __qa.py(); const p = py.console.interpreterChanged('/nonexistent/python'); await __qa.waitFor('.dialog .primary', 5000); const txt = document.querySelector('.dialog').innerText; document.querySelector('.dialog .primary').click(); await p; await new Promise(r => setTimeout(r, 300)); return txt;`, { timeout: 20000 });
    const o = await out("'keepme' in dir()");
    return { ok: /interpreter has changed/i.test(res) && o.trim() === "False", note: JSON.stringify([res.slice(0, 80), o]) };
  });

  await check("Stop ends the process; the next execution starts a new console", async () => {
    await py("await py.console.open(); return 1");
    const s1 = await py("return await py.console.stop()");
    const t = await tr();
    const o = await out("3 * 3");
    const s2 = await st();
    return { ok: s1 === "stopped" && /Process finished/.test(t) && o.endsWith("\n9\n") && s2.status === "ready", note: JSON.stringify([s1, t.slice(-120), o, s2.status]) };
  });

  await check("restart clears the transcript and the namespace", async () => {
    await out("zz = 1");
    await py("await py.console.restart(); return 1");
    const o = await out("zz");
    return { ok: /NameError/.test(o), note: JSON.stringify(o.slice(-80)) };
  });

  await check("remote: console over ssh on mc (/usr/bin/python3, no IPython)", async () => {
    if (noSsh) return { ok: true, note: "skipped (--no-ssh)" };
    await py("await py.console.stop(); py.console.useOverride({ host: 'mc', cwd: '/tmp', python: '/usr/bin/python3' }); await py.console.restart(); return 1");
    try {
      const s = await st();
      const o = await out("import sys\nprint(sys.version_info[:2], sys.platform)\nsum(range(10))");
      const bad = await out("1/0");
      const chk = await app.ev(`const py = await __qa.py(); await py.console.setInput('for i in range(2):'); return 1`);
      const v = await py("return await py.console.vars()");
      return { ok: s.status === "ready" && !s.ipython && /linux/.test(o) && /45/.test(o) && /ZeroDivisionError/.test(bad) && Array.isArray(v), note: JSON.stringify({ s: s.status, o, bad: bad.slice(-60) }) };
    } finally {
      await py("await py.console.stop(); py.console.useOverride(null); py.console.clear(); return 1");
    }
  });

  await check("screenshot (visual review only): transcript, traceback link, variables panel", async () => {
    await py("await py.console.restart(); py.console.showVars(true); return 1");
    await out("import math\nvals = [round(math.sin(i), 3) for i in range(5)]\nprint('sin:', vals)\nvals");
    await out("def f(n):\n    return 10 / n");
    await out("f(0)");
    await py("await py.console.setInput('f(2)'); return 1");
    await sleep(500);
    const f = app.shot("c_console");
    return { ok: true, note: String(f) };
  });

  await check("final: console stopped, nothing left running", async () => {
    await py("await py.console.stop(); return 1");
    const s = await st();
    return { ok: s.status === "stopped", note: s.status };
  });
}
