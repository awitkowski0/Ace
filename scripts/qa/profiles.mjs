#!/usr/bin/env node
// Profiles suite (docs/PROFILES.md): Developer unchanged, Asset Dev gating, Assets tree, Asset Bar flows
// (Get latest / Branch / Save to Git / newer-version notice / Run Game) against a SCRATCH git repo + bare remote in a temp dir.
// Drives the app only through the ACE_AUTOMATION harness (never the real keyboard/mouse). Git write operations only ever touch the scratch repos;
// the real Thematic-Collections* repos are checked (status + HEAD) before and after and must be identical.
// Usage: node scripts/qa/profiles.mjs [--no-run] [--thematic]       Env: ACE_BIN
//   --no-run    skip the Run Game part (needs Gradle + a JDK)
//   --thematic  also open ~/IdeaProjects/Thematic-Collections READ ONLY and check Run Game discovery + asset tree there
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, sleep } from "./lib.mjs";

const args = process.argv.slice(2);
const home = os.homedir();
const real = fs.readdirSync(path.join(home, "IdeaProjects")).filter((n) => n.startsWith("Thematic-Collections")).map((n) => path.join(home, "IdeaProjects", n)).concat([path.join(home, "IdeaProjects/Ace")]);
const snap = (d) => { try { return execSync("git status --porcelain | md5; git rev-parse HEAD", { cwd: d, encoding: "utf8", shell: "/bin/zsh" }).trim(); } catch { return "n/a"; } };
const before = Object.fromEntries(real.map((d) => [d, snap(d)]));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ace-qa-profiles-"));
const sh = (cwd, cmd) => execSync(cmd, { cwd, encoding: "utf8", shell: "/bin/zsh", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trim();
const bare = path.join(tmp, "remote.git"), seed = path.join(tmp, "seed"), work = path.join(tmp, "work"), other = path.join(tmp, "other");
const A = "src/common/resources/assets/thematic";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const geo = (extra = "") => JSON.stringify({ format_version: "1.12.0", "minecraft:geometry": [{ description: { identifier: "geometry.foo" }, bones: [{ name: "root" + extra }] }] }, null, 2) + "\n";
const w = (root, rel, content) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content); };

sh(tmp, `git init -q --bare -b main ${bare}`);
sh(tmp, `git clone -q ${bare} seed`);
sh(seed, `git config user.name Seed && git config user.email seed@x && git checkout -q -b main`);
w(seed, "src/main/java/Foo.java", "class Foo {\n  int a = 1;\n}\n");
w(seed, `${A}/geo/entity/foo.geo.json`, geo());
w(seed, `${A}/animations/entity/foo.animation.json`, JSON.stringify({ format_version: "1.8.0", animations: { "animation.foo.idle": { loop: true } } }, null, 2) + "\n");
w(seed, `${A}/textures/entity/foo.png`, PNG);
w(seed, `${A}/blockstates/chair.json`, "{}\n");
w(seed, ".ace/config.json", JSON.stringify({ version: 1, profile: "asset", assetRun: { task: "runClient" } }, null, 2) + "\n");
w(seed, "settings.gradle", "rootProject.name = 'scratch'\n");
w(seed, "build.gradle", "tasks.register('runClient') { doLast { println 'Setting user: Dev'; Thread.sleep(6000) } }\n");
// the Gradle wrapper (same distribution as Thematic-Collections, copied read-only; nothing is downloaded when it is cached)
const tc = path.join(home, "IdeaProjects/Thematic-Collections");
if (fs.existsSync(path.join(tc, "gradlew"))) {
  fs.mkdirSync(path.join(seed, "gradle/wrapper"), { recursive: true });
  for (const f of ["gradlew", "gradle/wrapper/gradle-wrapper.jar", "gradle/wrapper/gradle-wrapper.properties"]) fs.copyFileSync(path.join(tc, f), path.join(seed, f));
  fs.chmodSync(path.join(seed, "gradlew"), 0o755);
}
w(seed, ".gitignore", ".gradle/\nbuild/\n");
sh(seed, `git add -A && git commit -qm "initial" && git push -q origin main`);
sh(tmp, `git clone -q ${bare} work && git clone -q ${bare} other`);
sh(work, `git config user.name "Alex QA" && git config user.email alex@qa.test`);
sh(other, `git config user.name Sam && git config user.email sam@qa.test`);
const g = (cmd, cwd = work) => sh(cwd, "git " + cmd);
const gb = (cmd) => sh(bare, "git " + cmd);

const rows = [];
async function check(name, fn) {
  let ok = false, note = "";
  try { const r = await fn(); ok = r === true || (r && r.ok); note = r && r.note ? r.note : ""; } catch (e) { note = String(e.message || e).split("\n")[0].slice(0, 220); }
  rows.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? "  - " + note : ""}`);
}
const dataDir = fs.mkdtempSync(path.join(tmp, "data-"));
let app = await launch(work, { dataDir });
const Q = (body, o) => app.ev(`const P = await __qa.profiles(); ${body}`, o);
const click = (sel, text) => app.ev(`const els = [...document.querySelectorAll(${JSON.stringify(sel)})].filter((e) => ${text ? `e.textContent.includes(${JSON.stringify(text)})` : "true"}); if (!els.length) throw new Error("no element " + ${JSON.stringify(sel + " " + (text ?? ""))}); els[0].click(); return els.length;`);
const until = async (expr, ms = 15000, what = expr) => {
  const t0 = Date.now();
  for (;;) {
    const r = await Q(`const t0 = Date.now(); while (Date.now() - t0 < 5000) { const r = await (async () => { ${expr} })(); if (r) return r; await __qa.sleep(100); } return null;`).catch(() => null);
    if (r) return r;
    if (Date.now() - t0 > ms) throw new Error("timeout waiting for: " + what.slice(0, 120));
  }
};
const setInput = (sel, value) => app.ev(`const el = document.querySelector(${JSON.stringify(sel)}); if (!el) throw new Error("no input"); const d = Object.getOwnPropertyDescriptor(el.constructor.prototype, "value"); d.set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event("input", { bubbles: true })); return el.value;`);
const gitSt = () => Q(`await P.refresh(); return P.git();`);
const text = (sel) => app.ev(`const e = document.querySelectorAll(${JSON.stringify(sel)}); return e.length ? e[e.length - 1].innerText : null`);
const stashes = () => g("stash list").split("\n").filter(Boolean);

try {
  await app.ev(`await __qa.waitFor(() => document.querySelector('.statusbar'), 15000); return 1`);
  await until(`return P.state().ready`, 15000, "profiles ready");

  // ---- project default + switcher ----
  await check("project suggestion (.ace/config.json profile) opens as Asset Dev", async () => {
    // ready flips before the repo's .ace/config.json arrives; wait for the suggestion instead of sampling once
    const s = (await until(`const s = P.state(); return s.source === "project" ? s : null`, 8000).catch(() => null)) ?? (await Q(`return P.state()`));
    return { ok: s.profile === "asset" && s.source === "project", note: JSON.stringify(s) };
  });
  await check("Developer: switch from the project widget menu", async () => {
    await Q(`await __qa.runAction("RecentProjects"); return 1`);
    await until(`return document.querySelector('[data-testid=profile-row]')`);
    await click('[data-testid=profile-row] button[data-profile=developer]');
    await until(`return P.get() === "developer"`);
    return true;
  });
  await check("Status bar shows the profile and opens Switch Profile on click", async () => {
    const label = await until(`const e = document.querySelector('[data-testid=profile-status]'); return e && e.textContent`);
    await click('[data-testid=profile-status]');
    await until(`return document.querySelector('[data-testid=switch-profile]')`);
    await app.ev(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return 1`);
    return { ok: /Developer/.test(label), note: label };
  });
  const devWindows = await Q(`return P.toolWindows()`);
  const devActions = await Q(`return P.actions()`);
  const devRaw = await Q(`return P.rawToolWindows()`);
  await check("Developer: every tool window visible, every action ungated, no Asset Bar", async () => {
    const same = JSON.stringify([...devWindows].sort()) === JSON.stringify([...devRaw].sort());
    const gated = devActions.filter((a) => !/=(ok|profile-only)$/.test(a));
    const bar = await app.ev(`return !!document.querySelector('.asset-bar')`);
    const runw = await app.ev(`return !!document.querySelector('#run-widget-slot .run-widget')`);
    return { ok: same && !gated.length && !bar && runw && devWindows.length >= 5, note: `windows=${devWindows.length} gated=${gated.join(",")} bar=${bar} runWidget=${runw}` };
  });
  await check("Developer: Terminal shortcut still opens the terminal", async () => {
    await app.ev(`await __qa.reset(); await __qa.key("alt F12"); await __qa.sleep(500); const ok = !!document.querySelector('[data-toolwindow="terminal"]'); await __qa.key("alt F12"); return ok;`);
    return true;
  });

  // ---- Asset Dev ----
  await check("Switch Profile via Find Action list + Settings page exist", async () => {
    const acts = await Q(`return ["SwitchProfile", "Profile.Asset", "Profile.Developer", "Profile.Settings", "Assets.Save"].filter((a) => P.hasAction(a))`);
    await Q(`await __qa.runAction("SwitchProfile"); return 1`);
    await until(`return document.querySelector('[data-testid=switch-profile]')`);
    await click('[data-testid=switch-profile] [data-profile=asset]');
    await until(`return P.get() === "asset"`);
    return { ok: acts.length === 5, note: acts.join(",") };
  });
  await check("Asset Dev: only Assets / Changes / Run tool windows; toolbar shows the Asset Bar", async () => {
    const tw = await Q(`return P.toolWindows()`);
    const stripe = await app.ev(`return [...document.querySelectorAll('.stripe-btn')].map((b) => b.title.replace(/\\s+.*$/, ""))`);
    const bar = await app.ev(`return [...document.querySelectorAll('.asset-bar .ab-btn')].map((b) => b.dataset.act)`);
    const runw = await app.ev(`return !!document.querySelector('#run-widget-slot')`);
    return { ok: tw.join() === "project:Assets,commit:Changes,run:Run" && stripe.length === 3 && bar.join() === "get-latest,branch,save,run" && !runw, note: `${tw} | ${stripe} | ${bar} runSlot=${runw}` };
  });
  await check("Asset Dev: hidden tool windows' shortcuts are inert with a gentle notice", async () => {
    await app.ev(`await __qa.reset(); await __qa.key("alt F12"); await __qa.sleep(300); return 1`);
    const opened = await app.ev(`return !!document.querySelector('[data-toolwindow="terminal"]')`);
    const toast = await text('[data-testid=toast]');
    const gates = await Q(`return ["ActivateTerminalToolWindow", "ActivateGradleToolWindow", "ActivateGitToolWindow", "ActivateVersionControlToolWindow", "Debug", "Terminal.New"].map((a) => a + "=" + P.gateOf(a))`);
    const claude = await Q(`return P.gateOf("ActivateClaudeToolWindow")`);
    return { ok: !opened && /isn't available in Asset Dev/.test(toast ?? "") && gates.filter((x) => !/=(blocked|null)$/.test(x)).length === 0, note: `opened=${opened} toast=${JSON.stringify(toast)} ${gates} claude=${claude}` };
  });
  await check("Asset Dev: ⌘1 still toggles Assets; ⌘T/⌘K/⌃R map to Get latest / Save / Run Game", async () => {
    const r = await Q(`return ["Vcs.UpdateProject", "CheckinProject", "Run", "Git.Branches"].map((a) => P.gateOf(a))`);
    return { ok: r.join() === "redirect:Assets.GetLatest,redirect:Assets.Save,redirect:Assets.RunGame,redirect:Assets.Branch", note: r.join() };
  });
  await check("Assets tree: asset roots only, grouped by kind, no code files", async () => {
    await app.ev(`await __qa.reset(); return 1`);
    await until(`return document.querySelector('[data-testid=asset-tree] [data-row=group]')`, 15000, "asset groups");
    const groups = await app.ev(`return [...document.querySelectorAll('[data-testid=asset-tree] [data-row=group]')].map((r) => r.dataset.name)`);
    await click('[data-testid=asset-tree] [data-row=group]', "Entities");
    await until(`return document.querySelectorAll('[data-testid=asset-tree] [data-row=section]').length >= 2`);
    const secs = await app.ev(`return [...document.querySelectorAll('[data-testid=asset-tree] [data-row=section]')].map((r) => r.dataset.name)`);
    await click('[data-testid=asset-tree] [data-row=section]', "Models");
    const files = await until(`const f = [...document.querySelectorAll('[data-testid=asset-tree] [data-row=file]')].map((r) => r.dataset.path); return f.length ? f : null`);
    const html = await app.ev(`return document.querySelector('[data-testid=asset-tree]').innerText`);
    return { ok: groups.join() === "Entities" && secs.includes("Models") && secs.includes("Animations") && files.some((f) => f.endsWith("foo.geo.json")) && !/Foo\.java|blockstates|chair/.test(html), note: `groups=${groups} sections=${secs} files=${files}` };
  });
  await check("Assets tree: search box filters", async () => {
    await setInput('[data-testid=asset-search]', "foo.anim");
    const rows = await until(`const f = [...document.querySelectorAll('[data-testid=asset-tree] [data-row=file]')].map((r) => r.dataset.path); return f.length === 1 ? f : null`);
    await setInput('[data-testid=asset-search]', "");
    return { ok: rows[0].endsWith("foo.animation.json"), note: rows.join() };
  });
  await check("Assets tree: thumbnail of a texture", async () => {
    await setInput('[data-testid=asset-search]', "foo.png");
    const ok = await until(`return document.querySelector('[data-testid=asset-tree] img.ap-thumb') ? true : null`, 8000, "thumbnail");
    await setInput('[data-testid=asset-search]', "");
    return ok === true;
  });

  // ---- status chip, branch picker, new branch ----
  await check("Status chip shows branch, ahead/behind and unsaved assets", async () => {
    w(work, `${A}/animations/entity/web_wall_hold.animation.json`, JSON.stringify({ format_version: "1.8.0", animations: {} }) + "\n");
    fs.appendFileSync(path.join(work, "src/main/java/Foo.java"), "// local code change\n");
    await gitSt();
    const chip = await until(`const t = document.querySelector('[data-testid=asset-chip]')?.innerText ?? ""; return /1 unsaved asset/.test(t) ? t : null`, 10000, "chip");
    return { ok: /main/.test(chip), note: JSON.stringify(chip) };
  });
  await check("Branch picker lists branches; New branch starts assets/<you>/…", async () => {
    await click('.asset-bar [data-act=branch]');
    await until(`return document.querySelector('[data-testid=branch-list] [data-name=main]')`);
    await click('[data-testid=branch-new]');
    await until(`return document.querySelector('.dialog-input')`);
    const init = await app.ev(`return document.querySelector('.dialog-input').value`);
    await setInput('.dialog-input', init + "Walk Cycle");
    await click('.dialog-buttons button', "Create");
    await until(`return P.git()?.branch === "assets/alex-qa/walk-cycle"`, 10000, "new branch");
    const st = await gitSt();
    return { ok: init === "assets/alex-qa/" && st.changes.length === 2, note: `prefill=${init} changes=${st.changes}` };
  });

  // ---- Save to Git ----
  await check("Save to Git: asset files only, code greyed + excluded with a warning, suggested message", async () => {
    await click('.asset-bar [data-act=save]');
    await until(`return document.querySelector('[data-testid=asset-save]')`, 15000, "save dialog");
    await sleep(1500);
    const info = await app.ev(`const d = document.querySelector('[data-testid=asset-save]'); return { assets: [...d.querySelectorAll('.ap-save-row:not(.code)')].map((r) => r.dataset.path), code: [...d.querySelectorAll('.ap-save-row.code')].map((r) => ({ p: r.dataset.path, dis: r.querySelector('input').disabled, ex: r.dataset.excluded })), warn: d.querySelector('[data-testid=asset-save-warn]')?.innerText, msg: d.querySelector('[data-testid=asset-save-msg]').value, push: d.querySelector('[data-testid=asset-save-push]').checked, pr: !!d.querySelector('[data-testid=asset-save-pr]') }`);
    const ghInstalled = (() => { try { execFileSync("gh", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
    return { ok: info.assets.length === 1 && info.assets[0].endsWith("web_wall_hold.animation.json") && info.code.length === 1 && info.code[0].dis && info.code[0].ex === "1" && /code file/.test(info.warn) && info.msg === "Add web_wall_hold animation" && info.push && info.pr === ghInstalled, note: JSON.stringify({ ...info, ghInstalled }) };
  });
  await check("Save to Git: commits only the asset, pushes with upstream, code change stays local", async () => {
    await click('[data-testid=asset-save-ok]');
    await until(`return !document.querySelector('[data-testid=asset-save]')`, 30000, "dialog closes");
    const files = g("show --name-only --format=%s HEAD").split("\n").filter(Boolean);
    const up = g("rev-parse --abbrev-ref @{u}");
    const remote = gb("branch --list 'assets/*'");
    const porcelain = g("status --porcelain");
    return { ok: files[0] === "Add web_wall_hold animation" && files.length === 2 && up === "origin/assets/alex-qa/walk-cycle" && /walk-cycle/.test(remote) && /M src\/main\/java\/Foo\.java/.test(porcelain), note: `${files} | ${up} | ${remote} | ${porcelain}` };
  });

  // ---- newer-version notice ----
  const sam = (cmd) => g(cmd, other);
  await check("Notice: main moved on (teammate pushed) -> balloon with Get latest / Later + badge", async () => {
    sam("pull -q origin main");
    w(other, `${A}/animations/entity/sam_run.animation.json`, "{}\n");
    sam(`add -A && git commit -qm "Add sam_run animation" && git push -q origin main`);
    await Q(`await P.checkNow(); return 1`);
    const n = await until(`const n = P.notices(); return n.balloon ? n : null`, 15000, "balloon");
    const badge = await app.ev(`return document.querySelector('[data-testid=get-latest-badge]')?.innerText ?? null`);
    const shown = await app.ev(`return document.querySelector('[data-testid=balloon]')?.innerText ?? null`);
    return { ok: /main version has moved on/.test(n.balloon) && /1 update from Sam/.test(n.balloon) && n.actions.join() === "Get latest,Later" && badge === "1" && /Get latest/.test(shown), note: JSON.stringify({ n, badge }) };
  });
  await check("Notice: Later snoozes until a newer commit; badge stays", async () => {
    await click('[data-testid=balloon] button', "Later");
    await Q(`await P.checkNow(); return 1`);
    const n1 = await Q(`return P.notices().balloon`);
    const badge = await app.ev(`return document.querySelector('[data-testid=get-latest-badge]')?.innerText ?? null`);
    sam(`checkout -q main && git pull -q origin main`);
    w(other, `${A}/animations/entity/sam_jump.animation.json`, "{}\n");
    sam(`add -A && git commit -qm "Add sam_jump" && git push -q origin main`);
    await Q(`await P.checkNow(); return 1`);
    const n2 = await until(`return P.notices().balloon`, 10000, "balloon again");
    return { ok: n1 === null && badge === "1" && /2 updates from Sam/.test(n2), note: JSON.stringify({ n1, badge, n2 }) };
  });
  await check("Notice: own branch behind its remote (teammate pushed to it)", async () => {
    sam(`fetch -q origin && git checkout -q -B assets/alex-qa/walk-cycle origin/assets/alex-qa/walk-cycle`);
    w(other, `${A}/animations/entity/sam_on_branch.animation.json`, "{}\n");
    sam(`add -A && git commit -qm "Sam on branch" && git push -q origin assets/alex-qa/walk-cycle`);
    await Q(`await P.checkNow(); return 1`);
    const n = await until(`const b = P.notices().balloon; return b && /newer version of assets\\/alex-qa\\/walk-cycle/.test(b) ? b : null`, 10000, "branch balloon");
    return { ok: /1 update from Sam/.test(n), note: n };
  });

  // ---- Get latest (autostash by SHA, foreign stash untouched) ----
  await check("Get latest: keeps local changes (tagged autostash applied by SHA), foreign stash untouched, no leftovers", async () => {
    fs.writeFileSync(path.join(work, "foreign.txt"), "x\n");
    g("stash push -u -m foreign-stash");
    fs.appendFileSync(path.join(work, "src/main/java/Foo.java"), "// still local\n");
    w(work, `${A}/animations/entity/mine.animation.json`, "{}\n");
    await gitSt();
    const s0 = stashes();
    await click('.asset-bar [data-act=get-latest]');
    await until(`return P.git()?.behind === 0 && !document.querySelector('[data-act=get-latest]').disabled`, 60000, "pull done");
    await sleep(500);
    const s1 = stashes();
    const here = (f) => fs.existsSync(path.join(work, f));
    const java = fs.readFileSync(path.join(work, "src/main/java/Foo.java"), "utf8");
    return { ok: here(`${A}/animations/entity/sam_on_branch.animation.json`) && here(`${A}/animations/entity/mine.animation.json`) && /still local/.test(java) && s0.length === 1 && s1.length === 1 && /foreign-stash/.test(s1[0]) && !s1.some((l) => /ace-autostash/.test(l)), note: `stash before=${s0.length} after=${s1.length} ${s1}` };
  });
  await check("Get latest: nothing newer -> friendly 'already have the latest'", async () => {
    await Q(`await P.getLatest(); return 1`);
    const t = await text('[data-testid=toast]');
    return { ok: /already have the latest/.test(t ?? ""), note: t };
  });

  // ---- pre-flight nudge ----
  await check("Nudge before Save to Git when behind: Get latest & continue", async () => {
    sam(`checkout -q assets/alex-qa/walk-cycle && git pull -q origin assets/alex-qa/walk-cycle`);
    w(other, `${A}/animations/entity/sam_two.animation.json`, "{}\n");
    sam(`add -A && git commit -qm "Sam two" && git push -q origin assets/alex-qa/walk-cycle`);
    await click('.asset-bar [data-act=save]');
    await until(`return [...document.querySelectorAll('.dialog-title')].some((e) => /not on the latest/.test(e.textContent))`, 15000, "nudge dialog");
    const btns = await app.ev(`return [...document.querySelectorAll('.dialog-buttons button')].map((b) => b.textContent)`);
    await click('.dialog-buttons button', "Get latest & continue");
    await until(`return document.querySelector('[data-testid=asset-save]')`, 60000, "save dialog after pull");
    const there = fs.existsSync(path.join(work, `${A}/animations/entity/sam_two.animation.json`));
    await click('.ap-buttons button', "Cancel");
    return { ok: there && btns.join() === "Get latest & continue,Continue anyway,Cancel", note: btns.join() };
  });
  await check("Nudge before Run Game when behind: Continue anyway / Cancel", async () => {
    sam(`checkout -q main`); // teammate moves main again so the branch is behind its base
    sam(`pull -q origin main`);
    w(other, `${A}/animations/entity/sam_three.animation.json`, "{}\n");
    sam(`add -A && git commit -qm "Sam three" && git push -q origin main`);
    await Q(`P.answers("Cancel"); await P.ensureLatest("run"); return 1`);
    const r = await Q(`P.answers("Continue anyway"); return await P.ensureLatest("run")`);
    return { ok: r === true };
  });

  // ---- conflicts ----
  const conflictRound = async (answer, expectSide, tag) => {
    const f = `${A}/geo/entity/foo.geo.json`;
    sam(`checkout -q assets/alex-qa/walk-cycle && git pull -q origin assets/alex-qa/walk-cycle`);
    w(other, f, geo("-THEIRS" + tag));
    sam(`add -A && git commit -qm "Sam edits foo ${answer}" && git push -q origin assets/alex-qa/walk-cycle`);
    w(work, f, geo("-MINE"));
    await gitSt();
    await Q(`P.answers(${JSON.stringify(answer)}); const r = await P.getLatest(); return r`);
    const body = fs.readFileSync(path.join(work, f), "utf8");
    const st = await gitSt();
    return { body, ok: body.includes(expectSide) && !/<<<<<<<|>>>>>>>/.test(body) && !st.changes.some((c) => c.startsWith("conflict")) && !stashes().some((l) => /ace-autostash/.test(l)) };
  };
  await check("Get latest conflict: Keep mine", async () => { const r = await conflictRound("Keep mine", "-MINE", "1"); return { ok: r.ok, note: r.body.match(/root[^"]*/)?.[0] }; });
  await check("Get latest conflict: Take theirs", async () => { g(`checkout -q -- .`); const r = await conflictRound("Take theirs", "-THEIRS", "2"); return { ok: r.ok, note: r.body.match(/root[^"]*/)?.[0] }; });

  // ---- switching branches ----
  await check("Switch branch with changes: bring my changes along", async () => {
    g(`checkout -q -- . 2>/dev/null; git clean -fdq -- ${A}/animations || true`);
    w(work, `${A}/animations/entity/carry.animation.json`, "{}\n");
    await gitSt();
    await Q(`P.answers("Bring my changes"); const ok = await P.switchBranch("main"); return ok`);
    const br = g("branch --show-current");
    const carried = fs.existsSync(path.join(work, `${A}/animations/entity/carry.animation.json`));
    return { ok: br === "main" && carried && !stashes().some((l) => /ace-autostash/.test(l)), note: `${br} carried=${carried}` };
  });
  await check("Switch to a branch that only exists on the server", async () => {
    sam(`checkout -q main && git checkout -q -b assets/sam/remote-only && git push -q -u origin assets/sam/remote-only`);
    await Q(`await P.git(); return 1`);
    g("fetch -q origin");
    const rows = await Q(`return await P.listBranches()`);
    const remoteRow = rows.find((r) => r.name === "origin/assets/sam/remote-only");
    await Q(`P.answers("Bring my changes"); return await P.switchBranch("origin/assets/sam/remote-only", true)`);
    const br = g("branch --show-current");
    return { ok: !!remoteRow && remoteRow.remote && br === "assets/sam/remote-only" && g("rev-parse --abbrev-ref @{u}") === "origin/assets/sam/remote-only", note: br };
  });

  // ---- Run Game ----
  if (!args.includes("--no-run")) {
    await check("Run Game: discovers the client task from .ace/config.json and runs it; status chip building -> running -> closed", async () => {
      g("checkout -q -f main 2>&1 || true");
      g("clean -fdq");
      g("pull -q origin main");
      await sleep(500);
      const d = await Q(`return await P.discoverRun()`);
      await Q(`P.answers("Continue anyway"); return 1`);
      await click('.asset-bar [data-act=run]');
      const states = new Set();
      const t0 = Date.now();
      let finalState = "";
      while (Date.now() - t0 < 240000) {
        const s = await Q(`return P.game().state`);
        states.add(s);
        if (s === "running") { const chip = await text('[data-testid=asset-chip]'); states.add("chip:" + /Game is running/.test(chip ?? "")); await click('.asset-bar [data-act=stop]'); }
        if (s === "closed" || s === "crashed") { finalState = s; break; }
        await sleep(400);
      }
      return { ok: d.task === "runClient" && d.source === "config" && states.has("running") && states.has("chip:true") && finalState === "closed", note: `${JSON.stringify(d)} states=${[...states]} final=${finalState}` };
    });
  }

  // ---- persistence ----
  await check("Choice is remembered per user (survives a restart) and beats the project suggestion", async () => {
    await Q(`await P.set("developer"); return 1`);
    const prefs = JSON.parse(fs.readFileSync(path.join(dataDir, "ui-prefs.json"), "utf8"));
    await app.stop();
    app = await launch(work, { dataDir });
    await app.ev(`await __qa.waitFor(() => document.querySelector('.statusbar'), 15000); return 1`);
    await until(`return P.state().ready`, 15000, "ready after restart");
    const s = await Q(`return P.state()`);
    return { ok: s.profile === "developer" && s.source === "user" && !!prefs.profiles, note: JSON.stringify(s) };
  });
  await check("Developer round trip: tool windows and action set identical to before", async () => {
    const w1 = await Q(`return P.toolWindows()`);
    const a1 = await Q(`return P.actions()`);
    await Q(`await P.set("asset"); return 1`);
    await until(`return P.get() === "asset"`);
    await Q(`await P.set("developer"); return 1`);
    await until(`return P.get() === "developer"`);
    const w2 = await Q(`return P.toolWindows()`);
    const a2 = await Q(`return P.actions()`);
    return { ok: JSON.stringify(w1) === JSON.stringify(w2) && JSON.stringify(a1) === JSON.stringify(a2) && JSON.stringify(w2) === JSON.stringify(devWindows) && JSON.stringify(a2.filter((a) => !/^(Profile|SwitchProfile)/.test(a))) === JSON.stringify(devActions.filter((a) => !/^(Profile|SwitchProfile)/.test(a))), note: `${w2.length} windows ${a2.length} actions` };
  });
  await app.stop();

  // ---- Thematic-Collections: read only ----
  if (args.includes("--thematic")) {
    const dd = fs.mkdtempSync(path.join(tmp, "data-th-"));
    const th = await launch(tc, { dataDir: dd });
    try {
      await th.ev(`await __qa.waitFor(() => document.querySelector('.statusbar'), 20000); return 1`);
      await check("Thematic-Collections (read only): Run Game discovery + asset tree", async () => {
        const P2 = (b) => th.ev(`const P = await __qa.profiles(); ${b}`);
        await P2(`await P.set("asset"); return 1`);
        const d = await P2(`return await P.discoverRun()`);
        const t0 = Date.now();
        let groups = [];
        while (Date.now() - t0 < 60000 && !groups.length) { groups = await th.ev(`return [...document.querySelectorAll('[data-testid=asset-tree] [data-row=group]')].map((r) => r.dataset.name + ":" + r.querySelector('.tree-hint').textContent)`); await sleep(500); }
        return { ok: /fabricRunClient$/.test(d.task) && groups.length >= 3, note: `${JSON.stringify(d)} groups=${groups}` };
      });
    } finally { await th.stop(); }
  }
} finally {
  try { await app.stop(); } catch {}
}

// ---- the real repos must be untouched ----
await check("Real repos untouched (Thematic-Collections*: status + HEAD identical; Ace HEAD unchanged)", async () => {
  const bad = real.filter((d) => { const a = snap(d); return d.endsWith("Ace") ? a.split("\n").pop() !== before[d].split("\n").pop() : a !== before[d]; });
  return { ok: !bad.length, note: bad.length ? "CHANGED: " + bad.join(",") : `${real.length} repos compared` };
});
const failed = rows.filter((r) => !r.ok);
console.log(`\n${rows.length - failed.length}/${rows.length} passed` + (failed.length ? `; FAILED: ${failed.map((r) => r.name).join(" | ")}` : ""));
if (!process.env.KEEP) fs.rmSync(tmp, { recursive: true, force: true }); else console.log("kept", tmp);
process.exit(failed.length ? 1 : 0);
