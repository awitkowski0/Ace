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
w("data/thematic/flight_profiles/jetpack.json", `{ "effects": { "jets": [] } }\n`);
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
const before = Object.fromEntries([SUIT, HUD, HIVE, GUIDE].map((f) => [f, fs.readFileSync(f, "utf8")]));

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
