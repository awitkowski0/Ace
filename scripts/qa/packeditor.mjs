#!/usr/bin/env node
// Pack editor QA (docs/PACKEDITOR.md): suit, ability (renders + Ultron-style console + wheel), HUD, flight profile and guide
// designers over a synthetic Thematic-shaped pack in the session scratchpad. Every edit is checked in the file's live text
// (the Monaco model), plus undo, and that a code-side change shows up in the designer. Synthetic events only.
// Usage: ACE_BIN=src-tauri/target-qa/release/ace node scripts/qa/packeditor.mjs
import fs from "node:fs";
import path from "node:path";
import { launch, sleep } from "./lib.mjs";

const base = process.env.QA_SCRATCH || "/private/tmp/claude-501/-Users-alexw/35ea4777-b70f-4143-9644-0b77d2838b7c/scratchpad/packeditor-qa";
fs.rmSync(base, { recursive: true, force: true });
const proj = path.join(base, "proj");
const res = path.join(proj, "src/common/resources");
const w = (rel, c) => { const f = path.join(res, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, c); return f; };
const geo = { format_version: "1.12.0", "minecraft:geometry": [{ description: { identifier: "geometry.test_suit", texture_width: 64, texture_height: 64 }, bones: [
  { name: "armorHead", pivot: [0, 24, 0], cubes: [{ origin: [-4, 24, -4], size: [8, 8, 8], uv: [0, 0] }] },
  { name: "armorBody", pivot: [0, 24, 0], cubes: [{ origin: [-4, 12, -2], size: [8, 12, 4], uv: [16, 16] }] },
  { name: "armorRightArm", pivot: [-5, 22, 0], cubes: [{ origin: [-8, 12, -2], size: [4, 12, 4], uv: [40, 16] }] },
  { name: "armorLeftArm", pivot: [5, 22, 0], cubes: [{ origin: [4, 12, -2], size: [4, 12, 4], uv: [32, 48] }] },
  { name: "armorRightLeg", pivot: [-1.9, 12, 0], cubes: [{ origin: [-3.9, 0, -2], size: [4, 12, 4], uv: [0, 16] }] },
  { name: "armorLeftLeg", pivot: [1.9, 12, 0], cubes: [{ origin: [-0.1, 0, -2], size: [4, 12, 4], uv: [16, 48] }] },
] }] };
w("assets/thematic/geo/armor/test_suit.geo.json", JSON.stringify(geo, null, 2) + "\n");
const SUIT = w("data/thematic/armors/heroes/test_suit.json", `{
  "tier": 8,
  "abilities": [
    {
      "identifier": "hand_beam",
      "keybind": "key.thematic.ability_0",
      "assets": { "beam": { "endColor": "#32C932" } }
    },
    {
      "identifier": "flight",
      "keybind": "key.thematic.passive"
    }
  ],
  "flight_profile": "thematic:repulsor"
}
`);
w("data/thematic/abilities/shared/hand_beam.js", `// Hand Beam
component(component => {
    component.visual("thematic:aim_arm", { emptyHand: true });
    component.visual("thematic:beam", { style: "model", from: "right_hand", when: "held" });
    component.hold(hold => hold.then("firing"));
});
`);
w("data/thematic/flight_profiles/repulsor.json", `{
  "parent": "thematic:jetpack",
  "effects": {
    "jets": [
      { "anchor": "rightFoot", "when": "always", "flame": { "core": "#64E9FF", "outer": "#64E9FF", "length": 0.85, "width": 0.1 } },
      { "anchor": "leftFoot", "when": "always", "flame": { "core": "#64E9FF", "outer": "#64E9FF", "length": 0.85, "width": 0.1 } }
    ]
  }
}
`);
w("data/thematic/flight_profiles/jetpack.json", `{ "poses": { "style": "propelled", "armBack": 20 }, "effects": { "jets": [] } }\n`);
const PALMS = w("data/thematic/flight_profiles/palms.json", `{
  "parent": "thematic:jetpack",
  "effects": {
    "jets": [
      { "anchor": "rightPalm", "aim": "palm", "when": "always", "flame": { "core": "#FFFFFF", "outer": "#64E9FF", "length": 0.9, "width": 0.12 } },
      { "anchor": "leftPalm", "aim": "palm", "when": "always", "flame": { "core": "#FFFFFF", "outer": "#64E9FF", "length": 0.9, "width": 0.12 } }
    ]
  }
}
`);
const CHILD = w("data/thematic/flight_profiles/child.json", `{ "parent": "thematic:repulsor" }\n`);
const HUD = w("data/thematic/huds/gun_default.js", `// The ammo counter
hud(hud => {
    hud.text("{ammo} / {capacity}", {
        anchor: "BOTTOM_RIGHT",
        x: -12,
        y: -22,
        scale: 1.5,
    });
    hud.bar("reloadProgress", { anchor: "BOTTOM_CENTER", x: 0, y: -46, width: 62, height: 3, when: "reloading" });
});
`);
const HIVE = w("data/thematic/abilities/ultron/hive_control.js", `// Hive Control
const GROUP = "hive";
component(component => {
    component.press(press => press.then("ready"));
    component.console({ group: GROUP, defaultMode: "overlay" }, con => {
        con.theme({ background: "#0B0D12", accent: "#D91F3A", opacity: 0.86 });
        con.page("command", { label: "thematic.ultron.console.page.command", icon: "minecraft:iron_block" }, page => {
            page.window("command_window", { title: "thematic.ultron.console.page.command", x: 0.04, y: 0.08, w: 0.30, h: 0.62 }, win => {
                win.button("deploy", { label: "thematic.ultron.deploy", hotkey: "1" }, a => {
                    a.sound("thematic:ultron.legion_cutin", { volume: 0.8, world: true });
                });
            });
        });
        con.window("map_window", { title: "thematic.ultron.console.map", x: 0.36, y: 0.55, w: 0.33, h: 0.43, minimized: false }, win => {
            win.map("tactical", { label: "thematic.ultron.console.map", radius: 64 });
        });
    });
    component.wheel({ color: "#8A0F14", accent: "#FF3B30" }, wheel => {
        wheel.entry("ultron_deploy", { icon: "minecraft:iron_block", label: "thematic.ultron.deploy" }, pick => {});
    });
});
`);
w("assets/thematic/lang/en_us.json", `{ "thematic.ultron.console.page.command": "Command", "thematic.ultron.deploy": "Deploy", "thematic.ultron.console.map": "Tactical map" }\n`);
const GUIDE = w("assets/thematic/guide/thematic/en_us/entries/suits/test_suit.json", `{
  "name": "Test Suit",
  "category": "thematic:suit",
  "pages": [
    { "type": "text", "title": "Intro", "text": "**Tier** 8\\n- a [link](thematic:x)" },
    { "type": "suit_stats", "title": "Stats", "suit": "thematic:test_suit" }
  ]
}
`);
const before = Object.fromEntries([SUIT, HUD, HIVE, GUIDE, PALMS, CHILD].map((f) => [f, fs.readFileSync(f, "utf8")]));

const app = await launch(proj);
const rows = [];
const E = (body, o) => app.ev(body, o);
const text = () => E(`return __qa.editor()?.getModel()?.getValue() ?? null`);
const open = async (f) => { await E(`await __qa.openFile(${JSON.stringify(f)}); return 1`); await E(`await __qa.waitFor(() => document.querySelector('[data-testid=pack-editor] [data-testid=pe-tree]'), 15000); await __qa.sleep(400); return 1`); };
const node = (label) => E(`const n = [...document.querySelectorAll('[data-testid=pack-editor] .pe-tn')].find((n) => n.querySelector('.pe-tn-l').textContent === ${JSON.stringify(label)}); if (!n) throw new Error('no node ' + ${JSON.stringify(label)}); n.click(); await __qa.sleep(250); return 1`);
const labels = () => E(`return [...document.querySelectorAll('[data-testid=pack-editor] .pe-tn')].map((n) => n.querySelector('.pe-tn-l').textContent + (n.querySelector('.pe-tn-h') ? ' | ' + n.querySelector('.pe-tn-h').textContent : ''))`);
// set an inspector input: by test id, then blur (commits)
const setInput = (testId, value, sel = "input") => E(`const r = document.querySelector('[data-testid=${testId}]'); if (!r) throw new Error('no ${testId}'); const el = r.querySelector(${JSON.stringify(sel)}); el.focus(); const d = Object.getOwnPropertyDescriptor(el.constructor.prototype, "value"); d.set.call(el, ${JSON.stringify(String(value))}); el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); await __qa.sleep(30); el.blur(); await __qa.sleep(250); return 1`);
const undo = () => E(`const r = document.querySelector('[data-testid=pack-editor]'); r.focus(); r.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, ctrlKey: !navigator.platform.includes('Mac'), bubbles: true })); await __qa.sleep(250); return 1`);
// synthetic drag on an element (listeners live on the element itself)
const drag = (sel, dx, dy) => E(`const el = document.querySelector(${JSON.stringify(sel)}); if (!el) throw new Error('no ' + ${JSON.stringify(sel)}); const r = el.getBoundingClientRect(); const x = r.left + 4, y = r.top + 4;
  const ev = (t, cx, cy) => el.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0, pointerId: 1 }));
  ev('pointerdown', x, y); for (let i = 1; i <= 4; i++) { ev('pointermove', x + ${dx} * i / 4, y + ${dy} * i / 4); await __qa.sleep(20); } ev('pointerup', x + ${dx}, y + ${dy}); await __qa.sleep(300); return 1`);
async function check(name, fn) {
  let ok = false, note = "";
  try { const r = await fn(); ok = r === true || (r && r.ok); note = r && r.note ? r.note : ""; } catch (e) { note = String(e.message || e).split("\n")[0].slice(0, 220); }
  rows.push({ name, ok, note });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? "  - " + note : ""}`);
}

try {
  await sleep(800);
  // ---- suit
  await check("P1 suit: opens in the designer with abilities, where they render from, and the flight jets", async () => {
    await open(SUIT);
    const l = await labels();
    const vp = await E(`return !!document.querySelector('[data-testid=pe-vp3] canvas')`);
    const want = ["test_suit | tier 8", "hand_beam | A0", "beam | right_hand", "Flight | repulsor", "rightFoot | always", "leftFoot | always"];
    return { ok: vp && want.every((x) => l.includes(x)), note: JSON.stringify(l) };
  });
  await check("P2 suit: tier edit writes the file; undo puts it back", async () => {
    await node("test_suit");
    await setInput("pe-tier", 9);
    const t1 = await text();
    await undo();
    const t2 = await text();
    return { ok: t1.includes('"tier": 9,') && t2 === before[SUIT], note: t1.split("\n")[1] + " / " + t2.split("\n")[1] };
  });
  await check("P3 suit: the beam's colour and offset are this suit's own (assets.beam), rest of file untouched", async () => {
    await node("hand_beam");
    await setInput("pe-beam-end", "#FF00AA", "input.hex");
    await E(`const r = document.querySelector('[data-testid=pe-beam-tp]'); const el = r.querySelectorAll('input')[1]; el.focus(); const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value'); d.set.call(el, '-0.3'); el.dispatchEvent(new Event('input', { bubbles: true })); el.blur(); await __qa.sleep(250); return 1`);
    const t = await text();
    const j = JSON.parse(t);
    const beam = j.abilities[0].assets.beam;
    return { ok: beam.endColor === "#FF00AA" && JSON.stringify(beam.thirdPersonTranslation) === "[0,-0.3,0]" && t.split("\n").slice(0, 2).join() === before[SUIT].split("\n").slice(0, 2).join(), note: JSON.stringify(beam) };
  });
  await check("P4 a change in the code pane shows up in the designer at once", async () => {
    await E(`const m = __qa.editor().getModel(); m.pushEditOperations([], [{ range: m.findMatches('"tier": 8', false, false, true, null, false)[0].range, text: '"tier": 7' }], () => null); await __qa.sleep(600); return 1`);
    const l = await labels();
    return { ok: l.includes("test_suit | tier 7"), note: l[0] };
  });

  // ---- ability: renders
  await check("A1 ability: render points; moving one rewrites only its from:", async () => {
    await open(path.join(res, "data/thematic/abilities/shared/hand_beam.js"));
    await node("beam");
    await setInput("pe-from-point", "left_hand", "select");
    const t = await text();
    return { ok: t.includes(`component.visual("thematic:beam", { style: "model", from: "left_hand", when: "held" });`) && t.includes(`component.visual("thematic:aim_arm", { emptyHand: true });`), note: t.split("\n")[3] };
  });
  await check("A2 ability: an offset is written as { point, offset }", async () => {
    await E(`const r = document.querySelector('[data-testid=pe-from-offset]'); const el = r.querySelectorAll('input')[1]; el.focus(); const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value'); d.set.call(el, '0.25'); el.dispatchEvent(new Event('input', { bubbles: true })); el.blur(); await __qa.sleep(250); return 1`);
    const t = await text();
    return { ok: t.includes(`from: { point: "left_hand", offset: [0, 0.25, 0] }`), note: t.split("\n")[3] };
  });

  // ---- ability: console (Ultron)
  await check("C1 console: pages, windows (translated), widgets and wheel in the tree; desktop drawn", async () => {
    await open(HIVE);
    const l = await labels();
    const wins = await E(`return [...document.querySelectorAll('[data-testid=pe-console] .pe-cwin')].map((w) => w.dataset.win)`);
    const want = ["Console", "Theme", "Command", "Command | ", "Deploy | button", "Tactical map | every page", "Wheel"];
    return { ok: ["Theme", "Command", "Wheel"].every((x) => l.some((y) => y.startsWith(x))) && l.some((y) => y.startsWith("Deploy")) && wins.length === 2, note: JSON.stringify({ l, wins, want: want.length }) };
  });
  await check("C2 console: dragging a window moves it (x, y rewritten in place, one undo step)", async () => {
    await E(`document.querySelector('[data-testid=pe-console]').style.width = '800px'; await __qa.sleep(200); return 1`);
    await drag(`[data-testid=pe-console] .pe-cwin[data-win=map_window] .pe-cwin-t`, 80, -45);
    const t = await text();
    const m = /con\.window\("map_window", \{ title: "thematic\.ultron\.console\.map", x: ([\d.]+), y: ([\d.]+), w: 0\.33, h: 0\.43, minimized: false \}/.exec(t);
    await undo();
    const back = await text();
    return { ok: !!m && Number(m[1]) > 0.36 && Number(m[2]) < 0.55 && back === before[HIVE], note: m ? `x=${m[1]} y=${m[2]}` : t.split("\n").find((x) => x.includes("map_window")) };
  });
  await check("C3 console: theme colour edit adds/replaces the token in con.theme", async () => {
    await node("Theme");
    await setInput("pe-theme-text", "#FFFFFF", "input.hex");
    const t = await text();
    return { ok: t.includes(`con.theme({ background: "#0B0D12", accent: "#D91F3A", opacity: 0.86, text: "#FFFFFF" });`), note: t.split("\n").find((x) => x.includes("con.theme")) };
  });

  // ---- HUD
  await check("H1 hud: elements laid out; dragging one rewrites its x/y against its anchor", async () => {
    await open(HUD);
    await E(`document.querySelector('[data-testid=pe-hud]').style.width = '960px'; await __qa.sleep(300); return 1`);
    const n = await E(`return document.querySelectorAll('[data-testid=pe-hud] .pe-hud-el').length`);
    await drag(`[data-testid=pe-hud] .pe-hud-el[data-el="0"]`, -40, -20);
    const t = await text();
    const x = Number(/x: (-?\d+),\n\s+y: -?\d+,\n\s+scale/.exec(t)?.[1]);
    const y = Number(/y: (-?\d+),\n\s+scale/.exec(t)?.[1]);
    return { ok: n === 2 && x < -12 && y < -22 && t.includes(`anchor: "BOTTOM_RIGHT",`), note: `n=${n} x=${x} y=${y}` };
  });
  await check("H2 hud: + Text adds a line in the file's own form; inspector edits it", async () => {
    await E(`document.querySelector('[data-testid=pe-add-text]').click(); await __qa.sleep(300); return 1`);
    await setInput("pe-hud-text", "{fireMode}");
    const t = await text();
    return { ok: /hud\.text\("\{fireMode\}", \{ anchor: "BOTTOM_RIGHT", x: -12, y: -12 \}\);/.test(t), note: t.split("\n").filter((x) => x.includes("hud.")).join(" | ") };
  });

  // ---- guide
  await check("G1 guide: pages in the tree, page preview renders the markup", async () => {
    await open(GUIDE);
    const l = await labels();
    const html = await E(`return document.querySelector('[data-testid=pe-guide]').innerHTML`);
    return { ok: l.includes("1. text | Intro") && l.includes("2. suit_stats | Stats") && /<span class="b ">Tier<\/span>/.test(html) && html.includes("•"), note: JSON.stringify(l) };
  });
  await check("G2 guide: retype a page and add one after it", async () => {
    await node("2. suit_stats");
    await setInput("pe-page-type", "suit_abilities", "select");
    await E(`[...document.querySelectorAll('[data-testid=pe-inspector] .pe-btn')].find((b) => b.textContent === '+ Page after').click(); await __qa.sleep(300); return 1`);
    const j = JSON.parse(await text());
    return { ok: j.pages[1].type === "suit_abilities" && j.pages.length === 3 && j.pages[2].type === "text", note: JSON.stringify(j.pages.map((p) => p.type)) };
  });

  // ---- flight designer
  const vecSet = (testId, idx, v) => E(`const r = document.querySelector('[data-testid=${testId}]'); const el = r.querySelectorAll('input')[${idx}]; el.focus(); const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value'); d.set.call(el, ${JSON.stringify(String(v))}); el.dispatchEvent(new Event('input', { bubbles: true })); el.blur(); await __qa.sleep(250); return 1`);
  const click = (testId) => E(`const b = document.querySelector('[data-testid=${testId}]'); if (!b) throw new Error('no ${testId}'); b.click(); await __qa.sleep(250); return 1`);
  await check("F1 flight: jet offset is added on edit, removed on reset; one undo restores the file", async () => {
    await E(`localStorage.setItem('packeditor.previewSuit', 'test_suit'); return 1`);
    await open(PALMS);
    await node("rightPalm");
    await vecSet("pe-jet-offset", 1, -2);
    const t = await text();
    const ok1 = JSON.parse(t).effects.jets[0].offset?.join() === "0,-2,0" && t.includes(`"offset": [0, -2, 0]`) && !JSON.parse(t).effects.jets[1].offset;
    await click("pe-jet-offset-reset");
    const t2 = await text();
    await vecSet("pe-jet-offset", 2, 3);
    await undo();
    const t3 = await text();
    return { ok: ok1 && t2 === before[PALMS] && t3 === before[PALMS], note: t.split("\n").find((x) => x.includes("offset")) };
  });
  await check("F2: jet angle is written as [pitch, yaw, roll] and removed on reset", async () => {
    await vecSet("pe-jet-angle", 0, 25);
    await vecSet("pe-jet-angle", 2, -10);
    const t = await text();
    const a = JSON.parse(t).effects.jets[0].angle;
    await click("pe-jet-angle-reset");
    const t2 = await text();
    return { ok: a?.join() === "25,0,-10" && t2 === before[PALMS], note: JSON.stringify(a) };
  });
  await check("F2b: nozzle glow toggle writes glow 0, and back on restores 0.45", async () => {
    await E(`document.querySelector('[data-testid=pe-glow-toggle] input').click(); await __qa.sleep(250); return 1`);
    const off = JSON.parse(await text()).effects.jets[0].flame.glow;
    const hidden = await E(`return !document.querySelector('[data-testid=pe-glow]')`);
    await E(`document.querySelector('[data-testid=pe-glow-toggle] input').click(); await __qa.sleep(250); return 1`);
    const on = JSON.parse(await text()).effects.jets[0].flame.glow;
    await undo(); await undo();
    return { ok: off === 0 && hidden && on === 0.45 && (await text()) === before[PALMS], note: `off=${off} on=${on}` };
  });
  await check("F3: pose sliders show the inherited value and write / remove only their key", async () => {
    await node("palms");
    const shown = await E(`return document.querySelector('[data-testid=pe-pose-armBack] input.pe-range-n').value + '/' + document.querySelector('[data-testid=pe-pose-armOut] input.pe-range-n').value`);
    await vecSet("pe-pose-armOut", 1, 35);
    const t = await text();
    const j = JSON.parse(t);
    await click("pe-pose-reset-armOut");
    const t2 = await text();
    return { ok: shown === "20/2" && j.poses.armOut === 35 && t2 === before[PALMS], note: shown + " " + JSON.stringify(j.poses) };
  });
  await check("F4: inherited jets are read-only; Override copies the parent's whole list in", async () => {
    await open(CHILD);
    await node("rightFoot");
    const ro = await E(`return !!document.querySelector('[data-testid=pe-jet-inherited]') && !document.querySelector('[data-testid=pe-jet-offset]')`);
    await click("pe-jet-override");
    const j = JSON.parse(await text());
    return { ok: ro && j.parent === "thematic:repulsor" && j.effects.jets.length === 2 && j.effects.jets[0].anchor === "rightFoot", note: JSON.stringify(j).slice(0, 120) };
  });
  await open(PALMS);
  await node("palms");
  await vecSet("pe-pose-armOut", 1, 30);
  await node("leftPalm");
  await vecSet("pe-jet-offset", 1, -3);
  await vecSet("pe-jet-angle", 0, 30);
  await E(`const s = document.querySelector('[data-testid=pe-speed]'); const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value'); d.set.call(s, '0.5'); s.dispatchEvent(new Event('input', { bubbles: true })); await __qa.sleep(500); return 1`);
  app.shot("flightdesigner");
  await undo(); await undo(); await undo();

  // ---- suit lists: abilities (picker, keybind, reorder, remove), stats, attributes, chips (the Suit Designer)
  await open(SUIT); // the flight section above leaves a flight profile open
  const setSelect = (sel, value) => E(`const el = document.querySelector(${JSON.stringify(sel)}); if (!el) throw new Error('no ' + ${JSON.stringify(sel)}); el.focus(); const d = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value'); d.set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('change', { bubbles: true })); await __qa.sleep(250); return 1`);
  const setVal = (sel, value) => E(`const el = document.querySelector(${JSON.stringify(sel)}); if (!el) throw new Error('no ' + ${JSON.stringify(sel)}); el.focus(); const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value'); d.set.call(el, ${JSON.stringify(String(value))}); el.dispatchEvent(new Event('input', { bubbles: true })); await __qa.sleep(30); el.blur(); await __qa.sleep(250); return 1`);
  const clickSel = (sel) => E(`const el = document.querySelector(${JSON.stringify(sel)}); if (!el) throw new Error('no ' + ${JSON.stringify(sel)}); el.click(); await __qa.sleep(250); return 1`);
  const clickText = (sel, text) => E(`const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find((b) => b.textContent === ${JSON.stringify(text)}); if (!el) throw new Error('no ${text} in ${sel}'); el.click(); await __qa.sleep(250); return 1`);
  const pickAbility = (q, id) => E(`const i = document.querySelector('[data-testid=pack-editor] [data-testid=pe-ab-add]'); i.focus(); const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value'); d.set.call(i, ${JSON.stringify(q)}); i.dispatchEvent(new Event('input', { bubbles: true })); await __qa.sleep(200);
    await __qa.waitFor(() => document.querySelector('[data-testid=pack-editor] [data-testid=pe-ab-results] [data-id=${id}]'), 15000); document.querySelector('[data-testid=pack-editor] [data-testid=pe-ab-results] [data-id=${id}]').click(); await __qa.sleep(300); return 1`);
  const rowsOf = () => E(`return [...document.querySelectorAll('[data-testid=pack-editor] [data-testid=pe-ab-row]')].map((r) => r.querySelector('.mono').textContent + ' ' + r.querySelector('select').value + (r.querySelector('.pe-warn') ? ' !' : ''))`);

  await check("S1 suit: Abilities lists the suit's abilities (keybind, missing flagged) with an add picker", async () => {
    await node("test_suit");
    await node("Abilities");
    const rows = await rowsOf();
    const picker = await E(`return !!document.querySelector('[data-testid=pack-editor] [data-testid=pe-ab-add]')`);
    return { ok: picker && rows.length === 2 && rows[0] === "hand_beam key.thematic.ability_0" && rows[1].startsWith("flight key.thematic.passive"), note: JSON.stringify(rows) };
  });
  let s2before;
  await check("S2 ability: picking one from the project writes { identifier, keybind } at the end", async () => {
    s2before = await text();
    await pickAbility("hive", "hive_control");
    const t1 = await text();
    const j = JSON.parse(t1);
    const last = j.abilities[j.abilities.length - 1];
    return { ok: j.abilities.length === 3 && last.identifier === "hive_control" && last.keybind === "key.thematic.ability_0" && t1.split("\n").filter((x) => x.includes("hive_control")).length === 1, note: JSON.stringify(last) };
  });
  await check("S3 ability: the keybind dropdown rewrites that ability's keybind; undo puts it back", async () => {
    const t0 = await text();
    await setSelect(`[data-testid=pack-editor] [data-testid=pe-ab-row][data-ab="2"] [data-testid=pe-ab-kb]`, "key.thematic.utility");
    const t1 = await text();
    await undo();
    const t2 = await text();
    const j = JSON.parse(t1);
    return { ok: j.abilities[2].keybind === "key.thematic.utility" && j.abilities[0].keybind === "key.thematic.ability_0" && t2 === t0, note: JSON.stringify(j.abilities[2]) };
  });
  await check("S4 ability: a row moves up; the others keep their order and bytes", async () => {
    const t0 = await text();
    await clickSel(`[data-testid=pack-editor] [data-testid=pe-ab-row][data-ab="2"] [data-testid=pe-ab-up]`);
    const j = JSON.parse(await text());
    const order = j.abilities.map((a) => a.identifier);
    await undo();
    return { ok: order.join() === "hand_beam,hive_control,flight" && (await text()) === t0, note: order.join(",") };
  });
  await check("S5 ability: remove (x) takes the row out; undo brings it back", async () => {
    const t0 = await text();
    await clickSel(`[data-testid=pack-editor] [data-testid=pe-ab-row][data-ab="2"] [data-testid=pe-ab-remove]`);
    const t1 = await text();
    await undo();
    const t2 = await text();
    return { ok: !JSON.parse(t1).abilities.some((a) => a.identifier === "hive_control") && JSON.parse(t1).abilities.length === 2 && t2 === t0 && t1 !== t0, note: JSON.stringify(JSON.parse(t1).abilities.map((a) => a.identifier)) };
  });
  await check("S6 ability: an id the project doesn't have is added anyway, flagged in the list", async () => {
    const t0 = await text();
    await E(`const i = document.querySelector('[data-testid=pack-editor] [data-testid=pe-ab-add]'); i.focus(); const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value'); d.set.call(i, 'nope_thing'); i.dispatchEvent(new Event('input', { bubbles: true })); await __qa.sleep(200);
      await __qa.waitFor(() => document.querySelector('[data-testid=pack-editor] [data-testid=pe-ab-add-typed]'), 15000); document.querySelector('[data-testid=pack-editor] [data-testid=pe-ab-add-typed]').click(); await __qa.sleep(300); return 1`);
    const t1 = await text();
    const flagged = await E(`return [...document.querySelectorAll('[data-testid=pack-editor] [data-testid=pe-ab-row]')].at(-1).querySelector('.pe-warn')?.textContent ?? null`);
    await undo();
    return { ok: JSON.parse(t1).abilities.at(-1).identifier === "nope_thing" && flagged === "not in project" && (await text()) === t0, note: String(flagged) };
  });
  await check("S7 stats: add one from the known ids (min 0, max 100); undo removes it", async () => {
    await node("Stats");
    const t0 = await text();
    await setSelect(`[data-testid=pack-editor] [data-testid=pe-stat-add]`, "thematic:base_defense");
    const t1 = await text();
    const st = JSON.parse(t1).stats;
    await undo();
    const back = (await text()) === t0;
    return { ok: st.length === 1 && st[0].identifier === "thematic:base_defense" && st[0].minimum === 0 && st[0].maximum === 100 && back, note: JSON.stringify(st) };
  });
  await check("S8 stats: min/max edit writes the number; min above max is flagged; undo steps back", async () => {
    await setSelect(`[data-testid=pack-editor] [data-testid=pe-stat-add]`, "thematic:base_defense");
    const t0 = await text();
    await setVal(`[data-testid=pack-editor] [data-stat="0"] [data-testid=pe-stat-min]`, "10");
    const a = JSON.parse(await text()).stats[0];
    await setVal(`[data-testid=pack-editor] [data-stat="0"] [data-testid=pe-stat-max]`, "5");
    const flagged = await E(`return !!document.querySelector('[data-testid=pack-editor] [data-testid=pe-stat-row].bad')`);
    const b = JSON.parse(await text()).stats[0];
    await undo();
    const mid = JSON.parse(await text()).stats[0];
    await undo();
    const back = (await text()) === t0;
    return { ok: a.minimum === 10 && b.maximum === 5 && flagged && mid.maximum === 100 && back, note: JSON.stringify(b) };
  });
  await check("S9 attributes: add a scale from the docs' ids (effect 1); undo removes it", async () => {
    await node("Stats");
    const t0 = await text();
    await setSelect(`[data-testid=pack-editor] [data-testid=pe-attr-add]`, "pehkui:base");
    const att = JSON.parse(await text()).attributes;
    await undo();
    return { ok: att.length === 1 && att[0].identifier === "pehkui:base" && att[0].effect === 1 && (await text()) === t0, note: JSON.stringify(att) };
  });
  await check("S10 suit: fighting type chips, tier, flight profile link; each undoes", async () => {
    await node("test_suit");
    const t0 = await text();
    await clickText(`[data-testid=pack-editor] [data-testid=pe-fighting] .pe-chip`, "DUELIST");
    const f = JSON.parse(await text()).fighting_type;
    await undo();
    const f2 = (await text()) === t0;
    await setVal(`[data-testid=pack-editor] [data-testid=pe-tier] input`, "9");
    const tier = JSON.parse(await text()).tier;
    await undo();
    const link = await E(`return !!document.querySelector('[data-testid=pack-editor] [data-testid=pe-edit-profile]')`);
    return { ok: f.join() === "DUELIST" && f2 && tier === 9 && (await text()) === t0 && link, note: JSON.stringify({ f, tier }) };
  });

  // ---- nothing reached disk unsaved
  await check("Z1 designer edits stay in the editor until saved (files on disk untouched)", async () => {
    const same = Object.entries(before).every(([f, t]) => fs.readFileSync(f, "utf8") === t);
    return { ok: same };
  });
  app.shot("packeditor");
} finally {
  await app.stop();
}
const pass = rows.filter((r) => r.ok).length;
console.log(`\npackeditor: ${pass}/${rows.length} passed${pass < rows.length ? "; FAILED: " + rows.filter((r) => !r.ok).map((r) => r.name).join(" | ") : ""}`);
process.exit(pass === rows.length ? 0 : 1);
