/** Rows of the Godot tool window. Pure. */
import type { ScanScript } from "./api";
import { defaultHeadless, pinRecord, specKey, specLabel, type GodotPin, type GodotSpec, type Preset } from "./presets";

export type RowKind = "section" | "pinned" | "run" | "scene" | "preset" | "script" | "more";
export interface Row {
  id: string;
  kind: RowKind;
  label: string;
  sub?: string;
  depth: number;
  hasChildren?: boolean;
  spec?: GodotSpec;
  /** index into the pins (kind "pinned") */
  pinIndex?: number;
  main?: boolean;
  title?: string;
}

export interface TreeModel { name: string; mainScene: string; recent: string[]; scenes: string[]; presets: Preset[]; scripts: ScanScript[] }

export const sceneSpec = (res: string): GodotSpec => ({ type: "scene", scene: res });
export const scriptSpec = (s: ScanScript): GodotSpec => ({ type: "script", script: s.path, headless: defaultHeadless(s.path) });
const base = (p: string) => p.split("/").pop() ?? p;

export function pinnedHint(p: GodotPin): string {
  if (p.type === "project") return "";
  return p.type === "scene" ? p.scene ?? "" : p.script ?? "";
}

export function buildRows(m: TreeModel, pins: GodotPin[], open: Set<string>): Row[] {
  const rows: Row[] = [];
  const sec = (id: string, label: string, n?: number): boolean => {
    const o = open.has(id);
    rows.push({ id, kind: "section", label, sub: n != null ? String(n) : undefined, depth: 0, hasChildren: true });
    return o;
  };
  if (pins.length && sec("sec:pinned", "Pinned", pins.length)) {
    pins.forEach((p, i) => rows.push({ id: `pin:${i}:${specKey(p)}`, kind: "pinned", label: specLabel(p), sub: pinnedHint(p), depth: 1, spec: p, pinIndex: i, title: specKey(p) }));
  }
  if (sec("sec:project", m.name || "Project")) {
    rows.push({ id: "run", kind: "run", label: "Run Project", sub: m.mainScene || "main scene", depth: 1, spec: { type: "project", name: m.name || undefined } });
  }
  const recent = m.recent.filter((r) => r !== m.mainScene);
  const shown = [...(m.mainScene ? [m.mainScene] : []), ...recent];
  if (sec("sec:scenes", "Scenes", m.scenes.length || shown.length)) {
    for (const s of shown) rows.push({ id: `scene:${s}`, kind: "scene", label: base(s), sub: s === m.mainScene ? "main scene" : s, depth: 1, spec: sceneSpec(s), main: s === m.mainScene });
    const more = m.scenes.filter((s) => !shown.includes(s));
    if (more.length) {
      rows.push({ id: "more:scenes", kind: "more", label: `All Scenes (${m.scenes.length})`, depth: 1, hasChildren: true });
      if (open.has("more:scenes")) for (const s of more) rows.push({ id: `scene:${s}`, kind: "scene", label: base(s), sub: s, depth: 2, spec: sceneSpec(s) });
    }
  }
  if (m.presets.length && sec("sec:presets", "Presets (README Dev tools)", m.presets.length)) {
    m.presets.forEach((p, i) => rows.push({ id: `preset:${i}`, kind: "preset", label: specLabel(p), sub: p.line.replace(/^tools\/run_godot\.sh\s+/, ""), depth: 1, spec: p, title: p.line }));
  }
  if (m.scripts.length && sec("sec:scripts", "Scripts (SceneTree)", m.scripts.length)) {
    for (const s of m.scripts) rows.push({ id: `script:${s.path}`, kind: "script", label: base(s.path), sub: s.path.replace(/^res:\/\//, "").replace(/\/[^/]*$/, ""), depth: 1, spec: scriptSpec(s), title: s.doc || s.path });
  }
  return rows;
}

export const DEFAULT_OPEN = ["sec:pinned", "sec:project", "sec:scenes", "sec:presets", "sec:scripts"];
export const pinOf = (s: GodotSpec) => pinRecord(s);
