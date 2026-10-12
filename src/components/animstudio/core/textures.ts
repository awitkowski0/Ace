/**
 * Textures: .bbmodel texture list commands (embedded `data:` URLs exactly as Blockbench stores them, per-face `texture` indices),
 * PNG helpers and the model for geo "texture layers" (Bedrock geometry has ONE texture slot in game; the Studio previews several
 * as variants / stacked layers, persisted outside the repo by the UI). Pure; no DOM.
 */
import { getBb, withRoot, type Doc } from "./doc";
import { setBbFaces } from "./bbedit";
import { FACES, type Face } from "./format/geo";
import {
  derive, getIn, getKey, isArr, isObj, jarr, jbool, jnum, jobj, jstr, setEntry, setIn, strOf,
  type JArr, type JEntry, type JNode, type JObj,
} from "./format/json";
import { pseudoUuid } from "./format/bbmodel";

// ---------------------------------------------------------------- PNG helpers

/** Pixel size from a PNG header (IHDR); null when `bytes` is not a PNG. */
export function pngSize(bytes: Uint8Array): { w: number; h: number } | null {
  if (bytes.length < 24) return null;
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (bytes[i] !== sig[i]) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { w: dv.getUint32(16), h: dv.getUint32(20) };
}
export function bytesToDataUrl(bytes: Uint8Array, mime = "image/png"): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${mime};base64,${typeof btoa === "function" ? btoa(s) : Buffer.from(s, "binary").toString("base64")}`;
}
export function dataUrlToBytes(url: string): Uint8Array | null {
  const m = /^data:[^;,]*;base64,(.*)$/s.exec(url);
  if (!m) return null;
  const bin = typeof atob === "function" ? atob(m[1]) : Buffer.from(m[1], "base64").toString("binary");
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------- bbmodel texture list

export interface TextureInfo {
  index: number;
  name: string;
  /** embedded `data:` URL, if any */
  source?: string;
  /** texture file on disk (`path` / `relative_path`) when it is not embedded */
  path?: string;
  visible: boolean;
  particle: boolean;
  /** pixel size recorded in the file */
  width?: number;
  height?: number;
  uvWidth?: number;
  uvHeight?: number;
}

export function bbTextureInfos(doc: Doc): TextureInfo[] {
  if (doc.kind !== "bbmodel") return [];
  return getBb(doc).textures.map((t) => {
    const n = (k: string) => { const v = getKey(t.node, k); return v && v.t === "n" ? v.value : undefined; };
    const b = (k: string, d: boolean) => { const v = getKey(t.node, k); return v && v.t === "l" && typeof v.value === "boolean" ? v.value : d; };
    return {
      index: t.index, name: t.name, source: t.source, path: t.path ?? strOf(getKey(t.node, "relative_path")),
      visible: b("visible", true), particle: b("particle", false),
      width: n("width"), height: n("height"), uvWidth: n("uv_width"), uvHeight: n("uv_height"),
    };
  });
}

const TEX_ORDER = ["name", "path", "relative_path", "folder", "namespace", "id", "group", "scope", "width", "height", "uv_width", "uv_height", "particle", "use_as_default", "layers_enabled", "sync_to_project", "file_format", "render_mode", "render_sides", "wrap_mode", "pbr_channel", "fps", "frame_time", "frame_order_type", "frame_order", "frame_interpolate", "visible", "internal", "saved", "uuid", "source"];

function defaults(): Record<string, () => JNode | undefined> {
  return {
    folder: () => jstr(""), namespace: () => jstr(""), group: () => jstr(""), scope: () => jnum(0, 0), particle: () => jbool(false), use_as_default: () => jbool(false),
    layers_enabled: () => jbool(false), sync_to_project: () => jstr(""), file_format: () => jstr("png"), render_mode: () => jstr("default"), render_sides: () => jstr("auto"),
    wrap_mode: () => jstr("limited"), pbr_channel: () => jstr("color"), fps: () => jnum(7, 0), frame_time: () => jnum(1, 0), frame_order_type: () => jstr("loop"),
    frame_order: () => jstr(""), frame_interpolate: () => jbool(false), visible: () => jbool(true), internal: () => jbool(true), saved: () => jbool(true),
  };
}

export interface AddTextureArgs {
  name: string;
  /** `data:image/png;base64,...` (embedded exactly like Blockbench) */
  source: string;
  /** pixel size of the image (parsed from the data URL when omitted) */
  width?: number;
  height?: number;
  /** UV size; defaults to the project resolution */
  uvWidth?: number;
  uvHeight?: number;
}

/** Append a texture. The entry copies the key order / style of the last existing texture, else Blockbench's default layout. */
export function addBbTexture(doc: Doc, a: AddTextureArgs): Doc {
  if (doc.kind !== "bbmodel") throw new Error("not a bbmodel");
  const model = getBb(doc);
  const root = doc.root as JObj;
  const bytes = dataUrlToBytes(a.source);
  const size = bytes ? pngSize(bytes) : null;
  const w = a.width ?? size?.w ?? 16, h = a.height ?? size?.h ?? 16;
  const uvW = a.uvWidth ?? model.resolution?.width ?? w, uvH = a.uvHeight ?? model.resolution?.height ?? h;
  const index = model.textures.length;
  const used = new Set<string>();
  for (const t of model.textures) { const u = strOf(getKey(t.node, "uuid")); if (u) used.add(u); }
  let uuid = pseudoUuid(`bbtex/${a.name}/${index}`);
  for (let i = 0; used.has(uuid) && i < 1000; i++) uuid = pseudoUuid(`bbtex/${a.name}/${index}#${i}`);
  const tpl = model.textures[model.textures.length - 1]?.node;
  const want: Record<string, JNode | undefined> = {
    name: jstr(a.name), id: jstr(String(index)), width: jnum(w, 0), height: jnum(h, 0), uv_width: jnum(uvW, 0), uv_height: jnum(uvH, 0),
    particle: jbool(false), uuid: jstr(uuid), source: jstr(a.source),
  };
  const dflt = defaults();
  const keys = tpl ? tpl.entries.map((e) => e.key) : TEX_ORDER.filter((k) => k !== "path");
  const entries: JEntry[] = [];
  for (const k of keys) {
    const te = tpl?.entries.find((e) => e.key === k);
    // path / relative_path belong to the template's file, not to the new embedded texture
    if (k === "path" || k === "relative_path") continue;
    const v = want[k] ?? (te ? dflt[k]?.() ?? te.value : dflt[k]?.());
    if (v) entries.push({ key: k, keyRaw: te?.keyRaw, value: v });
  }
  const node = jobj(entries, tpl);
  const arr = getKey(root, "textures");
  let next: JObj;
  if (isArr(arr)) next = setIn(root, ["textures"], derive(arr, [...arr.items, node])) as JObj;
  else next = setEntry(root, "textures", jarr([node]), (k) => k === "display" || k === "outliner" || k === "animations") as JObj;
  return withRoot(doc, next);
}

function eachFace(root: JObj, fn: (path: Array<string | number>, tex: JNode | undefined) => void) {
  const els = getKey(root, "elements");
  if (!isArr(els)) return;
  els.items.forEach((e, i) => {
    const faces = isObj(e) ? getKey(e, "faces") : undefined;
    if (!isObj(faces)) return;
    for (const f of FACES) {
      const fn_ = getKey(faces, f);
      if (isObj(fn_)) fn(["elements", i, "faces", f], getKey(fn_, "texture"));
    }
  });
}

/** Remove texture `index`; faces using it become untextured, faces of later textures shift down (Blockbench saves indices). */
export function removeBbTexture(doc: Doc, a: { index: number }): Doc {
  if (doc.kind !== "bbmodel") throw new Error("not a bbmodel");
  let root = doc.root as JObj;
  const arr = getKey(root, "textures");
  if (!isArr(arr) || a.index < 0 || a.index >= arr.items.length) throw new Error(`No texture ${a.index}`);
  const edits: Array<{ path: Array<string | number>; value: JNode | undefined }> = [];
  eachFace(root, (path, tex) => {
    if (!tex || tex.t !== "n") return;
    if (tex.value === a.index) edits.push({ path: [...path, "texture"], value: undefined });
    else if (tex.value > a.index) edits.push({ path: [...path, "texture"], value: jnum(tex.value - 1, 0) });
  });
  for (const e of edits) root = setIn(root, e.path, e.value) as JObj;
  const items = arr.items.slice();
  items.splice(a.index, 1);
  const cur = getKey(root, "textures") as JArr;
  root = setIn(root, ["textures"], derive(cur, items)) as JObj;
  // keep the string `id` of the following textures in step with their position, where they followed it
  items.forEach((t, i) => {
    if (i < a.index || !isObj(t)) return;
    const id = getKey(t, "id");
    if (id && id.t === "s" && id.value === String(i + 1)) root = setIn(root, ["textures", i, "id"], jstr(String(i))) as JObj;
  });
  return withRoot(doc, root);
}

export interface TexturePatch { name?: string; visible?: boolean; particle?: boolean; uvWidth?: number; uvHeight?: number }
export function setBbTexture(doc: Doc, a: { index: number; patch: TexturePatch }): Doc {
  if (doc.kind !== "bbmodel") throw new Error("not a bbmodel");
  const root = doc.root as JObj;
  const t = getIn(root, ["textures", a.index]);
  if (!isObj(t)) throw new Error(`No texture ${a.index}`);
  const p = a.patch;
  let n: JObj = t;
  const put = (k: string, v: JNode) => {
    const cur = getKey(n, k);
    if (cur && cur.t === v.t && (cur as { value: unknown }).value === (v as { value: unknown }).value) return;
    const ki = TEX_ORDER.indexOf(k);
    n = setEntry(n, k, v, (key) => TEX_ORDER.indexOf(key) > ki);
  };
  if (p.name !== undefined) put("name", jstr(p.name));
  if (p.visible !== undefined) put("visible", jbool(p.visible));
  if (p.particle !== undefined) put("particle", jbool(p.particle));
  if (p.uvWidth !== undefined) put("uv_width", jnum(p.uvWidth, 0));
  if (p.uvHeight !== undefined) put("uv_height", jnum(p.uvHeight, 0));
  return n === t ? doc : withRoot(doc, setIn(root, ["textures", a.index], n));
}

/** Assign a texture (index), "none" (false) or disable the face (null) on `faces` of several cubes. */
export function setBbFaceTexture(
  doc: Doc,
  a: { cubes: Array<{ group: string | null; index: number }>; faces?: readonly Face[]; texture: number | null | false },
): Doc {
  let d = doc;
  const faces: Partial<Record<Face, { texture: number | null | false }>> = {};
  for (const f of a.faces ?? FACES) faces[f] = { texture: a.texture };
  for (const c of a.cubes) d = setBbFaces(d, { group: c.group, index: c.index, faces });
  return d;
}

/** Texture index of a face from the raw JSON value: >= 0 index, -1 = none (key absent / false), null = face disabled. */
export function faceTextureOf(v: unknown): number | null {
  if (v === null) return null;
  if (typeof v === "number" && v >= 0) return v;
  return -1;
}

// ---------------------------------------------------------------- geo texture layers (preview only)

export type LayerBlend = "normal" | "add";
export interface GeoTexLayer {
  /** absolute path of a png */
  path: string;
  visible: boolean;
  blend?: LayerBlend;
}
export interface GeoTexState {
  layers: GeoTexLayer[];
  /** index into `layers` the UV editor shows */
  active: number;
}

const stemOf = (p: string) => p.slice(p.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");
const dirOf = (p: string) => p.slice(0, p.lastIndexOf("/"));

/** Pngs next to the default texture that look like variants of it: `<stem>_*.png` (and `<stem>.<n>.png`), sorted, excluding the default itself. */
export function discoverVariants(defaultTexture: string, siblingFiles: readonly string[]): string[] {
  const stem = stemOf(defaultTexture);
  const dir = dirOf(defaultTexture);
  return siblingFiles
    .filter((f) => /\.png$/i.test(f) && f !== defaultTexture.slice(defaultTexture.lastIndexOf("/") + 1))
    .filter((f) => f.startsWith(stem + "_") || f.startsWith(stem + "."))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((f) => `${dir}/${f}`);
}

/**
 * Reconcile the persisted layer list with what is on disk now: saved layers keep order / visibility (dropped when the file is gone),
 * the default texture is always first when none is saved, newly discovered variants are appended hidden (they would cover the base).
 */
export function mergeGeoTextures(saved: GeoTexState | undefined, defaultTexture: string | null, variants: readonly string[], exists: (p: string) => boolean = () => true): GeoTexState {
  const layers: GeoTexLayer[] = [];
  const seen = new Set<string>();
  for (const l of saved?.layers ?? []) {
    if (seen.has(l.path) || !exists(l.path)) continue;
    seen.add(l.path);
    layers.push({ path: l.path, visible: l.visible, ...(l.blend && l.blend !== "normal" ? { blend: l.blend } : {}) });
  }
  if (defaultTexture && !seen.has(defaultTexture) && exists(defaultTexture)) {
    seen.add(defaultTexture);
    layers.unshift({ path: defaultTexture, visible: true });
  }
  for (const v of variants) if (!seen.has(v)) { seen.add(v); layers.push({ path: v, visible: false }); }
  const active = Math.min(Math.max(saved?.active ?? 0, 0), Math.max(0, layers.length - 1));
  return { layers, active };
}

/** Layers to draw, bottom to top. */
export const visibleLayers = (s: GeoTexState): GeoTexLayer[] => s.layers.filter((l) => l.visible);

export const layerName = (l: GeoTexLayer): string => l.path.slice(l.path.lastIndexOf("/") + 1);
