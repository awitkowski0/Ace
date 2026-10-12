/** Flight-profile helpers that need the file system: the poses a profile inherits, and opening a profile by id. */
import { openFile } from "../../../editor/store";
import { fs } from "../../../lib/ipc";
import { getAnimations, parseDoc, type Animation } from "../../animstudio/core";
import { newFlightProfileText } from "../core/flight";
import { packRoot } from "../core/kinds";
import { abilityName, nsOf } from "../core/suit";
import { clearCatalogCache } from "./data";
import { exists, findByName, readText, resourceRoots } from "./resolve";

/** The `poses` object of each profile up the `parent` chain, nearest first (undefined where a profile has none). */
export async function loadPoseChain(host: string, roots: string[], parentId: string | undefined): Promise<Array<Record<string, unknown> | undefined>> {
  const out: Array<Record<string, unknown> | undefined> = [];
  const seen = new Set<string>();
  for (let cur = parentId; cur && !seen.has(cur) && out.length < 8;) {
    seen.add(cur);
    const path = await findByName(host, roots, nsOf(cur), "flight_profiles", [abilityName(cur) + ".json"], 3);
    if (!path) break;
    let raw: Record<string, unknown> | null = null;
    try { raw = JSON.parse((await readText(host, path)) ?? "null"); } catch { raw = null; }
    out.push((raw?.poses ?? undefined) as Record<string, unknown> | undefined);
    cur = typeof raw?.parent === "string" ? raw.parent : undefined;
  }
  return out;
}

/**
 * Open flight profile `id` (e.g. `thematic:repulsor`, a suit's `flight_profile`) in its designer. `fromPath` is any pack file of
 * the same project (the suit being edited); the profile is looked up in that project's resource roots. Resolves false when
 * no such profile is found.
 */
export async function openFlightProfile(host: string, fromPath: string, id: string): Promise<boolean> {
  const roots = await resourceRoots(host, fromPath);
  const path = await findByName(host, roots, nsOf(id), "flight_profiles", [abilityName(id) + ".json"], 3);
  if (!path) return false;
  void openFile({ host, path });
  return true;
}


const clipCache = new Map<string, Promise<Animation | null>>();
const dirs = async (host: string, dir: string) => (await fs.listDir({ host, path: dir }).catch(() => [])).filter((e) => e.isDir);
const jsonFiles = async (host: string, dir: string, depth: number): Promise<string[]> => {
  const out: string[] = [];
  for (const e of await fs.listDir({ host, path: dir }).catch(() => [])) {
    if (!e.isDir && e.name.endsWith(".json")) out.push(e.path);
    else if (e.isDir && depth > 0) out.push(...(await jsonFiles(host, e.path, depth - 1)));
  }
  return out;
};

/**
 * The player-animator clip `name` (a `poses.hoverIdle` / `poses.loop` id such as `super.flight.idle`): the animation of that
 * name in any `assets/<ns>/animations/armor/**.json` of the project (PlayerAnimationRegistry loads them all, keyed by the
 * lower-cased name), read with the player rules. Null when no file has it. Flight files and the thematic namespace go first.
 */
export function loadClip(host: string, roots: string[], name: string): Promise<Animation | null> {
  const key = host + ":" + roots.join("|") + ":" + name;
  let p = clipCache.get(key);
  if (!p) {
    p = (async () => {
      const want = name.toLowerCase();
      for (const r of roots) {
        const nss = (await dirs(host, `${r}/assets`)).sort((a, b) => Number(b.name === "thematic") - Number(a.name === "thematic"));
        for (const ns of nss) {
          const files = (await jsonFiles(host, `${ns.path}/animations/armor`, 3)).sort((a, b) => Number(/flight/.test(b)) - Number(/flight/.test(a)));
          for (const f of files) {
            const text = await readText(host, f);
            if (!text || !text.toLowerCase().includes(want)) continue;
            try {
              const hit = getAnimations(parseDoc(text, "animation", "player")).find((a) => a.name.toLowerCase().replace(/^animation\./, "") === want || a.name.toLowerCase() === want);
              if (hit) return hit;
            } catch { /* an unreadable file has no clips */ }
          }
        }
      }
      return null;
    })();
    clipCache.set(key, p);
  }
  return p;
}

/**
 * Create flight profile `<ns>:<id>` as `{ "parent": <parent> }` in the same pack as `fromPath` (any file of that pack's
 * data/<ns>/): `<resources root>/data/<ns>/flight_profiles/<id>.json`. Refreshes the catalog; resolves the new file's path.
 */
export async function createFlightProfile(host: string, fromPath: string, id: string, parent: string): Promise<string> {
  const pr = packRoot(fromPath);
  if (!pr) throw new Error("Not a pack file");
  const path = `${pr.root}/data/${pr.ns}/flight_profiles/${id}.json`;
  if (await exists(host, path)) throw new Error(`${id} already exists`);
  await fs.writeFile({ host, path }, newFlightProfileText(parent));
  clearCatalogCache();
  return path;
}
