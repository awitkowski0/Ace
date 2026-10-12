/**
 * HUDs (data/<ns>/huds/*.js|json, HudDefinition.java): a list of TEXT / BAR / TEXTURE elements, each hung from one of nine
 * screen anchors with a pixel offset. Read from either form with the source span of each editable value, so the editor writes
 * back into the file the author (or anyone else) wrote.
 */
import { callsOn, fnArg, objArg, plain, scanCalls, setProp, strArg, applyEdits, type JsCall, type JsObj, type TextEdit } from "./jsdsl";
import { getIn, isArr, isObj, parseJson, setIn, fromValue, emitJson, detectStyle, toValue, type JNode } from "../../animstudio/core/format/json";

export const HUD_ANCHORS = ["TOP_LEFT", "TOP_CENTER", "TOP_RIGHT", "MIDDLE_LEFT", "CENTER", "MIDDLE_RIGHT", "BOTTOM_LEFT", "BOTTOM_CENTER", "BOTTOM_RIGHT"] as const;
export type HudAnchor = (typeof HUD_ANCHORS)[number];
export const HUD_KINDS = ["TEXT", "BAR", "TEXTURE"] as const;
export type HudKind = (typeof HUD_KINDS)[number];
export const HUD_VALUES = ["AMMO", "CAPACITY", "FIRE_MODE", "GUN_NAME", "RELOAD_PROGRESS", "NONE"] as const;
export const HUD_WHEN = ["ALWAYS", "HOLDING_GUN", "AIMING", "NOT_AIMING", "RELOADING", "FIRING", "HAS_AMMO", "OUT_OF_AMMO"] as const;
/** Sample values for the preview: what a mid-magazine rifle shows. */
export const HUD_SAMPLE: Record<string, string> = { ammo: "18", capacity: "30", fireMode: "Auto", gunName: "Rifle", reloadProgress: "0.6" };

export interface HudElement {
  index: number;
  kind: HudKind;
  /** every property as written (camelCase names and enum names both kept as-is) */
  props: Record<string, unknown>;
  /** primary value: the text, the bar's value, the texture id */
  primary?: string;
}

export interface HudDoc { form: "js" | "json"; elements: HudElement[] }

/** `notAiming` / `NOT_AIMING` -> `NOT_AIMING` */
export const enumName = (v: unknown): string => (typeof v === "string" ? v.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase() : "");

const PRIMARY: Record<string, { kind: HudKind; key: string }> = { text: { kind: "TEXT", key: "text" }, bar: { kind: "BAR", key: "value" }, texture: { kind: "TEXTURE", key: "texture" } };

function jsElements(src: string): { calls: JsCall[]; els: JsCall[] } {
  const calls = scanCalls(src);
  const root = calls.find((c) => !c.recv && c.method === "hud");
  const els = root ? callsOn(calls, fnArg(root)).filter((c) => c.method in PRIMARY || c.method === "element") : [];
  return { calls, els };
}

export function readHud(text: string, form: "js" | "json"): HudDoc {
  if (form === "json") {
    const root = parseJson(text).root;
    const arr = getIn(root, ["elements"]);
    const elements: HudElement[] = isArr(arr) ? arr.items.map((n, index) => {
      const props = (isObj(n) ? toValue(n) : {}) as Record<string, unknown>;
      const kind = (enumName(props.type) || "TEXT") as HudKind;
      const primary = kind === "TEXT" ? props.text : kind === "BAR" ? props.value : props.texture;
      return { index, kind, props, primary: typeof primary === "string" ? primary : undefined };
    }) : [];
    return { form, elements };
  }
  const { els } = jsElements(text);
  return {
    form,
    elements: els.map((c, index) => {
      const props = (plain(objArg(c)) ?? {}) as Record<string, unknown>;
      const p = PRIMARY[c.method];
      const kind = p ? p.kind : ((enumName(props.type) || "TEXT") as HudKind);
      const primary = p ? strArg(c) : (props[kind === "TEXT" ? "text" : kind === "BAR" ? "value" : "texture"] as string | undefined);
      return { index, kind, props, primary };
    }),
  };
}

/** Set (or with `undefined`, remove) element `index`'s `key`. For a JS file, `key === "@primary"` edits the first argument. */
export function setHudProp(text: string, form: "js" | "json", index: number, key: string, value: unknown): string {
  if (form === "json") {
    const p = parseJson(text);
    const style = detectStyle(text, p.start, p.end);
    const cur = getIn(p.root, ["elements", index]);
    if (!isObj(cur)) return text;
    const k = key === "@primary" ? primaryKeyJson(cur) : key;
    const root = setIn(p.root, ["elements", index, k], value === undefined ? undefined : fromValue(value, getIn(p.root, ["elements", index, k]) ?? cur));
    return text.slice(0, p.start) + emitJson(root, style) + text.slice(p.end);
  }
  const { els } = jsElements(text);
  const c = els[index];
  if (!c) return text;
  let edit: TextEdit;
  if (key === "@primary" && c.method in PRIMARY) {
    const a = c.args[0];
    if (!a) return text;
    edit = { s: a.s, e: a.e, text: JSON.stringify(String(value ?? "")) };
  } else {
    const k = key === "@primary" ? PRIMARY[c.method]?.key ?? "text" : key;
    const o = objArg(c);
    if (!o) {
      // `hud.text("x")` with no options yet: add them
      const last = c.args[c.args.length - 1];
      if (!last || value === undefined) return text;
      edit = { s: last.e, e: last.e, text: `, { ${k}: ${JSON.stringify(value)} }` };
    } else edit = setProp(text, o, k, value);
  }
  return applyEdits(text, [edit]);
}

function primaryKeyJson(o: JNode): string {
  const t = enumName((toValue(o) as Record<string, unknown>).type);
  return t === "BAR" ? "value" : t === "TEXTURE" ? "texture" : "text";
}

/** Append a new element (keeps the file's form). */
export function addHudElement(text: string, form: "js" | "json", kind: HudKind, props: Record<string, unknown>): string {
  if (form === "json") {
    const p = parseJson(text);
    const style = detectStyle(text, p.start, p.end);
    const arr = getIn(p.root, ["elements"]);
    const items = isArr(arr) ? arr.items.length : 0;
    const el = { type: kind, ...props };
    const root = setIn(p.root, ["elements", items], fromValue(el, isArr(arr) ? arr.items[0] ?? arr : p.root));
    return text.slice(0, p.start) + emitJson(root, style) + text.slice(p.end);
  }
  const calls = scanCalls(text);
  const root = calls.find((c) => !c.recv && c.method === "hud");
  const fn = root && fnArg(root);
  if (!fn) return text;
  const param = fn.params[0] ?? "hud";
  const method = kind === "TEXT" ? "text" : kind === "BAR" ? "bar" : "texture";
  const primaryKey = PRIMARY[method].key;
  const { [primaryKey]: primary, ...rest } = props;
  const indentOf = (pos: number) => text.slice(0, pos).match(/\n([ \t]*)[^\n]*$/)?.[1] ?? "";
  const els = callsOn(calls, fn);
  const last = els[els.length - 1];
  const indent = last ? indentOf(last.s) : indentOf(fn.body.s) + "    ";
  const line = `${param}.${method}(${JSON.stringify(primary ?? "")}, ${objSource(rest)});`;
  // after the last element statement, or just inside the body's closing brace
  const at = last ? text.indexOf(";", last.e) + 1 || last.e : fn.body.e - 1;
  return text.slice(0, at) + `\n${indent}${line}` + (last ? "" : "\n" + indentOf(fn.body.e - 1)) + text.slice(at);
}

export function removeHudElement(text: string, form: "js" | "json", index: number): string {
  if (form === "json") {
    const p = parseJson(text);
    const style = detectStyle(text, p.start, p.end);
    const root = setIn(p.root, ["elements", index], undefined);
    return text.slice(0, p.start) + emitJson(root, style) + text.slice(p.end);
  }
  const { els } = jsElements(text);
  const c = els[index];
  if (!c) return text;
  let s = c.s;
  let e = c.e;
  const semi = text.slice(e).match(/^\s*;/);
  if (semi) e += semi[0].length;
  const lineStart = text.lastIndexOf("\n", s - 1) + 1;
  if (!text.slice(lineStart, s).trim()) s = lineStart - (lineStart > 0 ? 1 : 0);
  return text.slice(0, s) + text.slice(e);
}

const objSource = (o: Record<string, unknown>) =>
  "{ " + Object.entries(o).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", ") + " }";

// ---------------------------------------------------------------- layout (GUI-scaled pixels)

export interface Rect { x: number; y: number; w: number; h: number }

/** The vanilla font: 6 px advance on average, 9 px line height (8 + shadow). */
export const textSize = (s: string, scale = 1) => ({ w: Math.max(1, s.length * 6 - 1) * scale, h: 9 * scale });

export function fillPlaceholders(s: string, values = HUD_SAMPLE): string {
  return s.replace(/\{(\w+)\}/g, (m, k: string) => values[k] ?? m);
}

/** Top-left of an element's box: anchor point plus (x, y), with the box aligned so it grows away from its anchor's edge. */
export function anchorPoint(a: HudAnchor, sw: number, sh: number): [number, number] {
  const col = a.endsWith("LEFT") ? 0 : a.endsWith("RIGHT") ? 2 : 1;
  const row = a.startsWith("TOP") ? 0 : a.startsWith("BOTTOM") ? 2 : 1;
  return [(col * sw) / 2, (row * sh) / 2];
}

export function elementRect(el: HudElement, sw: number, sh: number): Rect {
  const a = (enumName(el.props.anchor) || "TOP_LEFT") as HudAnchor;
  const x = Number(el.props.x ?? 0);
  const y = Number(el.props.y ?? 0);
  let w: number, h: number;
  if (el.kind === "TEXT") ({ w, h } = textSize(fillPlaceholders(el.primary ?? ""), Number(el.props.scale ?? 1)));
  else if (el.kind === "TEXTURE" && enumName(el.props.fit) === "COVER") return { x: 0, y: 0, w: sw, h: sh };
  else { w = Number(el.props.width ?? 0); h = Number(el.props.height ?? 0); }
  // HudLayout.anchorX/anchorY: right/bottom boxes end at the edge, centred ones are centred (integer maths), then the offset
  w = Math.trunc(w);
  h = Math.trunc(h);
  const col = a.endsWith("LEFT") ? 0 : a.endsWith("RIGHT") ? 2 : 1;
  const row = a.startsWith("TOP") ? 0 : a.startsWith("BOTTOM") ? 2 : 1;
  const bx = col === 0 ? 0 : col === 1 ? Math.trunc((sw - w) / 2) : sw - w;
  const by = row === 0 ? 0 : row === 1 ? Math.trunc((sh - h) / 2) : sh - h;
  return { x: bx + x, y: by + y, w, h };
}

/** The (x, y) that puts an element's box at `left, top` against its anchor: the inverse of elementRect for a drag. */
export function offsetForRect(el: HudElement, left: number, top: number, sw: number, sh: number): [number, number] {
  const r = elementRect(el, sw, sh);
  const x = Number(el.props.x ?? 0);
  const y = Number(el.props.y ?? 0);
  return [Math.round(x + (left - r.x)), Math.round(y + (top - r.y))];
}

/** Nearest anchor to a box (re-anchoring keeps the box where it is). */
export function nearestAnchor(r: Rect, sw: number, sh: number): HudAnchor {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const col = cx < sw / 3 ? "LEFT" : cx > (2 * sw) / 3 ? "RIGHT" : "CENTER";
  const row = cy < sh / 3 ? "TOP" : cy > (2 * sh) / 3 ? "BOTTOM" : "MIDDLE";
  if (row === "MIDDLE" && col === "CENTER") return "CENTER";
  return `${row}_${col}` as HudAnchor;
}

export function argb(v: unknown, d = "#FFFFFFFF"): string {
  const s = typeof v === "string" ? v : d;
  const m = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(s);
  if (!m) return "#ffffff";
  const h = m[1];
  if (h.length === 6) return "#" + h;
  return `#${h.slice(2)}${h.slice(0, 2)}`; // CSS wants RRGGBBAA
}

export { toValue as jsonToValue };
