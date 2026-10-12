/**
 * Suits (data/<ns>/armors/**.json, SuitSchemas.java) and the abilities they carry, as the pack editor sees them: what the
 * suit renders and where it comes out of. A suit's own render settings are its abilities' `assets` (the beam: colours, size,
 * first/third person translation); where a move leaves the body (`from:`) belongs to the ability script, shared by every
 * suit that has it.
 */
import { applyEdits, plain, scanCalls, setProp, strArg, objArg, entry, type JsCall, type JsObj } from "./jsdsl";
import { parseAnchor, type AnchorSpec } from "./anchors";
import { detectStyle, emitJson, fromValue, getIn, isArr, isObj, parseJson, setIn, toValue, type JNode, type Path } from "../../animstudio/core/format/json";

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
  return {
    tier: typeof raw.tier === "number" ? raw.tier : undefined,
    wip: typeof raw.wip === "boolean" ? raw.wip : undefined,
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
