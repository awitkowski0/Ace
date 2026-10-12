#!/usr/bin/env node
// Speed search (IntelliJ-style type-to-find in trees) QA. Launches Ace on a scratch project and drives the Project tree
// ONLY through the automation harness (synthetic key events via __qa.key, no OS-level input). Screenshot: out/speedsearch.png
// Usage: ACE_BIN=src-tauri/target-qa/release/ace node scripts/qa/speedsearch.mjs
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, sleep } from "./lib.mjs";

const scratch = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "ace-ss-"));
const proj = path.join(scratch, "speedproj");
fs.mkdirSync(path.join(proj, "src"), { recursive: true });
for (const f of ["Main.kt", "MainView.kt", "README.md", "web_sling.animation.json", "WebSlingAnimation.java", "src/util.ts", "src/MainHelper.ts"]) fs.writeFileSync(path.join(proj, f), `// ${f}\n`);
execSync("git init -q . && git add -A && git -c user.email=q@q -c user.name=qa commit -qm init", { cwd: proj });

const app = await launch(proj);
const rows = [];
const key = (k) => app.ev(`return await __qa.key(${JSON.stringify(k)})`);
const type = async (s) => { for (const c of s) await key(c === c.toUpperCase() && c !== c.toLowerCase() ? `shift ${c}` : c); await sleep(40); };
// Tree facts: selected row's name, popup, highlighted fragments per row.
const snap = () => app.ev(`
  const q = document.querySelector('[data-testid="speed-search"]');
  const tree = document.querySelector('.tree[data-autofocus]');
  return {
    popup: q ? { query: q.dataset.query, nomatch: q.classList.contains('nomatch'), matches: +q.dataset.matches, text: q.textContent } : null,
    selected: [...document.querySelectorAll('.tree-row.selected .tree-name')].map((n) => n.textContent),
    hits: Object.fromEntries([...document.querySelectorAll('.tree-row')].map((r) => [r.querySelector('.tree-name').textContent, [...r.querySelectorAll('mark.ss-hit')].map((m) => m.textContent)]).filter(([, h]) => h.length)),
    focusedTree: document.activeElement === tree,
    tabs: __qa.state().tabs.flatMap((g) => g.tabs.map((t) => t.name)),
  };`);
const focusTree = () => app.ev(`await __qa.reset(); document.activeElement?.blur?.(); await __qa.sleep(50); const t = document.querySelector('.tree[data-autofocus]'); t.focus(); await __qa.sleep(150); return 1`);
async function check(name, fn) {
  let ok = false, note = "";
  try { await focusTree(); const r = await fn(); ok = r === true || (r && r.ok); note = r && r.note ? r.note : ""; } catch (e) { note = String(e.message || e).split("\n")[0].slice(0, 160); }
  rows.push({ name, ok, note });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? "  - " + note : ""}`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

try {
await check("typing starts search: popup, first match selected, hits highlighted", async () => {
  await type("m"); const s = await snap();
  return { ok: s.popup?.query === "m" && s.selected[0] === "Main.kt" && s.hits["Main.kt"]?.[0]?.toLowerCase() === "m" && s.hits["MainView.kt"], note: JSON.stringify(s).slice(0, 200) };
});
await check("refining: 'main' highlights Main*, non-matching rows still shown", async () => {
  await type("main"); const s = await snap();
  const all = await app.ev(`return document.querySelectorAll('.tree-row').length`);
  return { ok: eq(s.hits["Main.kt"], ["Main"]) && eq(s.hits["MainView.kt"], ["Main"]) && !s.hits["README.md"] && all >= 7, note: `rows=${all} hits=${JSON.stringify(s.hits)}` };
});
await check("camel humps + underscores: 'wsa'", async () => {
  await type("wsa"); const s = await snap();
  return { ok: eq(s.hits["web_sling.animation.json"], ["w", "s", "a"]) && eq(s.hits["WebSlingAnimation.java"], ["W", "S", "A"]) && /^web/i.test(s.selected[0]), note: JSON.stringify(s.hits) + " sel=" + s.selected };
});
await check("down/up jump between matches only; wraps", async () => {
  await type("main"); const s0 = (await snap()).selected[0];
  await key("DOWN"); const a = (await snap()).selected[0];
  await key("DOWN"); const b = (await snap()).selected[0];
  await key("UP"); const c = (await snap()).selected[0];
  return { ok: s0 === "Main.kt" && a === "MainView.kt" && b === "Main.kt" && c === "MainView.kt", note: `${s0} -> ${a} -> ${b} -> ${c}` };
});
await check("Home/End first/last match", async () => {
  await type("main"); await key("END"); const e = (await snap()).selected[0]; await key("HOME"); const h = (await snap()).selected[0];
  return { ok: e && h && e !== h, note: `first=${h} last=${e}` };
});
await check("Backspace edits query; empty closes", async () => {
  await type("mai"); await key("BACK_SPACE"); const a = await snap(); await key("BACK_SPACE"); await key("BACK_SPACE"); const b = await snap();
  return { ok: a.popup?.query === "ma" && !b.popup && b.focusedTree, note: `${a.popup?.query} / ${b.popup}` };
});
await check("no match: popup turns red, selection kept", async () => {
  await type("m"); const before = (await snap()).selected[0]; await type("zzq"); const s = await snap();
  return { ok: s.popup?.nomatch && s.popup.matches === 0 && s.selected[0] === before, note: JSON.stringify(s.popup) };
});
await check("Esc closes search, selection stays, tool window keeps focus", async () => {
  await type("mainv"); const a = await snap(); await key("ESCAPE"); await sleep(100); const b = await snap();
  return { ok: a.selected[0] === "MainView.kt" && !b.popup && b.selected[0] === "MainView.kt" && !Object.keys(b.hits).length && b.focusedTree, note: JSON.stringify(b.selected) };
});
await check("Enter opens the selected file and closes search", async () => {
  await type("mainv"); await key("ENTER"); await sleep(500); const s = await snap();
  return { ok: !s.popup && s.tabs.includes("MainView.kt"), note: `tabs=${s.tabs}` };
});
await check("Space does not start a search; modifiers do not either", async () => {
  await key("SPACE"); const a = await snap(); await key("meta M"); const b = await snap();
  return { ok: !a.popup && !b.popup, note: "" };
});
await check("click elsewhere / focus loss closes the search", async () => {
  await type("ma"); const a = await snap();
  await app.ev(`document.querySelector('.tree-row').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return 1`);
  const b = await snap();
  await type("ma"); await app.ev(`__qa.editor()?.focus(); await __qa.sleep(100); return 1`); const c = await snap();
  return { ok: a.popup && !b.popup && !c.popup, note: `${!!a.popup} ${!!b.popup} ${!!c.popup}` };
});
await check("Backspace with no search still deletes (confirm dialog), not swallowed", async () => {
  await key("DOWN"); await key("BACK_SPACE"); await sleep(300);
  const dlg = await app.ev(`return !!document.querySelector('.dialog, .modal, [role=dialog]') || /Delete/.test(document.body.innerText)`);
  await key("ESCAPE");
  return { ok: dlg, note: "" };
});
await check("typing stays fast", async () => {
  const ms = await app.ev(`const t = performance.now(); for (const c of 'mainviewkt') await __qa.key(c); return performance.now() - t`);
  return { ok: ms < 3000, note: `${Math.round(ms)}ms for 10 keys` };
});
// screenshot in the IntelliJ-like state: "ma", second match selected
await focusTree(); await type("ma"); await key("DOWN"); await sleep(300);
console.log(app.shot("speedsearch"));
} catch (e) { console.error("speedsearch aborted:", e.message); }

console.log("\n| # | Check | Result | Note |\n|---|---|---|---|");
rows.forEach((r, i) => console.log(`| ${i + 1} | ${r.name} | ${r.ok ? "PASS" : "FAIL"} | ${r.note} |`));
const failed = rows.filter((r) => !r.ok).length;
console.log(`\n${rows.length - failed}/${rows.length} passed`);
await app.stop();
fs.rmSync(scratch, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
