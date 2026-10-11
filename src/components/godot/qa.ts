/** Test hooks (`await __qa.godot()`) for scripts/qa/godot.mjs. Debugger state comes from `__qa.py().debug`. */
import { listConfigTypes, runStore } from "../run/configs";
import { sessionStore, type Session } from "../run/sessions";
import { runProblems } from "../run/problems";
import { repoConfigStore } from "../../lib/repoConfig";
import { activeSession } from "../python/debug/session";
import { godotStore, ensureScan } from "./model";
import { getPins, lastEditorLaunch, movePin, openInGodotEditor, pinSpec, reimportAssets, reloadScripts, runSpec, unpinAt, unpinSpec, currentScene } from "./ops";
import { liveLinks } from "./link";
import { lastStructure } from "./StructureWindow";
import type { GodotSpec } from "./presets";
import { godotUi } from "./ui";

const sum = (s: Session) => ({
  id: s.id, name: s.name, type: s.typeId, status: s.status, exit: s.exit, timedOut: !!s.timedOut, group: (s.cfg.groupId as string | undefined) ?? null, commandLine: s.commandLine,
  text: s.buf.fullText(),
});

export const godotQa = {
  state: () => {
    const g = godotStore.get();
    return { detected: g.detected, projectDir: g.projectDir, name: g.name, mainScene: g.mainScene, scanned: g.scanned, scans: g.scans, scenes: g.scenes, presets: g.presets.map((p) => ({ name: p.name, line: p.line, type: p.type, instanceArgs: p.instanceArgs ?? null, timeLimit: p.timeLimit ?? null, headless: !!p.headless })), scripts: g.scripts, bin: g.bin?.path ?? null, recent: g.settings.recent };
  },
  scan: (force = true) => ensureScan(force).then(() => godotQa.state()),
  configTypes: () => listConfigTypes().map((t) => ({ id: t.id, label: t.label, debuggable: t.debuggable !== false, fields: t.fields.map((f) => f.key) })),
  configs: () => runStore.get().configs.map((c) => ({ id: c.id, type: c.type, name: c.name, temporary: !!c.temporary })),
  selectedConfig: () => { const c = runStore.get().configs.find((x) => x.id === runStore.get().selectedId); return c ? { id: c.id, type: c.type, name: c.name, temporary: !!c.temporary } : null; },
  run: (spec: GodotSpec, mode: "run" | "debug" = "run") => runSpec(spec, mode).then((s) => (s ? sum(s) : null)),
  runPreset: (name: string, mode: "run" | "debug" = "run") => {
    const p = godotStore.get().presets.find((x) => x.name === name);
    if (!p) throw new Error("no preset " + name);
    return runSpec(p, mode).then((s) => (s ? sum(s) : null));
  },
  sessions: () => sessionStore.get().list.map(sum),
  session: (i: number) => { const s = sessionStore.get().list[i]; return s ? sum(s) : null; },
  problems: () => runProblems.get().runs,
  rows: () => [...document.querySelectorAll<HTMLElement>(".gd-row[data-row]")].map((e) => ({ id: e.dataset.row, kind: e.dataset.kind, text: e.querySelector(".gd-label")?.textContent ?? "", hint: e.querySelector(".gd-hint:last-child")?.textContent ?? "" })),
  select: (id: string) => {
    const r = [...document.querySelectorAll<HTMLElement>(".gd-row[data-row]")].find((e) => e.dataset.row === id);
    if (!r) throw new Error("no row " + id);
    r.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  },
  selected: () => godotUi.get().selected?.id ?? null,
  pins: () => getPins(),
  pin: (s: GodotSpec) => pinSpec(s),
  unpin: (s: GodotSpec) => unpinSpec(s),
  unpinAt,
  movePin,
  repo: () => repoConfigStore.get(),
  openEditor: (scene?: string) => openInGodotEditor(scene),
  lastEditorLaunch: () => lastEditorLaunch.get().argv,
  currentScene,
  reimport: () => reimportAssets().then((s) => (s ? sum(s) : null)),
  reloadScripts,
  liveGames: () => liveLinks.size,
  structure: () => lastStructure,
  /** variables of the paused debug session: scope 0 locals / 1 members / 2 globals, then children by name path (objects expand through the inspector) */
  vars: async (scope = 0, path: string[] = []) => {
    const s = activeSession();
    if (!s) throw new Error("no debug session");
    const sc = s.state.scopes[scope];
    if (!sc) return null;
    await s.ensureVars(sc.ref);
    let slot = s.state.vars[String(sc.ref)];
    let list = Array.isArray(slot) ? slot : [];
    for (const name of path) {
      const v = list.find((x) => x.name === name);
      if (!v) throw new Error("no variable " + name);
      list = await s.children(v);
    }
    return list.map((v) => ({ name: v.name, value: v.value, type: v.type, ref: v.ref }));
  },
};
