#!/usr/bin/env node
// Asset Dev on a Thematic-like repo (docs/PROFILES.md, "Thematic-Collections"): what the Assets tree shows and hides (poses, anim_controllers, particles,
// sounds.json, .geo.bbmodel, hidden generated models), Run Game picking the task for the branch's Minecraft version + the version menu, the
// version-branch notice/prefix, "New suit" and the Studio opening from the tree.
// Everything runs on a SYNTHETIC repo (+ bare remote) in a temp dir; the real Thematic-Collections is never opened or touched.
// Drives the app only through the ATELIER_AUTOMATION harness (never the real keyboard/mouse).
// Usage: ATELIER_BIN=src-tauri/target-qa/release/atelier node scripts/qa/assetmode.mjs
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, sleep } from "./lib.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ace-qa-assetmode-"));
const sh = (cwd, cmd) => execSync(cmd, { cwd, encoding: "utf8", shell: "/bin/zsh", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trim();
const bare = path.join(tmp, "remote.git"), seed = path.join(tmp, "seed"), work = path.join(tmp, "work"), other = path.join(tmp, "other");
const C = "src/common/resources", H = "src/packs/heroes/resources";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const w = (root, rel, content) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content); };
const geo = (id) => JSON.stringify({ format_version: "1.12.0", "minecraft:geometry": [{ description: { identifier: `geometry.${id}`, texture_width: 64, texture_height: 64 }, bones: [{ name: "root", cubes: [{ origin: [-4, 0, -4], size: [8, 8, 8], uv: [0, 0] }] }] }] }, null, 2) + "\n";
const anim = (id) => JSON.stringify({ format_version: "1.8.0", animations: { [id]: { loop: true, animation_length: 1, bones: {} } } }, null, 2) + "\n";
const bb = JSON.stringify({ meta: { format_version: "4.10", model_format: "free", box_uv: false }, name: "gun", resolution: { width: 16, height: 16 }, elements: [], outliner: [], textures: [] });

// The proposed Thematic config (assets section as in the proposal for Thematic-Collections/.ace/config.json), without "profile".
const pins = [["1.20.1", "fabric", "1.20.1 Fabric"], ["1.20.1", "forge", "1.20.1 Forge"], ["1.21.1", "fabric", "1.21.1 Fabric"], ["1.21.1", "neoforge", "1.21.1 NeoForge"], ["26.3", "fabric", "26.3 Fabric (parked)"]];
const CONFIG = {
  version: 1,
  gradle: { pinned: pins.map(([v, l, name]) => ({ task: `:${v}:${l}RunClient`, name })) },
  assets: {
    suitRoot: `${H}/assets/thematic`,
    hide: ["**/assets/*/models/block/**", "**/assets/*/models/item/**", "cleaned_sounds/**", "testpacks/**", "docs/**"],
    baseBranch: { branch: "^(v\\d+(?:\\.\\d+)+)(?:-.+)?$", base: "origin/$1" },
    branchPrefix: "{base}-{user}-",
  },
};

sh(tmp, `git init -q --bare -b main ${bare}`);
sh(tmp, `git clone -q ${bare} seed`);
sh(seed, `git config user.name Seed && git config user.email seed@x && git checkout -q -b main`);
w(seed, "README.md", "thematic-like\n");
sh(seed, `git add -A && git commit -qm "initial main" && git push -q origin main`);
sh(seed, `git checkout -q -b v1.20.1`);
const A = `${C}/assets/thematic`, HA = `${H}/assets/thematic`;
w(seed, `${A}/geo/entity/batmobile.geo.json`, geo("batmobile"));
w(seed, `${A}/geo/entity/batmobile.geo.bbmodel`, bb);
w(seed, `${A}/geo/item/grapplegun.geo.json`, geo("grapplegun"));
w(seed, `${A}/animations/armor/bat_slam.animation.json`, anim("bat_slam"));
w(seed, `${A}/textures/gui/hud.png`, PNG);
w(seed, `${A}/models/block/acacia_bench_left.json`, "{}\n");
w(seed, `${A}/models/item/grapplegun.json`, "{}\n");
w(seed, `${A}/models/animations/superhero_landing.pose`, "; thematic:superhero_landing\n{down} = curve {data}\n");
w(seed, `${A}/particles/smoke_particle.json`, '{"textures":["thematic:smoke"]}\n');
w(seed, `${A}/sounds.json`, "{}\n");
w(seed, `${A}/sounds/gun/shot.ogg`, "OggS");
w(seed, `${A}/lang/en_us.json`, "{}\n");
w(seed, `${A}/blockstates/chair.json`, "{}\n");
w(seed, `${C}/data/thematic/anim_controllers/armor.js`, "// controllers\n");
w(seed, `${C}/data/thematic/recipe/x.json`, "{}\n");
w(seed, `${HA}/geo/armor/robin.geo.json`, geo("robin"));
w(seed, `${HA}/animations/armor/robin.animation.json`, anim("robin"));
w(seed, `${HA}/textures/armor/robin.png`, PNG);
w(seed, `${HA}/textures/armor/robin_shiny.png`, PNG);
w(seed, `${HA}/poses/web.json`, "{}\n");
w(seed, `${H}/data/thematic/anim_controllers/myers.js`, "// myers\n");
w(seed, `${H}/data/thematic/armors/batfamily/robin.json`, "{}\n");
w(seed, "guns/black widow gun.bbmodel", bb);
w(seed, "cleaned_sounds/marvel/boom.wav", "RIFF");
w(seed, "src/main/java/Foo.java", "class Foo {}\n");
w(seed, ".ace/config.json", JSON.stringify(CONFIG, null, 2) + "\n");
sh(seed, `git add -A && git commit -qm "thematic-like tree" && git push -q -u origin v1.20.1`);
sh(tmp, `git clone -q -b v1.20.1 ${bare} work && git clone -q -b v1.20.1 ${bare} other`);
sh(work, `git config user.name "Alex QA" && git config user.email alex@qa.test`);
sh(other, `git config user.name Sam && git config user.email sam@qa.test`);
const g = (cmd, cwd = work) => sh(cwd, "git " + cmd);

const rows = [];
async function check(name, fn) {
  let ok = false, note = "";
  try { const r = await fn(); ok = r === true || (r && r.ok); note = r && r.note ? r.note : ""; } catch (e) { note = String(e.message || e).split("\n")[0].slice(0, 260); }
  rows.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? "  - " + note : ""}`);
}
const dataDir = fs.mkdtempSync(path.join(tmp, "data-"));
const app = await launch(work, { dataDir });
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
const treeRows = (kind) => app.ev(`return [...document.querySelectorAll('[data-testid=asset-tree] [data-row=${kind}]')].map((r) => ({ name: r.dataset.name, path: r.dataset.path, hint: r.querySelector('.tree-hint')?.textContent }))`);
const gitSt = () => Q(`await P.refresh(); return P.git();`);
const dblclick = (sel, text) => app.ev(`const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find((e) => ${text ? `e.dataset.path?.endsWith(${JSON.stringify(text)})` : "true"}); if (!e) throw new Error("no row " + ${JSON.stringify(text ?? sel)}); e.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); return 1;`);

try {
  await app.ev(`await __qa.waitFor(() => document.querySelector('.statusbar'), 15000); return 1`);
  await until(`return P.state().ready`, 15000, "profiles ready");
  await check("the repo does not suggest a profile; Asset Dev is this user's own choice", async () => {
    const s0 = await Q(`return P.state()`);
    await Q(`await P.set("asset"); return 1`);
    await until(`return P.get() === "asset"`);
    return { ok: s0.suggested === null && s0.profile === "developer", note: JSON.stringify(s0) };
  });

  // ---- the tree ----
  await check("Assets tree: Thematic kinds grouped, generated block/item models + raw sounds + code hidden", async () => {
    await until(`return document.querySelector('[data-testid=asset-tree] [data-row=group]')`, 20000, "asset groups");
    await sleep(500);
    const groups = await treeRows("group");
    const label = groups.map((x) => `${x.name}:${x.hint}`).join(" ");
    return { ok: label === "Armor:5 Items:1 Entities:2 Sounds:2 Language:1 Poses:2 Particles:1 Animation controllers:2 Other:2", note: label };
  });
  await check("Assets tree: anim_controllers (data/), pose sets, particles, sounds.json and .geo.bbmodel are listed", async () => {
    for (const n of ["Animation controllers", "Poses", "Particles", "Sounds", "Entities"]) await click('[data-testid=asset-tree] [data-row=group]', n);
    await click('[data-testid=asset-tree] [data-row=section]', "Models");
    await until(`return document.querySelectorAll('[data-testid=asset-tree] [data-row=file]').length >= 8`);
    const files = (await treeRows("file")).map((f) => f.path);
    const want = [`${C}/data/thematic/anim_controllers/armor.js`, `${H}/data/thematic/anim_controllers/myers.js`, `${A}/models/animations/superhero_landing.pose`, `${HA}/poses/web.json`,
      `${A}/particles/smoke_particle.json`, `${A}/sounds.json`, `${A}/sounds/gun/shot.ogg`, `${A}/geo/entity/batmobile.geo.bbmodel`];
    const missing = want.filter((p) => !files.includes(p));
    const bad = files.filter((p) => /recipe|armors\/batfamily|Foo\.java|blockstates|models\/(block|item)\/|cleaned_sounds/.test(p));
    const names = (await treeRows("file")).filter((f) => f.path.endsWith("batmobile.geo.bbmodel")).map((f) => f.name);
    return { ok: !missing.length && !bad.length && names[0] === "batmobile", note: `missing=${missing} unwanted=${bad} bbname=${names}` };
  });
  await check("Hidden files are not listed, but their changes still count as unsaved assets", async () => {
    await setInput('[data-testid=asset-search]', "acacia");
    await sleep(300);
    const hit = (await treeRows("file")).length;
    await setInput('[data-testid=asset-search]', "");
    fs.appendFileSync(path.join(work, `${A}/models/block/acacia_bench_left.json`), " \n");
    await gitSt();
    const chip = await until(`const t = document.querySelector('[data-testid=asset-chip]')?.innerText ?? ""; return /1 unsaved asset/.test(t) ? t : null`, 10000, "chip");
    g(`checkout -q -- .`);
    await gitSt();
    return { ok: hit === 0, note: `search hits=${hit} chip=${JSON.stringify(chip)}` };
  });

  // ---- Run Game ----
  await check("Run Game: on v1.20.1 picks 1.20.1 Fabric; the menu lists the pinned client tasks (parked last)", async () => {
    const d = await Q(`return await P.discoverRun()`);
    return { ok: d.task === ":1.20.1:fabricRunClient" && d.source === "branch" && d.options.map((o) => o.name).join("|") === "1.20.1 Fabric|1.20.1 Forge|1.21.1 Fabric|1.21.1 NeoForge|26.3 Fabric (parked)", note: JSON.stringify({ task: d.task, source: d.source }) };
  });
  await check("Run Game menu: ▾ lists the versions with the one in use ticked; picking Forge sticks", async () => {
    await click('.asset-bar .ab-caret');
    await until(`return document.querySelector('.menu .menu-item')`);
    const items = await app.ev(`return [...document.querySelectorAll('.menu .menu-item')].map((e) => e.textContent.trim())`);
    await click('.menu .menu-item', "1.20.1 Forge");
    await sleep(300);
    const d = await Q(`return await P.discoverRun()`);
    const prefs = JSON.parse(fs.readFileSync(path.join(dataDir, "ui-prefs.json"), "utf8"));
    return { ok: items[0].startsWith("✓") && /Automatic: 1\.20\.1 Fabric/.test(items[0]) && items.length === 6 && d.task === ":1.20.1:forgeRunClient" && d.source === "chosen" && !!prefs.assetRun, note: `${items.join(" | ")} -> ${d.task} ${d.source}` };
  });
  await check("The pick belongs to the Minecraft version: a 1.21.1 branch ignores it and goes back to the 1.20.1 pick after", async () => {
    g(`checkout -q -b v1.21.1-alex-qa-test`);
    await gitSt();
    const d1 = await Q(`return await P.discoverRun()`);
    g(`checkout -q v1.20.1`);
    await gitSt();
    const d2 = await Q(`return await P.discoverRun()`);
    return { ok: d1.task === ":1.21.1:fabricRunClient" && d1.source === "branch" && d2.task === ":1.20.1:forgeRunClient" && d2.source === "chosen", note: `${d1.task}/${d1.source} then ${d2.task}/${d2.source}` };
  });
  await check("Run Game menu: Automatic follows the branch again", async () => {
    await click('.asset-bar .ab-caret');
    await until(`return document.querySelector('.menu .menu-item')`);
    const first = await app.ev(`return document.querySelector('.menu .menu-item').textContent.trim()`);
    await click('.menu .menu-item', "Automatic");
    await sleep(300);
    const d = await Q(`return await P.discoverRun()`);
    return { ok: /^Automatic/.test(first) && d.task === ":1.20.1:fabricRunClient" && d.source === "branch", note: `${first} -> ${d.task} ${d.source}` };
  });

  // ---- branches ----
  await check("New branch for my work starts with the version branch: v1.20.1-<you>-", async () => {
    await click('.asset-bar [data-act=branch]');
    await until(`return document.querySelector('[data-testid=branch-list] [data-name="v1.20.1"]')`);
    await click('[data-testid=branch-new]');
    await until(`return document.querySelector('.dialog-input')`);
    const init = await app.ev(`return document.querySelector('.dialog-input').value`);
    await click('.dialog-buttons button', "Cancel");
    return { ok: init === "v1.20.1-alex-qa-", note: init };
  });
  await check("Not-on-latest notice compares with the version branch (not main) for v1.20.1-… branches", async () => {
    g(`checkout -q -b v1.20.1-alex-qa-walk`);
    await gitSt();
    const g0 = g("rev-list --count HEAD..origin/main");
    g(`fetch -q`);
    w(other, `${A}/animations/entity/sam_run.animation.json`, anim("sam_run"));
    sh(other, `git add -A && git commit -qm "Add sam_run animation" && git push -q origin v1.20.1`);
    await Q(`await P.checkNow(); return 1`);
    const b = await until(`const t = P.notices().balloon; return t && /v1\\.20\\.1 version has moved on/.test(t) ? t : null`, 15000, "balloon");
    return { ok: /1 update from Sam/.test(b) && g0 === "0", note: `${b} (main behind=${g0})` };
  });

  // ---- New suit + Studio ----
  await check("New suit: model + animation + texture (+shiny) land beside the shipped suits, texture copied", async () => {
    await app.ev(`const t = document.querySelector('[data-testid=asset-tree] .tree'); t.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 80 })); return 1;`);
    await until(`return [...document.querySelectorAll('.menu .menu-item')].some((e) => /New suit/.test(e.textContent))`);
    await click('.menu .menu-item', "New suit");
    await until(`return document.querySelector('.dialog-input')`);
    await setInput('.dialog-input', "Nova Prime");
    await click('.dialog-buttons button', "Create");
    const f = (n) => path.join(work, `${HA}/${n}`);
    const t0 = Date.now();
    while (!fs.existsSync(f("textures/armor/nova_prime_shiny.png")) && Date.now() - t0 < 10000) await sleep(200);
    const geoJ = JSON.parse(fs.readFileSync(f("geo/armor/nova_prime.geo.json"), "utf8"));
    const animJ = JSON.parse(fs.readFileSync(f("animations/armor/nova_prime.animation.json"), "utf8"));
    const same = fs.readFileSync(f("textures/armor/nova_prime.png")).equals(PNG) && fs.readFileSync(f("textures/armor/nova_prime_shiny.png")).equals(PNG);
    const common = fs.existsSync(path.join(work, `${A}/geo/armor/nova_prime.geo.json`));
    return { ok: geoJ["minecraft:geometry"][0].description.identifier === "geometry.nova_prime" && Object.keys(animJ.animations).join() === "nova_prime" && same && !common, note: `copied=${same} inCommon=${common}` };
  });
  await check("New suit shows up in the tree under Armor and opens in the Studio", async () => {
    await setInput('[data-testid=asset-search]', "nova_prime");
    const files = await until(`const f = [...document.querySelectorAll('[data-testid=asset-tree] [data-row=file]')].map((r) => r.dataset.path); return f.length >= 4 ? f : null`, 10000, "new suit rows");
    const st = await until(`return document.querySelector('[data-testid=studio]') ? document.querySelector('[data-testid=studio]').dataset.kind : null`, 15000, "studio for the new geo");
    await setInput('[data-testid=asset-search]', "");
    return { ok: files.length === 4 && st === "geo", note: `${files.length} rows, studio=${st}` };
  });
  await check("Studio opens animations and Blockbench files from the tree", async () => {
    await setInput('[data-testid=asset-search]', "nova_prime.anim");
    await until(`return document.querySelectorAll('[data-testid=asset-tree] [data-row=file]').length === 1`);
    await dblclick('[data-testid=asset-tree] [data-row=file]', "nova_prime.animation.json");
    const a = await until(`const s = [...document.querySelectorAll('[data-testid=studio]')].map((e) => e.dataset.kind); return s.includes("animation") ? s : null`, 15000, "animation studio");
    await setInput('[data-testid=asset-search]', "black widow");
    await until(`return document.querySelectorAll('[data-testid=asset-tree] [data-row=file]').length === 1`);
    await dblclick('[data-testid=asset-tree] [data-row=file]', "black widow gun.bbmodel");
    const b = await until(`const s = [...document.querySelectorAll('[data-testid=studio]')].map((e) => e.dataset.kind); return s.includes("bbmodel") ? s : null`, 15000, "bbmodel studio");
    const toggle = await app.ev(`return !!document.querySelector('.dual-toggle, [data-testid=dual-toggle]')`);
    await setInput('[data-testid=asset-search]', "");
    return { ok: !toggle, note: `studios=${b} toggle=${toggle}` };
  });
} finally {
  try { await app.stop(); } catch {}
}

const failed = rows.filter((r) => !r.ok);
console.log(`\n${rows.length - failed.length}/${rows.length} passed` + (failed.length ? `; FAILED: ${failed.map((r) => r.name).join(" | ")}` : ""));
if (!process.env.KEEP) fs.rmSync(tmp, { recursive: true, force: true }); else console.log("kept", tmp);
process.exit(failed.length ? 1 : 0);
