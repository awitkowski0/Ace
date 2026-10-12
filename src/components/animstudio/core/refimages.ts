/**
 * Reference images (Blockbench parity, docs/BLOCKBENCH-PARITY.md section 3). Pure data + the `.bbmodel` `reference_images` key.
 * Property names and defaults are Blockbench's (`reference_images.ts` `new Property(ReferenceImage, ...)`), so a model saved here
 * opens in Blockbench with its images and vice versa. Defaults are omitted when written (like Blockbench's property copy).
 * `locked` is an Ace extension (Blockbench has "Locked Blueprint" only for blueprints); it is written only when true.
 */
import { fromValue, getKey, isArr, isObj, jarr, setEntry, toValue, type JNode, type JObj } from "./format/json";
import type { Doc } from "./doc";

export type RefLayer = "background" | "viewport" | "float";
export type RefViewMode = "flat_image" | "plane" | "blueprint";
export type RefScope = "project" | "global";
/** Ortho view a blueprint is attached to (Blockbench camera angle names). */
export type RefSide = "north" | "south" | "east" | "west" | "top" | "bottom";

export interface RefImage {
  uuid: string;
  name: string;
  /** data URL, or an absolute file path (desktop) */
  source: string;
  layer: RefLayer;
  scope: RefScope;
  view_mode: RefViewMode;
  position: [number, number];
  plane_position: [number, number, number];
  plane_rotation: [number, number, number];
  size: [number, number];
  rotation: number;
  flip_x: boolean;
  flip_y: boolean;
  /** 0..1 */
  opacity: number;
  visibility: boolean;
  clear_mode: boolean;
  cull_backface: boolean;
  attached_side: RefSide;
  /** Blockbench "Enabled in Modes" (empty = all) */
  modes: string[];
  sync_to_timeline: boolean;
  /** Ace extension */
  locked: boolean;
}

export const REF_LAYERS: { id: RefLayer; label: string }[] = [
  { id: "background", label: "Behind Model" },
  { id: "viewport", label: "Above Model" },
  { id: "float", label: "Above Interface" },
];

export const REF_DEFAULTS: Omit<RefImage, "uuid" | "source"> = {
  name: "Reference",
  layer: "background",
  scope: "project",
  view_mode: "flat_image",
  position: [0, 0],
  plane_position: [0, 0, 0],
  plane_rotation: [0, 0, 0],
  size: [400, 300],
  rotation: 0,
  flip_x: false,
  flip_y: false,
  opacity: 1,
  visibility: true,
  clear_mode: false,
  cull_backface: false,
  attached_side: "north",
  modes: [],
  sync_to_timeline: true,
  locked: false,
};

let counter = 0;
export function newRefUuid(): string {
  const h = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0");
  counter++;
  return `${h()}${h()}-${h()}-4${h().slice(1)}-a${h().slice(1)}-${h()}${h()}${h()}`;
}

export function makeRef(source: string, patch: Partial<RefImage> = {}): RefImage {
  return { ...REF_DEFAULTS, uuid: newRefUuid(), source, ...patch };
}

const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Plain JSON object of one reference, defaults omitted (name, source and size always written, like Blockbench). */
export function refToJson(r: RefImage): Record<string, unknown> {
  const o: Record<string, unknown> = { name: r.name, uuid: r.uuid, source: r.source };
  for (const k of Object.keys(REF_DEFAULTS) as (keyof typeof REF_DEFAULTS)[]) {
    if (k === "name") continue;
    if (k === "size" || !eq(r[k], REF_DEFAULTS[k])) o[k] = r[k];
  }
  return o;
}

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const vec = <T extends number[]>(v: unknown, d: T): T => (Array.isArray(v) && v.length === d.length && v.every((x) => typeof x === "number") ? (v.slice() as T) : (d.slice() as T));

/** Parse one JSON object (defaults filled). Unknown/invalid fields fall back to the defaults. */
export function refFromJson(v: unknown): RefImage | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.source !== "string") return null;
  const d = REF_DEFAULTS;
  const layer = o.layer === "viewport" || o.layer === "float" || o.layer === "background" ? o.layer : d.layer;
  const view_mode = o.view_mode === "plane" || o.view_mode === "blueprint" ? o.view_mode : "flat_image";
  const sides: RefSide[] = ["north", "south", "east", "west", "top", "bottom"];
  return {
    uuid: typeof o.uuid === "string" ? o.uuid : newRefUuid(),
    name: typeof o.name === "string" ? o.name : d.name,
    source: o.source,
    layer, view_mode,
    scope: o.scope === "global" ? "global" : "project",
    position: vec(o.position, d.position),
    plane_position: vec(o.plane_position, d.plane_position),
    plane_rotation: vec(o.plane_rotation, d.plane_rotation),
    size: vec(o.size, d.size),
    rotation: num(o.rotation, d.rotation),
    flip_x: o.flip_x === true, flip_y: o.flip_y === true,
    opacity: Math.min(1, Math.max(0, num(o.opacity, d.opacity))),
    visibility: o.visibility !== false,
    clear_mode: o.clear_mode === true,
    cull_backface: o.cull_backface === true,
    attached_side: sides.includes(o.attached_side as RefSide) ? (o.attached_side as RefSide) : d.attached_side,
    modes: Array.isArray(o.modes) ? o.modes.filter((x): x is string => typeof x === "string") : [],
    sync_to_timeline: o.sync_to_timeline !== false,
    locked: o.locked === true,
  };
}

/** `.bbmodel` project references (key `reference_images`). Other doc kinds have none in the file. */
export function readBbReferenceImages(doc: Doc): RefImage[] {
  if (doc.kind !== "bbmodel" || !isObj(doc.root)) return [];
  const arr = getKey(doc.root as JObj, "reference_images");
  if (!isArr(arr)) return [];
  return arr.items.map((n) => refFromJson(toValue(n))).filter((x): x is RefImage => !!x);
}

/**
 * Replace the `reference_images` key of a bbmodel with `list` (project-scope references only; the caller filters).
 * Entries whose JSON value did not change keep their original text; an empty list removes the key (Blockbench writes it only when
 * there are references). Returns the same doc when nothing changes.
 */
export function setBbReferenceImages(doc: Doc, list: RefImage[]): Doc {
  if (doc.kind !== "bbmodel" || !isObj(doc.root)) throw new Error("not a bbmodel");
  const root = doc.root as JObj;
  const cur = getKey(root, "reference_images");
  if (!list.length) {
    if (!cur) return doc;
    return { ...doc, root: setEntry(root, "reference_images", undefined) };
  }
  const old = isArr(cur) ? cur.items : [];
  const items: JNode[] = list.map((r) => {
    const json = refToJson(r);
    const prev = old.find((n) => isObj(n) && (getKey(n, "uuid") as { value?: string } | undefined)?.value === r.uuid);
    if (prev && eq(toValue(prev), json)) return prev;
    return fromValue(json, prev, 4);
  });
  if (isArr(cur) && cur.items.length === items.length && items.every((n, i) => n === cur.items[i])) return doc;
  const arr = jarr(items, cur);
  return { ...doc, root: setEntry(root, "reference_images", arr) };
}
