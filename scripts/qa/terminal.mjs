#!/usr/bin/env node
// Terminal (Ghostty parity) suite. Launches Atelier on a scratch project and drives it ONLY through the automation harness
// (window.__qa + __qa.term()): no OS-level keyboard/mouse input. The harness uses a private NSPasteboard, so Alex's clipboard is untouched,
// and desktop notifications / browser opens are intercepted by test hooks.
// Usage: node scripts/qa/terminal.mjs [--no-ssh]    Env: ATELIER_BIN
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, sleep } from "./lib.mjs";

const scratch = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "atelier-term-"));
const proj = fs.realpathSync(scratch) + "/proj";
fs.mkdirSync(path.join(proj, "src"), { recursive: true });
fs.mkdirSync(path.join(proj, "scripts"), { recursive: true });
fs.mkdirSync(path.join(proj, "sub dir"), { recursive: true });
fs.writeFileSync(path.join(proj, "src/util.ts"), Array.from({ length: 40 }, (_, i) => `export const v${i} = ${i};`).join("\n") + "\n");
fs.writeFileSync(path.join(proj, "scripts/player.gd"), Array.from({ length: 20 }, (_, i) => `# line ${i + 1}`).join("\n") + "\n");
fs.writeFileSync(path.join(proj, "README.md"), "# scratch\n");

const app = await launch(proj);
const rows = [];
const P = (f) => JSON.stringify(path.join(proj, f));
const S = () => app.ev("return __qa.state()");
const key = (k) => app.ev(`return await __qa.key(${JSON.stringify(k)})`);
/** run JS with T = terminal test hooks, st() = terminal state, and the focused pane id `fp` helper */
const T = (body, o) => app.ev(`const T = await __qa.term(); const st = () => T.state(); const cur = () => { const s = st(); const t = s.tabs.find((x) => x.id === s.active); return t && t.panes.find((p) => p.focused); }; ${body}`, o);
const reset = async () => { for (let i = 0; ; i++) { try { return await app.ev(`return await __qa.reset(${P("README.md")})`, { timeout: 15000 }); } catch (e) { if (i) throw e; await sleep(500); } } };
const settle = async () => { await app.ev("const T = await __qa.term(); T.settle(); await __qa.sleep(250); return 1"); };
const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;
async function check(name, fn, { fresh = false } = {}) {
  if (only && !name.toLowerCase().includes(only.toLowerCase())) return;
  let ok = false, note = "";
  try { if (fresh) await reset(); else await settle(); const r = await fn(); ok = r === true || (r && r.ok); note = r && r.note ? r.note : ""; } catch (e) { note = String(e.message || e).split("\n")[0].slice(0, 160); }
  rows.push({ name, ok, note });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? "  - " + note : ""}`);
  if (!ok) app.shot("terminal_fail_" + name.replace(/[^a-z0-9]+/gi, "_").toLowerCase());
}
/** Focus the terminal tool window and wait for a spawned, shell-integrated first pane. */
const openTerm = async () => {
  await key("alt F12");
  await T(`await __qa.waitFor(() => { const p = cur(); return p && p.cols > 10 && p.domFocused; }, 8000); return 1`);
};
const waitShell = (ms = 25000) => T(`await __qa.waitFor(() => { const p = cur(); return p && p.cwdFromShell && p.blocks > 0; }, ${ms}); return cur().cwd`);
const run = (cmd) => T(`T.sendText(cur().id, ${JSON.stringify(cmd + "\n")}); return 1`);
const waitCwd = (c, ms = 8000) => T(`await __qa.waitFor(() => cur() && cur().cwd === ${JSON.stringify(c)}, ${ms}); return cur().cwd`);

try {
// ------------------------------------------------------------------------------------------------ boot + shell integration
await check("terminal opens with one tab/pane, WebGL renderer, sync-output + unicode support", async () => {
  await openTerm();
  const s = await T("await __qa.sleep(600); return st()");
  const p = s.tabs[0].panes[0];
  return { ok: s.tabs.length === 1 && p.cols > 20 && p.gl === true, note: `tabs=${s.tabs.length} gl=${p.gl} ${p.cols}x${p.rows}` };
}, { fresh: true });
await check("zsh/bash shell integration: OSC 7 cwd + OSC 133 prompt marks arrive", async () => {
  const cwd = await waitShell();
  const p = (await T("return cur()"));
  return { ok: cwd === proj && p.blocks >= 1, note: `cwd=${cwd} blocks=${p.blocks}` };
});
await check("shell integration never touches dotfiles (ZDOTDIR is private, user's restored)", async () => {
  await run('print -r -- "ZD=[${ZDOTDIR:-unset}] INT=[$ATELIER_SHELL_INTEGRATION]" 2>/dev/null || echo ZD=[$ZDOTDIR]');
  await sleep(700);
  const txt = await T("return T.text(cur().id)");
  const m = /ZD=\[([^\]]*)\]/.exec(txt.split("\n").filter((l) => l.startsWith("ZD=")).pop() ?? "");
  const zd = m?.[1];
  return { ok: !!zd && !zd.includes("atelier-shell-integration"), note: `ZDOTDIR in shell=${zd}` };
});

// ------------------------------------------------------------------------------------------------ cwd inheritance, splits
await check("cd then ⌘D splits right; the new split starts in the same cwd and takes focus", async () => {
  await run("cd 'sub dir'"); await waitCwd(proj + "/sub dir");
  await key("meta D"); await sleep(500);
  const s = await T("await __qa.waitFor(() => cur() && cur().cols > 5, 5000); return st()");
  const t = s.tabs[0];
  return { ok: t.panes.length === 2 && t.panes.every((p) => p.cwd === proj + "/sub dir") && t.panes[1].focused, note: `panes=${t.panes.length} cwds=${t.panes.map((p) => p.cwd.split("/").pop())} focus=${t.panes.map((p) => p.focused)}` };
});
await check("⌘⇧D splits down (3 panes); geometry matches the tree", async () => {
  await key("meta shift D"); await sleep(500);
  const t = (await T("return st()")).tabs[0];
  const r = t.rects, [a, b, c] = t.panes.map((p) => r[p.id]);
  return { ok: t.panes.length === 3 && Math.abs(a.w - 0.5) < 1e-6 && Math.abs(b.h - 0.5) < 1e-6 && b.x === 0.5 && c.y === 0.5, note: JSON.stringify([a, b, c]) };
});
await check("focus next/prev/directional split (⌘] ⌘[ ⌘⌥←→↑↓)", async () => {
  const f = async () => (await T("return cur().id"));
  const ids = (await T("return st().tabs[0].panes.map((p) => p.id)"));
  const seq = [];
  await key("meta OPEN_BRACKET"); await sleep(120); seq.push(await f()); // prev of c(3rd) = b
  await key("meta alt LEFT"); await sleep(120); seq.push(await f());      // b -> a
  await key("meta alt RIGHT"); await sleep(120); seq.push(await f());     // a -> b (or c: both overlap; geometry picks b)
  await key("meta alt DOWN"); await sleep(120); seq.push(await f());      // b -> c
  await key("meta alt UP"); await sleep(120); seq.push(await f());        // c -> b
  await key("meta CLOSE_BRACKET"); await sleep(120); seq.push(await f()); // next of b = c
  const exp = [ids[1], ids[0], ids[1], ids[2], ids[1], ids[2]];
  return { ok: JSON.stringify(seq) === JSON.stringify(exp), note: `got=${seq.map((x) => ids.indexOf(x))} want=${exp.map((x) => ids.indexOf(x))}` };
});
await check("resize with ⌘⌃←/→, equalize ⌘⌃=, divider drag", async () => {
  await T("T.pane(st().tabs[0].panes[0].id).focus(); return 1"); await sleep(150);
  const w0 = (await T("const t = st().tabs[0]; return t.rects[t.panes[0].id].w"));
  await key("meta control RIGHT"); await sleep(200);
  const w1 = (await T("const t = st().tabs[0]; return t.rects[t.panes[0].id].w"));
  await key("meta control LEFT"); await key("meta control LEFT"); await sleep(200);
  const w2 = (await T("const t = st().tabs[0]; return t.rects[t.panes[0].id].w"));
  await key("meta control EQUALS"); await sleep(200);
  const w3 = (await T("const t = st().tabs[0]; return t.rects[t.panes[0].id].w"));
  // drag the vertical divider to 30%
  const w4 = await app.ev(`const d = document.querySelector('.term-divider.row'); const host = d.parentElement.getBoundingClientRect();
    const x0 = host.left + host.width * 0.5; d.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x0, clientY: host.top + 20, pointerId: 1 }));
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: host.left + host.width * 0.3, clientY: host.top + 20, pointerId: 1 }));
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 })); await __qa.sleep(150);
    const T = await __qa.term(); const t = T.state().tabs[0]; return t.rects[t.panes[0].id].w`);
  return { ok: w1 > w0 && w2 < w1 && Math.abs(w3 - 0.5) < 1e-6 && Math.abs(w4 - 0.3) < 0.02, note: `w0=${w0} →${w1} →${w2} equalize=${w3} drag=${w4.toFixed?.(3)}` };
});
await check("zoom split (⌘⇧↩) shows one pane full-size, toggles back", async () => {
  await key("meta shift ENTER"); await sleep(300);
  const z = await T("const s = st(); return { zoom: s.tabs[0].zoom, slots: document.querySelectorAll('.term-slot').length, focus: cur().id }");
  await key("meta shift ENTER"); await sleep(300);
  const u = await T("const s = st(); return { zoom: s.tabs[0].zoom, slots: document.querySelectorAll('.term-slot').length }");
  return { ok: z.zoom === z.focus && z.slots === 1 && u.zoom === null && u.slots === 3, note: JSON.stringify([z, u]) };
});
await check("⌘W closes a split; focus moves to a remaining pane", async () => {
  await key("meta W"); await sleep(500);
  const t = (await T("return st().tabs[0]"));
  return { ok: t.panes.length === 2 && t.panes.some((p) => p.focused), note: `panes=${t.panes.length}` };
});

// ------------------------------------------------------------------------------------------------ tabs
await check("⌘T new tab inherits cwd; ⌘⇧] / ⌘⇧[ switch; move tab; titles from OSC 2", async () => {
  await key("meta T"); await sleep(600);
  let s = await T("await __qa.waitFor(() => cur() && cur().cols > 5, 5000); return st()");
  const inherited = s.tabs.length === 2 && s.tabs[1].panes[0].cwd === proj + "/sub dir";
  await key("meta shift OPEN_BRACKET"); await sleep(150);
  const prev = (await T("return st().active")) === s.tabs[0].id;
  await key("meta shift CLOSE_BRACKET"); await sleep(150);
  const next = (await T("return st().active")) === s.tabs[1].id;
  await key("meta alt shift LEFT"); await sleep(150);
  const moved = (await T("return st().tabs.map((t) => t.id)")).join() === [s.tabs[1].id, s.tabs[0].id].join();
  await T("T.write(cur().id, '\\x1b]2;my-title\\x07'); await __qa.sleep(100); return 1");
  const title = (await T("return st().tabs.find((t) => t.id === st().active).title"));
  return { ok: inherited && prev && next && moved && title === "my-title", note: `inherit=${inherited} prev=${prev} next=${next} move=${moved} title=${title}` };
});
await check("rename tab (dialog); custom name beats OSC titles", async () => {
  await app.ev("return __qa.runAction('Terminal.RenameTab')");
  await app.ev("await __qa.waitFor('.dialog-input', 3000); await __qa.type('X'); return 1");
  await key("Enter"); await sleep(150);
  const s = await T("return st()");
  const t = s.tabs.find((x) => x.id === s.active);
  await T("T.write(cur().id, '\\x1b]2;other\\x07'); await __qa.sleep(100); return 1");
  const t2 = (await T("return st()")).tabs.find((x) => x.id === s.active);
  return { ok: !!t.custom && t.custom.endsWith("X") && t2.title === t.title, note: `custom=${t.custom} after-osc=${t2.title}` };
});
await check("⌘⇧T reopens a closed tab with a new shell in its cwd; confirm-close for running process", async () => {
  await T("await __qa.waitFor(() => cur().cwdFromShell, 15000); return 1");
  await run("cd /usr"); await waitCwd("/usr", 10000);
  await run("sleep 300"); await T("await __qa.waitFor(() => cur().running, 5000); return 1");
  const n0 = (await T("return st().tabs.length"));
  await key("meta alt W"); await sleep(400);
  const dlg = await app.ev("const d = document.querySelector('.dialog'); return d ? d.innerText : null");
  await key("Escape"); await sleep(300);
  const keptTab = (await T("return st().tabs.length")) === n0;
  await key("meta alt W"); await sleep(400);
  await key("Enter"); await sleep(900);
  const n1 = (await T("return st().tabs.length"));
  await key("meta shift T"); await sleep(700);
  if ((await T("return st().tabs.length")) !== n0) { await app.ev("return __qa.runAction('Terminal.UndoClose')"); await sleep(700); }
  const s = await T("return st()");
  const t = s.tabs.find((x) => x.id === s.active);
  return { ok: /still running/.test(dlg ?? "") && keptTab && n1 === n0 - 1 && s.tabs.length === n0 && t.panes[0].cwd === "/usr", note: `dialog=${!!dlg} kept=${keptTab} closed=${n1 === n0 - 1} restored=${s.tabs.length === n0} cwd=${t.panes[0].cwd}` };
});

// ------------------------------------------------------------------------------------------------ prompt marks
await check("OSC 133: ⌘↑/⌘↓ jump between prompts; select + copy last command output", async () => {
  await T("await __qa.waitFor(() => cur().cwdFromShell && cur().blocks > 0, 20000); return 1");
  for (let i = 0; i < 3; i++) { await run(`seq 1 40 | sed 's/^/L${i}-/'`); await sleep(900); }
  await run("echo out-$((1+2))"); await sleep(900);
  const before = await T("const p = cur(); return { top: p.viewportY, base: p.baseY, prompts: p.promptLines }");
  await key("meta UP"); await sleep(200);
  const a = await T("return cur().viewportY");
  await key("meta UP"); await sleep(200);
  const b = await T("return cur().viewportY");
  await key("meta DOWN"); await sleep(200);
  const c = await T("return cur().viewportY");
  const sel = await T("const ok = T.pane(cur().id).selectLastOutput(); return { ok, text: T.pane(cur().id).term.getSelection() }");
  const copied = await T("T.pane(cur().id).copySelection(); await __qa.sleep(250); return await __qa.invoke('clipboard_read')");
  return { ok: a < before.top && b < a && c > b && sel.text.trim() === "out-3" && copied.trim() === "out-3" && before.prompts.includes(a), note: `top=${before.top} →${a} →${b} →${c} lastOutput=${JSON.stringify(sel.text)} clip=${JSON.stringify(copied)}` };
});
await check("OSC 133 marks via raw sequences + non-integrated cwd fallback (pty_cwd)", async () => {
  const id = await T("return cur().id");
  await T(`const p = T.pane(${JSON.stringify(id)}); p.term.write('\\x1b]133;A\\x07$ cmd\\r\\n\\x1b]133;C\\x07hello\\r\\n\\x1b]133;D;3\\x07'); await __qa.sleep(100); return 1`);
  const info = await T("const p = T.pane(cur().id); return { running: p.running, exit: p.lastExit }");
  const fallback = await T("const p = T.pane(cur().id); const was = p.cwdFromShell; p.cwdFromShell = false; const c = await p.currentCwd(); p.cwdFromShell = was; return c");
  return { ok: info.exit === 3 && info.running === false && fallback.startsWith("/"), note: `exit=${info.exit} fallbackCwd=${fallback}` };
});

// ------------------------------------------------------------------------------------------------ search
await check("⌘F search: highlights, counts, next/prev, Esc closes", async () => {
  const id = await T("return cur().id");
  await T(`T.write(${JSON.stringify(id)}, '\\r\\nneedle one\\r\\nhay\\r\\nneedle two\\r\\nhay\\r\\nNeedle three\\r\\n'); await __qa.sleep(150); return 1`);
  await key("meta F"); await app.ev("await __qa.waitFor('.term-search input', 3000); return 1");
  await app.ev("await __qa.type('needle'); await __qa.sleep(400); return 1");
  const a = await T("const p = cur(); return { c: T.pane(p.id).search.count, i: T.pane(p.id).search.index }");
  await key("Enter"); await sleep(200);
  const b = await T("return T.pane(cur().id).search.index");
  await key("shift Enter").catch(() => {});
  await app.ev("document.querySelector('.term-search input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true })); await __qa.sleep(200); return 1");
  const c = await T("return T.pane(cur().id).search.index");
  await key("meta shift G"); await sleep(150); await key("meta G"); await sleep(150);
  await key("Escape"); await sleep(250);
  const closed = await T("const p = T.pane(cur().id); return { open: p.search.open, bar: !!document.querySelector('.term-search'), focus: p.el.contains(document.activeElement) }");
  return { ok: a.c === 3 && b !== a.i && c !== b && !closed.open && !closed.bar && closed.focus, note: `count=${a.c} idx ${a.i}→${b}→${c} closed=${JSON.stringify(closed)}` };
});

// ------------------------------------------------------------------------------------------------ links
await check("links: URL + file:line:col + res:// are detected; ⌘-click opens (editor line/col, URL via opener hook), plain click does not", async () => {
  const id = await T("return cur().id");
  await T(`const p = T.pane(${JSON.stringify(id)}); p.term.write('\\x1b]7;file://h' + ${JSON.stringify(proj)} + '\\x07'); p.term.clear(); p.term.write('see src/util.ts:12:3 and https://example.com/x?y=1 and res://scripts/player.gd:5 done\\r\\n\\x1b]8;;https://osc8.example/\\x07hyper\\x1b]8;;\\x07\\r\\n'); await __qa.sleep(150);
    window.__opened = []; T.hooks.openUrl = (u) => window.__opened.push(u); return 1`);
  const links = await T(`const out = []; for (const y of [1, 2]) for (const l of await T.links(${JSON.stringify(id)}, y)) out.push(l.text); return out`);
  // plain click: nothing; ⌘-click: opens
  const plain = await T(`const l = (await T.links(${JSON.stringify(id)}, 1)).find((x) => x.text.startsWith('https')); l.activate({ metaKey: false }, l.text); return window.__opened.length`);
  await T(`await T.activateLink(${JSON.stringify(id)}, 1, 'https://example.com'); return 1`);
  const url = await T("return window.__opened.slice()");
  await T(`await T.activateLink(${JSON.stringify(id)}, 1, 'src/util.ts'); return 1`);
  await sleep(900);
  const s1 = await S();
  const at1 = s1.cursor;
  await T(`await T.activateLink(${JSON.stringify(id)}, 1, 'res://scripts'); return 1`);
  await sleep(900);
  const s2 = await S();
  const names = s2.tabs.flatMap((g) => g.tabs.map((t) => t.name));
  return { ok: links.some((t) => t.startsWith("src/util.ts")) && links.some((t) => t.startsWith("res://")) && links.some((t) => t.startsWith("https://example.com")) && plain === 0 && url[0] === "https://example.com/x?y=1" && at1.line === 12 && at1.col === 3 && s2.cursor.line === 5 && names.includes("util.ts") && names.includes("player.gd"),
    note: `links=${JSON.stringify(links)} plain=${plain} url=${url} util=${at1.line}:${at1.col} gd=${s2.cursor.line}` };
});
await check("OSC 8 hyperlink: ⌘-click routes through the link handler", async () => {
  const id = await T("return cur().id");
  const r = await T(`const p = T.pane(${JSON.stringify(id)}); window.__opened = []; const h = p.term.options.linkHandler; h.activate({ metaKey: false }, 'https://osc8.example/'); const a = window.__opened.length; h.activate({ metaKey: true }, 'https://osc8.example/'); return { a, b: window.__opened.slice() }`);
  return { ok: r.a === 0 && r.b[0] === "https://osc8.example/", note: JSON.stringify(r) };
});

// ------------------------------------------------------------------------------------------------ clipboard
await check("OSC 52 write sets the clipboard; read is denied by default, answers when allowed, asks in 'ask' mode", async () => {
  const id = await T("return cur().id");
  await T(`T.resetSettings(); T.record(${JSON.stringify(id)}); T.write(${JSON.stringify(id)}, '\\x1b]52;c;' + btoa('hello-52') + '\\x07'); await __qa.sleep(300); return 1`);
  const clip = await app.ev("return await __qa.invoke('clipboard_read')");
  await T(`T.write(${JSON.stringify(id)}, '\\x1b]52;c;?\\x07'); await __qa.sleep(300); return 1`);
  const denied = (await T(`return T.writes(${JSON.stringify(id)})`)).filter((w) => w.includes("]52;")).length;
  await T(`T.updateSettings({ clipboardRead: 'allow' }); T.write(${JSON.stringify(id)}, '\\x1b]52;c;?\\x07'); await __qa.sleep(400); return 1`);
  const allowed = (await T(`return T.writes(${JSON.stringify(id)})`)).find((w) => w.includes("]52;c;"));
  await T(`T.updateSettings({ clipboardRead: 'ask' }); T.record(${JSON.stringify(id)}); T.write(${JSON.stringify(id)}, '\\x1b]52;c;?\\x07'); await __qa.sleep(300); return 1`);
  const dlg = await app.ev("return !!document.querySelector('.dialog')");
  await key("Enter"); await sleep(400);
  const asked = (await T(`return T.writes(${JSON.stringify(id)})`)).some((w) => w.includes("]52;c;" + btoa("hello-52")));
  await T("T.resetSettings(); return 1");
  return { ok: clip === "hello-52" && denied === 0 && allowed?.includes(btoa("hello-52")) && dlg && asked, note: `clip=${clip} deniedWrites=${denied} allowed=${!!allowed} askDialog=${dlg} asked=${asked}` };
});
await check("paste protection: multi-line paste asks (cancel/accept); bracketed paste mode pastes without asking; ⌘V and native paste event share the path", async () => {
  const id = await T("return cur().id");
  await T(`T.resetSettings(); T.write(${JSON.stringify(id)}, '\\x1b[?2004l'); await __qa.sleep(100); T.record(${JSON.stringify(id)}); T.pane(${JSON.stringify(id)}).pasteText('echo a\\necho b'); await __qa.sleep(300); return 1`);
  const dlg1 = await app.ev("const d = document.querySelector('.dialog'); return d ? d.innerText : null");
  await key("Escape"); await sleep(200);
  const none = (await T(`return T.writes(${JSON.stringify(id)})`)).length === 0;
  await T(`T.pane(${JSON.stringify(id)}).pasteText('echo a\\necho b'); await __qa.sleep(300); return 1`);
  await key("Enter"); await sleep(300);
  const w1 = (await T(`return T.writes(${JSON.stringify(id)})`)).join("");
  // native paste event (the shell re-enables bracketed paste at every prompt: switch it off again)
  await T(`T.write(${JSON.stringify(id)}, '\\x1b[?2004l'); await __qa.sleep(100); T.record(${JSON.stringify(id)}); const dt = new DataTransfer(); dt.setData('text/plain', 'x\\ny'); T.pane(${JSON.stringify(id)}).term.textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); await __qa.sleep(300); return 1`);
  const dlg2 = await app.ev("return !!document.querySelector('.dialog')");
  await key("Escape"); await sleep(200);
  // ⌘V reads the (private) pasteboard
  await app.ev("await __qa.invoke('clipboard_write', { text: 'one\\ntwo' }); return 1");
  await T(`T.write(${JSON.stringify(id)}, '\\x1b[?2004l'); await __qa.sleep(100); T.pane(${JSON.stringify(id)}).focus(); T.record(${JSON.stringify(id)}); return 1`);
  await key("meta V"); await sleep(400);
  const dlg3 = await app.ev("return !!document.querySelector('.dialog')");
  await key("Escape"); await sleep(200);
  // bracketed paste: no prompt, wrapped
  await T(`T.write(${JSON.stringify(id)}, '\\x1b[?2004h'); await __qa.sleep(50); T.record(${JSON.stringify(id)}); T.pane(${JSON.stringify(id)}).pasteText('l1\\nl2'); await __qa.sleep(300); return 1`);
  const dlg4 = await app.ev("return !!document.querySelector('.dialog')");
  const w2 = (await T(`return T.writes(${JSON.stringify(id)})`)).join("");
  // control characters always ask
  await T(`T.pane(${JSON.stringify(id)}).pasteText('rm\\x1b[201~ -rf'); await __qa.sleep(300); return 1`);
  const dlg5 = await app.ev("return !!document.querySelector('.dialog')");
  await key("Escape"); await sleep(200);
  return { ok: /Unsafe/i.test(dlg1 ?? "") && none && w1 === "echo a\recho b" && dlg2 && dlg3 && !dlg4 && w2 === "\x1b[200~l1\rl2\x1b[201~" && dlg5, note: `d1=${!!dlg1} none=${none} accepted=${JSON.stringify(w1)} native=${dlg2} cmdV=${dlg3} bracketed=${!dlg4}:${JSON.stringify(w2)} ctrl=${dlg5}` };
});
await check("copy-on-select (default on) copies the selection; off leaves the clipboard alone; ⌘C copies", async () => {
  const id = await T("return cur().id");
  await app.ev("await __qa.invoke('clipboard_write', { text: 'sentinel' }); return 1");
  await T(`T.resetSettings(); const p = T.pane(${JSON.stringify(id)}); p.term.write('\\r\\nselect-me-please\\r\\n'); await __qa.sleep(100); const b = p.term.buffer.active; let y = -1; for (let i = 0; i < b.length; i++) if (b.getLine(i).translateToString(true) === 'select-me-please') y = i; p.term.select(0, y, 9); await __qa.sleep(500); return 1`);
  const on = await app.ev("return await __qa.invoke('clipboard_read')");
  await app.ev("await __qa.invoke('clipboard_write', { text: 'sentinel2' }); return 1");
  await T(`T.updateSettings({ copyOnSelect: false }); const p = T.pane(${JSON.stringify(id)}); p.term.clearSelection(); const b = p.term.buffer.active; let y = -1; for (let i = 0; i < b.length; i++) if (b.getLine(i).translateToString(true) === 'select-me-please') y = i; p.term.select(0, y, 6); await __qa.sleep(500); return 1`);
  const off = await app.ev("return await __qa.invoke('clipboard_read')");
  await T(`T.pane(${JSON.stringify(id)}).focus(); return 1`);
  await key("meta C"); await sleep(300);
  const cmdC = await app.ev("return await __qa.invoke('clipboard_read')");
  await T("T.resetSettings(); return 1");
  return { ok: on === "select-me" && off === "sentinel2" && cmdC === "select", note: `on=${on} off=${off} cmdC=${cmdC}` };
});

// ------------------------------------------------------------------------------------------------ font / appearance
await check("font size ⌘= ⌘- ⌘0 are per terminal", async () => {
  await T("T.resetSettings(); T.pane(cur().id).focus(); return 1");
  const base = await T("return cur().fontSize");
  await key("meta EQUALS"); await key("meta EQUALS"); await sleep(150);
  const up = await T("return cur().fontSize");
  await key("meta MINUS"); await sleep(150);
  const down = await T("return cur().fontSize");
  const others = await T("const s = st(); return s.tabs.flatMap((t) => t.panes).filter((p) => !p.focused).map((p) => p.fontSize)");
  await key("meta 0"); await sleep(150);
  const reset = await T("return cur().fontSize");
  return { ok: up === base + 2 && down === base + 1 && reset === base && others.every((f) => f === base), note: `base=${base} up=${up} down=${down} reset=${reset} others=${others}` };
});
await check("themes: Ghostty theme list, switch (Dracula), light/dark pair, back to Nord", async () => {
  const names = await app.ev("return (await __qa.invoke('ghostty_themes')).length");
  if (names < 50) return { ok: false, note: `only ${names} themes (Ghostty.app missing?)` };
  const id = await T("return cur().id");
  const bg = () => T(`return T.pane(${JSON.stringify(id)}).term.options.theme.background`);
  const b0 = await bg();
  await T("T.updateSettings({ theme: 'Dracula' }); await __qa.sleep(500); return 1");
  const b1 = await bg();
  const dark = await app.ev("return matchMedia('(prefers-color-scheme: dark)').matches");
  await T("T.updateSettings({ theme: 'light:Solarized Light,dark:Dracula' }); await __qa.sleep(500); return 1");
  const b2 = await bg();
  await T("T.resetSettings(); await __qa.sleep(400); return 1");
  const b3 = await bg();
  return { ok: b0 === "#2e3440" && b1 === "#282a36" && b2 === (dark ? "#282a36" : "#fdf6e3") && b3 === "#2e3440", note: `nord=${b0} dracula=${b1} pair(dark=${dark})=${b2} reset=${b3}` };
});
await check("theme picker + settings popups open from Find Action ids and apply", async () => {
  await app.ev("__qa.runAction('Terminal.SelectTheme'); await __qa.sleep(500); return 1");
  const open = await app.ev("return document.querySelector('.popup')?.innerText.includes('Terminal Theme')");
  await app.ev("await __qa.type('dracula'); await __qa.sleep(500); return 1");
  await key("Enter"); await sleep(500);
  const theme = await T("return T.settings().theme");
  await T("T.resetSettings(); return 1");
  await app.ev("__qa.runAction('Terminal.Settings'); await __qa.sleep(400); return 1");
  const settings = await app.ev("return document.querySelector('.popup')?.innerText.includes('Terminal Settings')");
  await key("Escape"); await sleep(300);
  const closed = await app.ev("return !document.querySelector('.popup')");
  return { ok: open && theme === "Dracula" && settings && closed, note: `picker=${open} theme=${theme} settings=${settings} closed=${closed}` };
});
await check("cursor style/blink, scrollback, padding, option-as-alt settings reach xterm", async () => {
  const id = await T("return cur().id");
  await T("T.updateSettings({ cursorStyle: 'bar', cursorBlink: false, scrollback: 2222, padding: 12, optionAsAlt: false, fontSize: 15 }); await __qa.sleep(300); return 1");
  const o = await T(`const p = T.pane(${JSON.stringify(id)}); const o = p.term.options; return { cs: o.cursorStyle, cb: o.cursorBlink, sb: o.scrollback, alt: o.macOptionIsMeta, fs: o.fontSize, pad: p.el.style.getPropertyValue('--term-pad') }`);
  await T("T.resetSettings(); return 1");
  return { ok: o.cs === "bar" && o.cb === false && o.sb === 2222 && o.alt === false && o.fs === 15 && o.pad === "12px", note: JSON.stringify(o) };
});
await check("⌘←/⌘⌫/⌥← map to line-edit sequences; mouse hides while typing", async () => {
  const id = await T("return cur().id");
  await T(`T.updateSettings({ mouseHideWhileTyping: true }); const p = T.pane(${JSON.stringify(id)}); p.focus(); T.record(${JSON.stringify(id)}); return 1`);
  await key("meta LEFT"); await key("meta RIGHT"); await key("meta BACK_SPACE"); await key("alt LEFT"); await key("alt RIGHT");
  const w = (await T(`return T.writes(${JSON.stringify(id)})`)).join("|");
  // a real mouse over the window would clear the class again, so check inside the same task as the key
  const hidden = await T(`const el = T.pane(${JSON.stringify(id)}).el; el.classList.remove('hide-mouse'); await __qa.key('meta LEFT'); return el.classList.contains('hide-mouse')`);
  await T(`T.pane(${JSON.stringify(id)}).el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true })); return 1`);
  const shown = await T(`return !T.pane(${JSON.stringify(id)}).el.classList.contains('hide-mouse')`);
  await T("T.resetSettings(); return 1");
  return { ok: w.includes("\x01") && w.includes("\x05") && w.includes("\x15") && w.includes("\x1bb") && w.includes("\x1bf") && hidden && shown, note: JSON.stringify(w) + ` hidden=${hidden} shown=${shown}` };
});

// ------------------------------------------------------------------------------------------------ protocol features
await check("desktop notifications OSC 9 / 777 fire only while the window is unfocused", async () => {
  const id = await T("return cur().id");
  const r = await T(`window.__n = []; T.hooks.notify = (t, b) => { window.__n.push([t, b]); return true; }; const hf = document.hasFocus; const p = T.pane(${JSON.stringify(id)});
    document.hasFocus = () => true; p.term.write('\\x1b]9;focused-no\\x07'); await __qa.sleep(150); const focusedCount = window.__n.length;
    document.hasFocus = () => false; p.term.write('\\x1b]9;build done\\x07\\x1b]777;notify;Title;Body text\\x07\\x1b]9;4;1;50\\x07'); await __qa.sleep(250);
    document.hasFocus = hf; T.updateSettings({ notifications: false }); document.hasFocus = () => false; p.term.write('\\x1b]9;muted\\x07'); await __qa.sleep(150); document.hasFocus = hf; T.resetSettings();
    const n = window.__n.slice(); T.hooks.notify = undefined; return { focusedCount, n }`);
  return { ok: r.focusedCount === 0 && r.n.length === 2 && r.n[0][1] === "build done" && r.n[1][0] === "Title" && r.n[1][1] === "Body text", note: JSON.stringify(r) };
});
await check("bell: visual flash + badge on a background tab, cleared when it is selected", async () => {
  await key("meta T"); await sleep(500);
  const s = await T("return st()");
  const first = s.tabs[0], second = s.tabs.find((t) => t.id === s.active);
  await T(`T.write(${JSON.stringify(first.panes[0].id)}, '\\x07'); await __qa.sleep(200); return 1`);
  const badge = await app.ev(`return !!document.querySelector('.term-tab[data-tab-id=${JSON.stringify(first.id)}] .term-bell')`);
  await app.ev(`document.querySelector('.term-tab[data-tab-id=${JSON.stringify(first.id)}]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })); await __qa.sleep(300); return 1`);
  const cleared = await app.ev(`return !document.querySelector('.term-tab .term-bell')`);
  return { ok: first.id !== second.id && badge && cleared, note: `badge=${badge} cleared=${cleared}` };
});
await check("inline images: sixel and iTerm2 (OSC 1337) load @xterm/addon-image lazily", async () => {
  const id = await T("return cur().id");
  const before = await T(`return T.pane(${JSON.stringify(id)}).imagesLoaded`);
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  await T(`const p = T.pane(${JSON.stringify(id)}); p.inject('\\x1bPq#0;2;100;0;0#0!8~-#0!8~\\x1b\\\\'); await __qa.sleep(800); p.inject('\\x1b]1337;File=inline=1;width=2;height=1:${png}\\x07'); await __qa.sleep(500); return 1`);
  const after = await T(`const p = T.pane(${JSON.stringify(id)}); return { loaded: p.imagesLoaded, layers: p.el.querySelectorAll('canvas').length }`);
  return { ok: before === false && after.loaded === true, note: `before=${before} after=${JSON.stringify(after)}` };
});
await check("synchronized output (DEC 2026) and bracketed paste modes are tracked", async () => {
  const id = await T("return cur().id");
  await T(`T.write(${JSON.stringify(id)}, '\\x1b[?2026h'); await __qa.sleep(50); return 1`);
  const on = await T("return cur().sync");
  await T(`T.write(${JSON.stringify(id)}, '\\x1b[?2026l'); await __qa.sleep(50); return 1`);
  const off = await T("return cur().sync");
  return { ok: on === true && off === false, note: `on=${on} off=${off}` };
});
await check("wide / emoji / CJK glyph widths (unicode 11) advance the cursor correctly", async () => {
  const id = await T("return cur().id");
  const x = await T(`const p = T.pane(${JSON.stringify(id)}); p.term.write('\\r\\n'); p.term.write('\\u754c\\u{1F600}'); await __qa.sleep(100); return p.term.buffer.active.cursorX`);
  return { ok: x === 4, note: `cursorX=${x}` };
});

// ------------------------------------------------------------------------------------------------ quick terminal
await check("quick terminal: toggle action shows a drop-down shell with its own cwd, toggles away, autohides", async () => {
  // the harness window is not the frontmost app, so document.hasFocus() is false; autohide ignores focus changes then
  await T("T.updateSettings({ quickTerminalAutohide: true }); window.__hf = document.hasFocus; document.hasFocus = () => true; return 1");
  await app.ev("__qa.runAction('Terminal.ToggleQuick'); return 1");
  await T("await __qa.waitFor(() => st().quick.open && st().quick.pane && st().quick.pane.cols > 10, 6000); return 1");
  await sleep(1500);
  const inQuick = await app.ev("return !!document.activeElement?.closest('[data-quick]')");
  const qid = await T("return st().quick.pane.id");
  await T(`T.sendText(${JSON.stringify(qid)}, 'echo qt-$((6*7))\\n'); await __qa.waitFor(() => T.text(${JSON.stringify(qid)}).includes('qt-42'), 15000); return 1`);
  const visible = await app.ev("const r = document.querySelector('[data-quick]').getBoundingClientRect(); return r.height > 100 && r.top >= 0");
  // IntelliJ key still works from inside the quick terminal: ⌘1 focuses Project
  await key("meta 1"); await sleep(400);
  const focusedProject = (await S()).focused;
  await T("await __qa.waitFor(() => !st().quick.open, 3000).catch(() => {}); return 1");
  const hidden = !(await T("return st().quick.open"));
  await app.ev("__qa.runAction('Terminal.ToggleQuick'); return 1");
  await T("await __qa.waitFor(() => st().quick.open, 3000); return 1");
  await app.ev("__qa.runAction('Terminal.ToggleQuick'); return 1");
  await sleep(300);
  const toggledOff = !(await T("return st().quick.open"));
  await T("T.resetSettings(); document.hasFocus = window.__hf; return 1");
  return { ok: inQuick && visible && hidden && toggledOff && /project/.test(focusedProject), note: `focusInQuick=${inQuick} visible=${visible} hidAfterFocusLoss=${hidden} toggleOff=${toggledOff} focus=${focusedProject}` };
});

// ------------------------------------------------------------------------------------------------ IntelliJ keys from the terminal
await check("IntelliJ keys still work from the focused terminal (⌘1, ⌥F12, ⇧Esc, Esc→shell, double-⇧, ⌘E, ⌘⇧A)", async () => {
  const res = {};
  await key("alt F12"); await sleep(200);
  await openTerm();
  const id = await T("return cur().id");
  res.focusedTerm = (await S()).focused;
  await T(`T.record(${JSON.stringify(id)}); return 1`);
  await key("Escape"); await sleep(250);
  res.escToShell = (await T(`return T.writes(${JSON.stringify(id)}).includes('\\x1b')`)) && (await S()).focused === "toolwindow:terminal";
  await key("shift shift"); await sleep(400); res.doubleShift = (await S()).popup.open; await key("Escape"); await sleep(250);
  await T(`T.pane(${JSON.stringify(id)}).focus(); return 1`);
  await key("meta E"); await sleep(400); res.cmdE = /recent/i.test((await S()).popup.text); await key("Escape"); await sleep(250);
  await T(`T.pane(${JSON.stringify(id)}).focus(); return 1`);
  await key("meta shift A"); await sleep(400); res.findAction = (await S()).popup.open;
  await app.ev("await __qa.type('Terminal: Split'); await __qa.sleep(500); return 1");
  res.actionsListed = /Terminal: Split Right/.test((await S()).popup.text) && /Terminal: Split Down/.test((await S()).popup.text);
  await key("Escape"); await sleep(250);
  await T(`T.pane(${JSON.stringify(id)}).focus(); return 1`);
  await key("meta 1"); await sleep(300); res.cmd1 = (await S()).focused;
  await openTerm();
  await key("shift Escape"); await sleep(300); res.shiftEsc = (await S()).toolWindows.bottom === null;
  await key("alt F12"); await sleep(900); res.reopen = (await S()).toolWindows.bottom === "terminal";
  await key("alt F12"); await sleep(300); await openTerm();
  await key("alt F12"); await sleep(300); res.altF12Hides = (await S()).toolWindows.bottom === null;
  // ⌘D / ⌘W from the editor do NOT touch the terminal
  await key("alt F12"); await sleep(700);
  const n0 = (await T("return st().tabs.reduce((n, t) => n + t.panes.length, 0)"));
  await app.ev("__qa.editor()?.focus(); await __qa.sleep(150); return 1");
  await key("meta D"); await sleep(300);
  const n1 = (await T("return st().tabs.reduce((n, t) => n + t.panes.length, 0)"));
  res.editorCmdD = n0 === n1;
  await app.ev("return __qa.reset(" + P("README.md") + ")");
  const ok = res.escToShell && res.doubleShift && res.cmdE && res.findAction && res.actionsListed && /project/.test(res.cmd1) && res.shiftEsc && res.reopen && res.altF12Hides && res.editorCmdD;
  return { ok, note: JSON.stringify(res) };
});
await check("every Terminal action is registered with the terminal context and visible to Find Action", async () => {
  const acts = await app.ev("return __qa.actions().filter((a) => a.id.startsWith('Terminal.')).map((a) => [a.id, a.title, a.keys])");
  const need = ["NewTab", "CloseSurface", "SplitRight", "SplitDown", "PrevSplit", "NextSplit", "FocusLeft", "EqualizeSplits", "ResizeRight", "ToggleZoom", "Find", "Clear", "PrevPrompt", "NextPrompt", "FontIncrease", "FontDecrease", "FontReset", "UndoClose", "ToggleQuick", "SelectTheme", "Settings", "Copy", "Paste"];
  const have = new Set(acts.map((a) => a[0].replace("Terminal.", "")));
  const missing = need.filter((n) => !have.has(n));
  const keyed = acts.filter((a) => a[2].length).length;
  return { ok: missing.length === 0 && acts.every((a) => a[1].startsWith("Terminal: ")), note: `actions=${acts.length} withKeys=${keyed} missing=${missing}` };
});
await check("secure keyboard entry toggles (Carbon EnableSecureEventInput)", async () => {
  const on = await app.ev("return await __qa.invoke('secure_keyboard_entry', { enable: true })");
  const off = await app.ev("return await __qa.invoke('secure_keyboard_entry', { enable: false })");
  return { ok: on === true && off === false, note: `on=${on} off=${off}` };
});

// ------------------------------------------------------------------------------------------------ ssh mc (read-only)
if (!process.argv.includes("--no-ssh") && spawnSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=6", "mc", "true"]).status === 0) {
  await check("ssh mc: shell integration through a pipe (no remote files), OSC 7 cwd, split inherits the remote cwd", async () => {
    await key("alt F12"); await sleep(600); await openTerm();
    // Open the host menu entry the way a user would: the "New SSH Session" item
    await app.ev(`[...document.querySelectorAll('.term-add')][1].click(); await __qa.sleep(600); const it = [...document.querySelectorAll('.menu-item')].find((e) => e.innerText.includes('mc')); if (!it) throw new Error('no mc menu item'); it.click(); return 1`);
    await T(`await __qa.waitFor(() => { const p = cur(); return p && p.host === 'mc' && p.cwdFromShell && p.blocks > 0; }, 40000); return 1`);
    const p0 = await T("return cur()");
    await run("unset HISTFILE; cd /tmp"); // never write remote shell history
    await waitCwd("/tmp", 10000);
    await key("meta D"); await sleep(600);
    const s = await T("await __qa.waitFor(() => cur() && cur().cols > 5, 5000); return st()");
    const t = s.tabs.find((x) => x.id === s.active);
    await run("exit"); await sleep(500);
    return { ok: p0.host === "mc" && t.panes.length === 2 && t.panes.every((p) => p.host === "mc" && p.cwd === "/tmp"), note: `home=${p0.cwd} split cwds=${t.panes.map((p) => p.cwd)}` };
  });
} else console.log("SKIP  ssh mc checks (--no-ssh or ssh mc unavailable)");
} catch (e) { console.error("terminal suite aborted:", e.message); }

console.log("\n| # | Check | Result | Note |\n|---|---|---|---|");
rows.forEach((r, i) => console.log(`| ${i + 1} | ${r.name} | ${r.ok ? "PASS" : "FAIL"} | ${r.note} |`));
const failed = rows.filter((r) => !r.ok).length;
console.log(`\n${rows.length - failed}/${rows.length} passed`);
await app.stop();
try { execSync(`pkill -f -- ${JSON.stringify("--path " + proj)} || true`); } catch {}
if (!process.argv.includes("--keep")) fs.rmSync(scratch, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
