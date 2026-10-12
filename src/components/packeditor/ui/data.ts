/** Async loaders shared by the views: a suit's model and texture, ability scripts by id, flight profiles with inheritance. */
import { useEffect, useState } from "react";
import { parseDoc } from "../../animstudio/core";
import { playerRigModel, rigFromGeo, type RigModel } from "../../animstudio/ui/model";
import { loadImage } from "../../animstudio/ui/resolve";
import { abilityName, nsOf } from "../core/suit";
import { scanCatalog, type Catalog, type SourceFile } from "../core/catalog";
import { fs, type Location } from "../../../lib/ipc";
import { findByName, findInRoots, readText } from "./resolve";

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[], initial: T): [T, boolean] {
  const [v, setV] = useState<{ v: T; loading: boolean }>({ v: initial, loading: true });
  useEffect(() => {
    let dead = false;
    setV((s) => ({ ...s, loading: true }));
    fn().then((x) => { if (!dead) setV({ v: x, loading: false }); }, () => { if (!dead) setV({ v: initial, loading: false }); });
    return () => { dead = true; };
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return [v.v, v.loading];
}

export interface SuitModel { rig: RigModel; texture: HTMLImageElement | null; geoPath: string | null; texPath: string | null }

/** `assets/<ns>/geo/armor/<id>.geo.json` + `textures/armor/<id>.png` (CharacterModel's lookups); the plain player when missing. */
export async function loadSuitModel(host: string, roots: string[], ns: string, id: string): Promise<SuitModel> {
  const geoPath = await findInRoots(host, roots, `assets/${ns}/geo/armor/${id}.geo.json`);
  let rig: RigModel | null = null;
  if (geoPath) {
    const text = await readText(host, geoPath);
    if (text) { try { rig = rigFromGeo(parseDoc(text, "geo")); } catch { rig = null; } }
  }
  const texPath = await findInRoots(host, roots, `assets/${ns}/textures/armor/${id}.png`);
  const texture = texPath ? await loadImage(host, texPath) : null;
  return { rig: rig ?? playerRigModel(), texture: rig ? texture : null, geoPath, texPath };
}

const abilityCache = new Map<string, Promise<string | null>>();
/** The script (or JSON) behind an ability id, searched under data/<ns>/abilities of every root. */
export function abilityPath(host: string, roots: string[], id: string): Promise<string | null> {
  const key = host + ":" + roots[0] + ":" + id;
  let p = abilityCache.get(key);
  if (!p) {
    const name = abilityName(id);
    p = findByName(host, roots, nsOf(id), "abilities", [name + ".js", name + ".json"], 5);
    abilityCache.set(key, p);
  }
  return p;
}

export interface FlightJet { index: number; anchor: string; when?: string; aim?: string; flame?: Record<string, unknown>; raw: Record<string, unknown>; from: string }
export interface Flight { id: string; path: string | null; chain: string[]; jets: FlightJet[]; raw: Record<string, unknown> | null }

/** A flight profile and what it inherits (`parent`): the jets of the nearest profile that declares any. */
export async function loadFlight(host: string, roots: string[], id: string): Promise<Flight> {
  const chain: string[] = [];
  let cur: string | undefined = id;
  let first: { path: string | null; raw: Record<string, unknown> | null } | null = null;
  let jets: FlightJet[] | null = null;
  for (let guard = 0; cur && guard < 8; guard++) {
    const path = await findByName(host, roots, nsOf(cur), "flight_profiles", [abilityName(cur) + ".json"], 3);
    if (!path) break;
    chain.push(path);
    const t = await readText(host, path);
    let raw: Record<string, unknown> | null = null;
    try { raw = t ? JSON.parse(t) : null; } catch { raw = null; }
    if (!first) first = { path, raw };
    const list = (raw?.effects as { jets?: unknown } | undefined)?.jets;
    if (!jets && Array.isArray(list)) {
      jets = list.map((j: Record<string, unknown>, index) => ({
        index, anchor: String(j?.anchor ?? ""), when: j?.when as string | undefined, aim: j?.aim as string | undefined,
        flame: j?.flame as Record<string, unknown> | undefined, raw: j ?? {}, from: path,
      }));
    }
    cur = typeof raw?.parent === "string" ? raw.parent : undefined;
  }
  return { id, path: first?.path ?? null, chain, jets: jets ?? [], raw: first?.raw ?? null };
}

/** `flight_type` shorthand -> the shipped profile of that name. */
export const flightIdOf = (profile: string | undefined, type: string | undefined) =>
  profile ?? (type ? "thematic:" + type.toLowerCase() : "thematic:no_hands");

// ---------------------------------------------------------------- the project's catalog (what a suit can name)

const at = (host: string, path: string): Location => ({ host, path });
const SKIP_DIRS = new Set(["test", "tests", "build", "out", "run", "runs", "bin", "generated", "node_modules", "testpacks"]);
const catalogCache = new Map<string, Promise<Catalog>>();
/** Forget the scanned catalogs, so the next `loadCatalog` reads the files again (a file was just created). */
export const clearCatalogCache = () => catalogCache.clear();

/** Every file under `dir` whose name ends in one of `exts` (depth-limited; folders in SKIP_DIRS are not read). */
async function filesUnder(host: string, dir: string, exts: string[], depth: number, out: Array<{ path: string }> = []): Promise<Array<{ path: string }>> {
  const es = await fs.listDir(at(host, dir)).catch(() => []);
  for (const e of es) {
    if (e.isDir) { if (depth > 0 && !SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) await filesUnder(host, e.path, exts, depth - 1, out); continue; }
    if (exts.some((x) => e.name.endsWith(x))) out.push({ path: e.path });
  }
  return out;
}

async function dirsOf(host: string, dir: string): Promise<string[]> {
  const es = await fs.listDir(at(host, dir)).catch(() => []);
  return es.filter((e) => e.isDir && !e.name.startsWith(".")).map((e) => e.name).sort();
}

/** Read `paths` a few at a time (a project has thousands of suits). */
async function readAll(host: string, paths: Array<{ path: string }>): Promise<SourceFile[]> {
  const out: SourceFile[] = [];
  for (let i = 0; i < paths.length; i += 32) {
    const part = paths.slice(i, i + 32);
    const texts = await Promise.all(part.map((f) => readText(host, f.path)));
    part.forEach((f, j) => { if (texts[j] !== null) out.push({ path: f.path, text: texts[j]! }); });
  }
  return out;
}

/**
 * The project's catalog for namespace `ns`, read once per set of resource roots: every ability script of every namespace, the
 * suits, flight profiles and lang files of `ns` (the lang files of every namespace, for keybind names).
 */
export function loadCatalog(host: string, roots: string[], ns: string): Promise<Catalog> {
  const key = host + ":" + ns + ":" + roots.join("|");
  let p = catalogCache.get(key);
  if (!p) {
    p = (async () => {
      const files: SourceFile[] = [];
      for (const r of roots) {
        for (const nsDir of await dirsOf(host, `${r}/data`)) {
          const base = `${r}/data/${nsDir}`;
          files.push(...(await readAll(host, await filesUnder(host, `${base}/abilities`, [".js", ".json"], 6))));
          if (nsDir === ns) {
            files.push(...(await readAll(host, await filesUnder(host, `${base}/armors`, [".json"], 6))));
            files.push(...(await readAll(host, await filesUnder(host, `${base}/flight_profiles`, [".json"], 3))));
          }
        }
        for (const langNs of await dirsOf(host, `${r}/assets`)) {
          const lang = `${r}/assets/${langNs}/lang/en_us.json`;
          const t = await readText(host, lang);
          if (t !== null) files.push({ path: lang, text: t });
        }
      }
      return scanCatalog(files, ns);
    })();
    catalogCache.set(key, p);
    p.catch(() => catalogCache.delete(key));
  }
  return p;
}
