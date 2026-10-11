// Python Packages window checks. Everything that modifies an environment targets the SCRATCH venv only (asserted first).
export async function checks(c) {
  const { check, py, S, app, venvPython, sleep, noSsh } = c;
  const J = JSON.stringify;
  const st = () => py("return py.packages.state()");
  /** run an operation through the real confirmation dialog: assert its text, then press `button` ("primary" | "cancel") */
  const viaDialog = (kind, name, version, button = "primary") =>
    app.ev(
      `const py = await __qa.py(); py.packages.open(); const p = py.packages.requestOp(${J(kind)}, ${J(name)}, ${J(version ?? null)}); await __qa.waitFor('.dialog', 8000);
       const d = document.querySelector('.dialog'); const text = d.innerText;
       [...d.querySelectorAll('button')].find(b => ${button === "primary" ? "b.classList.contains('primary')" : "b.textContent.trim() === 'Cancel'"}).click();
       const r = await p; return { text, r };`,
      { timeout: 120000 },
    );

  await check("safety: the selected interpreter is the scratch venv", async () => {
    const i = await py("return py.packages.interp()");
    return { ok: i === venvPython, note: i };
  });

  await check("lists the packages of the interpreter (uv pip list): pytest, debugpy, ruff, basedpyright", async () => {
    await py("return py.packages.open()");
    const r = await py("return await py.packages.list()");
    const names = r.pkgs.map((p) => p.name.toLowerCase());
    const need = ["pytest", "debugpy", "ruff", "basedpyright"];
    return { ok: r.interp === venvPython && r.tool === "uv" && need.every((n) => names.includes(n)) && !r.error, note: JSON.stringify({ tool: r.tool, n: names.length, missing: need.filter((n) => !names.includes(n)), error: r.error }) };
  });

  await check("window renders rows, filter box narrows the list", async () => {
    await py("return py.packages.open()");
    const n = await app.ev(`await __qa.waitFor('.pk-row[data-name="pytest"]', 8000); return document.querySelectorAll('.pk-row').length`, { timeout: 12000 });
    await py("py.packages.setQuery('pyte'); return 1");
    await sleep(200);
    const rows = await app.ev(`return [...document.querySelectorAll('.pk-row .n')].map(e => e.textContent)`);
    await py("py.packages.setQuery(''); return 1");
    return { ok: n > 5 && rows.length >= 1 && rows.every((r) => r.toLowerCase().includes("pyte")), note: JSON.stringify({ n, rows }) };
  });

  await check("PyPI exact lookup (six) + details pane", async () => {
    const d = await py("return await py.packages.lookup('six')");
    await py("py.packages.open(); await py.packages.list(); return 1");
    await py("await py.packages.select('pytest', 'installed'); return 1");
    const shown = await app.ev(`await __qa.waitFor(() => document.querySelector('[data-k="latest"]') && document.querySelector('[data-k="latest"]').textContent !== '…', 10000); return [document.querySelector('.pk-title').textContent, document.querySelector('[data-k="installed"]').textContent, document.querySelector('[data-k="latest"]').textContent, document.querySelectorAll('.pk-select option').length]`, { timeout: 15000 });
    return { ok: d && d.name.toLowerCase() === "six" && d.versions.length > 3 && shown[0] === "pytest" && /^\d/.test(shown[1]) && /^\d/.test(shown[2]) && shown[3] > 3, note: JSON.stringify({ six: d && [d.name, d.version, d.versions.length], shown }) };
  });

  await check("PyPI search mode lists results (exact name lookup always works)", async () => {
    const hits = await py("return await py.packages.search('six')");
    await py("py.packages.setMode('installed'); py.packages.setQuery(''); return 1");
    return { ok: hits.some((h) => h.name.toLowerCase() === "six") && hits.every((h) => "version" in h), note: JSON.stringify(hits.slice(0, 3)) };
  });

  await check("install: confirmation shows the exact command; Cancel changes nothing", async () => {
    const res = await viaDialog("install", "six", null, "cancel");
    const l = await py("return await py.packages.list()");
    const exact = `pip install --python ${venvPython} six`;
    return { ok: res.text.includes(exact) && res.r.cancelled === true && !l.pkgs.some((p) => p.name === "six"), note: JSON.stringify({ text: res.text.slice(0, 260), cancelled: res.r.cancelled }) };
  });

  await check("install six through the confirm dialog: appears in the list, log streamed", async () => {
    const res = await viaDialog("install", "six", null, "primary");
    const l = await py("return await py.packages.list()");
    const s = await st();
    const dom = await app.ev(`await __qa.waitFor('.pk-row[data-name="six"]', 8000); return document.querySelector('[data-testid="pk-log"]').textContent`, { timeout: 12000 });
    return { ok: res.r.ok && l.pkgs.some((p) => p.name === "six") && dom.includes("pip install --python") && !s.status.error, note: JSON.stringify({ ok: res.r.ok, status: s.status, log: dom.slice(-200) }) };
  });

  await check("install a pinned old version, then upgrade through the dialog", async () => {
    const un = await py(`return await py.packages.requestOp('uninstall', 'six', null, true)`);
    const a = await py(`return await py.packages.requestOp('install', 'six', '1.15.0', true)`);
    let l = await py("return await py.packages.list()");
    const v1 = l.pkgs.find((p) => p.name === "six")?.version;
    const res = await viaDialog("upgrade", "six", null, "primary");
    l = await py("return await py.packages.list()");
    const v2 = l.pkgs.find((p) => p.name === "six")?.version;
    return { ok: un.ok && a.ok && v1 === "1.15.0" && res.r.ok && res.text.includes("--upgrade") && v2 && v2 !== "1.15.0", note: JSON.stringify({ v1, v2 }) };
  });

  await check("uninstall six through the dialog: gone from the list", async () => {
    const res = await viaDialog("uninstall", "six", null, "primary");
    const l = await py("return await py.packages.list()");
    return { ok: res.r.ok && res.text.includes("uninstall --python") && !l.pkgs.some((p) => p.name === "six"), note: JSON.stringify({ ok: res.r.ok, left: l.pkgs.some((p) => p.name === "six") }) };
  });

  await check("failures surface in the log and a red status line", async () => {
    await py("py.packages.open(); return 1");
    const r = await py(`return await py.packages.requestOp('install', 'definitely-not-a-real-package-ace-xyz', null, true)`);
    const s = await st();
    const red = await app.ev(`return document.querySelector('[data-testid="pk-status"]').classList.contains('err')`);
    return { ok: !r.ok && s.status.error && red, note: JSON.stringify(s.status).slice(0, 200) };
  });

  await check("remote: package listing on mc surfaces the pip-less python as an error (no crash)", async () => {
    if (noSsh) return { ok: true, note: "skipped (--no-ssh)" };
    await py("py.packages.useOverride({ host: 'mc', cwd: '/tmp', python: '/usr/bin/python3' }); return 1");
    try {
      const r = await py("return await py.packages.list()");
      return { ok: r.pkgs.length === 0 && /pip|No module/i.test(r.error ?? "") && r.tool === "pip", note: JSON.stringify({ error: r.error, tool: r.tool }) };
    } finally {
      await py("py.packages.useOverride(null); await py.packages.list(); return 1");
    }
  });

  await check("screenshot (visual review only)", async () => {
    await py("py.packages.open(); py.packages.setMode('installed'); py.packages.setQuery(''); await py.packages.list(); await py.packages.select('pytest', 'installed'); return 1");
    await app.ev(`await __qa.waitFor(() => document.querySelector('[data-k="latest"]')?.textContent !== '…', 10000); return 1`, { timeout: 15000 });
    await sleep(300);
    return { ok: true, note: String(app.shot("c_packages")) };
  });

  await check("scratch venv unchanged at the end (six not installed)", async () => {
    const l = await py("return await py.packages.list()");
    return { ok: !l.pkgs.some((p) => p.name === "six"), note: "" };
  });
}
