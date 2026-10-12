/** Pure asset-file logic for the Asset Dev profile (docs/PROFILES.md): classification, grouping, suggested commit messages, templates. */

export type AssetType = "model" | "animation" | "texture" | "sound" | "lang" | "pose" | "particle" | "controller" | "data" | "other";
export type AssetKind = "armor" | "item" | "entity" | "block";
export interface AssetInfo {
  type: AssetType;
  kind: AssetKind | null;
  /** file name without its extension(s): `web_wall_hold` */
  name: string;
  /** folder below the kind (or type) directory, "" when directly inside */
  sub: string;
  /** shown in the Assets tree (everything but `other`) */
  inTree: boolean;
}

/** git pathspecs that cover every file classifyAsset() can accept without config (the tree lists these only) */
export const ASSET_PATHSPECS = [
  ":(glob)**/assets/**", ":(glob)**/*.bbmodel", ":(glob)**/*.geo.json", ":(glob)**/*.animation.json", ":(glob)**/*.pose",
  ":(glob)**/textures/**", ":(glob)**/sounds/**", ":(glob)**/*_sounds/**",
  ":(glob)**/data/*/anim_controllers/**", ":(glob)**/data/*/poses/**",
];

// ---------- repo config: `.ace/config.json` "assets" section (docs/PROFILES.md) ----------
type Extra = string | { glob?: unknown; type?: unknown; kind?: unknown };
export interface AssetRules {
  /** extra files that count as assets and show in the tree (type defaults to what the folders say, else "data") */
  include: { glob: string; re: RegExp; type: AssetType | null; kind: AssetKind | null }[];
  /** files that stay assets (committable) but are left out of the tree */
  hide: { glob: string; re: RegExp }[];
  /** assets/<namespace> folder where new armor suits go (instead of guessing the one with the most armor models), project-relative */
  suitRoot: string | null;
  /** how a branch name maps to the branch it was started from: first matching `branch` regex wins, `$1` is a capture */
  baseBranch: { re: RegExp; base: string }[];
  /** new-branch prefix template: {user} (slug) and {base} (the matched base branch without `origin/`) */
  branchPrefix: string | null;
}
export const NO_RULES: AssetRules = { include: [], hide: [], suitRoot: null, baseBranch: [], branchPrefix: null };

/** gitignore-style glob: `**` crosses folders, `*`/`?` stay inside one; a pattern without `/` matches a name anywhere */
export function globToRegExp(glob: string): RegExp {
  let g = glob.trim().replace(/^\.?\//, "");
  if (!g.includes("/")) g = "**/" + g;
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*" && g[i + 1] === "*") {
      if (g[i + 2] === "/") { re += "(?:.*/)?"; i += 2; } else { re += ".*"; i += 1; }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re + "$", "i");
}
const TYPES = new Set<string>(["model", "animation", "texture", "sound", "lang", "pose", "particle", "controller", "data", "other"]);
const KINDS = new Set<string>(["armor", "item", "entity", "block"]);
const tryRe = (s: unknown): RegExp | null => { try { return typeof s === "string" && s ? new RegExp(s) : null; } catch { return null; } };

/** Parses the raw `assets` section; anything malformed is ignored (a typo must never break the tree). */
export function parseAssetRules(raw: unknown): AssetRules {
  if (!raw || typeof raw !== "object") return NO_RULES;
  const o = raw as Record<string, unknown>;
  const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const include = list(o.include).flatMap((e) => {
    const x = (typeof e === "string" ? { glob: e } : e) as Exclude<Extra, string>;
    if (!x || typeof x.glob !== "string" || !x.glob.trim()) return [];
    return [{ glob: x.glob.trim(), re: globToRegExp(x.glob), type: TYPES.has(String(x.type)) ? (x.type as AssetType) : null, kind: KINDS.has(String(x.kind)) ? (x.kind as AssetKind) : null }];
  });
  const hide = list(o.hide).flatMap((e) => (typeof e === "string" && e.trim() ? [{ glob: e.trim(), re: globToRegExp(e) }] : []));
  const bb = o.baseBranch;
  const baseBranch = (Array.isArray(bb) ? bb : bb ? [bb] : []).flatMap((e: { branch?: unknown; base?: unknown }) => {
    const re = tryRe(e?.branch);
    return re && typeof e.base === "string" && e.base ? [{ re, base: e.base }] : [];
  });
  const nr = typeof o.suitRoot === "string" ? o.suitRoot.trim().replace(/^\.?\/|\/+$/g, "") : "";
  return { include, hide, suitRoot: nr || null, baseBranch, branchPrefix: typeof o.branchPrefix === "string" && o.branchPrefix.trim() ? o.branchPrefix.trim() : null };
}
let rules: AssetRules = NO_RULES;
export const setAssetRules = (r: AssetRules) => { rules = r; };
export const getAssetRules = () => rules;
/** ASSET_PATHSPECS plus the config's `include` globs */
export const assetPathspecs = (r: AssetRules = rules) => [...ASSET_PATHSPECS, ...r.include.map((i) => ":(glob)" + (i.glob.includes("/") ? i.glob.replace(/^\.?\//, "") : "**/" + i.glob))];

const EXCLUDED = new Set(["build", ".gradle", "node_modules", ".git", ".claude", ".idea", "run", "runs", "minecraft-src", "target", "out", "dist"]);
const TYPE_DIRS: Record<string, AssetType> = { geo: "model", ".geo": "model", models: "model", animations: "animation", textures: "texture", sounds: "sound", poses: "pose", lang: "lang", particles: "particle", anim_controllers: "controller" };
const KIND_DIRS: Record<string, AssetKind> = { armor: "armor", item: "item", items: "item", entity: "entity", block: "block", blocks: "block" };
const CODE_EXT = new Set(["java", "kt", "kts", "gd", "py", "rs", "ts", "tsx", "js", "mjs", "cjs", "jsx", "gradle", "sh", "toml", "properties", "yml", "yaml", "xml", "md", "txt", "cs", "c", "h", "cpp", "go", "rb", "lock", "accesswidener", "bat", "cmd"]);
const SOUND_EXT = new Set(["ogg", "wav", "mp3", "flac"]);
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "mcmeta"]);

export const extOf = (p: string) => { const b = p.slice(p.lastIndexOf("/") + 1); const i = b.lastIndexOf("."); return i < 0 ? "" : b.slice(i + 1).toLowerCase(); };
export function assetName(file: string): string {
  const b = file.slice(file.lastIndexOf("/") + 1);
  for (const s of [".geo.json", ".animation.json", ".geo.bbmodel", ".bbmodel", ".pose"]) if (b.toLowerCase().endsWith(s)) return b.slice(0, -s.length);
  const i = b.lastIndexOf(".");
  return i > 0 ? b.slice(0, i) : b;
}

const bareName = (file: string) => { const i = file.lastIndexOf("."); return i > 0 ? file.slice(0, i) : file; };

/**
 * null = not an asset (code, config, docs, build output ...). `r` = the project's `assets` rules from .ace/config.json:
 * `include` makes extra files assets, `hide` keeps files committable but out of the tree.
 */
export function classifyAsset(rel: string, r: AssetRules = rules): AssetInfo | null {
  const path = rel.replace(/^\.?\//, "");
  const seg = path.split("/");
  const file = seg[seg.length - 1];
  const dirs = seg.slice(0, -1);
  if (!file || dirs.some((d) => EXCLUDED.has(d))) return null;
  if (dirs[0] === "src" && dirs[1] === "test") return null;
  let info = classifyBuiltin(file, dirs);
  const inc = r.include.length && (!info || !info.inTree) ? r.include.find((i) => i.re.test(path)) : undefined;
  if (inc) {
    const t = inc.type ?? (info && info.type !== "other" ? info.type : "data");
    info = { type: t, kind: inc.kind ?? info?.kind ?? null, name: info?.name ?? assetName(file), sub: info?.sub ?? dirs.slice(-1).join("/"), inTree: t !== "other" };
  }
  if (info && info.inTree && r.hide.length && r.hide.some((h) => h.re.test(path))) info = { ...info, inTree: false };
  return info;
}

function classifyBuiltin(file: string, dirs: string[]): AssetInfo | null {
  const lower = file.toLowerCase();
  // data/<namespace>/anim_controllers|poses/**: authored by asset devs even though they live in the data tree
  const di = dirs.indexOf("data");
  if (di >= 0 && !dirs.includes("assets") && dirs.length > di + 2 && (dirs[di + 2] === "anim_controllers" || dirs[di + 2] === "poses")) {
    const isCtl = dirs[di + 2] === "anim_controllers";
    if (!isCtl && CODE_EXT.has(extOf(file))) return null;
    return { type: isCtl ? "controller" : "pose", kind: null, name: bareName(file), sub: dirs.slice(di + 3).join("/"), inTree: true };
  }
  const ext = extOf(file);
  const ai = dirs.indexOf("assets");
  if (ai >= 0 && lower === "sounds.json" && dirs.length === ai + 2) return { type: "sound", kind: null, name: "sounds", sub: "", inTree: true };

  let type: AssetType | null = null;
  let typeAt = -1;
  if (lower.endsWith(".bbmodel") || lower.endsWith(".geo.json")) type = "model";
  else if (lower.endsWith(".animation.json")) type = "animation";
  else if (ext === "pose") type = "pose";
  const from = ai >= 0 ? ai + 2 : 0; // skip assets/<namespace>
  for (let i = from; i < dirs.length && typeAt < 0; i++) {
    const t = TYPE_DIRS[dirs[i]] ?? (dirs[i].endsWith("sounds") && dirs[i] !== "sounds" ? "sound" : undefined);
    if (t) { typeAt = i; if (!type) type = t; }
  }
  if (!type) {
    if (ai < 0) return null;
    type = "other";
  } else if (ai < 0) {
    // outside an assets/ tree only the obvious media types count (png in textures/, ogg in sounds/ ...), never code
    if (CODE_EXT.has(ext)) return null;
    if (type === "texture" && !IMAGE_EXT.has(ext)) return null;
    if (type === "sound" && !SOUND_EXT.has(ext)) return null;
    if (type === "lang") return null;
    if (type === "model" && !/\.(bbmodel|geo\.json|json)$/.test(lower)) return null;
    if (type === "particle" || type === "controller") return null;
  } else if (type !== "other" && type !== "controller" && CODE_EXT.has(ext)) {
    type = "other";
  }
  if (type === "texture" && ai >= 0 && !IMAGE_EXT.has(ext)) type = "other";
  let kind: AssetKind | null = null;
  let kindAt = -1;
  for (let i = Math.max(typeAt, from - 1) + 1; i < dirs.length; i++) {
    const k = KIND_DIRS[dirs[i]];
    if (k) { kind = k; kindAt = i; break; }
  }
  const subStart = kindAt >= 0 ? kindAt + 1 : typeAt >= 0 ? typeAt + 1 : dirs.length;
  return { type, kind, name: assetName(file), sub: dirs.slice(subStart).join("/"), inTree: type !== "other" };
}

export const isAssetPath = (rel: string) => classifyAsset(rel) !== null;

export const TYPE_LABEL: Record<AssetType, string> = { model: "Models", animation: "Animations", texture: "Textures", sound: "Sounds", lang: "Language", pose: "Poses", particle: "Particles", controller: "Animation controllers", data: "Data files", other: "Other files" };
export const KIND_LABEL: Record<AssetKind, string> = { armor: "Armor", item: "Items", entity: "Entities", block: "Blocks" };
export const TYPE_WORD: Record<AssetType, string> = { model: "model", animation: "animation", texture: "texture", sound: "sound", lang: "text", pose: "pose", particle: "particle", controller: "animation controller", data: "data file", other: "file" };

export interface AssetFile { path: string; info: AssetInfo }
export interface AssetSection { id: string; label: string | null; files: AssetFile[] }
export interface AssetGroup { id: string; label: string; kind: AssetKind | null; sections: AssetSection[]; count: number }

const GROUP_ORDER = ["armor", "item", "entity", "block", "sound", "lang", "pose", "particle", "controller", "data", "misc"];
const FLAT = new Set(["sound", "lang", "pose", "particle", "controller", "data"]);
const TYPE_ORDER: AssetType[] = ["model", "animation", "texture", "sound", "lang", "pose", "particle", "controller", "data", "other"];

/** Groups tree files by kind (Armor / Items / Entities / Blocks), then by type; sounds, language, poses, particles and controllers get their own flat groups. */
export function groupAssets(paths: string[], query = ""): AssetGroup[] {
  const q = query.trim().toLowerCase();
  const buckets = new Map<string, Map<AssetType, AssetFile[]>>();
  for (const path of paths) {
    const info = classifyAsset(path);
    if (!info || !info.inTree) continue;
    if (q && !path.toLowerCase().includes(q)) continue;
    const gid: string = info.kind ?? (FLAT.has(info.type) ? info.type : "misc");
    const m = buckets.get(gid) ?? new Map<AssetType, AssetFile[]>();
    buckets.set(gid, m);
    const l = m.get(info.type) ?? [];
    l.push({ path, info });
    m.set(info.type, l);
  }
  const out: AssetGroup[] = [];
  for (const gid of GROUP_ORDER) {
    const m = buckets.get(gid);
    if (!m) continue;
    const flat = FLAT.has(gid);
    const sections: AssetSection[] = TYPE_ORDER.filter((t) => m.has(t)).map((t) => ({
      id: `${gid}/${t}`, label: flat ? null : TYPE_LABEL[t],
      files: m.get(t)!.sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: "base", numeric: true })),
    }));
    const kind = (["armor", "item", "entity", "block"] as const).find((k) => k === gid) ?? null;
    out.push({ id: gid, label: kind ? KIND_LABEL[kind] : gid === "misc" ? "Other" : TYPE_LABEL[gid as AssetType], kind, sections, count: sections.reduce((n, s) => n + s.files.length, 0) });
  }
  return out;
}

export interface ChangeLite { path: string; kind: string; orig?: string | null }

/** Suggested commit message: "Add web_wall_hold animation", "Update 3 animations", "Update 5 assets". */
export function suggestMessage(changes: ChangeLite[]): string {
  const rows = changes.map((c) => ({ c, info: classifyAsset(c.path) })).filter((r) => r.info);
  if (!rows.length) return "";
  const verbOf = (k: string) => (k === "added" || k === "untracked" ? "Add" : k === "deleted" ? "Remove" : k === "renamed" ? "Rename" : "Update");
  const verbs = new Set(rows.map((r) => verbOf(r.c.kind)));
  const verb = verbs.size === 1 ? [...verbs][0] : "Update";
  const types = new Set(rows.map((r) => r.info!.type));
  if (rows.length === 1) {
    const { info } = rows[0];
    return `${verb} ${info!.name} ${TYPE_WORD[info!.type]}`;
  }
  if (types.size === 1) {
    const t = [...types][0];
    const names = rows.map((r) => r.info!.name);
    if (rows.length <= 3) return `${verb} ${names.join(", ")} ${TYPE_WORD[t]}s`;
    return `${verb} ${rows.length} ${TYPE_WORD[t]}s`;
  }
  return `${verb} ${rows.length} assets`;
}

// ---------- branch names ----------
export function userSlug(name: string, email = ""): string {
  const s = (name || email.split("@")[0] || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s || "me";
}
export const branchPrefix = (slug: string) => `assets/${slug}/`;
/** The branch `branch` was started from per the config's `baseBranch` rules ("v1.20.1-wolverine" -> "origin/v1.20.1"), else null (the git module then guesses origin/main). */
export function resolveBase(branch: string | null, r: AssetRules = rules): string | null {
  if (!branch) return null;
  for (const b of r.baseBranch) { const m = b.re.exec(branch); if (m) return b.base.replace(/\$(\d)/g, (_, i) => m[Number(i)] ?? ""); }
  return null;
}
/** Prefix for "New branch for my work": the config's `branchPrefix` ({user}, {base}) when it can be filled in, else assets/<user>/ */
export function newBranchPrefix(slug: string, branch: string | null, r: AssetRules = rules): string {
  if (!r.branchPrefix) return branchPrefix(slug);
  const base = resolveBase(branch, r)?.replace(/^origin\//, "") ?? "";
  if (r.branchPrefix.includes("{base}") && !base) return branchPrefix(slug);
  return r.branchPrefix.replace(/\{base\}/g, base).replace(/\{user\}/g, slug);
}
/** User typed "walk cycle" after the prefix: make a legal branch name ("" when nothing usable). */
export function cleanBranchName(prefix: string, typed: string): string {
  let t = typed.trim();
  if (t.startsWith(prefix)) t = t.slice(prefix.length);
  t = t.toLowerCase().replace(/[^a-z0-9._/-]+/g, "-").replace(/\/{2,}/g, "/").replace(/^[-/.]+|[-/.]+$/g, "").replace(/\.lock$/, "");
  return t ? prefix + t : "";
}

// ---------- templates / placement ----------
/** Directory (project-relative) for a new file of `type`/`kind`: next to existing ones, else derived from any assets/<ns> root. */
export function targetDir(paths: string[], type: AssetType, kind: AssetKind | null, r: AssetRules = rules): string | null {
  if (r.suitRoot && kind === "armor") return `${r.suitRoot}/${type === "model" ? "geo" : type === "texture" ? "textures" : "animations"}${kind ? "/" + kind : ""}`;
  let nsRoot: string | null = null;
  for (const p of paths) {
    const info = classifyAsset(p);
    if (!info) continue;
    const dir = p.slice(0, p.lastIndexOf("/"));
    if (info.type === type && info.kind === kind && !info.sub && p.includes("assets/")) return dir;
    const m = /^(.*?assets\/[^/]+)\//.exec(p);
    if (m && !nsRoot) nsRoot = m[1];
  }
  if (!nsRoot) return null;
  return `${nsRoot}/${type === "model" ? "geo" : type === "texture" ? "textures" : "animations"}${kind ? "/" + kind : ""}`;
}
export const safeName = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");

export function animationTemplate(name: string): string {
  return JSON.stringify({ format_version: "1.8.0", animations: { [`animation.${name}.idle`]: { loop: true, animation_length: 1, bones: {} } } }, null, 2) + "\n";
}
export function modelTemplate(name: string): string {
  return JSON.stringify({
    format_version: "1.12.0",
    "minecraft:geometry": [{
      description: { identifier: `geometry.${name}`, texture_width: 64, texture_height: 64, visible_bounds_width: 2, visible_bounds_height: 2, visible_bounds_offset: [0, 1, 0] },
      bones: [{ name: "root", pivot: [0, 0, 0], cubes: [{ origin: [-4, 0, -4], size: [8, 8, 8], uv: [0, 0] }] }],
    }],
  }, null, 2) + "\n";
}
/** New armor suit skeleton (Thematic's armor rig: biped* bones holding armor* parts, same pivots as the shipped suits). */
export function suitModelTemplate(name: string): string {
  const part = (bone: string, armor: string, pivot: number[], origin: number[], size: number[], uv: number[], extra: string[] = []) => [
    { name: bone, pivot },
    { name: armor, parent: bone, pivot, cubes: [{ origin, size, uv }] },
    ...extra.map((n) => ({ name: n, parent: bone, pivot })),
  ];
  return JSON.stringify({
    format_version: "1.12.0",
    "minecraft:geometry": [{
      description: { identifier: `geometry.${name}`, texture_width: 128, texture_height: 128, visible_bounds_width: 3, visible_bounds_height: 3.5, visible_bounds_offset: [0, 1.25, 0] },
      bones: [
        ...part("bipedHead", "armorHead", [0, 24, 0], [-4, 24, -4], [8, 8, 8], [0, 0]),
        ...part("bipedBody", "armorBody", [0, 24, 0], [-4, 12, -2], [8, 12, 4], [16, 16]),
        ...part("bipedRightArm", "armorRightArm", [-4, 22, 0], [-8, 12, -2], [4, 12, 4], [40, 16]),
        ...part("bipedLeftArm", "armorLeftArm", [4, 22, 0], [4, 12, -2], [4, 12, 4], [32, 48]),
        ...part("bipedLeftLeg", "armorLeftLeg", [-2, 12, 0], [0, 0, -2], [4, 12, 4], [16, 48], ["armorLeftBoot"]),
        ...part("bipedRightLeg", "armorRightLeg", [2, 12, 0], [-4, 0, -2], [4, 12, 4], [0, 16], ["armorRightBoot"]),
      ],
    }],
  }, null, 2) + "\n";
}
/** Suit animation file: Thematic's armor clips are keyed by the file name (`bat_slam.animation.json` -> "bat_slam"). */
export function suitAnimationTemplate(name: string): string {
  return JSON.stringify({ format_version: "1.8.0", animations: { [name]: { loop: true, animation_length: 1, bones: {} } } }, null, 2) + "\n";
}
/** Files a new suit needs, relative to `<root>` (an assets/<namespace> folder): geo + animation + texture (+ the `_shiny` variant every shipped suit has). */
export function suitFiles(root: string, name: string) {
  return { geo: `${root}/geo/armor/${name}.geo.json`, animation: `${root}/animations/armor/${name}.animation.json`, texture: `${root}/textures/armor/${name}.png`, shiny: `${root}/textures/armor/${name}_shiny.png` };
}
/** Namespace root for new suits: the config's `suitRoot`, else the assets/<ns> folder holding the most armor geo files. */
export function suitRoot(paths: string[], r: AssetRules = rules): string | null {
  if (r.suitRoot) return r.suitRoot;
  const n = new Map<string, number>();
  for (const p of paths) { const m = /^(.*?assets\/[^/]+)\/geo\/armor\/[^/]+\.geo\.json$/.exec(p); if (m) n.set(m[1], (n.get(m[1]) ?? 0) + 1); }
  return [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}
/** `dir/walk.geo.json` + "run" -> `dir/run.geo.json` */
export function duplicateName(file: string, newName: string): string {
  const b = file.slice(file.lastIndexOf("/") + 1);
  const dir = file.slice(0, file.lastIndexOf("/") + 1);
  return dir + newName + b.slice(assetName(file).length);
}
