/**
 * Finding the files a pack file points at: a suit's model and texture, an ability script by id, a flight profile and the
 * profiles it inherits from, translations. A project can spread one namespace over several resource roots (Thematic:
 * src/common/resources plus src/packs/<pack>/resources), so lookups try every root, nearest first.
 */
import { fs, type Location } from "../../../lib/ipc";
import { packRoot } from "../core/kinds";

const at = (host: string, path: string): Location => ({ host, path });
const rootsCache = new Map<string, Promise<string[]>>();
/** Folders that hold copies or fixtures, never the pack itself. */
const SKIP = new Set(["test", "tests", "build", "out", "run", "runs", "bin", "generated", "node_modules", "testpacks"]);

/** Every resource root of the project the file is in: its own first, then siblings (packs/*), then common/main ones. */
export function resourceRoots(host: string, path: string): Promise<string[]> {
  const own = packRoot(path)?.root;
  if (!own) return Promise.resolve([]);
  const key = host + ":" + own;
  let p = rootsCache.get(key);
  if (!p) {
    p = (async () => {
      const out = [own];
      const add = (r: string) => { if (!out.includes(r)) out.push(r); };
      const parts = own.split("/");
      // up to four levels up, look for */resources folders: packs/<x>/resources, common/resources, main/resources
      for (let up = 2; up <= 4 && parts.length - up > 1; up++) {
        const base = parts.slice(0, parts.length - up).join("/");
        const kids = await fs.listDir(at(host, base)).catch(() => []);
        for (const k of kids) {
          if (!k.isDir || SKIP.has(k.name) || k.name.startsWith(".")) continue;
          if (k.name === "resources") add(k.path);
          else {
            const grand = await fs.listDir(at(host, k.path)).catch(() => []);
            if (grand.some((g) => g.isDir && g.name === "resources")) add(k.path + "/resources");
          }
        }
      }
      return out;
    })();
    rootsCache.set(key, p);
  }
  return p;
}

export async function exists(host: string, path: string): Promise<boolean> {
  try { return (await fs.stat(at(host, path))).exists; } catch { return false; } // stat answers `exists: false` for a missing path, it does not throw
}

/** First root holding `rel` (e.g. `assets/thematic/geo/armor/iron_man.geo.json`). */
export async function findInRoots(host: string, roots: string[], rel: string): Promise<string | null> {
  for (const r of roots) if (await exists(host, `${r}/${rel}`)) return `${r}/${rel}`;
  return null;
}

/** Search a folder tree (depth-limited) for a file named `name` under `data/<ns>/<folder>` of every root. */
export async function findByName(host: string, roots: string[], ns: string, folder: string, names: string[], depth = 4): Promise<string | null> {
  for (const r of roots) {
    const hit = await walkFind(host, `${r}/data/${ns}/${folder}`, names, depth);
    if (hit) return hit;
  }
  return null;
}

async function walkFind(host: string, dir: string, names: string[], depth: number): Promise<string | null> {
  const es = await fs.listDir(at(host, dir)).catch(() => null);
  if (!es) return null;
  for (const e of es) if (!e.isDir && names.includes(e.name)) return e.path;
  if (depth <= 0) return null;
  for (const e of es) if (e.isDir) {
    const hit = await walkFind(host, e.path, names, depth - 1);
    if (hit) return hit;
  }
  return null;
}

/** Every file under `data/<ns>/<folder>` of every root, with its id (path inside the folder, no extension). */
export async function listData(host: string, roots: string[], ns: string, folder: string, exts: string[], depth = 4): Promise<Array<{ id: string; path: string }>> {
  const out: Array<{ id: string; path: string }> = [];
  const seen = new Set<string>();
  const walk = async (base: string, dir: string, d: number) => {
    const es = await fs.listDir(at(host, dir)).catch(() => []);
    for (const e of es) {
      if (e.isDir) { if (d > 0) await walk(base, e.path, d - 1); continue; }
      const ext = exts.find((x) => e.name.endsWith(x));
      if (!ext) continue;
      const id = e.name.slice(0, -ext.length);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id, path: e.path });
    }
  };
  for (const r of roots) await walk(`${r}/data/${ns}/${folder}`, `${r}/data/${ns}/${folder}`, depth);
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export async function readText(host: string, path: string): Promise<string | null> {
  try { return await fs.readFile(at(host, path)); } catch { return null; }
}

/** en_us translations of every root, merged (own root wins). */
const langCache = new Map<string, Promise<Record<string, string>>>();
export function translations(host: string, roots: string[], ns: string): Promise<Record<string, string>> {
  const key = host + ":" + roots.join("|") + ":" + ns;
  let p = langCache.get(key);
  if (!p) {
    p = (async () => {
      const out: Record<string, string> = {};
      for (const r of [...roots].reverse()) {
        const t = await readText(host, `${r}/assets/${ns}/lang/en_us.json`);
        if (!t) continue;
        try { Object.assign(out, JSON.parse(t)); } catch { /* a broken lang file reads as empty */ }
      }
      return out;
    })();
    langCache.set(key, p);
  }
  return p;
}

/** Forget the merged translations, so the next lookup reads the lang files again (one was just edited). */
export const clearLangCache = () => langCache.clear();

export const tr = (lang: Record<string, string>, key: unknown) => (typeof key === "string" ? lang[key] ?? key : "");
