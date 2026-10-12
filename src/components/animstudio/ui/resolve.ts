/** Locating the model / texture / sibling animation files of a Studio document (walks up to `assets/<ns>/`). */
import { fs, invoke, type Location } from "../../../lib/ipc";
import { discoverVariants, mergeGeoTextures, type FsLike, type GeoTexState } from "../core";

export interface AssetPath {
  assetsRoot: string;
  namespace: string;
  /** `armor`, `entity/foo` … (the folder below geo/ animations/ textures/) */
  kind: string;
  stem: string;
  type: "geo" | "animation";
}

export function assetPath(path: string): AssetPath | null {
  const m = /^(.*\/assets\/([^/]+))\/(geo|animations)\/(?:(.+)\/)?([^/]+?)\.(geo|animation)\.json$/.exec(path.replace(/\\/g, "/"));
  if (!m) return null;
  return { assetsRoot: m[1], namespace: m[2], kind: m[4] ?? "", stem: m[5], type: m[6] as "geo" | "animation" };
}

const at = (host: string, path: string): Location => ({ host, path });
const exists = (host: string, path: string) => fs.stat(at(host, path)).then((s) => s.exists && s.isFile, () => false);

export function fsLike(host: string): FsLike {
  return {
    listDir: (p) => fs.listDir(at(host, p)).then((es) => es.map((e) => ({ name: e.name, isDir: e.isDir }))),
    readFile: (p) => fs.readFile(at(host, p)),
  };
}

export async function findTexture(host: string, geoPath: string): Promise<string | null> {
  const a = assetPath(geoPath);
  if (!a) return null;
  const cand = `${a.assetsRoot}/textures/${a.kind ? a.kind + "/" : ""}${a.stem}.png`;
  return (await exists(host, cand)) ? cand : null;
}

export async function findSiblingAnimation(host: string, geoPath: string): Promise<string | null> {
  const a = assetPath(geoPath);
  if (!a) return null;
  const cand = `${a.assetsRoot}/animations/${a.kind ? a.kind + "/" : ""}${a.stem}.animation.json`;
  return (await exists(host, cand)) ? cand : null;
}

export async function findSiblingGeo(host: string, animPath: string): Promise<string | null> {
  const a = assetPath(animPath);
  if (!a) return null;
  const cand = `${a.assetsRoot}/geo/${a.kind ? a.kind + "/" : ""}${a.stem}.geo.json`;
  return (await exists(host, cand)) ? cand : null;
}

/** Geos available as a preview model for an animation file: the same kind folder first, then other folders (bounded). */
export async function listGeos(host: string, animPath: string): Promise<string[]> {
  const a = assetPath(animPath);
  if (!a) return [];
  const out: string[] = [];
  const walk = async (dir: string, depth: number) => {
    let es;
    try { es = await fs.listDir(at(host, dir)); } catch { return; }
    es.sort((x, y) => x.name.localeCompare(y.name));
    for (const e of es) {
      if (e.isDir) { if (depth < 2) await walk(e.path, depth + 1); }
      else if (e.name.endsWith(".geo.json")) out.push(e.path);
    }
  };
  await walk(`${a.assetsRoot}/geo/${a.kind.split("/")[0] ?? ""}`.replace(/\/$/, ""), 0);
  return out.slice(0, 400);
}

export async function loadImage(host: string, path: string): Promise<HTMLImageElement | null> {
  try {
    const bytes = await fs.readBytes(at(host, path));
    const url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
    return await new Promise((res) => {
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); res(img); };
      img.onerror = () => { URL.revokeObjectURL(url); res(null); };
      img.src = url;
    });
  } catch { return null; }
}

// ---- remembered preview model per animation file: app data (ui prefs), never the repo
const PREF = "animstudio";
interface Prefs { previewModel?: Record<string, string>; layout?: Record<string, number[]>; projectModel?: Record<string, string>; geoTextures?: Record<string, GeoTexState> }
let cache: Prefs | null = null;
async function load(): Promise<Prefs> {
  if (cache) return cache;
  try {
    const t = await invoke<string | null>("ui_pref_get", { name: PREF });
    cache = t ? JSON.parse(t) : {};
  } catch { cache = {}; }
  return cache!;
}
export async function getPreviewModel(animPath: string): Promise<string | null> {
  return (await load()).previewModel?.[animPath] ?? null;
}
export async function setPreviewModel(animPath: string, geoPath: string | null) {
  const p = await load();
  p.previewModel = { ...p.previewModel };
  if (geoPath) p.previewModel[animPath] = geoPath; else delete p.previewModel[animPath];
  await invoke("ui_pref_set", { name: PREF, value: JSON.stringify(p) }).catch(() => {});
}

// ---- project-level default preview model (app data, never the repo)
/**
 * Stable project key of a file: the path before `/src/` when the file lives in a Gradle-style tree
 * (`<repo>/src/<set>/resources/assets/...`), else the path before `/assets/`.
 */
export function projectRootOf(path: string): string | null {
  const p = path.replace(/\\/g, "/");
  const i = p.indexOf("/src/");
  if (i > 0) return p.slice(0, i);
  const j = p.indexOf("/assets/");
  return j > 0 ? p.slice(0, j) : null;
}
export async function getProjectModel(animPath: string): Promise<string | null> {
  const r = projectRootOf(animPath);
  return r ? (await load()).projectModel?.[r] ?? null : null;
}
export async function setProjectModel(animPath: string, geoPath: string | null): Promise<void> {
  const r = projectRootOf(animPath);
  if (!r) return;
  const p = await load();
  p.projectModel = { ...p.projectModel };
  if (geoPath) p.projectModel[r] = geoPath; else delete p.projectModel[r];
  await invoke("ui_pref_set", { name: PREF, value: JSON.stringify(p) }).catch(() => {});
}

/**
 * `assets/thematic/geo/armor/spiderman.geo.json` of the same project as an ARMOR animation file: the pack the file is in first,
 * then `src/common` and the other `src/packs/*` resource sets. Bounded (one listDir of src/packs).
 */
export async function findSpidermanGeo(host: string, animPath: string): Promise<string | null> {
  const a = assetPath(animPath);
  if (!a || a.kind.split("/")[0] !== "armor") return null;
  const rel = `assets/${a.namespace}/geo/armor/spiderman.geo.json`;
  const own = `${a.assetsRoot}/geo/armor/spiderman.geo.json`;
  if (await exists(host, own)) return own;
  const root = projectRootOf(animPath);
  if (!root) return null;
  const cands = [`${root}/src/common/resources/${rel}`];
  try {
    const packs = await fs.listDir(at(host, `${root}/src/packs`));
    for (const e of packs) if (e.isDir) cands.push(`${e.path}/resources/${rel}`);
  } catch { /* no packs dir */ }
  for (const c of cands.slice(0, 40)) if (await exists(host, c)) return c;
  return null;
}

// ---- geo preview texture layers per geo file: app data only (Bedrock geometry has ONE texture slot in game)
export async function getGeoTextures(geoPath: string): Promise<GeoTexState | undefined> {
  return (await load()).geoTextures?.[geoPath];
}
export async function setGeoTextures(geoPath: string, st: GeoTexState): Promise<void> {
  const p = await load();
  p.geoTextures = { ...p.geoTextures, [geoPath]: st };
  await invoke("ui_pref_set", { name: PREF, value: JSON.stringify(p) }).catch(() => {});
}
/** Saved layer list reconciled with the disk: the default `<stem>.png` first, `<stem>_*.png` next to it appended hidden. */
export async function resolveGeoTextures(host: string, geoPath: string): Promise<GeoTexState> {
  const def = await findTexture(host, geoPath);
  let variants: string[] = [];
  if (def) {
    try {
      const dir = def.slice(0, def.lastIndexOf("/"));
      variants = discoverVariants(def, (await fs.listDir(at(host, dir))).filter((e) => !e.isDir).map((e) => e.name));
    } catch { /* unreadable dir */ }
  }
  const saved = await getGeoTextures(geoPath);
  const known = new Set<string>();
  const files = [...(saved?.layers.map((l) => l.path) ?? []), ...(def ? [def] : []), ...variants];
  await Promise.all(files.map((f) => exists(host, f).then((ok) => { if (ok) known.add(f); })));
  return mergeGeoTextures(saved, def, variants, (f) => known.has(f));
}
