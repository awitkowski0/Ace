// Language intelligence area (Agent D): basedpyright through the LSP bridge, ruff diagnostics/fixes, Reformat Code, Optimize Imports,
// File Structure, Go to Symbol, interpreter switching + the "Install basedpyright" flow. Driven only through window.__qa / __qa.py().
export async function checks(c) {
  const { app, proj, venv, venvPython, check, key, py, P, S, W, sleep, fs, path, scratch, execSync } = c;
  const ev = (body, o) => app.ev(body, o);
  const jq = JSON.stringify;
  const L = (body, o) => py(`const lang = py.lang; const T = await lang.tools(); ${body}`, o);
  const made = [];

  W("lsp_probe.py", `import os\nimport pytest\nfrom app.util import add, greet\n\n\nclass Box:\n    def size(self) -> int:\n        return 3\n\n\nb = Box()\nb.size()\nos.path.jo\npytest.rais\nadd(1, 2)\nadd("a", 1)\nundefined_name_xyz\ngreet("q")\n`);
  W("rn_a.py", `def alpha_fn(x):\n    return x\n`);
  W("rn_b.py", `from rn_a import alpha_fn\n\nprint(alpha_fn(1))\n`);
  W("rn_c.py", `from rn_a import alpha_fn\n\nprint(alpha_fn(2))\n`);
  const MESSY = fs.readFileSync(P("messy.py"), "utf8");
  const MESSY_FORMATTED = `import sys\nimport os\nfrom app.util import greet\n\nx = 1\n\n\ndef f(a, b):\n    return a + b\n\n\nprint(greet("x"), x)\n`;
  const MESSY_OPTIMIZED_RUFF = `from app.util import greet\n\nx=1\ndef f( a,b ):\n  return a+b\nprint(greet("x"),x)\n`;

  const open = (rel) => ev(`return await __qa.reset(${jq(P(rel))})`, { timeout: 20000 });
  const modelText = (rel) => L(`return T.text(${jq(P(rel))})`);
  const restore = (rel, text) => L(`T.setText(${jq(P(rel))}, ${jq(text)}); return 1`);
  const waitFor = (fnSrc, ms = 60000) => ev(`return await __qa.waitFor(async () => { const py = await __qa.py(); const lang = py.lang; const T = await lang.tools(); return (${fnSrc}); }, ${ms})`, { timeout: ms + 5000 });
  /** poll hover until the server answers for this file (it is the readiness probe) */
  const serverReady = async (rel, line = 15, col = 2, ms = 90000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const h = await L(`return await lang.hover(${jq(P(rel))}, ${line}, ${col})`).catch(() => null);
      if (h) return true;
      await sleep(400);
    }
    return false;
  };
  const diags = (rel) => L(`return await lang.diagnostics(${jq(P(rel))})`);
  const waitDiags = async (rel, pred, ms = 60000) => {
    const t0 = Date.now();
    let d = [];
    while (Date.now() - t0 < ms) { d = await diags(rel); if (pred(d)) return d; await sleep(300); }
    return d;
  };
  const dom = (sel) => ev(`return [...document.querySelectorAll(${jq(sel)})].map((e) => e.innerText)`);
  const click = (sel) => ev(`const el = document.querySelector(${jq(sel)}); if (!el) throw new Error("no element"); el.click(); return 1`);
  const clickText = (sel, text) => ev(`const el = [...document.querySelectorAll(${jq(sel)})].find((e) => e.textContent.trim() === ${jq(text)}); if (!el) throw new Error("no element with text"); el.click(); return 1`);
  const setInput = (sel, val) => ev(`const el = document.querySelector(${jq(sel)}); if (!el) throw new Error("no element"); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(el, ${jq(val)}); el.dispatchEvent(new Event("input", { bubbles: true })); return el.value`);
  const cursor = async () => (await S()).cursor;
  const activeTab = async () => { const s = await S(); const g = s.tabs.find((t) => t.group === s.activeGroup); return g?.active ?? null; };

  // ------------------------------------------------------------------------------------------ server + navigation
  await check("basedpyright starts on the first .py file, from the interpreter's venv bin, no other servers", async () => {
    await open("lsp_probe.py");
    const ok = await serverReady("lsp_probe.py");
    const ss = await L("return lang.sessions()");
    const ll = await L("return lang.lastLaunch()");
    return { ok: ok && ss.length === 1 && ss[0].serverId === "basedpyright" && ss[0].bin === path.join(venv, "bin/basedpyright-langserver") && ll.pathPrepend.includes(path.join(venv, "bin")), note: JSON.stringify(ss) };
  }, { fresh: false });

  await check("completion (project type): members of Box after '.'", async () => {
    const items = await L(`return await lang.completion(${jq(P("lsp_probe.py"))}, 12, 3, ".")`);
    return { ok: items.some((i) => i.label === "size"), note: `${items.length} items` };
  }, { fresh: false });

  await check("completion resolves into the venv's site-packages (pytest.raises) and the stdlib (os.path.join)", async () => {
    const a = await L(`return await lang.completion(${jq(P("lsp_probe.py"))}, 14, 12)`);
    const b = await L(`return await lang.completion(${jq(P("lsp_probe.py"))}, 13, 11)`);
    return { ok: a.some((i) => i.label === "raises") && b.some((i) => i.label === "join"), note: `pytest:${a.length} os.path:${b.length}` };
  }, { fresh: false });

  await check("completion popup is shown by the real editor (⌃Space) with the same items", async () => {
    await open("lsp_probe.py");
    await L(`T.setCaret(${jq(P("lsp_probe.py"))}, 12, 3); return 1`);
    await key("control SPACE");
    const shown = await ev(`return await __qa.waitFor(() => { const w = document.querySelector(".suggest-widget.visible"); return w ? w.innerText : null; }, 8000)`, { timeout: 12000 });
    await key("ESCAPE");
    return { ok: /size/.test(shown), note: String(shown).replace(/\s+/g, " ").slice(0, 80) };
  }, { fresh: false });

  await check("hover / Quick Documentation: signature + docstring of add (F1 shows it in the editor)", async () => {
    const h = await L(`return await lang.hover(${jq(P("lsp_probe.py"))}, 15, 2)`);
    await open("lsp_probe.py");
    await L(`T.setCaret(${jq(P("lsp_probe.py"))}, 15, 2); return 1`);
    await key("F1");
    const shown = await ev(`return await __qa.waitFor(() => { const w = document.querySelector(".monaco-hover:not(.hidden)"); return w && w.innerText.includes("Add two") ? w.innerText : null; }, 8000)`, { timeout: 12000 }).catch(() => null);
    await key("ESCAPE");
    return { ok: /add/.test(h) && /Add two numbers/.test(h) && !!shown, note: `hover=${String(h).replace(/\s+/g, " ").slice(0, 80)} widget=${!!shown}` };
  }, { fresh: false });

  await check("go to declaration (⌘B) into the project: add -> app/util.py:1", async () => {
    await open("lsp_probe.py");
    await L(`T.setCaret(${jq(P("lsp_probe.py"))}, 15, 2); return 1`);
    await key("meta B");
    await waitFor(`location.href && document.title !== undefined`, 2000).catch(() => {});
    await ev(`return await __qa.waitFor(() => __qa.state().tabs.some((g) => g.active && g.active.endsWith("app/util.py")), 8000)`, { timeout: 12000 });
    const cur = await cursor();
    return { ok: (await activeTab())?.endsWith("app/util.py") && cur.line === 1, note: JSON.stringify(cur) };
  }, { fresh: false });

  await check("go to declaration (⌘B) into site-packages: import pytest -> .venv/lib/.../site-packages/pytest/__init__.py", async () => {
    await open("lsp_probe.py");
    await L(`T.setCaret(${jq(P("lsp_probe.py"))}, 2, 10); return 1`);
    await key("meta B");
    await ev(`return await __qa.waitFor(() => __qa.state().tabs.some((g) => g.active && g.active.includes("site-packages/pytest/")), 10000)`, { timeout: 14000 });
    const t = await activeTab();
    const def = await L(`return await lang.definition(${jq(P("lsp_probe.py"))}, 2, 10)`);
    return { ok: t.includes(path.join(venv, "lib")) && def[0].path.includes("site-packages/pytest/"), note: t.slice(-60) };
  }, { fresh: false });

  await check("find usages (⌥F7) fills the Usages window; references via LSP include app/main.py", async () => {
    await open("app/util.py");
    await serverReady("app/util.py", 1, 6);
    await L(`T.setCaret(${jq(P("app/util.py"))}, 1, 6); return 1`);
    await key("alt F7");
    await ev(`return await __qa.waitFor(() => document.querySelectorAll(".lsp-row").length >= 3, 15000)`, { timeout: 20000 });
    const rows = await dom(".lsp-row");
    const refs = await L(`return await lang.references(${jq(P("app/util.py"))}, 1, 6)`);
    return { ok: rows.length >= 3 && refs.some((r) => r.path.endsWith("app/main.py")) && refs.some((r) => r.path.endsWith("app/util.py")), note: `${rows.length} rows, refs=${refs.length}` };
  }, { fresh: false });

  await check("parameter info (⌘P) shows add(a: int, b: int) with the active parameter", async () => {
    await open("lsp_probe.py");
    const sig = await L(`return await lang.signature(${jq(P("lsp_probe.py"))}, 15, 8)`);
    await L(`T.setCaret(${jq(P("lsp_probe.py"))}, 15, 8); return 1`);
    await key("meta P");
    const shown = await ev(`return await __qa.waitFor(() => { const w = document.querySelector(".parameter-hints-widget.visible"); return w ? w.innerText : null; }, 8000)`, { timeout: 12000 }).catch(() => null);
    await key("ESCAPE");
    return { ok: sig?.[0]?.label.includes("a: int") && sig[0].active === 1 && /a: int/.test(shown ?? ""), note: JSON.stringify(sig)?.slice(0, 120) };
  }, { fresh: false });

  await check("File Structure (⌘F12) lists Counter, __init__, bump, compute of app/main.py", async () => {
    await open("app/main.py");
    await serverReady("app/main.py", 12, 25);
    await key("meta F12");
    await ev(`return await __qa.waitFor(() => document.querySelectorAll(".popup .popup-row").length >= 3, 8000)`, { timeout: 12000 });
    const rows = (await dom(".popup .popup-row")).map((t) => t.replace(/\s+/g, " ").trim());
    await key("ESCAPE");
    const has = (n) => rows.some((r) => r.includes(n));
    return { ok: has("Counter") && has("__init__") && has("bump") && has("compute"), note: rows.join(" | ").slice(0, 160) };
  }, { fresh: false });

  await check("Go to Symbol (⌘⌥O) finds Python classes and functions", async () => {
    await open("app/main.py");
    await key("meta alt O");
    await ev(`return await __qa.waitFor(".popup input", 5000)`, { timeout: 8000 });
    await ev(`await __qa.type("Counter"); return 1`);
    await ev(`return await __qa.waitFor(() => [...document.querySelectorAll(".popup")].some((p) => /Counter/.test(p.innerText) && p.innerText.includes("main.py")), 15000)`, { timeout: 20000 });
    const txt = (await dom(".popup"))[0].replace(/\s+/g, " ");
    await key("ESCAPE");
    return { ok: /Counter/.test(txt) && /main\.py/.test(txt), note: txt.slice(0, 140) };
  }, { fresh: false });

  // ------------------------------------------------------------------------------------------ diagnostics
  await check("diagnostics: pyright error (undefined name, wrong argument type) + merged per source, shown in Problems", async () => {
    await open("lsp_probe.py");
    const d = await waitDiags("lsp_probe.py", (x) => x.some((e) => e.code === "reportUndefinedVariable") && x.some((e) => e.code === "reportArgumentType"));
    await key("meta 6");
    await ev(`return await __qa.waitFor(() => document.querySelectorAll(".lsp-row").length >= 2, 8000)`, { timeout: 12000 });
    const rows = await dom(".lsp-row");
    const markers = await L(`return T.markers(${jq(P("lsp_probe.py"))})`);
    await key("meta 6");
    const undef = d.find((e) => e.code === "reportUndefinedVariable"), arg = d.find((e) => e.code === "reportArgumentType");
    return { ok: !!undef && undef.line === 17 && undef.severity === 1 && !!arg && arg.line === 16 && rows.some((r) => /not defined/.test(r)) && markers.some((m) => m.owner === "lsp"), note: `${d.length} diags, rows=${rows.length}` };
  }, { fresh: false });

  await check("diagnostics: ruff F401 x2 in messy.py (source ruff, own marker owner), next to LSP results", async () => {
    await open("messy.py");
    const d = await waitDiags("messy.py", (x) => x.filter((e) => e.code === "F401").length >= 2);
    const markers = await L(`return T.markers(${jq(P("messy.py"))})`);
    const f = d.filter((e) => e.code === "F401");
    return { ok: f.length === 2 && f.every((e) => e.owner === "ruff" && e.source === "ruff" && e.fix) && markers.filter((m) => m.owner === "ruff").length >= 2, note: d.map((e) => `${e.code}@${e.line}`).join(",") };
  }, { fresh: false });

  await check("diagnostics: ruff and LSP results coexist after an edit (neither clobbers the other)", async () => {
    await open("lsp_probe.py");
    await L(`T.setText(${jq(P("lsp_probe.py"))}, T.text(${jq(P("lsp_probe.py"))}) + "import json\\n"); return 1`);
    const d = await waitDiags("lsp_probe.py", (x) => x.some((e) => e.owner === "ruff" && e.code === "F401") && x.some((e) => e.owner === "lsp" && e.code === "reportArgumentType"), 30000);
    await L(`T.setText(${jq(P("lsp_probe.py"))}, T.text(${jq(P("lsp_probe.py"))}).replace("import json\\n", "")); return 1`);
    return { ok: d.some((e) => e.owner === "ruff" && e.code === "F401") && d.some((e) => e.owner === "lsp" && e.code === "reportArgumentType"), note: d.map((e) => `${e.owner}:${e.code}`).join(",") };
  }, { fresh: false });

  await check("ruff is debounced: 6 edits 60 ms apart cause at most 2 runs; a non-Python file triggers none", async () => {
    await open("lsp_probe.py");
    await sleep(1500);
    const before = (await L("return await lang.ruffStats()")).runs;
    await L(`await T.burst(${jq(P("lsp_probe.py"))}, 6, 60); return 1`);
    await sleep(2500);
    const after = (await L("return await lang.ruffStats()")).runs;
    await open("pyproject.toml");
    await sleep(1500);
    const toml = (await L("return await lang.ruffStats()")).runs;
    await L(`T.setText(${jq(P("lsp_probe.py"))}, T.text(${jq(P("lsp_probe.py"))}).replace(/(\\n# edit \\d)+$/, "")); return 1`);
    return { ok: after - before >= 1 && after - before <= 2 && toml === after, note: `burst runs=${after - before} toml runs=${toml - after}` };
  }, { fresh: false });

  await check("quick fix (⌥↵) on a ruff F401: 'Remove unused import' removes the line; # noqa entry offered too", async () => {
    await open("messy.py");
    await waitDiags("messy.py", (x) => x.filter((e) => e.code === "F401").length >= 2);
    await L(`T.setCaret(${jq(P("messy.py"))}, 1, 9); return 1`);
    await key("alt ENTER");
    await ev(`return await __qa.waitFor(() => document.querySelectorAll(".popup .popup-row").length >= 1, 8000)`, { timeout: 12000 });
    const rows = (await dom(".popup .popup-row")).map((t) => t.trim());
    const fix = rows.findIndex((r) => /Remove unused import/.test(r));
    for (let i = 0; i < fix; i++) await key("DOWN");
    await key("ENTER");
    await sleep(500);
    const after = await modelText("messy.py");
    await restore("messy.py", MESSY);
    return { ok: fix >= 0 && rows.some((r) => /noqa/.test(r)) && !after.split("\n")[0].includes("import sys") && after.split("\n").length === MESSY.split("\n").length - 1, note: rows.join(" | ").slice(0, 160) };
  }, { fresh: false });

  // ------------------------------------------------------------------------------------------ reformat / imports
  await check("Reformat Code (⌥⌘L) = ruff format output, single undo step, caret kept", async () => {
    await open("messy.py");
    await restore("messy.py", MESSY);
    await L(`T.setCaret(${jq(P("messy.py"))}, 7, 13); return 1`);
    await key("meta alt L");
    await waitFor(`T.text(${jq(P("messy.py"))}) !== ${jq(MESSY)}`, 15000);
    const text = await modelText("messy.py");
    const caret = await L("return T.caret()");
    await key("meta Z");
    await sleep(300);
    const undone = await modelText("messy.py");
    return { ok: text === MESSY_FORMATTED && undone === MESSY && caret.text === 'print(greet("x"), x)' && caret.col === 13, note: `caret=${JSON.stringify(caret)} undone=${undone === MESSY}` };
  }, { fresh: false });

  await check("Reformat Code on a selection formats only the selected lines (ruff --range)", async () => {
    await open("messy.py");
    await restore("messy.py", MESSY);
    await L(`T.select(${jq(P("messy.py"))}, 5, 1, 6, 13); return 1`);
    await key("meta alt L");
    await waitFor(`T.text(${jq(P("messy.py"))}) !== ${jq(MESSY)}`, 15000);
    const text = await modelText("messy.py");
    await restore("messy.py", MESSY);
    return { ok: text === `import sys\nimport os\nfrom app.util import greet\nx=1\ndef f(a, b):\n    return a + b\nprint(greet("x"),x)\n`, note: JSON.stringify(text).slice(0, 160) };
  }, { fresh: false });

  await check("Optimize Imports (⌃⌥O) with ruff: sorts and removes unused imports", async () => {
    await open("messy.py");
    await restore("messy.py", MESSY);
    await key("control alt O");
    await waitFor(`T.text(${jq(P("messy.py"))}) !== ${jq(MESSY)}`, 15000);
    const text = await modelText("messy.py");
    await restore("messy.py", MESSY);
    return { ok: text === MESSY_OPTIMIZED_RUFF, note: JSON.stringify(text).slice(0, 160) };
  }, { fresh: false });

  await check("remote/odd cases: reformat of a syntax-error file leaves the text alone and reports in the status bar", async () => {
    W("broken_fmt.py", "def (:\n  pass\n");
    await open("broken_fmt.py");
    const before = await modelText("broken_fmt.py");
    await key("meta alt L");
    await sleep(2500);
    const after = await modelText("broken_fmt.py");
    const note = await L("return lang.note()");
    return { ok: before === after && !!note && /Reformat Code/.test(note), note: String(note).slice(0, 100) };
  }, { fresh: false });

  // ------------------------------------------------------------------------------------------ rename (multi-file)
  await check("rename (⇧F6) alpha_fn -> beta_fn updates the definition, an open file and a closed file", async () => {
    await open("rn_b.py");
    await open("rn_a.py");
    await serverReady("rn_a.py", 1, 6);
    await L(`T.setCaret(${jq(P("rn_a.py"))}, 1, 6); return 1`);
    await key("shift F6");
    await ev(`return await __qa.waitFor(".dialog-input", 8000)`, { timeout: 12000 });
    await setInput(".dialog-input", "beta_fn");
    await click(".dialog-buttons .primary");
    await waitFor(`T.text(${jq(P("rn_a.py"))}).includes("beta_fn")`, 15000);
    await sleep(800);
    const a = await modelText("rn_a.py"), b = await modelText("rn_b.py");
    const cDisk = fs.readFileSync(P("rn_c.py"), "utf8");
    await restore("rn_a.py", `def alpha_fn(x):\n    return x\n`);
    await restore("rn_b.py", `from rn_a import alpha_fn\n\nprint(alpha_fn(1))\n`);
    fs.writeFileSync(P("rn_c.py"), `from rn_a import alpha_fn\n\nprint(alpha_fn(2))\n`);
    await key("meta S");
    return { ok: a.includes("def beta_fn") && b.includes("import beta_fn") && b.includes("beta_fn(1)") && cDisk.includes("beta_fn(2)") && !/alpha_fn/.test(cDisk), note: `a=${a.split("\n")[0]} b=${b.split("\n")[0]} c=${cDisk.split("\n")[0]}` };
  }, { fresh: false });

  // ------------------------------------------------------------------------------------------ formatter fallback (black / isort only)
  await check("without ruff (system interpreter): Reformat Code uses black, Optimize Imports uses isort", async () => {
    const sys = (await py("return py.interp.list()")).find((i) => !i.project && i.kind === "system");
    const st0 = await py("return py.interp.state()");
    if (!sys || !execSync("zsh -lc 'command -v black; command -v isort'").toString().includes("isort")) return { ok: true, note: "skipped: black/isort not on the login PATH" };
    await py(`await py.interp.switchTo(${jq(sys.path)}); return 1`);
    await waitFor(`!(await __qa.py()).interp.state().loading && (await __qa.py()).interp.current().path === ${jq(sys.path)} && !(await __qa.py()).interp.state().tools.ruff`, 20000);
    await open("messy.py");
    await restore("messy.py", MESSY);
    const r = await L("return await lang.reformat()");
    const fmt = await modelText("messy.py");
    await restore("messy.py", MESSY);
    const o = await L("return await lang.optimizeImports()");
    const opt = await modelText("messy.py");
    await restore("messy.py", MESSY);
    await py(`await py.interp.switchTo(${jq(venvPython)}); return 1`);
    await waitFor(`(await __qa.py()).interp.current().path === ${jq(venvPython)} && (await __qa.py()).interp.state().tools.ruff`, 20000);
    return { ok: r.tool === "black" && fmt === MESSY_FORMATTED && o.tool === "isort" && opt.startsWith("import os\nimport sys\n\nfrom app.util import greet\n"), note: `fmt=${r.tool} opt=${o.tool} ${JSON.stringify(opt).slice(0, 90)}` };
  }, { fresh: false });

  // ------------------------------------------------------------------------------------------ interpreter switch + install flow
  const venv2 = path.join(scratch, "qa-venv-b");
  made.push(venv2);
  await check("switching to a second venv without basedpyright shows 'Install basedpyright' (status bar + Problems), nothing is installed automatically", async () => {
    W("second_probe.py", `import qa_second_only\n\nqa_second_only.second_only_func()\nqa_second_only.\n`);
    // the harness aborts evals after 30 s and venv creation + probe can exceed that on a loaded Mac: start it, then poll
    await py(`window.__qaVenvB = py.interp.createVenv(${jq(venv2)}).then(() => "ok", (e) => String(e)); return 1`);
    for (let i = 0; i < 120 && (await ev("return window.__qaVenvB && (await Promise.race([window.__qaVenvB, new Promise((r) => setTimeout(() => r(null), 50))]))")) === null; i++) await sleep(500);
    const sp = execSync(`ls -d ${venv2}/lib/python3*/site-packages`).toString().trim();
    fs.writeFileSync(path.join(sp, "qa_second_only.py"), "def second_only_func() -> int:\n    \"\"\"only in venv B\"\"\"\n    return 2\n");
    await waitFor(`(await __qa.py()).interp.current().path === ${jq(path.join(venv2, "bin/python"))} && !(await __qa.py()).interp.state().loading`, 30000);
    await open("second_probe.py");
    await ev(`return await __qa.waitFor('[data-testid="lsp-install-hint"]', 30000)`, { timeout: 35000 });
    const hint = (await dom('[data-testid="lsp-install-hint"]'))[0];
    await key("meta 6");
    const notice = await ev(`return await __qa.waitFor('[data-testid="lsp-install-notice"]', 8000)`, { timeout: 12000 }).catch(() => false);
    await key("meta 6");
    const none = !fs.existsSync(path.join(venv2, "bin/basedpyright-langserver"));
    const ss = await L("return lang.sessions()");
    return { ok: /Install basedpyright/.test(hint) && !!notice && none && !ss.some((s) => s.ready), note: `hint='${hint}' notice=${!!notice} sessions=${JSON.stringify(ss)}` };
  }, { fresh: false });

  await check("install dialog shows the exact commands, Cancel installs nothing", async () => {
    await click('[data-testid="lsp-install-hint"]');
    await ev(`return await __qa.waitFor(".dialog-msg", 5000)`, { timeout: 8000 });
    const msg = (await dom(".dialog-msg"))[0];
    const choice = await L("return lang.installChoice()");
    await clickText(".dialog-buttons button", "Cancel");
    await sleep(1500);
    const none = !fs.existsSync(path.join(venv2, "bin/basedpyright-langserver"));
    return { ok: msg.includes("basedpyright") && (!choice.primary || msg.includes(choice.primary.join(" ").replace(/^.*\/(uv|pipx) /, "$1 ").split(" ").slice(1).join(" ")) || msg.includes("tool install")) && msg.includes(`--python ${path.join(venv2, "bin/python")}`) && none && !(await ev('return !!document.querySelector(".dialog")')), note: msg.replace(/\s+/g, " ").slice(0, 260) };
  }, { fresh: false });

  await check("'Install into Project Interpreter' installs into venv B, the server starts from it, completion finds a package present only there", async () => {
    await click('[data-testid="lsp-install-hint"]');
    await ev(`return await __qa.waitFor(".dialog-msg", 5000)`, { timeout: 8000 });
    await clickText(".dialog-buttons button", "Install into Project Interpreter");
    await ev(`return await __qa.waitFor(() => !document.querySelector(".dialog") && !document.querySelector('[data-testid="lsp-install-hint"]'), 240000)`, { timeout: 245000 });
    const ready = await serverReady("second_probe.py", 3, 5, 120000);
    const ss = await L("return lang.sessions()");
    const items = await L(`return await lang.completion(${jq(P("second_probe.py"))}, 4, 16, ".")`);
    const d = await waitDiags("second_probe.py", () => true, 1500);
    const def = await L(`return await lang.definition(${jq(P("second_probe.py"))}, 3, 18)`);
    return { ok: ready && ss.some((s) => s.ready && s.bin === path.join(venv2, "bin/basedpyright-langserver")) && items.some((i) => i.label === "second_only_func") && def[0]?.path.includes("qa-venv-b/lib") && !d.some((e) => e.code === "reportMissingImports"), note: `bin=${ss[0]?.bin?.slice(-40)} items=${items.length} def=${def[0]?.path.slice(-40)}` };
  }, { fresh: false });

  await check("switching back to the project venv restarts the server: venv B's package is no longer resolved", async () => {
    await py(`await py.interp.switchTo(${jq(venvPython)}); return 1`);
    await waitFor(`(await __qa.py()).interp.current().path === ${jq(venvPython)} && !(await __qa.py()).interp.state().loading`, 20000);
    await waitFor(`(await lang.sessions()).some((s) => s.ready && s.bin === ${jq(path.join(venv, "bin/basedpyright-langserver"))})`, 60000);
    await open("second_probe.py");
    const d = await waitDiags("second_probe.py", (x) => x.some((e) => e.code === "reportMissingImports"), 60000);
    const items = await L(`return await lang.completion(${jq(P("second_probe.py"))}, 4, 16, ".")`);
    return { ok: d.some((e) => e.code === "reportMissingImports") && !items.some((i) => i.label === "second_only_func"), note: d.map((e) => e.code).join(",") };
  }, { fresh: false });

  await check("server RSS while idle with a few files open (reported)", async () => {
    await sleep(1500);
    const out = execSync(`ps -axo rss=,command= | grep -F ${jq(scratch)} | grep -E "langserver.index.js|basedpyright-langserver" | grep -v grep || true`, { shell: "/bin/bash" }).toString().trim().split("\n").filter(Boolean);
    const rss = out.map((l) => Math.round(parseInt(l.trim(), 10) / 1024));
    return { ok: rss.length >= 1 && Math.max(...rss) < 1500, note: `basedpyright processes RSS MB: ${rss.join(", ")}` };
  }, { fresh: false });

  await check("cleanup", async () => {
    for (const d of made) fs.rmSync(d, { recursive: true, force: true });
    for (const f of ["lsp_probe.py", "rn_a.py", "rn_b.py", "rn_c.py", "second_probe.py", "broken_fmt.py"]) fs.rmSync(P(f), { force: true });
    const s = await S();
    return { ok: made.every((d) => !fs.existsSync(d)), note: `dirty=${s.dirty.length}` };
  }, { fresh: false });
}
