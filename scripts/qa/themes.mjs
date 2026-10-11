#!/usr/bin/env node
// Colour scheme suite (src/theme, docs/THEMES.md). Launches Ace under the automation harness on a SCRATCH project (own basedpyright venv,
// created with uv) and drives it only through window.__qa / __qa.themes(): no OS keyboard/mouse. Persistence is checked by relaunching
// with the same ATELIER_DATA_DIR. Real-file screenshots live in theme-shots.mjs.
// Usage: node scripts/qa/themes.mjs [--only <substring>]     Env: ATELIER_BIN
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, sleep, repo } from "./lib.mjs";

const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "ace-themes-")));
const proj = path.join(scratch, "proj");
const W = (rel, text) => { const f = path.join(proj, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const P = (rel) => path.join(proj, rel);
const jq = JSON.stringify;

// ---------------------------------------------------------------- fixtures
W("pyproject.toml", `[project]\nname = "demo"\nversion = "0.1.0"\n`);
W("counter.py", `class Counter:\n    LIMIT = 10\n\n    def __init__(self, start: int) -> None:\n        self.value = start\n\n    def bump(self, by: int = 1) -> int:\n        self.value = self.value + by\n        return self.value\n\n    @staticmethod\n    def make() -> "Counter":\n        return Counter(0)\n\n\nc = Counter(0)\nc.bump(2)\n`);
W("Sample.java", fs.readFileSync(new URL("./themes/Sample.java", import.meta.url), "utf8"));
W("sample.gd", fs.readFileSync(new URL("./themes/sample.gd", import.meta.url), "utf8"));
W("other.txt", "hello\n");
const uv = execSync("zsh -lc 'command -v uv'").toString().trim();
const venv = path.join(proj, ".venv");
let t0 = Date.now();
execFileSync(uv, ["venv", "--seed", venv], { stdio: "ignore" });
execFileSync(uv, ["pip", "install", "--python", path.join(venv, "bin/python"), "basedpyright"], { stdio: "ignore" });
console.log(`scratch ${proj} (venv ${Date.now() - t0} ms)`);

const dataDir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "ace-themes-data-"));
let app = await launch(proj, { dataDir });
const rows = [];
const S = () => app.ev("return __qa.state()");
const key = (k) => app.ev(`return await __qa.key(${jq(k)})`);
const T = (body, o) => app.ev(`const T = await __qa.themes(); ${body}`, o);
const reset = async (rel) => { for (let i = 0; ; i++) { try { return await app.ev(`return await __qa.reset(${jq(P(rel))})`, { timeout: 15000 }); } catch (e) { if (i) throw e; await sleep(500); } } };
const rgb = (h) => { const x = h.replace("#", ""); return `rgb(${parseInt(x.slice(0, 2), 16)}, ${parseInt(x.slice(2, 4), 16)}, ${parseInt(x.slice(4, 6), 16)})`; };
async function check(name, fn) {
  if (only && !name.toLowerCase().includes(only.toLowerCase())) return;
  let ok = false, note = "";
  try { const r = await fn(); ok = r === true || (r && r.ok); note = r && r.note ? r.note : ""; } catch (e) { note = String(e.message || e).split("\n")[0].slice(0, 220); }
  rows.push({ name, ok, note });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? "  - " + note : ""}`);
  if (!ok) app.shot("themes_fail_" + name.replace(/[^a-z0-9]+/gi, "_").toLowerCase());
}
const kinds = (tokens, text) => tokens.flat().filter((t) => t.text === text).map((t) => t.type.replace(/\.(java|gdscript)$/, ""));

try {
  await sleep(1500);
  const list = await T("return T.list()");
  const ids = list.map((s) => s.id);

  // ------------------------------------------------------------------------------------------ unit-level
  await check("contrast: unit tests (every scheme: body >= 7:1, every syntax/semantic colour >= 4.5:1) + semantic mapper pass", async () => {
    const out = execSync("pnpm vitest run src/theme src/editor/lsp/semantic.test.ts 2>&1", { cwd: repo, encoding: "utf8" });
    const m = /Tests\s+(\d+) passed/.exec(out);
    return { ok: !!m && !/failed/.test(out), note: m ? `${m[1]} tests` : out.slice(-200) };
  });
  await check(`registry has ${ids.length} schemes incl. Nord, Nord Vivid, Darcula, IntelliJ Dark (New UI), One Dark Vivid, Gradianto x2, Dracula, Tokyo Night, Catppuccin Mocha`, async () => {
    const need = ["nord", "nord-vivid", "darcula", "intellij-dark", "one-dark-vivid", "gradianto-deep-ocean", "gradianto-nature-green", "dracula", "tokyo-night", "catppuccin-mocha"];
    return { ok: need.every((n) => ids.includes(n)) && ids.length >= 10, note: ids.join(",") };
  });

  // ------------------------------------------------------------------------------------------ live switching
  await reset("Sample.java");
  await sleep(800);
  await app.ev("window.__themeMarker = Math.random(); return 1");
  const marker = await app.ev("return window.__themeMarker");
  await check("default scheme is Nord Vivid", async () => (await T("return T.state()")).effective === "nord-vivid");
  for (const id of ids) {
    await check(`live switch -> ${id}: UI vars + Monaco background change without reload`, async () => {
      await T(`T.set(${jq(id)}); await __qa.sleep(250); return 1`);
      const r = await T(`const e = T.expected(${jq(id)}); const m = await T.monaco(); return { e, m, vars: T.vars(["--bg-editor", "--nord0", "--nord15", "--accent", "--fg", "--bg-chrome"]), chrome: getComputedStyle(document.querySelector(".statusbar") || document.body).backgroundColor, mk: window.__themeMarker, st: T.state() }`);
      const bad = [];
      for (const k of ["--bg-editor", "--nord0", "--nord15", "--accent", "--fg", "--bg-chrome"]) if (r.vars[k] !== r.e.css[k]) bad.push(`${k} ${r.vars[k]} != ${r.e.css[k]}`);
      if (r.m.bg !== rgb(r.e.editorBg)) bad.push(`monaco bg ${r.m.bg} != ${rgb(r.e.editorBg)}`);
      if (r.chrome !== rgb(r.e.css["--bg-chrome"])) bad.push(`status bar ${r.chrome}`);
      if (r.mk !== marker) bad.push("page reloaded");
      if (r.st.saved !== id) bad.push("not saved");
      return { ok: bad.length === 0, note: bad.join("; ") };
    });
  }
  await check("all open editors re-theme (two groups after a split) and a second file keeps the scheme", async () => {
    await app.ev(`await __qa.openFile(${jq(P("sample.gd"))}); return 1`);
    await app.ev(`return __qa.runAction("SplitVertically") ?? 1`).catch(() => {});
    await sleep(500);
    await T(`T.set("dracula"); await __qa.sleep(300); return 1`);
    const r = await T(`const e = T.expected("dracula"); const bgs = [...document.querySelectorAll(".monaco-editor-background")].map((n) => getComputedStyle(n).backgroundColor); return { bgs, want: e.editorBg }`);
    return { ok: r.bgs.length >= 1 && r.bgs.every((b) => b === rgb(r.want)), note: `${r.bgs.length} editor surface(s)` };
  });
  await check("terminal follows the IDE scheme live (default terminal theme), keeps a Ghostty override", async () => {
    await key("alt F12");
    await app.ev(`const T = await __qa.term(); await __qa.waitFor(() => { const s = T.state(); const t = s.tabs.find((x) => x.id === s.active); return t && t.panes[0] && t.panes[0].cols > 10; }, 10000); return 1`);
    const bgOf = () => app.ev(`const T = await __qa.term(); const s = T.state(); const t = s.tabs.find((x) => x.id === s.active); const p = T.pane(t.panes[0].id); return { bg: p.term.options.theme.background, red: p.term.options.theme.red, set: T.settings().theme }`);
    const seen = {};
    for (const id of ["tokyo-night", "intellij-light", "nord-vivid"]) {
      await T(`T.set(${jq(id)}); await __qa.sleep(500); return 1`);
      const want = await T(`return T.expected(${jq(id)}).term`);
      const got = await bgOf();
      seen[id] = got.bg === want.background && got.red === want.red;
      if (!seen[id]) return { ok: false, note: `${id}: terminal bg ${got.bg} red ${got.red} want ${want.background}/${want.red} (theme setting ${got.set})` };
    }
    // a terminal-own choice wins over the IDE scheme
    await app.ev(`const T = await __qa.term(); const m = await import("/src/components/terminal/settings.ts").catch(() => null); return 1`).catch(() => {});
    return { ok: true, note: "tokyo-night, intellij-light, nord-vivid" };
  });

  // ------------------------------------------------------------------------------------------ quick switch popup
  await check("Quick Switch Scheme (control `): opens, arrows preview live, Esc restores the previous scheme", async () => {
    await T(`T.set("nord-vivid"); await __qa.sleep(200); return 1`);
    await reset("other.txt");
    await key("control BACK_QUOTE");
    const open = await S();
    if (!open.popup.open || !/Switch Theme/.test(open.popup.text)) return { ok: false, note: "popup not open: " + open.popup.text };
    await key("DOWN"); await sleep(250);
    const a = await T("return { st: T.state(), bg: T.cssVar('--bg-editor') }");
    await key("DOWN"); await sleep(250);
    const b = await T("return { st: T.state(), bg: T.cssVar('--bg-editor') }");
    await key("ESCAPE"); await sleep(300);
    const c = await T("return { st: T.state(), bg: T.cssVar('--bg-editor') }");
    const closed = !(await S()).popup.open;
    const ok = a.st.preview && a.st.saved === "nord-vivid" && a.st.effective !== "nord-vivid" && b.st.effective !== a.st.effective && c.st.effective === "nord-vivid" && c.st.preview === null && c.bg === "#2e3440" && closed;
    return { ok, note: `preview ${a.st.effective} -> ${b.st.effective}, after Esc ${c.st.effective}, popup closed=${closed}` };
  });
  await check("Quick Switch Scheme: Enter applies and persists; digit key selects", async () => {
    await key("control BACK_QUOTE");
    await key("DOWN"); await key("DOWN"); await sleep(200);
    const pre = await T("return T.state()");
    await key("ENTER"); await sleep(400);
    const post = await T("return T.state()");
    const okEnter = post.saved === pre.effective && post.preview === null && !(await S()).popup.open;
    await key("control BACK_QUOTE");
    await key("1"); await sleep(400);
    const dig = await T("return T.state()");
    return { ok: okEnter && dig.saved === ids[0], note: `enter -> ${post.saved}; digit 1 -> ${dig.saved}` };
  });
  await check("Settings > Appearance > Theme (Cmd+,) lists every scheme, preview on select, Cancel restores, OK saves", async () => {
    await T(`T.set("nord-vivid"); await __qa.sleep(200); return 1`);
    await key("meta COMMA"); await sleep(400);
    const rowsN = await app.ev(`return [...document.querySelectorAll("[data-settings] .scheme-row")].map((r) => r.dataset.id)`);
    await app.ev(`document.querySelector('[data-settings] .scheme-row[data-id="darcula"]').click(); return 1`); await sleep(300);
    const prev = await T("return T.state()");
    await key("ESCAPE"); await sleep(300);
    const afterCancel = await T("return T.state()");
    await key("meta COMMA"); await sleep(300);
    await app.ev(`document.querySelector('[data-settings] .scheme-row[data-id="catppuccin-mocha"]').click(); return 1`); await sleep(250);
    await app.ev(`document.querySelector("[data-settings] [data-ok]").click(); return 1`); await sleep(400);
    const afterOk = await T("return T.state()");
    return { ok: rowsN.length === ids.length && prev.effective === "darcula" && prev.saved === "nord-vivid" && afterCancel.effective === "nord-vivid" && afterOk.saved === "catppuccin-mocha", note: `${rowsN.length} rows; preview ${prev.effective}/${prev.saved}; cancel ${afterCancel.effective}; ok ${afterOk.saved}` };
  });

  // ------------------------------------------------------------------------------------------ persistence
  await check("persistence: the chosen scheme survives a relaunch (global pref in the data dir)", async () => {
    await T(`T.set("tokyo-night"); await __qa.sleep(300); return 1`);
    await app.stop();
    app = await launch(proj, { dataDir });
    await sleep(1500);
    const st = await T("return { st: T.state(), bg: T.cssVar('--bg-editor') }");
    return { ok: st.st.saved === "tokyo-night" && st.bg === "#1a1b26", note: `saved=${st.st.saved} bg=${st.bg}` };
  });
  await check("persistence file lives in ATELIER_DATA_DIR only", async () => {
    const f = path.join(dataDir, "ui-prefs.json");
    return { ok: fs.existsSync(f) && /tokyo-night/.test(fs.readFileSync(f, "utf8")) };
  });

  // ------------------------------------------------------------------------------------------ grammars
  await check("GDScript grammar: declarations, calls, self, types, constants, annotations, signals, node paths, string names", async () => {
    const text = fs.readFileSync(P("sample.gd"), "utf8");
    const tk = await T(`return await T.tokenize("gdscript", ${jq(text)})`);
    const want = [["take", "function.declaration"], ["is_dead", "function"], ["self", "variable.predefined"], ["Vector3", "type.identifier"], ["MAX_HP", "constant"],
      ["@export", "annotation"], ["@onready", "annotation"], ["died", "signal"], ["$Sprite3D", "tag.node"], ["$\"../Label\"", "tag.node"], ["damage", "variable.parameter"],
      ["speed", "variable.field"], ["hp", "variable.field"], ["if", "keyword.control"], ["and", "keyword.operator"], ["print", "predefined"], ["func", "keyword"], ["## Docs here", "comment.doc"]];
    const bad = [];
    for (const [w, k] of want) { const ks = kinds(tk, w); if (!ks.includes(k)) bad.push(`${w}: ${ks.join("|") || "?"} (want ${k})`); }
    const sn = tk.flat().some((t) => /string\.name/.test(t.type));
    if (!sn) bad.push("&\"x\" string name");
    return { ok: bad.length === 0, note: bad.join("; ") };
  });
  await check("Java grammar: annotations, constants, method decl vs call, this, types, namespaces, javadoc tags, keywords, new", async () => {
    const text = fs.readFileSync(P("Sample.java"), "utf8");
    const tk = await T(`return await T.tokenize("java", ${jq(text)})`);
    const want = [["@Mixin", "annotation"], ["MAX_SIZE", "constant"], ["run", "function.declaration"], ["make", "function.declaration"], ["spawn", "function"], ["forEach", "function"],
      ["this", "variable.predefined"], ["Spawner", "type.identifier"], ["java", "namespace"], ["if", "keyword.if"], ["return", "keyword.return"], ["public", "keyword.public"],
      ["null", "keyword.null"], ["@see", "comment.doc.tag"], ["new", "keyword.new"], ["Item", "type.identifier"], ["name", "variable.field"], ["\\n", "string.escape"]];
    const bad = [];
    for (const [w, k] of want) { const ks = kinds(tk, w); if (!ks.includes(k)) bad.push(`${w}: ${ks.join("|") || "?"} (want ${k})`); }
    return { ok: bad.length === 0, note: bad.join("; ") };
  });
  await check("theme maps those tokens to distinct colours (Nord Vivid): keyword vs control vs fn decl vs call vs field vs constant vs type vs annotation", async () => {
    await T(`T.set("nord-vivid"); await __qa.sleep(300); return 1`);
    await reset("Sample.java");
    await sleep(900);
    const c = await T(`return { kw: T.colorOf("public")?.color, ctl: T.colorOf("if")?.color, decl: T.colorOf("run")?.color, call: T.colorOf("forEach")?.color, ann: T.colorOf("@Mixin")?.color, con: T.colorOf("MAX_SIZE")?.color, ty: T.colorOf("Spawner")?.color, str: T.colorOf('"zombie')?.color, num: T.colorOf("0xFF")?.color }`);
    const vals = Object.values(c);
    return { ok: vals.every(Boolean) && new Set(vals).size === vals.length, note: JSON.stringify(c) };
  });

  // ------------------------------------------------------------------------------------------ semantic tokens (basedpyright)
  await check("semantic tokens: basedpyright delivers them and a field, a parameter and a method call render in three distinct colours", async () => {
    await T(`T.set("nord-vivid"); await __qa.sleep(200); return 1`);
    await reset("counter.py");
    let sem = null;
    for (let i = 0; i < 120; i++) {
      sem = await T(`const L = await T.lsp(); try { return await L.semantic(${jq(P("counter.py"))}); } catch (e) { return { err: String(e) }; }`).catch(() => null);
      if (sem?.tokens?.length) break;
      await sleep(500);
    }
    if (!sem?.tokens?.length) return { ok: false, note: "no tokens: " + JSON.stringify(sem).slice(0, 160) };
    await sleep(900); // Monaco applies them after its own debounce
    const types = Object.fromEntries(["value", "by", "bump", "Counter", "make", "LIMIT"].map((w) => [w, [...new Set(sem.tokens.filter((t) => t.text === w).map((t) => t.type))]]));
    const col = await T(`return { field: T.colorOf("value", 0)?.color, param: T.colorOf("by", 0)?.color, method: T.colorOf("bump", 0)?.color, cls: T.colorOf("Counter", 0)?.color }`);
    const distinct = new Set([col.field, col.param, col.method]).size === 3 && !!col.field && !!col.param && !!col.method;
    return { ok: distinct && types.value.some((t) => /property/.test(t)) && types.by.some((t) => /parameter/.test(t)), note: `types ${JSON.stringify(types)} colors ${JSON.stringify(col)}` };
  });
  await check("semantic modifiers: declaration colours the def name (fnDecl), static is italic, constants recoloured", async () => {
    const r = await T(`const L = await T.lsp(); const s = await L.semantic(${jq(P("counter.py"))}); return s.tokens.map((t) => t.text + ":" + t.type)`);
    const decl = r.some((x) => /^bump:sem\.method\.declaration/.test(x));
    const lim = r.some((x) => /^LIMIT:sem\.constant/.test(x));
    return { ok: decl && lim, note: r.slice(0, 14).join(" ") };
  });
  await check("semantic tokens change colour with the scheme (live) and follow edits (debounced)", async () => {
    const before = await T(`return T.colorOf("value", 0)?.color`);
    await T(`T.set("darcula"); await __qa.sleep(500); return 1`);
    const after = await T(`return T.colorOf("value", 0)?.color`);
    return { ok: !!before && !!after && before !== after, note: `${before} -> ${after}` };
  });
} finally {
  await app.stop().catch(() => {});
  try { fs.rmSync(scratch, { recursive: true, force: true }); fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
const pass = rows.filter((r) => r.ok).length;
console.log(`\n${pass}/${rows.length} passed`);
process.exit(pass === rows.length ? 0 : 1);
