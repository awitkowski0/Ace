/**
 * Texture operations of the Edit-mode Textures panel. .bbmodel: real `textures[]` entries (embedded `data:` URLs, per-face `texture`
 * indices) through core commands, so everything is one Monaco undo stop. Geo: viewport-only preview layers persisted in Ace app data
 * (resolve.ts), never written into the repo; the game renders one texture.
 */
import { fs } from "../../../lib/ipc";
import {
  addBbTexture, bbTextureInfos, bytesToDataUrl, getBb, layerName, pngSize, removeBbTexture, setBbFaceTexture, setBbTexture, FACES,
  type Doc, type Face, type GeoTexState,
} from "../core";
import { bbCubeRefs } from "../core";
import { selValue, coveredCubes } from "./selection";
import { rigFromDoc, rigTree } from "./model";
import { setGeoTextures } from "./resolve";
import type { StudioApi } from "./state";

export interface TexRow {
  index: number;
  name: string;
  /** image source for thumbnails: data URL (bbmodel) or null (geo: the panel loads the file) */
  src: string | null;
  path?: string;
  visible: boolean;
  width?: number;
  height?: number;
}

export const isGeoDoc = (d: Doc | null | undefined) => d?.kind === "geo";

/** The texture list the panel shows for the current document. */
export function textureRows(api: StudioApi): TexRow[] {
  const s = api.store.get();
  if (s.doc?.kind === "bbmodel") return bbTextureInfos(s.doc).map((t) => ({ index: t.index, name: t.name, src: t.source ?? null, path: t.path, visible: t.visible, width: t.width, height: t.height }));
  if (s.doc?.kind === "geo") return s.geoTex.layers.map((l, i) => ({ index: i, name: layerName(l), src: null, path: l.path, visible: l.visible }));
  return [];
}

export function opSetActiveTexture(api: StudioApi, index: number): void {
  const n = textureRows(api).length;
  const a = Math.min(Math.max(index, 0), Math.max(0, n - 1));
  api.store.set({ texActive: a });
  const g = api.store.get();
  if (g.doc?.kind === "geo" && g.geoTex.active !== a) setGeoTex(api, { ...g.geoTex, active: a });
}

let persistTimer: ReturnType<typeof setTimeout> | undefined;
/** geo: keep the layer list in app data (debounced; keyed by the geo file path) */
function persistGeo(api: StudioApi) {
  const s = api.store.get();
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => { void setGeoTextures(s.path, s.geoTex); }, 150);
}
export function setGeoTex(api: StudioApi, next: GeoTexState): void {
  api.store.set({ geoTex: next, texActive: Math.min(api.store.get().texActive, Math.max(0, next.layers.length - 1)) });
  persistGeo(api);
}

/** Add a texture from raw PNG bytes (drop / HTML file input) - bbmodel only (geo layers need a path). */
export function opAddTextureBytes(api: StudioApi, name: string, bytes: Uint8Array): boolean {
  const s = api.store.get();
  if (s.doc?.kind !== "bbmodel" || !pngSize(bytes)) return false;
  const doc = addBbTexture(s.doc, { name, source: bytesToDataUrl(bytes) });
  api.commit(doc, "Add Texture");
  api.store.set({ texActive: getBb(doc).textures.length - 1 });
  return true;
}

/** Add a texture from a png file: .bbmodel embeds it; geo adds a preview layer (hidden unless it is the first). */
export async function opAddTexturePath(api: StudioApi, host: string, path: string): Promise<boolean> {
  const s = api.store.get();
  if (!/\.png$/i.test(path) || !s.doc) return false;
  if (s.doc.kind === "bbmodel") {
    const bytes = await fs.readBytes({ host, path });
    return opAddTextureBytes(api, path.slice(path.lastIndexOf("/") + 1), new Uint8Array(bytes));
  }
  if (s.doc.kind === "geo") {
    const cur = s.geoTex;
    if (cur.layers.some((l) => l.path === path)) { opSetActiveTexture(api, cur.layers.findIndex((l) => l.path === path)); return true; }
    const next: GeoTexState = { layers: [...cur.layers, { path, visible: cur.layers.length === 0 }], active: cur.layers.length };
    setGeoTex(api, next);
    api.store.set({ texActive: next.layers.length - 1 });
    return true;
  }
  return false;
}

export function opRemoveTexture(api: StudioApi, index: number): boolean {
  const s = api.store.get();
  if (s.doc?.kind === "bbmodel") {
    if (index < 0 || index >= getBb(s.doc).textures.length) return false;
    api.commit(removeBbTexture(s.doc, { index }), "Remove Texture");
    api.store.set({ texActive: Math.max(0, Math.min(s.texActive, getBb(s.doc).textures.length - 2)) });
    return true;
  }
  if (s.doc?.kind === "geo") {
    if (index < 0 || index >= s.geoTex.layers.length) return false;
    // the default texture (what the game uses) can be hidden but not removed from the preview list
    const layers = s.geoTex.layers.filter((_, i) => i !== index);
    setGeoTex(api, { layers, active: Math.min(s.geoTex.active, Math.max(0, layers.length - 1)) });
    return true;
  }
  return false;
}

export function opToggleTextureVisible(api: StudioApi, index: number, visible?: boolean): boolean {
  const s = api.store.get();
  if (s.doc?.kind === "bbmodel") {
    const cur = bbTextureInfos(s.doc)[index];
    if (!cur) return false;
    api.commit(setBbTexture(s.doc, { index, patch: { visible: visible ?? !cur.visible } }), "Toggle Texture Visibility");
    return true;
  }
  if (s.doc?.kind === "geo") {
    const l = s.geoTex.layers[index];
    if (!l) return false;
    setGeoTex(api, { ...s.geoTex, layers: s.geoTex.layers.map((x, i) => (i === index ? { ...x, visible: visible ?? !x.visible } : x)) });
    return true;
  }
  return false;
}

/** geo: show only this layer (solo) - switches a skin variant for the preview */
export function opSoloTexture(api: StudioApi, index: number): boolean {
  const s = api.store.get();
  if (s.doc?.kind !== "geo" || !s.geoTex.layers[index]) return false;
  setGeoTex(api, { ...s.geoTex, layers: s.geoTex.layers.map((x, i) => ({ ...x, visible: i === index })) });
  return true;
}
export function opSetLayerBlend(api: StudioApi, index: number, blend: "normal" | "add"): boolean {
  const s = api.store.get();
  if (s.doc?.kind !== "geo" || !s.geoTex.layers[index]) return false;
  setGeoTex(api, { ...s.geoTex, layers: s.geoTex.layers.map((x, i) => (i === index ? (blend === "add" ? { ...x, blend } : { path: x.path, visible: x.visible }) : x)) });
  return true;
}
export function opMoveLayer(api: StudioApi, index: number, dir: -1 | 1): boolean {
  const s = api.store.get();
  const j = index + dir;
  if (s.doc?.kind !== "geo" || !s.geoTex.layers[index] || !s.geoTex.layers[j]) return false;
  const layers = s.geoTex.layers.slice();
  [layers[index], layers[j]] = [layers[j], layers[index]];
  setGeoTex(api, { ...s.geoTex, layers });
  api.store.set({ texActive: j });
  return true;
}

/** .bbmodel: assign texture `index` to the selected faces (UV editor selection) or to every face of the selected cubes. */
export function opApplyTexture(api: StudioApi, index: number, scope: "faces" | "all"): boolean {
  const s = api.store.get();
  if (s.doc?.kind !== "bbmodel") return false;
  const rig = rigFromDoc(s.doc);
  const cubes = coveredCubes(selValue(s), rigTree(rig));
  if (!cubes.length) return false;
  const model = getBb(s.doc);
  const refs = bbCubeRefs(model);
  const isBoxCube = (c: { bone: string; index: number }) => rig?.bones.find((b) => b.name === c.bone)?.cubes.find((x) => x.index === c.index)?.uv?.kind === "box";
  const list = cubes.map((c) => ({ group: c.bone === "(root)" ? null : c.bone, index: c.index, box: isBoxCube(c) })).filter((c) => refs.some((r) => r.group === (c.group ?? "(root)") && r.index === c.index));
  if (!list.length) return false;
  const faces: readonly Face[] = scope === "all" ? FACES : s.uvFaces;
  // box-UV cubes carry one texture for all six faces (Blockbench)
  let doc = setBbFaceTexture(s.doc, { cubes: list.filter((c) => !c.box), faces, texture: index });
  doc = setBbFaceTexture(doc, { cubes: list.filter((c) => c.box), faces: FACES, texture: index });
  api.commit(doc, "Apply Texture");
  return true;
}
