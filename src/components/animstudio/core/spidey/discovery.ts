/**
 * Finding pose sets for an animation file.
 *
 * Spidey-aware mode applies to `.../assets/<ns>/animations/armor/*.animation.json` when a `poses/*.json` exists
 * somewhere in the same source tree (Thematic splits resources over `src/common`, `src/packs/*`, …).
 */
import { parsePoseSet, type PoseSet } from "./poseSet";

export interface DirEntry {
  name: string;
  isDir: boolean;
}
/** The minimal file-system the UI provides (local or ssh). Paths use "/" separators. */
export interface FsLike {
  listDir(path: string): Promise<DirEntry[]>;
  readFile(path: string): Promise<string>;
}

const SKIP = new Set(["build", ".git", "node_modules", ".gradle", ".claude", ".idea", "test", "out", "run", "runs"]);

export interface ArmorAnimLocation {
  /** `.../assets/<ns>` */
  assetsRoot: string;
  namespace: string;
  /** Directory to search for pose sets (the `src` folder, or the assets' pack root when there is none). */
  treeRoot: string;
}

/** Parse a path; undefined unless it is under `assets/<ns>/animations/armor/`. */
export function armorAnimLocation(filePath: string): ArmorAnimLocation | undefined {
  const p = filePath.replace(/\\/g, "/");
  const m = /^(.*\/assets\/([^/]+))\/animations\/armor\/[^/]+$/.exec(p);
  if (!m) return undefined;
  const assetsRoot = m[1];
  const before = assetsRoot.slice(0, assetsRoot.indexOf("/assets/" + m[2]));
  const srcIdx = before.lastIndexOf("/src");
  const treeRoot = srcIdx >= 0 && (before.length === srcIdx + 4 || before[srcIdx + 4] === "/") ? before.slice(0, srcIdx + 4) : before;
  return { assetsRoot, namespace: m[2], treeRoot };
}

/** True when `path` is an armor animation file (cheap check; no I/O). */
export const isArmorAnimationPath = (path: string) => armorAnimLocation(path) !== undefined && /\.animation\.json$/.test(path);

export interface FoundPoseSet {
  path: string;
  /** Pose dir is next to the animation file's own assets root. */
  sameAssetsRoot: boolean;
  set: PoseSet;
}

/**
 * Locate and parse every `poses/*.json` for the animation file at `filePath`, searching `<assets>/poses`
 * first and then (breadth-first, bounded) the rest of the source tree for `assets/<ns>/poses`.
 */
export async function findPoseSets(filePath: string, fs: FsLike, opts: { maxDirs?: number; maxDepth?: number } = {}): Promise<FoundPoseSet[]> {
  const loc = armorAnimLocation(filePath);
  if (!loc) return [];
  const poseDirs: string[] = [];
  const seen = new Set<string>();
  const addDir = (d: string) => {
    if (!seen.has(d)) {
      seen.add(d);
      poseDirs.push(d);
    }
  };
  const tryList = async (d: string) => {
    try {
      return await fs.listDir(d);
    } catch {
      return undefined;
    }
  };
  if (await tryList(loc.assetsRoot + "/poses")) addDir(loc.assetsRoot + "/poses");

  let budget = opts.maxDirs ?? 1500;
  const maxDepth = opts.maxDepth ?? 6;
  let level = [loc.treeRoot];
  for (let depth = 0; depth <= maxDepth && level.length && budget > 0; depth++) {
    const next: string[] = [];
    for (const dir of level) {
      if (budget-- <= 0) break;
      const entries = await tryList(dir);
      if (!entries) continue;
      const base = dir.slice(dir.lastIndexOf("/") + 1);
      for (const e of entries) {
        if (!e.isDir || SKIP.has(e.name) || e.name.startsWith(".")) continue;
        if (base === "assets") {
          // dir = .../assets ; e = namespace
          const pd = `${dir}/${e.name}/poses`;
          if (e.name === loc.namespace && (await tryList(pd))) addDir(pd);
          continue; // never descend into assets/<ns>
        }
        next.push(`${dir}/${e.name}`);
      }
    }
    level = next;
  }

  const out: FoundPoseSet[] = [];
  for (const dir of poseDirs) {
    const entries = (await tryList(dir)) ?? [];
    for (const e of entries.slice().sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isDir || !e.name.endsWith(".json")) continue;
      const path = `${dir}/${e.name}`;
      try {
        const text = await fs.readFile(path);
        out.push({ path, sameAssetsRoot: dir === loc.assetsRoot + "/poses", set: parsePoseSet(text, e.name.replace(/\.json$/, ""), path) });
      } catch {
        /* unreadable: skip */
      }
    }
  }
  return out;
}
