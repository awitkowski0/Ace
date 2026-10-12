/**
 * Making a new ability by copying one: the id a typed name stands for, the title of the copy, where the file goes, the blank
 * script, and the lang entries that give the ability its display name. Pure; the file work is in ui/newAbilityData.ts.
 */
import { setTop } from "./suit";

/** A typed name as an ability name: lowercase, `[a-z0-9_]`, spaces and dashes as `_`. A leading `<ns>:` is dropped. */
export function normalizeAbilityName(raw: string, ns = "thematic"): string {
  let s = raw.trim().toLowerCase();
  if (s.startsWith(ns + ":")) s = s.slice(ns.length + 1);
  return s.replace(/[\s-]+/g, "_").replace(/[^a-z0-9_]/g, "").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
}

/** The id a suit names the ability by: the bare name for `thematic`, `<ns>:<name>` otherwise. */
export const newAbilityId = (ns: string, name: string) => (ns === "thematic" ? name : `${ns}:${name}`);

/** Why `name` can't be a new ability's name, or null. `existing` are the project's ability ids. */
export function abilityNameProblem(name: string, ns: string, existing: Iterable<string>): string | null {
  if (!name) return "Type a name with letters or digits.";
  const id = newAbilityId(ns, name);
  for (const e of existing) if (e === id || (ns === "thematic" && e === "thematic:" + name)) return `An ability ${id} already exists.`;
  return null;
}

/** `unibeam` -> `Unibeam`, `repulsor_blast` -> `Repulsor Blast`. */
export const titleFromName = (name: string) =>
  name.split("_").filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

/** A title is a short phrase before the first colon; a longer stretch is a sentence, replaced whole. */
const TITLE_MAX = 40;

/** Text with its title swapped for `title`: keeps what follows a colon in the first 40 characters, else replaces everything. */
export function retitleLine(body: string, title: string): string {
  const i = body.indexOf(":");
  return i > 0 && i <= TITLE_MAX ? title + body.slice(i) : title;
}

/** A copy of an ability file's text titled `title`: the first leading `//` comment line (or a JSON ability's `description`). */
export function retitleAbility(src: string, title: string, ext: "js" | "json"): string {
  if (ext === "json") {
    try {
      const d = (JSON.parse(src.replace(/^﻿/, "")) as { description?: unknown }).description;
      if (typeof d === "string") return setTop(src, "description", retitleLine(d, title));
    } catch { /* not JSON: copied as it is */ }
    return src;
  }
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*\/\/+\s?)(.*?)(\r?)$/.exec(lines[i].replace(/^﻿/, ""));
    if (lines[i].trim() === "") continue;
    if (!m) break;
    const bom = lines[i].startsWith("﻿") ? "﻿" : "";
    lines[i] = bom + m[1] + retitleLine(m[2], title) + m[3];
    return lines.join("\n");
  }
  const eol = src.includes("\r\n") ? "\r\n" : "\n";
  return `// ${title}${eol}${src}`;
}

/** The smallest script that loads: a cooldown and a press that plays a sound. */
export const blankAbility = (title: string) => `// ${title}: describe what it does here.
component(component => {
    component.cooldown();
    component.press(press => {
        press.sound("minecraft:entity.player.attack.crit");
    });
});
`;

/** A folder under abilities/ as a clean path (`iron_man`, `a/b`), `""` at the top. */
export const normalizeFolder = (raw: string) =>
  raw.trim().replace(/\\/g, "/").split("/").map((s) => s.trim().toLowerCase().replace(/[\s-]+/g, "_").replace(/[^a-z0-9_]/g, "")).filter(Boolean).join("/");

/** The folder a new ability starts in: the copied one's, else one named after the suit when it exists, else the top level. */
export function defaultFolder(copyFolder: string | undefined, suitId: string, folders: Iterable<string>): string {
  if (copyFolder) return copyFolder;
  for (const f of folders) if (f === suitId) return f;
  return "";
}

/** `<resources root>/data/<ns>/abilities/<folder>/<name>.<ext>` */
export function abilityTargetPath(root: string, ns: string, folder: string, name: string, ext: "js" | "json"): string {
  return `${root}/data/${ns}/abilities/${folder ? folder + "/" : ""}${name}.${ext}`;
}

/** The lang entries an ability needs: the HUD name (`<id>`) and the guide/menu name (`ability.thematic.<id>`). */
export const abilityLangKeys = (id: string) => [id, `ability.thematic.${id}`];

/**
 * Add `"key": "value"` lines to a lang file's text without touching the rest: before the closing brace, with the indent of the
 * existing entries. Keys already present are left alone. Throws when the text isn't a JSON object.
 */
export function addLangEntries(text: string, entries: Record<string, string>): string {
  const obj = JSON.parse(text.replace(/^﻿/, "")) as Record<string, unknown>;
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("The lang file isn't a JSON object");
  const add = Object.entries(entries).filter(([k]) => !(k in obj));
  if (add.length === 0) return text;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const close = text.lastIndexOf("}");
  const indent = /\n([ \t]+)"/.exec(text)?.[1] ?? "  ";
  let head = text.slice(0, close);
  const trimmed = head.replace(/\s+$/, "");
  const empty = trimmed.endsWith("{");
  const lines = add.map(([k, v]) => `${indent}${JSON.stringify(k)}: ${JSON.stringify(v)}`).join("," + eol);
  const tail = text.slice(close);
  head = trimmed + (empty ? "" : ",") + eol + lines;
  return head + eol + tail;
}

/** A lang file for a pack that has none yet. */
export const newLangText = (entries: Record<string, string>) => addLangEntries("{}", entries) + "\n";
