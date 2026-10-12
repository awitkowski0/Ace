/**
 * File editor providers (IntelliJ's FileEditorProvider): which editor shows a file, chosen by name (extension) first and
 * by a content sniff for unknown types. Pure data + functions: no React/Monaco imports, so the editor store can use it.
 *
 *  - "viewer": bytes-only editor (no Monaco model): images, audio, video, 3D, fonts, NBT, archives, placeholders.
 *  - "dual":   a text file that also has a rendered view (Markdown preview, CSV table, SVG image, Blockbench model).
 *              Monaco keeps the model; the tab toggles Editor | Editor and Preview | Preview.
 */
export type ViewerId =
  | "image" | "audio" | "video" | "model" | "font" | "nbt" | "archive" | "binary" | "toolarge";
export type DualId = "svg" | "markdown" | "csv" | "svg" | "bbmodel" | "mcmeta" | "animstudio" | "pack";
export type DualMode = "editor" | "split" | "preview";

export interface Provider {
  id: ViewerId | DualId;
  title: string;
  kind: "viewer" | "dual";
  exts: string[];
  /** dual only: mode the tab opens in */
  defaultMode?: DualMode;
  /** dual only: label of the rendered view */
  previewLabel?: string;
  /** match `name` exactly (e.g. "x.png.mcmeta"); checked before extensions */
  suffix?: string;
  /** match by where the file is (pack files: data/<ns>/armors/…); checked first, needs the path */
  match?: (path: string) => boolean;
}

// Pack editor (docs/PACKEDITOR.md): suits, abilities, HUDs, flight profiles and guide pages, by folder.
const PACK_FILE = /\/data\/[^/]+\/(armors|abilities|huds|flight_profiles)\/.+\.(json|js)$|\/guide\/[^/]+\/[^/]+\/(entries|categories)\/.+\.json$/;

export const PROVIDERS: Provider[] = [
  { id: "pack", title: "Pack editor", kind: "dual", exts: [], match: (p) => PACK_FILE.test(p.replace(/\\/g, "/")), defaultMode: "preview", previewLabel: "Designer" },
  { id: "mcmeta", title: "Animated texture", kind: "dual", exts: [], suffix: ".png.mcmeta", defaultMode: "split", previewLabel: "Animation" },
  { id: "image", title: "Image", kind: "viewer", exts: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "icns", "tga", "avif", "cur"] },
  { id: "svg", title: "SVG", kind: "dual", exts: ["svg"], defaultMode: "preview", previewLabel: "Image" },
  { id: "markdown", title: "Markdown", kind: "dual", exts: ["md", "markdown", "mdx"], defaultMode: "split", previewLabel: "Preview" },
  { id: "csv", title: "Table", kind: "dual", exts: ["csv", "tsv"], defaultMode: "preview", previewLabel: "Table" },
  // Animation Studio (docs/ANIMSTUDIO.md): one dual editor for geo / animation / bbmodel. The old "bbmodel" viewer stays as fallback code only.
  { id: "animstudio", title: "Animation Studio", kind: "dual", exts: [], suffix: ".geo.json", defaultMode: "preview", previewLabel: "Studio" },
  { id: "animstudio", title: "Animation Studio", kind: "dual", exts: [], suffix: ".animation.json", defaultMode: "preview", previewLabel: "Studio" },
  { id: "animstudio", title: "Animation Studio", kind: "dual", exts: ["bbmodel"], defaultMode: "preview", previewLabel: "Studio" },
  { id: "audio", title: "Audio", kind: "viewer", exts: ["wav", "ogg", "oga", "opus", "aiff", "aif", "aifc", "mp3", "flac", "m4a", "aac"] },
  { id: "video", title: "Video", kind: "viewer", exts: ["mp4", "webm", "mov", "m4v", "ogv"] },
  { id: "model", title: "3D model", kind: "viewer", exts: ["glb", "gltf"] },
  { id: "font", title: "Font", kind: "viewer", exts: ["ttf", "otf", "woff", "woff2"] },
  { id: "nbt", title: "NBT", kind: "viewer", exts: ["nbt", "schematic", "schem", "litematic", "mcstructure"] },
  { id: "archive", title: "Archive", kind: "viewer", exts: ["zip", "jar", "mcpack", "mrpack", "apk", "war"] },
];

/** extensions that are known to be binary but have no dedicated viewer: straight to the placeholder, no probe needed */
export const BINARY_EXTS = new Set([
  "exe", "dll", "so", "dylib", "o", "a", "class", "pyc", "bin", "dat", "mca", "gz", "tgz", "bz2", "xz", "7z", "rar", "tar",
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "sqlite", "db", "jks", "keystore", "lib", "wasm", "pck", "res", "ctex", "scn", "stex",
]);

/** text types whose bytes we never need to sniff (Monaco opens them straight away) */
export const TEXT_EXTS = new Set([
  "txt", "log", "json", "jsonc", "mcmeta", "snbt", "fsh", "vsh", "glsl", "gdshader", "gdshaderinc", "tres", "tscn", "import", "godot",
  "pose", "ts", "tsx", "js", "jsx", "mjs", "cjs", "css", "scss", "html", "htm", "rs", "py", "java", "kt", "kts", "go", "sh", "yaml",
  "yml", "xml", "toml", "gd", "cfg", "ini", "properties", "gradle", "lang", "mcfunction", "csv", "tsv", "md", "svg", "gitignore",
]);

export const extOf = (name: string) => {
  const i = name.lastIndexOf(".");
  return i > 0 || (i === 0 && name.length > 1) ? name.slice(i + 1).toLowerCase() : "";
};

export function providerFor(name: string, path?: string): Provider | null {
  if (path) {
    const byPath = PROVIDERS.find((p) => p.match?.(path));
    if (byPath) return byPath;
  }
  const lower = name.toLowerCase();
  const bySuffix = PROVIDERS.find((p) => p.suffix && lower.endsWith(p.suffix));
  if (bySuffix) return bySuffix;
  const ext = extOf(name);
  return PROVIDERS.find((p) => p.exts.includes(ext)) ?? null;
}

/** Above this a text file is not opened in Monaco without confirmation (IntelliJ: "The file is too large"). */
export const TEXT_LIMIT = 8 * 1024 * 1024;

export interface Decision {
  /** viewer id for a bytes-only tab; undefined = text (possibly dual) */
  viewer?: ViewerId;
  dual?: DualId;
  /** sniff needed before deciding (unknown extension) */
  needsProbe: boolean;
}

/** First-pass decision by name only. */
export function decide(name: string, path?: string): Decision {
  const p = providerFor(name, path);
  if (p?.kind === "viewer") return { viewer: p.id as ViewerId, needsProbe: false };
  if (p?.kind === "dual") return { dual: p.id as DualId, needsProbe: true };
  const ext = extOf(name);
  if (BINARY_EXTS.has(ext)) return { viewer: "binary", needsProbe: false };
  return { needsProbe: !TEXT_EXTS.has(ext) };
}

/** Second pass with probe results. */
export function refine(d: Decision, probe: { size: number; binary: boolean } | null, force = false): Decision {
  if (d.viewer || !probe) return d;
  if (force) return d;
  if (probe.binary) return { viewer: "binary", needsProbe: false };
  if (probe.size > TEXT_LIMIT && !force) return { viewer: "toolarge", needsProbe: false };
  return d;
}

export const formatSize = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : n < 1024 ** 3 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`;
