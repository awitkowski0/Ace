#!/usr/bin/env node
// AI sessions suite: Files <-> AI flip, Claude "done / needs input" notifications (hook channel local + mc, transcript fallback).
// Drives Ace ONLY through the automation harness (window.__qa, __qa.ai(), __qa.term()): no OS-level keyboard/mouse.
// NEVER starts a real Claude session: ATELIER_CLAUDE_BIN / ATELIER_CLAUDE_BIN_MC point Ace's `claude` launches at
// scripts/qa/ai/fake-claude.py (accepts --settings, runs the configured hooks with realistic JSON payloads), transcripts live in a
// scratch ATELIER_CLAUDE_PROJECTS. Desktop notifications are intercepted by the notify test hook (no OS notification pops up).
// The mc part runs only when `ssh mc` works and only touches /tmp/ace-ai-fake-<nonce> (removed afterwards).
// Usage: node scripts/qa/ai.mjs [--no-ssh] [--only <substr>]    Env: ATELIER_BIN
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, sleep, here } from "./lib.mjs";

const noSsh = process.argv.includes("--no-ssh");
const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "ace-ai-")));
const proj = path.join(scratch, "proj");
const proj2 = path.join(scratch, "proj2");
for (const p of [proj, proj2]) fs.mkdirSync(p, { recursive: true });
const readme = Array.from({ length: 30 }, (_, i) => `line ${i + 1} of the readme`).join("\n") + "\n";
fs.writeFileSync(path.join(proj, "README.md"), readme);
fs.writeFileSync(path.join(proj, "notes.txt"), "notes\n");
fs.writeFileSync(path.join(proj2, "README.md"), readme);
const fake = path.join(scratch, "fakebin", "claude");
fs.mkdirSync(path.dirname(fake), { recursive: true });
fs.copyFileSync(path.join(here, "ai", "fake-claude.py"), fake);
fs.chmodSync(fake, 0o755);
const projects = path.join(scratch, "claude-projects");
const enc = (c) => c.replace(/[^A-Za-z0-9]/g, "-");
fs.mkdirSync(path.join(projects, enc(proj)), { recursive: true });
const argsLog = path.join(scratch, "fake-args.log");
const hookDir = path.join(os.tmpdir(), `ace-claude-hooks-${process.getuid()}`);

// ---- mc (optional) ----
let mcDir = null;
const ssh = (cmd) => execFileSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "mc", cmd], { encoding: "utf8", timeout: 30000 });
if (!noSsh) {
  try {
    ssh("true");
    mcDir = `/tmp/ace-ai-fake-${process.pid}`;
    ssh(`mkdir -p ${mcDir}`);
    execFileSync("ssh", ["-o", "BatchMode=yes", "mc", `cat > ${mcDir}/claude && chmod +x ${mcDir}/claude`], { input: fs.readFileSync(fake), timeout: 30000 });
  } catch { mcDir = null; }
}

const app = await launch(proj, {
  env: {
    ATELIER_CLAUDE_BIN: fake,
    ATELIER_CLAUDE_PROJECTS: projects,
    ATELIER_FAKE_ARGS: argsLog,
    ...(mcDir ? { ATELIER_CLAUDE_BIN_MC: `${mcDir}/claude` } : {}),
  },
});
const rows = [];
const S = () => app.ev("return __qa.state()");
const key = (k, o) => app.ev(`return await __qa.key(${JSON.stringify(k)})`, o);
const J = JSON.stringify;
/** run JS with ai = AI test hooks, T = terminal hooks, st() = __qa.state(), hf(b) = fake document.hasFocus */
const A = (body, o) => app.ev(`const ai = await __qa.ai(); const T = await __qa.term(); const st = () => __qa.state();
  const hf = (b) => { window.__hf0 ??= document.hasFocus.bind(document); document.hasFocus = b === null ? window.__hf0 : () => b; };
  const pane = (sid) => ai.panes().find((p) => p.session && p.session.sessionId === sid);
  const text = (id) => T.text(id);
  const fc = async (id, cmd) => { const k = 'FAKE-CLAUDE-DONE ' + cmd.split(' ')[0]; const n = () => text(id).split(k).length - 1; const b = n(); T.sendText(id, cmd + '\\n'); await __qa.waitFor(() => n() > b, 10000); };
  ${body}`, o);
const noteCount = () => A("return ai.notes().length");
async function check(name, fn) {
  if (only && !name.toLowerCase().includes(only.toLowerCase())) return;
  let ok = false, note = "";
  try { const r = await fn(); ok = r === true || (r && r.ok); note = r && r.note ? r.note : ""; } catch (e) { note = String(e.message || e).split("\n")[0].slice(0, 200); }
  rows.push({ name, ok, note });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? "  - " + note : ""}`);
  if (!ok) app.shot("ai_fail_" + name.replace(/[^a-z0-9]+/gi, "_").toLowerCase().slice(0, 60));
}
/** Baseline: no popup, Project visible, no bottom/right tool window, README open with the caret at line 7 col 4 and the editor focused. */
const base = async () => {
  await sleep(3300); // the same kind of signal for one session is debounced for 3 s
  await A("hf(null); ai.release(); ai.reset(); ai.clearAttn(); ai.clearLog(); ai.capture(); return 1");
  return app.ev(`await __qa.reset(${J(path.join(proj, "README.md"))}); const ed = __qa.editor(); ed.setPosition({ lineNumber: 7, column: 4 }); ed.focus(); await __qa.sleep(150); return __qa.state()`, { timeout: 20000 });
};
const procsOf = () => execSync("ps -axo pid=,ppid=,rss=,command=", { encoding: "utf8" }).split("\n").filter((l) => /ace-claude-hooks/.test(l) && !/ps -axo|pgrep/.test(l));
const filesNow = () => (fs.existsSync(hookDir) ? fs.readdirSync(hookDir) : []);
/** AI Sessions view with a fresh list (the list only refreshes by itself while the window is active; the harness window usually is not). */
const showList = async () => {
  await app.ev("__qa.runAction('Claude.ShowSessions'); await __qa.sleep(400); document.querySelector('.claude-bar [title=\"Refresh\"]')?.click(); await __qa.sleep(700); return 1");
};
const logOf = () => A("return ai.log()");
const waitLog = (pred, ms = 8000) => A(`const f = ${pred.toString()}; await __qa.waitFor(() => ai.log().some(f), ${ms}); return ai.log().filter(f).pop()`, { timeout: ms + 3000 });
const waitNotes = (n, ms = 8000) => A(`await __qa.waitFor(() => ai.notes().length >= ${n}, ${ms}); return ai.notes()`, { timeout: ms + 3000 });
const badges = () => app.ev(`const t = (s) => [...document.querySelectorAll(s)].map((e) => e.textContent); return { stripe: t('.stripe-badge'), tab: t('.tw-badge'), term: t('.term-attn'), stripeKind: [...document.querySelectorAll('.stripe-badge')].map((e) => e.className), termKind: [...document.querySelectorAll('.term-attn')].map((e) => e.dataset.attn) }`);

try {
// ------------------------------------------------------------------------------------------------ actions / keys
await check("Flip action registered with ⌃⌥A; no other action owns that key; related actions are in Find Action", async () => {
  const acts = await app.ev("return __qa.actions()");
  const flip = acts.find((a) => a.id === "Claude.FlipFilesAI");
  const owners = acts.filter((a) => a.keys.some((k) => /control.*alt.*A$/i.test(k) && !/shift/i.test(k)));
  const need = ["Claude.ShowFiles", "Claude.ShowAiSessions", "Claude.GotoWaiting", "Claude.Toggle.notifyDone", "Claude.Toggle.onlyWhenUnfocused", "Claude.NewSession"].filter((id) => !acts.some((a) => a.id === id));
  return { ok: !!flip && flip.keys.length === 1 && owners.length === 1 && need.length === 0, note: `keys=${J(flip?.keys)} owners=${owners.map((o) => o.id)} missing=${need}` };
});

// ------------------------------------------------------------------------------------------------ flip without sessions
await check("AI Sessions is the 2nd view of the Project window: header tabs Project | AI Sessions, one stripe button", async () => {
  await base();
  await app.ev("__qa.runAction('ActivateClaudeToolWindow'); await __qa.sleep(300); return 1");
  const r = await app.ev(`return { left: __qa.state().toolWindows.left, tabs: [...document.querySelectorAll('.tw-tab')].map((e) => e.textContent), stripe: document.querySelectorAll('.stripe.left .stripe-btn').length, rightHasClaude: !!document.querySelector('.stripe.right [title^="AI"]') }`);
  return { ok: r.left === "claude" && r.tabs.join().startsWith("Project") && r.tabs.join().includes("AI Sessions"), note: J(r) };
});
await check("⌘1 from the AI view switches back to Project; ⌃⌥C switches to AI (view switcher semantics)", async () => {
  await key("meta 1"); await sleep(250);
  const a = (await S()).toolWindows.left;
  await key("control alt C"); await sleep(250);
  const b = (await S()).toolWindows.left;
  return { ok: a === "project" && b === "claude", note: `${a} -> ${b}` };
});
await check("flip files -> AI with no session: AI Sessions view shown, list focused; flip again -> Project + editor, caret intact", async () => {
  const s0 = await base();
  await key("control alt A"); await sleep(400);
  const s1 = await S();
  await key("control alt A"); await sleep(400);
  const s2 = await S();
  return { ok: s1.toolWindows.left === "claude" && s1.focused === "toolwindow:claude" && s2.toolWindows.left === "project" && s2.focused === "editor" && s2.cursor.line === 7 && s2.cursor.col === 4 && s0.cursor.line === 7,
    note: `AI: left=${s1.toolWindows.left} focus=${s1.focused}; back: left=${s2.toolWindows.left} focus=${s2.focused} caret=${s2.cursor.line}:${s2.cursor.col}` };
});
await check("repeated flips toggle: 5 presses end in AI, 6 end in files, caret never moves", async () => {
  await base();
  const seq = [];
  for (let i = 0; i < 6; i++) { await key("control alt A"); await sleep(300); const s = await S(); seq.push(s.toolWindows.left + "/" + s.focused.replace("toolwindow:", "tw:")); }
  const s = await S();
  return { ok: seq.map((x) => x.split("/")[0]).join() === "claude,project,claude,project,claude,project" && s.focused === "editor" && s.cursor.line === 7 && s.cursor.col === 4, note: seq.join(" ") };
});

// ------------------------------------------------------------------------------------------------ launch, hook args
let s1id = null, s1pane = null;
await check("New Session launches claude with --settings (Stop/Notification/UserPromptSubmit hooks) and registers the terminal for the session", async () => {
  await base();
  fs.writeFileSync(argsLog, "");
  await A(`ai.launch.newSession('local', ${J(proj)}); await __qa.waitFor(() => ai.panes().some((p) => p.session), 8000); const p = ai.panes().find((p) => p.session); await __qa.waitFor(() => text(p.id).includes('FAKE-CLAUDE-START'), 15000); return 1`, { timeout: 25000 });
  const line = JSON.parse(fs.readFileSync(argsLog, "utf8").trim().split("\n").pop());
  const settings = JSON.parse(line.argv[line.argv.indexOf("--settings") + 1]);
  const ev = Object.keys(settings.hooks).sort().join();
  const p = await A("const p = ai.panes().find((p) => p.session); return { id: p.id, title: p.title, file: p.session.paneId }");
  s1pane = p.id; s1id = line.sid;
  const channel = fs.existsSync(line.env_hook_file) && line.env_hook_file.startsWith(hookDir) && line.pane === p.id;
  return { ok: ev === "Notification,Stop,UserPromptSubmit" && channel && p.title === "Claude", note: `hooks=${ev} file=${path.basename(line.env_hook_file ?? "")} paneEnv=${line.pane === p.id} title=${p.title}` };
});
// hand the fake its session id: the test learns it from the first hook event
await check("terminal tab shows the session title once the transcript has one", async () => {
  await A(`await fc(${J(s1pane)}, 'prompt first question'); await __qa.waitFor(() => ai.panes().find((p) => p.id === ${J(s1pane)}).title.startsWith('Claude: Fake session'), 10000); return 1`, { timeout: 20000 });
  const t = await A(`return ai.panes().find((p) => p.id === ${J(s1pane)}).title`);
  return { ok: t === `Claude: Fake session ${s1id.slice(0, 8)}`, note: t };
});

// ------------------------------------------------------------------------------------------------ flip with a session
await check("flip files -> AI focuses the most recent Claude session terminal; flip back restores editor focus + caret and hides the terminal again", async () => {
  const s0 = await base();
  await key("control alt A"); await sleep(700);
  const s1 = await S();
  const t = await A("const s = await T.state(); const tab = s.tabs.find((x) => x.id === s.active); return { focus: tab.panes.find((p) => p.focused)?.id, dom: tab.panes.find((p) => p.focused)?.domFocused, tabs: s.tabs.length }");
  await key("control alt A"); await sleep(500);
  const s2 = await S();
  return { ok: s1.toolWindows.left === "claude" && s1.toolWindows.bottom === "terminal" && s1.focused === "toolwindow:terminal" && t.focus === s1pane && t.dom
    && s2.toolWindows.left === "project" && s2.toolWindows.bottom === null && s2.focused === "editor" && s2.cursor.line === 7 && s2.cursor.col === 4,
    note: `AI: ${s1.toolWindows.left}/${s1.toolWindows.bottom} ${s1.focused} pane=${t.focus === s1pane} dom=${t.dom}; back: ${s2.toolWindows.left}/${s2.toolWindows.bottom} ${s2.focused} ${s2.cursor.line}:${s2.cursor.col}` };
});
await check("flip from the Project tree returns to the Project tree (not the editor)", async () => {
  await base();
  await key("meta 1"); await sleep(300);
  const f0 = (await S()).focused;
  await key("control alt A"); await sleep(600);
  const f1 = (await S()).focused;
  await key("control alt A"); await sleep(500);
  const s2 = await S();
  return { ok: f0 === "toolwindow:project" && f1 === "toolwindow:terminal" && s2.focused === "toolwindow:project" && s2.toolWindows.left === "project", note: `${f0} -> ${f1} -> ${s2.focused}` };
});
await check("flip works when the Claude terminal itself has focus and Ghostty terminal keys are untouched (⌃⌥A goes to the flip action, not the shell)", async () => {
  await base();
  await key("control alt A"); await sleep(600);
  await A(`T.record(${J(s1pane)}); return 1`);
  await key("control alt A"); await sleep(500);
  const w = await A(`return T.writes(${J(s1pane)})`);
  const s = await S();
  return { ok: s.focused === "editor" && w.length === 0, note: `focus=${s.focused} bytes written to pty=${w.length}` };
});

// ------------------------------------------------------------------------------------------------ hook channel + notifications
const unfocusedFlow = async () => { await base(); await A("hf(false); return 1"); await key("control alt A").catch(() => {}); };
await check("hook channel: UserPromptSubmit + Stop reach Ace; unfocused -> ONE notification 'Claude finished' with project + first line; badges on stripe, AI tab and terminal tab", async () => {
  await base();
  await A("hf(false); return 1");
  await A(`ai.flip(); await __qa.sleep(500); return 1`); // AI view with the terminal visible (window unfocused)
  await A(`await fc(${J(s1pane)}, 'prompt refactor'); await fc(${J(s1pane)}, 'stop Refactored the parser'); return 1`, { timeout: 25000 });
  const notes = await waitNotes(1);
  const hook = await waitLog((e) => e.source === "hook" && e.action === "notified" && e.kind === "done");
  const b = await badges();
  return { ok: notes.length === 1 && notes[0].title === "Claude finished" && notes[0].body === `proj: Refactored the parser` && b.stripe.join() === "1" && b.tab.join() === "1" && b.term.join() === "✓",
    note: `notes=${J(notes.map((n) => [n.title, n.body]))} badges=${J(b)} hookLog=${hook?.action}` };
});
await check("question: AskUserQuestion pending -> 'Claude needs input' with the question text; badge switches to ? / orange", async () => {
  await A(`await fc(${J(s1pane)}, 'prompt next'); ai.clearNotes(); await fc(${J(s1pane)}, 'ask Which database should we use?'); return 1`, { timeout: 25000 });
  const notes = await waitNotes(1);
  const b = await badges();
  return { ok: notes[0].title === "Claude needs input" && notes[0].body === "proj: Which database should we use?" && b.term.join() === "?" && b.termKind.join() === "question" && b.stripeKind[0].includes("question"), note: `${J(notes.map((n) => n.body))} ${J(b)}` };
});
await check("permission prompt (plain Notification hook) -> needs input with Claude's message; idle reminder after Stop is not announced again", async () => {
  await sleep(3300);
  await A(`ai.clearNotes(); ai.clearLog(); await fc(${J(s1pane)}, 'prompt more'); await fc(${J(s1pane)}, 'perm'); return 1`, { timeout: 25000 });
  const n1 = await waitNotes(1);
  await A(`ai.clearNotes(); await fc(${J(s1pane)}, 'stop Done again'); return 1`, { timeout: 15000 });
  await waitNotes(1);
  await A(`ai.clearNotes(); await fc(${J(s1pane)}, 'idle'); await __qa.sleep(600); return 1`, { timeout: 15000 });
  const n3 = await noteCount();
  const ign = (await logOf()).some((e) => e.reason === "idle reminder after Stop");
  return { ok: n1[0].title === "Claude needs input" && n1[0].body === "proj: Claude needs your permission to use Bash" && n3 === 0 && ign, note: `perm=${n1[0].body} idleNotes=${n3} idleIgnored=${ign}` };
});
await check("one notification per turn: two Stop events and a burst are collapsed (debounce + armed-by-prompt)", async () => {
  await sleep(3300);
  await A(`ai.clearNotes(); await fc(${J(s1pane)}, 'prompt turn'); await fc(${J(s1pane)}, 'stop first'); await fc(${J(s1pane)}, 'stop second'); await fc(${J(s1pane)}, 'stop third'); await __qa.sleep(500); return 1`, { timeout: 30000 });
  const n = await A("return ai.notes()");
  return { ok: n.length === 1 && n[0].body === "proj: first", note: J(n.map((x) => x.body)) };
});
await check("suppressed when the session's terminal is visible AND focused (window focused): no notification, no badge", async () => {
  await base();
  await A("hf(true); return 1");
  await key("control alt A"); await sleep(700); // terminal focused
  await A(`ai.clearNotes(); ai.clearLog(); ai.clearAttn(); await fc(${J(s1pane)}, 'prompt visible'); await fc(${J(s1pane)}, 'stop visible and focused'); await __qa.sleep(400); return 1`, { timeout: 30000 });
  const [n, attn, log, b] = [await A("return ai.notes()"), await A("return ai.attn()"), await logOf(), await badges()];
  const why = log.find((e) => e.action === "suppressed");
  return { ok: n.length === 0 && attn.length === 0 && b.stripe.length === 0 && why?.reason === "focused terminal", note: `notes=${n.length} attn=${attn.length} reason=${why?.reason}` };
});
await check("terminal visible but focus elsewhere (window focused): 'only when unfocused' ON -> suppressed; OFF -> shown", async () => {
  await base();
  await A("hf(true); return 1");
  await key("control alt A"); await sleep(700);
  await app.ev("__qa.editor().focus(); await __qa.sleep(200); return 1"); // terminal stays visible at the bottom
  const vis = await A(`return ai.panes().find((p) => p.id === ${J(s1pane)}).visible`);
  await A(`ai.clearNotes(); ai.clearLog(); await fc(${J(s1pane)}, 'prompt a'); await fc(${J(s1pane)}, 'stop on screen'); await __qa.sleep(400); return 1`, { timeout: 30000 });
  const on = await noteCount();
  await sleep(3300);
  await A(`ai.update({ onlyWhenUnfocused: false }); ai.clearNotes(); await fc(${J(s1pane)}, 'prompt b'); await fc(${J(s1pane)}, 'stop on screen again'); return 1`, { timeout: 30000 });
  await waitNotes(1);
  const off = await noteCount();
  return { ok: vis && on === 0 && off === 1, note: `visible=${vis} ON->${on} notes, OFF->${off}` };
});

await check("terminal hidden while Ace is focused: notification shown + badge; looking at the session (flip) clears the badge", async () => {
  await base();
  await A("hf(true); ai.hideTerminal(); return 1");
  await A(`ai.clearNotes(); await fc(${J(s1pane)}, 'prompt c'); await fc(${J(s1pane)}, 'stop in the background'); return 1`, { timeout: 30000 });
  const n = await waitNotes(1);
  const b1 = await badges();
  await key("control alt A"); await sleep(900);
  const b2 = await badges();
  const attn = await A("return ai.attn()");
  return { ok: n[0].body === "proj: in the background" && b1.stripe.join() === "1" && b2.stripe.length === 0 && b2.term.length === 0 && attn.length === 0, note: `before=${J(b1.stripe)} after=${J(b2.stripe)} attn=${attn.length}` };
});
await check("settings: 'notify when done' off -> no OS notification but the badge still shows; Find Action toggles exist", async () => {
  await base();
  await A("hf(false); ai.update({ notifyDone: false }); return 1");
  await A(`ai.clearNotes(); await fc(${J(s1pane)}, 'prompt d'); await fc(${J(s1pane)}, 'stop quiet'); await __qa.sleep(500); return 1`, { timeout: 30000 });
  const [n, b] = [await noteCount(), await badges()];
  await A("ai.reset(); return 1");
  return { ok: n === 0 && b.stripe.join() === "1", note: `notes=${n} badge=${b.stripe}` };
});

// ------------------------------------------------------------------------------------------------ click target
let s2id = null, s2pane = null;
await check("notification activation routes to the session: other tab active, session 1 notifies, claim -> AI view + its terminal tab focused, badge cleared", async () => {
  await base();
  fs.writeFileSync(argsLog, "");
  await A(`ai.launch.newSession('local', ${J(proj)}); await __qa.waitFor(() => ai.panes().filter((p) => p.session).length >= 2, 8000); return 1`, { timeout: 15000 });
  const line = await (async () => { for (let i = 0; i < 40; i++) { const l = fs.readFileSync(argsLog, "utf8").trim().split("\n").filter(Boolean); if (l.length) return JSON.parse(l.pop()); await sleep(250); } throw new Error("session 2 never started"); })();
  s2id = line.sid; s2pane = line.pane;
  await A(`await __qa.waitFor(() => text(${J(s2pane)}).includes('FAKE-CLAUDE-START'), 10000); await fc(${J(s2pane)}, 'prompt hello'); return 1`, { timeout: 20000 });
  await A(`hf(false); ai.clearNotes(); ai.clearAttn(); ai.clearLog(); return 1`);
  // session 2's tab is active and visible; session 1 finishes in the background
  await A(`await fc(${J(s1pane)}, 'prompt x'); await fc(${J(s1pane)}, 'stop session one finished'); return 1`, { timeout: 30000 });
  const notes = await waitNotes(1);
  const before = await S();
  const claimed = await A("return await __qa.invoke('claude_note_claim')");
  await A(`await __qa.waitFor(() => !ai.attn().length, 4000); await __qa.sleep(500); return 1`, { timeout: 8000 });
  const after = await S();
  const act = await A(`const s = await T.state(); const tab = s.tabs.find((x) => x.id === s.active); return { focus: tab.panes.find((p) => p.focused)?.id, dom: tab.panes.find((p) => p.focused)?.domFocused }`);
  const again = await A("return await __qa.invoke('claude_note_claim')");
  return { ok: notes.length === 1 && claimed === true && act.focus === s1pane && act.dom && after.toolWindows.left === "claude" && after.focused === "toolwindow:terminal" && again === false, note: `claimed=${claimed} focusIsSession1=${act.focus === s1pane} dom=${act.dom} left=${after.toolWindows.left} claimAgain=${again}; active before=${before.focused}` };
});

// ------------------------------------------------------------------------------------------------ AI list: selection focuses terminal
fs.mkdirSync(path.join(projects, enc(proj)), { recursive: true });
const oldId = "11111111-2222-3333-4444-555555555555";
const t0 = () => new Date().toISOString();
fs.writeFileSync(path.join(projects, enc(proj), `${oldId}.jsonl`), [
  JSON.stringify({ type: "user", cwd: proj, sessionId: oldId, uuid: "o1", timestamp: t0(), message: { role: "user", content: "an older conversation" } }),
  JSON.stringify({ type: "ai-title", aiTitle: "Older conversation", sessionId: oldId }),
].join("\n") + "\n");
await check("AI list: rows show 'terminal' for sessions open in Ace; Enter/double-click focuses that terminal tab instead of resuming twice", async () => {
  await base();
  await A("hf(null); return 1");
  await showList();
  await app.ev(`await __qa.waitFor(() => document.querySelector('.claude-row[data-session]'), 8000); return 1`);
  const rowsInfo = await app.ev(`return [...document.querySelectorAll('.claude-row[data-session]')].map((r) => ({ id: r.dataset.session, term: !!r.querySelector('.claude-badge.term'), text: r.querySelector('.txt')?.textContent }))`);
  const paneCount0 = await A("return ai.panes().length");
  await app.ev(`document.querySelector('.claude-row[data-session="${s1id}"]').click(); document.querySelector('.claude-panel').focus(); await __qa.sleep(150); return 1`);
  await key("ENTER"); await sleep(800);
  const act = await A(`const s = await T.state(); const tab = s.tabs.find((x) => x.id === s.active); return { focus: tab.panes.find((p) => p.focused)?.id, dom: tab.panes.find((p) => p.focused)?.domFocused, n: ai.panes().length }`);
  const st = await S();
  const r1 = rowsInfo.find((r) => r.id === s1id);
  return { ok: !!r1?.term && act.focus === s1pane && act.dom && act.n === paneCount0 && st.focused === "toolwindow:terminal", note: `row terminal=${r1?.term} focusIsSession1=${act.focus === s1pane} panes ${paneCount0}->${act.n} focus=${st.focused} rows=${rowsInfo.length}` };
});
let oldPane = null;
await check("Enter on a session without a terminal resumes it (claude --resume <id> --settings ...) in a new tab titled with the session", async () => {
  await showList();
  await app.ev(`try { await __qa.waitFor(() => document.querySelector('.claude-row[data-session="${oldId}"]'), 8000); } catch (e) { throw new Error(e.message.slice(0, 40) + ' rows=' + JSON.stringify([...document.querySelectorAll('.claude-row')].map((r) => r.dataset.session)) + ' left=' + __qa.state().toolWindows.left + ' panel=' + (document.querySelector('.claude-panel')?.innerText || '').slice(0, 200)); } document.querySelector('.claude-row[data-session="${oldId}"]').click(); document.querySelector('.claude-panel').focus(); await __qa.sleep(150); return 1`);
  fs.writeFileSync(argsLog, "");
  await key("ENTER");
  const line = await (async () => { for (let i = 0; i < 60; i++) { const l = fs.readFileSync(argsLog, "utf8").trim().split("\n").filter(Boolean); if (l.length) return JSON.parse(l.pop()); await sleep(250); } throw new Error("resume never started"); })();
  oldPane = line.pane;
  const p = await A(`const p = ai.panes().find((p) => p.id === ${J(line.pane)}); return { title: p.title, session: p.session.sessionId }`);
  return { ok: line.argv.includes("--resume") && line.argv.includes(oldId) && line.argv.includes("--settings") && p.session === oldId && p.title === "Claude: Older conversation", note: `argv=${line.argv.slice(0, 3).join(" ")}... title=${p.title} session=${p.session}` };
});
await check("selecting the same session again focuses the existing terminal (no third process)", async () => {
  await key("control alt A"); await sleep(400); // back to files
  await showList();
  await app.ev(`document.querySelector('.claude-row[data-session="${oldId}"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); await __qa.sleep(700); return 1`);
  const n = await A("return ai.panes().length");
  const log = fs.readFileSync(argsLog, "utf8").trim().split("\n").filter(Boolean).length;
  const st = await S();
  return { ok: log === 1 && st.focused === "toolwindow:terminal", note: `launches since=${log} panes=${n} focus=${st.focused}` };
});

// ------------------------------------------------------------------------------------------------ plain `claude` typed in an Ace shell
await check("plain `claude` typed in an Ace terminal gets the hooks too (shell integration wrapper; dotfiles untouched)", async () => {
  await base();
  await A("hf(false); ai.clearNotes(); ai.clearAttn(); return 1");
  const id = await A(`const tabId = ai.plainShell('local', ${J(proj)}); __qa.runAction('ActivateTerminalToolWindow'); const panes = () => ai.panes().filter((p) => p.tab === tabId); await __qa.waitFor(() => panes().length && T.pane(panes()[0].id)?.cwdFromShell, 25000); return panes()[0].id`, { timeout: 35000 });
  fs.writeFileSync(argsLog, "");
  await A(`T.sendText(${J(id)}, 'claude\\n'); await __qa.waitFor(() => text(${J(id)}).includes('FAKE-CLAUDE-START'), 15000); return 1`, { timeout: 25000 });
  const line = JSON.parse(fs.readFileSync(argsLog, "utf8").trim().split("\n").pop());
  await A(`await fc(${J(id)}, 'prompt typed by hand'); await fc(${J(id)}, 'stop typed claude finished'); return 1`, { timeout: 30000 });
  const notes = await waitNotes(1);
  const reg = await A(`return ai.panes().find((p) => p.id === ${J(id)}).session`);
  return { ok: line.argv.includes("--settings") && line.pane === id && notes[0].title === "Claude finished" && notes[0].body === "proj: typed claude finished" && !!reg?.sessionId, note: `settings=${line.argv.includes("--settings")} pane=${line.pane === id} registered=${!!reg?.sessionId} note=${notes[0]?.body}` };
});

await check("setting 'report from sessions started in Ace' off: no hook file for claude / shells (the spawn hook yields nothing)", async () => {
  await base();
  const on = await A("return await ai.spawnHook({ host: 'local', cwd: '/tmp', command: 'claude --resume x', id: 'probe1' })");
  await A("ai.update({ hooks: false }); return 1");
  const off = await A("return (await ai.spawnHook({ host: 'local', cwd: '/tmp', command: 'claude --resume x', id: 'probe2' })) ?? null");
  const offShell = await A("return (await ai.spawnHook({ host: 'local', cwd: '/tmp', id: 'probe3' })) ?? null");
  await A("ai.reset(); return 1");
  const other = await A("return (await ai.spawnHook({ host: 'local', cwd: '/tmp', command: 'ls -la', id: 'probe4' })) ?? null");
  return { ok: typeof on === "string" && on.startsWith(hookDir) && off === null && offShell === null && other === null, note: `on=${path.basename(on ?? "")} off=${off} offShell=${offShell} nonClaudeCommand=${other}` };
});

// ------------------------------------------------------------------------------------------------ transcript fallback (sessions Ace did not launch)
const extId = "ext-session-aaaa";
const extFile = path.join(projects, enc(proj), `${extId}.jsonl`);
const rec = (o) => fs.appendFileSync(extFile, JSON.stringify({ sessionId: extId, cwd: proj, uuid: Math.random().toString(36).slice(2), timestamp: new Date().toISOString(), ...o }) + "\n");
const user = (c) => rec({ type: "user", message: { role: "user", content: c } });
const asst = (stop, content) => rec({ type: "assistant", message: { role: "assistant", stop_reason: stop, content } });
await check("transcript fallback: another terminal's session in this project -> 'finished' notification from the JSONL (end_turn)", async () => {
  await base();
  await A("hf(false); ai.clearNotes(); ai.clearAttn(); ai.clearLog(); return 1");
  await sleep(300);
  user("please deploy");
  await sleep(1200);
  asst("end_turn", [{ type: "text", text: "Deployed to staging" }]);
  const notes = await waitNotes(1, 9000);
  const e = await waitLog((x) => x.source === "fallback" && x.action === "notified");
  return { ok: notes[0].title === "Claude finished" && notes[0].body === "proj: Deployed to staging", note: `${J(notes.map((n) => [n.title, n.body]))} src=${e?.source}` };
});
await check("transcript fallback: trailing AskUserQuestion tool_use -> 'needs input' with the question", async () => {
  await A("ai.clearNotes(); return 1");
  user("next task");
  await sleep(900);
  asst("tool_use", [{ type: "tool_use", name: "AskUserQuestion", id: "q1", input: { questions: [{ question: "Use Postgres or SQLite?", options: [] }] } }]);
  const notes = await waitNotes(1, 9000);
  return { ok: notes[0].title === "Claude needs input" && notes[0].body === "proj: Use Postgres or SQLite?", note: J(notes.map((n) => n.body)) };
});
await check("transcript fallback: a tool call left unanswered for N s (setting) is announced as a possible permission prompt; an answered one is not", async () => {
  await A("ai.update({ pendingSecs: 2 }); ai.clearNotes(); return 1");
  user("run the build");
  await sleep(900);
  asst("tool_use", [{ type: "tool_use", name: "Bash", id: "b1", input: { command: "make" } }]);
  await sleep(900);
  rec({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "b1", content: "ok" }] } }); // answered within 2 s: no question
  await sleep(3500);
  const quiet = await noteCount();
  asst("tool_use", [{ type: "tool_use", name: "Bash", id: "b2", input: { command: "rm -rf build" } }]);
  const notes = await waitNotes(1, 9000);
  await A("ai.reset(); return 1");
  return { ok: quiet === 0 && notes[0].title === "Claude needs input" && notes[0].body === "proj: May be waiting for permission (Bash)", note: `answered->${quiet} notes; pending->${J(notes.map((n) => n.body))}` };
});
await check("transcript fallback is scoped: other projects' transcripts, stale first-seen state and sessions Ace already tracks via hooks produce nothing", async () => {
  await A("ai.clearNotes(); ai.clearLog(); return 1");
  const otherDir = path.join(projects, enc(proj2));
  fs.mkdirSync(otherDir, { recursive: true });
  fs.appendFileSync(path.join(otherDir, "other.jsonl"), JSON.stringify({ type: "assistant", sessionId: "other", cwd: proj2, uuid: "z1", timestamp: new Date().toISOString(), message: { stop_reason: "end_turn", content: [{ type: "text", text: "other project" }] } }) + "\n");
  const stale = path.join(projects, enc(proj), "stale.jsonl");
  fs.writeFileSync(stale, JSON.stringify({ type: "assistant", sessionId: "stale", cwd: proj, uuid: "z2", timestamp: "2020-01-01T00:00:00.000Z", message: { stop_reason: "end_turn", content: [{ type: "text", text: "very old" }] } }) + "\n");
  await sleep(300);
  await A(`await fc(${J(s1pane)}, 'prompt for hooked'); await fc(${J(s1pane)}, 'stop hooked session text'); return 1`, { timeout: 30000 });
  await sleep(3500); // watcher debounce 0.7 s + hook grace 1.5 s
  const notes = await A("return ai.notes()");
  const log = await logOf();
  const ign = log.some((e) => e.action === "ignored" && e.reason === "hooked session");
  return { ok: notes.length === 1 && notes[0].body === "proj: hooked session text" && ign && !notes.some((n) => /other project|very old/.test(n.body)), note: `notes=${J(notes.map((n) => n.body))} hookedIgnored=${ign}` };
});
await check("setting 'watch other sessions of this project' off -> fallback silent", async () => {
  await A("ai.update({ watchProject: false }); ai.clearNotes(); return 1");
  await sleep(300);
  user("again");
  await sleep(900);
  asst("end_turn", [{ type: "text", text: "should not notify" }]);
  await sleep(3500);
  const n = await noteCount();
  await A("ai.reset(); return 1");
  return { ok: n === 0, note: `notes=${n}` };
});

// ------------------------------------------------------------------------------------------------ mc
if (mcDir) {
  let mcPane = null;
  await check("mc: Claude launched on mc reports Stop/Notification through a /tmp file read over the multiplexed ssh connection", async () => {
    await base();
    await A("hf(false); ai.clearNotes(); ai.clearAttn(); ai.clearLog(); return 1");
    mcPane = await A(`ai.launch.newSession('mc', ${J(mcDir)}); await __qa.waitFor(() => ai.panes().some((p) => p.session && p.session.host === 'mc'), 10000); const p = ai.panes().find((p) => p.session && p.session.host === 'mc'); await __qa.waitFor(() => text(p.id).includes('FAKE-CLAUDE-START'), 30000); return p.id`, { timeout: 45000 });
    const files = ssh("ls /tmp/ace-claude-hooks-*.log 2>/dev/null | wc -l").trim();
    await A(`await fc(${J(mcPane)}, 'prompt remote'); await fc(${J(mcPane)}, 'stop Remote work complete'); return 1`, { timeout: 40000 });
    const n1 = await waitNotes(1, 15000);
    await A(`ai.clearNotes(); await fc(${J(mcPane)}, 'prompt more'); await fc(${J(mcPane)}, 'ask Remote question?'); return 1`, { timeout: 40000 });
    const n2 = await waitNotes(1, 15000);
    const tails = ssh(`pgrep -fa 'tail -n \\+1 -F /tmp/ace-claude-hooks' | grep -v pgrep | wc -l`).trim();
    return { ok: files === "1" && n1[0].title === "Claude finished" && n1[0].body === `${path.basename(mcDir)}: Remote work complete` && n2[0].title === "Claude needs input" && n2[0].body.endsWith(": Remote question?") && tails === "1",
      note: `remote files=${files} tails=${tails} done=${n1[0].body} question=${n2[0].body}` };
  });
    await check("mc: an interactive ssh shell gets the hook env and the claude wrapper function (not invoked)", async () => {
    await base();
    const id = await A(`const tabId = ai.plainShell('mc', '/tmp'); __qa.runAction('ActivateTerminalToolWindow'); await __qa.sleep(300); return ai.panes().filter((p) => p.tab === tabId)[0].id`);
    let up = false, last = null;
    for (let i = 0; i < 40 && !up; i++) { await sleep(1000); last = await A(`const p = T.pane(${J(id)}); return { shell: p.cwdFromShell, text: T.text(${J(id)}).trim().slice(-300), exited: p.exited }`); up = last.shell; }
    if (!up) throw new Error("remote shell never came up: " + J(last));
    await A(`T.sendText(${J(id)}, 'echo HF=$(case "$ATELIER_HOOK_FILE" in /tmp/ace-claude-hooks-*) echo ok;; esac) PANE=$ATELIER_PANE SET=$(printf %s "$ATELIER_CLAUDE_SETTINGS" | head -c 9); type claude | head -1\\n'); return 1`, { timeout: 5000 });
    for (let i = 0; i < 20; i++) { await sleep(500); if (await A(`return /claude is a function/.test(text(${J(id)}))`, { timeout: 5000 })) break; }
    const txt = await A(`return text(${J(id)})`);
    const files = ssh("ls /tmp/ace-claude-hooks-*.log 2>/dev/null | wc -l").trim();
    return { ok: /HF=ok PANE=p[0-9a-z]+ SET=\{"hooks"/.test(txt) && /claude is a function/.test(txt), note: `${(txt.match(/HF=.*/g) ?? []).pop()} | ${(txt.match(/claude is .*/g) ?? []).pop()} files=${files}` };
  });
await check("mc: the remote terminal tab is registered for the flip action (mc session is a valid flip target)", async () => {
    await base();
    await A(`ai.clearAttn(); return 1`);
    const mru = await A("return ai.mru()");
    await key("control alt A"); await sleep(900);
    const t = await A("const s = await T.state(); const tab = s.tabs.find((x) => x.id === s.active); return tab.panes.find((p) => p.focused)?.host");
    await key("control alt A"); await sleep(400);
    return { ok: mru === mcPane && t === "mc", note: `mru is mc pane=${mru === mcPane} focused host=${t}` };
  });
}

// ------------------------------------------------------------------------------------------------ per-window state, process hygiene
let labelA = null, labelB = null;
await check("second project window: own hook channel + flip state; closing it removes ITS listener process and temp file, window A keeps theirs", async () => {
  await base();
  const w0 = await app.windows();
  labelA = w0.find((w) => w.focused)?.label ?? w0[0].label;
  const before = { procs: procsOf().length, files: filesNow().length };
  await app.evIn(labelA, `window.__flow = __qa.openFlow(${J(proj2)}, 'new'); return 1`);
  await app.ev("await new Promise((r) => setTimeout(r, 100)); return 1", { window: labelA });
  let w;
  for (let i = 0; i < 60; i++) { w = await app.windows(); if (w.length === 2) break; await sleep(250); }
  labelB = w.map((x) => x.label).find((l) => l !== labelA);
  await app.evIn(labelB, `await __qa.waitFor(() => document.querySelector('.toolbar, .app'), 10000); return 1`);
  const AB = (body, o) => app.evIn(labelB, `const ai = await __qa.ai(); const T = await __qa.term(); const pane = () => ai.panes().find((p) => p.session); ${body}`, o);
  await AB(`await __qa.reset(${J(path.join(proj2, "README.md"))}); ai.capture(); ai.launch.newSession('local', ${J(proj2)}); await __qa.waitFor(() => pane(), 10000); await __qa.waitFor(() => T.text(pane().id).includes('FAKE-CLAUDE-START'), 20000); return 1`, { timeout: 40000 });
  await AB(`await __qa.reset(${J(path.join(proj2, "README.md"))}); __qa.runAction('Claude.FlipFilesAI'); await __qa.sleep(600); return 1`);
  const sA = await app.evIn(labelA, "return __qa.state()");
  const sB = await app.evIn(labelB, "return __qa.state()");
  const mid = { procs: procsOf().length, files: filesNow().length };
  const procsListBefore = await app.evIn(labelA, "return await __qa.invoke('procs_list')");
  await app.evIn(labelB, `__qa.runAction('CloseProject'); return 1`);
  let after = null;
  for (let i = 0; i < 60; i++) { await sleep(250); after = { procs: procsOf().length, files: filesNow().length }; if (after.procs === mid.procs - 2 && after.files === mid.files - 1) break; }
  const sA2 = await app.evIn(labelA, "return __qa.state()");
  const hooksProcs = procsListBefore.filter((p) => p.kind === "claude-hooks");
  const owners = [...new Set(hooksProcs.map((p) => p.owner))];
  return { ok: sB.toolWindows.left === "claude" && sA.toolWindows.left === "project" && sA2.toolWindows.left === "project" && mid.procs === before.procs + 2 && mid.files === before.files + 1 && after.procs === before.procs && after.files === before.files && owners.length >= 2,
    note: `B left=${sB.toolWindows.left} A left=${sA.toolWindows.left}; helper procs ${before.procs}->${mid.procs}->${after.procs}; files ${before.files}->${mid.files}->${after.files}; registered owners=${owners}` };
});
await check("helper footprint: listener = one sh + one tail per window/host, one ssh client per remote host (RSS reported)", async () => {
  const l = procsOf().filter((x) => /echo READY|tail -n \+1 -F|F="\$1"/.test(x)).map((x) => x.trim().split(/\s+/));
  const rss = (ls) => ls.reduce((a, x) => a + Number(x[2]), 0) / 1024;
  const sshp = l.filter((x) => x[3] === "ssh"), loc = l.filter((x) => x[3] !== "ssh");
  return { ok: loc.length >= 2 && loc.length % 2 === 0 && sshp.length === (mcDir ? 1 : 0), note: `local sh+tail: ${loc.length} procs ${rss(loc).toFixed(1)} MB; ssh clients: ${sshp.length} ${rss(sshp).toFixed(1)} MB` };
});
} finally {
  await app.stop();
}
// ---- after the app is gone ----
const leftovers = procsOf();
const files = filesNow();
const own = files;
let mcLeft = "n/a";
if (mcDir) {
  await sleep(1500);
  mcLeft = ssh(`ls /tmp/ace-claude-hooks-*.log 2>/dev/null | wc -l; pgrep -fa 'tail -n \\+1 -F /tmp/ace-claude-hooks' | grep -v pgrep | wc -l`).trim().replace(/\n/g, " tails=");
  ssh(`rm -rf ${mcDir}`);
}
const post = leftovers.length === 0 && own.length === 0 && (!mcDir || mcLeft.startsWith("0 tails=0"));
rows.push({ name: "after quitting: no listener processes, no hook temp files (local and mc)", ok: post });
console.log(`${post ? "PASS" : "FAIL"}  after quitting: no listener processes, no hook temp files (local and mc)  - local procs=${leftovers.length} files=${own.length} mc(files, tails)=${mcLeft}`);
fs.rmSync(scratch, { recursive: true, force: true });
const pass = rows.filter((r) => r.ok).length;
console.log(`\n${pass}/${rows.length} passed`);
process.exit(pass === rows.length ? 0 : 1);
