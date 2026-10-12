/**
 * Suits (data/<ns>/armors/**.json, SuitSchemas.java) and the abilities they carry, as the pack editor sees them: what the
 * suit renders and where it comes out of. A suit's own render settings are its abilities' `assets` (the beam: colours, size,
 * first/third person translation); where a move leaves the body (`from:`) belongs to the ability script, shared by every
 * suit that has it.
 */
import { applyEdits, plain, scanCalls, setProp, strArg, objArg, entry, type JsCall, type JsObj } from "./jsdsl";
import { parseAnchor, type AnchorSpec } from "./anchors";
import { derive, detectStyle, emitJson, fromValue, getIn, getKey, isArr, isObj, jarr, parseJson, setEntry, setIn, toValue, type JArr, type JNode, type JObj, type Path } from "../../animstudio/core/format/json";

export interface SuitAbility {
  index: number;
  id: string;
  keybind?: string;
  options?: Record<string, unknown>;
  assets?: Record<string, unknown>;
  remove?: boolean;
}
export interface Suit {
  tier?: number;
  wip?: boolean;
  boss?: boolean;
  priority?: number;
  parent?: string;
  suitRecipe?: string;
  /** `thematic:ladder` and other suit types; undefined for a plain suit */
  type?: string;
  fightingType: string[];
  tags: string[];
  flightType?: string;
  flightProfile?: string;
  jetGroups?: string;
  abilities: SuitAbility[];
  raw: Record<string, unknown>;
}

export const FLIGHT_TYPES = ["NO_HANDS", "ONE_HAND_LEFT", "ONE_HAND_RIGHT", "BOTH_HANDS", "JETPACK", "WINGED"] as const;
export const JET_GROUPS = ["arms", "legs", "both"] as const;
export const KEYBINDS = [
  "key.thematic.ability_0", "key.thematic.ability_1", "key.thematic.ability_2", "key.thematic.ability_3", "key.thematic.ability_4",
  "key.thematic.ability_5", "key.thematic.ultimate", "key.thematic.utility", "key.thematic.passive", "key.thematic.cosmetic", "key.thematic.equip_item",
] as const;

/** AbilityAssets.Beam defaults (what a suit gets for any key it leaves out). */
export const BEAM_DEFAULTS = {
  texture: "", startColor: "#FFFFFF", endColor: "#FF0000", size: 0.025, glowSize: 0.25, spacing: 0.1, count: 2,
  firstPersonOpacity: 0.5, thirdPersonOpacity: 1, firstPersonTranslation: [0, 0, 0], thirdPersonTranslation: [0, 0, 0],
  maxChains: 3, chainRange: 10, beamVelocity: 25,
} as const;
export type BeamKey = keyof typeof BEAM_DEFAULTS;

export function readSuit(text: string): Suit {
  const root = parseJson(text).root;
  const raw = (toValue(root) ?? {}) as Record<string, unknown>;
  const abilities = Array.isArray(raw.abilities) ? (raw.abilities as Array<Record<string, unknown>>).map((a, index) => ({
    index,
    id: String(a?.identifier ?? ""),
    keybind: typeof a?.keybind === "string" ? a.keybind : undefined,
    options: a?.options && typeof a.options === "object" ? (a.options as Record<string, unknown>) : undefined,
    assets: a?.assets && typeof a.assets === "object" ? (a.assets as Record<string, unknown>) : undefined,
    remove: a?.remove === true || undefined,
  })) : [];
  const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return {
    tier: typeof raw.tier === "number" ? raw.tier : undefined,
    wip: typeof raw.wip === "boolean" ? raw.wip : undefined,
    boss: typeof raw.boss === "boolean" ? raw.boss : undefined,
    priority: typeof raw.priority === "number" ? raw.priority : undefined,
    parent: typeof raw.parent === "string" ? raw.parent : undefined,
    suitRecipe: typeof raw["suit-recipe"] === "string" ? (raw["suit-recipe"] as string) : undefined,
    type: typeof raw.type === "string" ? raw.type : undefined,
    fightingType: strs(raw.fighting_type),
    tags: strs(raw.tags),
    flightType: typeof raw.flight_type === "string" ? raw.flight_type : undefined,
    flightProfile: typeof raw.flight_profile === "string" ? raw.flight_profile : undefined,
    jetGroups: typeof raw.jet_groups === "string" ? raw.jet_groups : undefined,
    abilities,
    raw,
  };
}

/** Set (or with `undefined`, remove) one value of a JSON file, keeping the rest of the text byte for byte. */
export function setJson(text: string, path: Path, value: unknown): string {
  const p = parseJson(text);
  const style = detectStyle(text, p.start, p.end);
  const like = nearest(p.root, path);
  const root = setIn(p.root, path, value === undefined ? undefined : fromValue(value, like));
  return text.slice(0, p.start) + emitJson(root, style) + text.slice(p.end);
}

function nearest(root: JNode, path: Path): JNode {
  for (let i = path.length; i >= 0; i--) {
    const n = getIn(root, path.slice(0, i));
    if (n) return n;
  }
  return root;
}

/** The beam settings a suit gives one ability, merged over the defaults. */
export function beamOf(a: SuitAbility | undefined): Record<BeamKey, unknown> {
  const b = (a?.assets?.beam ?? {}) as Record<string, unknown>;
  return { ...BEAM_DEFAULTS, ...b } as Record<BeamKey, unknown>;
}

export const abilityName = (id: string) => (id.includes(":") ? id.slice(id.indexOf(":") + 1) : id);
export const nsOf = (id: string, d = "thematic") => (id.includes(":") ? id.slice(0, id.indexOf(":")) : d);

// ---------------------------------------------------------------- ability scripts: where things come out

export interface RenderSource {
  /** index among the file's render sources (stable while the file's structure is unchanged) */
  index: number;
  /** the call that renders: `visual`, `beam`, `projectile`, `burst`, `spray`, ... */
  method: string;
  /** `component.visual("thematic:beam", ...)`'s kind */
  kind?: string;
  /** one anchor, or several (a list draws one from each) */
  from: AnchorSpec[];
  /** the raw `from` value; undefined when the call has no `from` (it defaults to the eyes) */
  fromRaw: unknown;
  opts: Record<string, unknown>;
  line: number;
}

const RENDER_METHODS = new Set(["visual", "beam", "projectile", "burst", "spray", "particles", "shoot", "trail"]);

function sourcesWithCalls(src: string): Array<{ s: RenderSource; obj?: JsObj; call: JsCall }> {
  const out: Array<{ s: RenderSource; obj?: JsObj; call: JsCall }> = [];
  for (const c of scanCalls(src)) {
    const obj = objArg(c);
    const hasFrom = !!entry(obj, "from");
    const isVisual = c.method === "visual" && !!strArg(c);
    if (!hasFrom && !isVisual && !RENDER_METHODS.has(c.method)) continue;
    if (!hasFrom && !isVisual) continue;
    const fromRaw = plain(entry(obj, "from")?.value);
    const list = Array.isArray(fromRaw) ? fromRaw : fromRaw === undefined ? [] : [fromRaw];
    const from = list.map(parseAnchor).filter((a): a is AnchorSpec => !!a);
    const line = src.slice(0, c.s).split("\n").length;
    out.push({ s: { index: out.length, method: c.method, kind: c.method === "visual" ? strArg(c) : undefined, from, fromRaw, opts: (plain(obj) ?? {}) as Record<string, unknown>, line }, obj, call: c });
  }
  return out;
}

export function readRenderSources(src: string): RenderSource[] {
  return sourcesWithCalls(src).map((x) => x.s);
}

/** Write render source `index`'s `from` (an anchor value or a list of them). */
export function setRenderFrom(src: string, index: number, value: unknown): string {
  const x = sourcesWithCalls(src)[index];
  if (!x) return src;
  if (x.obj) return applyEdits(src, [setProp(src, x.obj, "from", value)]);
  // `component.visual("thematic:beam")` with no options yet
  const last = x.call.args[x.call.args.length - 1];
  if (!last) return src;
  return src.slice(0, last.e) + `, { from: ${JSON.stringify(value)} }` + src.slice(last.e);
}

/** Visual kinds whose `from` places a beam / model the suit's `assets.beam` styles. */
export const BEAM_VISUALS = new Set(["thematic:beam", "thematic:layered_beam", "thematic:hand_beam"]);

export { isArr, isObj };

// ---------------------------------------------------------------- node edits (every one returns the new text)

/** The keys a suit file is written with, in the order the shipped suits use (docs/addon-format.md). A new key goes before the first existing key that follows it here. */
export const SUIT_KEYS = ["_comment", "__id", "__collection", "type", "wip", "parent", "suit-recipe", "tier", "abilities", "stats", "attributes", "fighting_type", "tags", "flight_type", "flight_profile", "jet_groups", "boss", "priority"] as const;
const keyRank = (k: string) => {
  const i = (SUIT_KEYS as readonly string[]).indexOf(k);
  return i < 0 ? SUIT_KEYS.length : i;
};

/** Apply `fn` to the file's root and re-emit it: the untouched parts keep their bytes. A `fn` that changes nothing returns `text`. */
export function editRoot(text: string, fn: (root: JNode) => JNode): string {
  const p = parseJson(text);
  const style = detectStyle(text, p.start, p.end);
  const root = fn(p.root);
  if (root === p.root) return text;
  return text.slice(0, p.start) + emitJson(root, style) + text.slice(p.end);
}

function objRoot(root: JNode): JObj {
  if (!isObj(root)) throw new Error("a suit file is a JSON object");
  return root;
}

function listOf(o: JObj, key: string): JArr | undefined {
  const n = getKey(o, key);
  if (n !== undefined && !isArr(n)) throw new Error(`${key} is not a list`);
  return n;
}

/** Set a top-level field (`value` undefined removes it). A new field lands in SUIT_KEYS order. */
export function setTop(text: string, key: string, value: unknown): string {
  return editRoot(text, (root) => {
    const o = objRoot(root);
    const node = value === undefined ? undefined : fromValue(value, getKey(o, key));
    return setEntry(o, key, node, (k) => keyRank(k) > keyRank(key));
  });
}

/** Append an object to a top-level list (the list is created when missing), in the list's own layout. */
export function listAdd(text: string, key: string, item: Record<string, unknown>): string {
  return editRoot(text, (root) => {
    const o = objRoot(root);
    const cur = listOf(o, key);
    if (!cur) return setEntry(o, key, jarr([fromValue(item, o)], o), (k) => keyRank(k) > keyRank(key));
    const like = cur.items[cur.items.length - 1];
    return setIn(o, [key], derive(cur, [...cur.items, fromValue(item, like)]));
  });
}

/** Remove the list item at `index`. */
export function listRemove(text: string, key: string, index: number): string {
  return editRoot(text, (root) => {
    const cur = listOf(objRoot(root), key);
    if (!cur || index < 0 || index >= cur.items.length) return root;
    return setIn(root, [key], derive(cur, cur.items.filter((_, i) => i !== index)));
  });
}

/** Move the list item at `from` so it ends up at `to` (its index afterwards). */
export function listMove(text: string, key: string, from: number, to: number): string {
  return editRoot(text, (root) => {
    const cur = listOf(objRoot(root), key);
    if (!cur || from === to || from < 0 || to < 0 || from >= cur.items.length || to >= cur.items.length) return root;
    const items = cur.items.slice();
    const [moved] = items.splice(from, 1);
    items.splice(to, 0, moved);
    return setIn(root, [key], derive(cur, items));
  });
}

/** Set one field of the list item at `index` (`value` undefined removes the field). */
export function listSet(text: string, key: string, index: number, field: string, value: unknown): string {
  return editRoot(text, (root) => {
    const cur = listOf(objRoot(root), key);
    const item = cur?.items[index];
    if (!cur || !item || !isObj(item)) return root;
    const node = value === undefined ? undefined : fromValue(value, getKey(item, field));
    return setIn(root, [key, index, field], node);
  });
}

/** Stat rows (`stats`) as the designer reads them; rows that aren't objects keep their index and read as empty. */
export interface StatRow { index: number; identifier: string; minimum?: number; maximum?: number }
export function readStats(raw: Record<string, unknown>): StatRow[] {
  return (Array.isArray(raw.stats) ? (raw.stats as Array<Record<string, unknown>>) : []).map((s, index) => ({
    index,
    identifier: typeof s?.identifier === "string" ? s.identifier : "",
    minimum: typeof s?.minimum === "number" ? s.minimum : undefined,
    maximum: typeof s?.maximum === "number" ? s.maximum : undefined,
  }));
}

/** `attributes` rows (`{identifier, effect}`), the Pehkui and other scales a suit sets. */
export interface AttributeRow { index: number; identifier: string; effect?: number }
export function readAttributes(raw: Record<string, unknown>): AttributeRow[] {
  return (Array.isArray(raw.attributes) ? (raw.attributes as Array<Record<string, unknown>>) : []).map((a, index) => ({
    index,
    identifier: typeof a?.identifier === "string" ? a.identifier : "",
    effect: typeof a?.effect === "number" ? a.effect : undefined,
  }));
}
