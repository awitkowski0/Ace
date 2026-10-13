/**
 * How an ability's beam looks, and who decides. `component.visual("thematic:beam", { ... })` (docs/thematic.d.ts, the
 * "thematic:beam" visual) takes the look as options; the options that say "(the suit's)" fall back to the preview suit's
 * `abilities[].assets.beam` (AbilityAssets.Beam), and what neither says is a built-in default. So the layers, strongest first:
 *   1. the visual's own option in the script,
 *   2. the suit's `assets.beam` for this ability (per suit),
 *   3. the default (the docs' "(1)", "(80 layered ...)" and Ace's BEAM_DEFAULTS for the suit keys).
 * Pure: finding the visual literals, editing one key of one, and resolving what is drawn.
 */
import { applyEdits, entry, jsSource, objArg, plain, preferredQuote, scanCalls, setProp, strArg, type JsCall, type JsObj, type TextEdit } from "./jsdsl";
import { parseAnchor, type AnchorSpec } from "./anchors";
import { BEAM_DEFAULTS, readSuit, setJson, nameMatches, type BeamKey } from "./suit";

export type BeamFieldKind = "num" | "enum" | "color" | "bool" | "text";
export interface BeamField {
  /** the option's name in `visual("thematic:beam", { key })` */
  key: string;
  kind: BeamFieldKind;
  /** the docs' text (docs/thematic.d.ts), shown as the tooltip */
  doc: string;
  /** the suit's `assets.beam` key this option falls back to */
  suit?: BeamKey;
  /** the default when neither layer says (a number / string; the style-dependent ones are worked out in `effectiveBeam`) */
  dflt?: number | string | boolean;
  options?: readonly string[];
  step?: number;
  min?: number;
  group: "shape" | "look" | "colour" | "more";
}

export const BEAM_STYLES = ["layered", "fan", "cylinder", "model", "filament", "lance", "cone", "waves", "flame"] as const;
/** Blocks long when `length` is left out, by style (docs: "80 layered or fanned, 15 as a cylinder, 30 as a cone; a filament: ... 64"). */
export const STYLE_LENGTH: Record<string, number> = { layered: 80, fan: 80, cylinder: 15, cone: 30, flame: 12, filament: 64, lance: 64 };
/** Anchors the docs call "the hands": a beam from them is a cylinder unless the style says otherwise. */
const HAND_POINTS = new Set(["main_hand", "off_hand", "right_hand", "left_hand", "arm"]);

export const BEAM_FIELDS: BeamField[] = [
  { key: "style", kind: "enum", group: "shape", options: BEAM_STYLES, doc: "how it is drawn: layered (Heat Vision's; the default from the head and body), fan (Visor Off's widening sheet), cylinder (the radiation beam's; the default from the hands), model (the suit's beam model's \"beam\" bone), filament (Vision's: a thin crackling line that stops on the first block along the look; lance is its old name) or cone (Incinerating Ice's: a square cone from size to end_width, in turning glow shells), or waves (the water jet's: rippling or crystal tubes out of the right arm)" },
  { key: "scale", kind: "num", group: "shape", dflt: 1, step: 0.1, min: 0, doc: "the whole third-person beam, length and all (1; Solar Fury's is 2.5); a filament it only thickens" },
  { key: "length", kind: "num", group: "shape", step: 1, min: 0, doc: "how long in third person, in blocks (80 layered or fanned, 15 as a cylinder, 30 as a cone; a filament: the farthest it looks for a block to stop on, 64)" },
  { key: "firstPersonScale", kind: "num", group: "shape", step: 0.1, min: 0, doc: "how much wider the first-person beam is drawn (scale)" },
  { key: "firstPersonRange", kind: "num", group: "shape", dflt: 90, step: 1, min: 0, doc: "how far the first-person beam looks for a block to stop at (90)" },
  { key: "firstPerson", kind: "enum", group: "shape", options: ["layered", "none"], dflt: "layered", doc: "a beam from the head in first person: layered (default), through the camera to the first block along the look; none. Hands are drawn on the first-person arm either way" },
  { key: "count", kind: "num", group: "look", suit: "count", step: 1, min: 1, doc: "how many beams side by side (the suit's)" },
  { key: "spacing", kind: "num", group: "look", suit: "spacing", step: 0.01, min: 0, doc: "how far apart they are (the suit's)" },
  { key: "size", kind: "num", group: "look", suit: "size", step: 0.005, min: 0, doc: "the core's width (the suit's)" },
  { key: "glowSize", kind: "num", group: "look", suit: "glowSize", step: 0.01, min: 0, doc: "how far the glow reaches past the core (the suit's)" },
  { key: "opacity", kind: "num", group: "look", suit: "thirdPersonOpacity", step: 0.05, min: 0, doc: "third-person opacity (the suit's)" },
  { key: "firstPersonOpacity", kind: "num", group: "look", suit: "firstPersonOpacity", step: 0.05, min: 0, doc: "first-person opacity (the suit's)" },
  { key: "coreColor", kind: "color", group: "colour", suit: "startColor", doc: "the core colour (the suit's startColor)" },
  { key: "color", kind: "color", group: "colour", suit: "endColor", doc: "the outer, glow colour (the suit's endColor)" },
  { key: "texture", kind: "text", group: "colour", suit: "texture", doc: "a texture id a layered beam is drawn with (the suit's)" },
  { key: "endWidth", kind: "num", group: "more", step: 1, min: 0, doc: "fan: how wide its far end is (30); cone: half its width at the far end (5)" },
  { key: "endHeight", kind: "num", group: "more", dflt: 6, step: 1, min: 0, doc: "fan: how tall its far end is (6)" },
  { key: "helix", kind: "bool", group: "more", doc: "cylinder: winds the radiation beam's twin strand round it" },
  { key: "wobble", kind: "num", group: "more", dflt: 1, step: 0.1, min: 0, doc: "filament: how far its line wanders off true, times the default (1); 0 draws it dead straight" },
  { key: "forks", kind: "bool", group: "more", dflt: true, doc: "filament: sparks fork off the line (true)" },
  { key: "delay", kind: "num", group: "more", step: 0.1, min: 0, doc: "seconds after since before it shows" },
  { key: "mobs", kind: "bool", group: "more", dflt: true, doc: "drawn on a mob using the move too (true)" },
];

/** The option -> suit-key table the "which layer wins" text and the effective values use. */
export const SUIT_FALLBACK: Record<string, BeamKey> = Object.fromEntries(BEAM_FIELDS.filter((f) => f.suit).map((f) => [f.key, f.suit!]));

// ---------------------------------------------------------------- finding and editing the visual literal

export interface BeamVisual {
  /** index among the file's `visual("thematic:beam", ...)` calls */
  index: number;
  /** 1-based line */
  line: number;
  /** the options that are plain literals */
  opts: Record<string, unknown>;
  /** the options that are expressions (a constant, a call): key -> source, read-only here */
  raw: Record<string, string>;
  from: AnchorSpec[];
  /** an object literal (or no options at all) we can edit; false when the options are a variable */
  editable: boolean;
}

function beamCalls(src: string): Array<{ call: JsCall; obj?: JsObj }> {
  return scanCalls(src).filter((c) => c.method === "visual" && strArg(c) === "thematic:beam").map((call) => ({ call, obj: objArg(call) }));
}

export function readBeamVisuals(src: string): BeamVisual[] {
  return beamCalls(src).map(({ call, obj }, index) => {
    const raw: Record<string, string> = {};
    for (const e of obj?.entries ?? []) if (e.value.t === "other" || e.value.t === "fn") raw[e.key] = src.slice(e.value.s, e.value.e);
    const fromRaw = plain(entry(obj, "from")?.value);
    const list = Array.isArray(fromRaw) ? fromRaw : fromRaw === undefined ? [] : [fromRaw];
    return {
      index,
      line: src.slice(0, call.s).split("\n").length,
      opts: (plain(obj) ?? {}) as Record<string, unknown>,
      raw,
      from: list.map(parseAnchor).filter((a): a is AnchorSpec => !!a),
      editable: !!obj || call.args.length <= 1,
    };
  });
}

/**
 * Set (or with `undefined`, remove) one option of the n-th beam visual: a minimal edit of its object literal. A visual with
 * no options gets `, { key: value }`; removing the last option removes the whole object. Unchanged when the options are not a
 * literal.
 */
export function setBeamOption(src: string, index: number, key: string, value: unknown): string {
  const x = beamCalls(src)[index];
  if (!x) return src;
  if (!x.obj) {
    if (value === undefined || x.call.args.length > 1) return src;
    const first = x.call.args[0];
    return applyEdits(src, [{ s: first.e, e: first.e, text: `, { ${key}: ${jsSource(value, preferredQuote(src))} }` }]);
  }
  const only = x.obj.entries.length === 1 && x.obj.entries[0].key === key;
  if (value === undefined && only) {
    const prev = x.call.args[x.call.args.indexOf(x.obj) - 1];
    const e: TextEdit = { s: prev ? prev.e : x.obj.s, e: x.obj.e, text: "" };
    return applyEdits(src, [e]);
  }
  return applyEdits(src, [setProp(src, x.obj, key, value)]);
}

// ---------------------------------------------------------------- the suit's layer

/** The index of the preview suit's entry for ability `name` (`unibeam`, `thematic:unibeam` and `ns:unibeam` as written), or -1. */
export function suitAbilityIndex(suitText: string, ns: string, name: string): number {
  try { return readSuit(suitText).abilities.findIndex((a) => nameMatches(a.id, ns, name)); } catch { return -1; }
}

/** The `assets.beam` of ability entry `index` of a suit file (what it sets itself, no defaults). */
export function suitBeamOwn(suitText: string, index: number): Record<string, unknown> {
  try {
    const a = readSuit(suitText).abilities[index];
    return (a?.assets?.beam ?? {}) as Record<string, unknown>;
  } catch { return {}; }
}

/** Set (or with `undefined`, remove) one `assets.beam` key of a suit's ability entry; an emptied `beam` / `assets` object is removed with it. */
export function setSuitBeam(suitText: string, index: number, key: string, value: unknown): string {
  let t = setJson(suitText, ["abilities", index, "assets", "beam", key], value);
  if (value === undefined) {
    const a = readSuit(t).abilities[index];
    if (a?.assets?.beam && Object.keys(a.assets.beam as object).length === 0) {
      t = setJson(t, ["abilities", index, "assets", "beam"], undefined);
      const b = readSuit(t).abilities[index];
      if (b?.assets && Object.keys(b.assets).length === 0) t = setJson(t, ["abilities", index, "assets"], undefined);
    }
  }
  return t;
}

// ---------------------------------------------------------------- what is drawn

export type Layer = "visual" | "suit" | "default";
export interface Eff<T> { value: T; layer: Layer }
export interface EffectiveBeam {
  style: Eff<string>;
  scale: Eff<number>;
  /** blocks before scale */
  length: Eff<number>;
  size: Eff<number>;
  glowSize: Eff<number>;
  count: Eff<number>;
  spacing: Eff<number>;
  coreColor: Eff<string>;
  glowColor: Eff<string>;
  opacity: Eff<number>;
  /** what the preview draws: radius and glow radius in blocks, length in blocks (scale applied, capped), and whether it was cut */
  drawn: { radius: number; glow: number; length: number; full: number; cut: boolean };
}

/** `#RRGGBB` from a hex string (`#AARRGGBB` loses the alpha) or a decimal int; null for anything else. */
export function hexColor(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return "#" + (Math.round(v) & 0xffffff).toString(16).padStart(6, "0").toUpperCase();
  if (typeof v === "string") {
    const m = /^#?([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(v.trim());
    if (m) return "#" + m[1].slice(-6).toUpperCase();
  }
  return null;
}

export const DRAW_CAP = 15;

/**
 * The look the game gives this visual: each setting from the visual's option, else the suit's `assets.beam`, else the default.
 * `hands`: the beam comes out of a hand / arm (default style cylinder instead of layered).
 */
export function effectiveBeam(opts: Record<string, unknown>, suit: Record<string, unknown> | undefined, hands: boolean): EffectiveBeam {
  const pick = <T>(key: string, ok: (v: unknown) => T | null, dflt: T): Eff<T> => {
    const v = ok(opts[key]);
    if (v !== null) return { value: v, layer: "visual" };
    const sk = SUIT_FALLBACK[key];
    const s = sk ? ok(suit?.[sk]) : null;
    if (s !== null) return { value: s, layer: "suit" };
    return { value: dflt, layer: "default" };
  };
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const col = (v: unknown) => hexColor(v);
  const style = pick("style", (v) => (typeof v === "string" && v ? v : null), hands ? "cylinder" : "layered");
  const scale = pick("scale", num, 1);
  const length = pick("length", num, STYLE_LENGTH[style.value] ?? 15);
  const size = pick("size", num, BEAM_DEFAULTS.size);
  const glowSize = pick("glowSize", num, BEAM_DEFAULTS.glowSize);
  const count = pick("count", num, BEAM_DEFAULTS.count);
  const spacing = pick("spacing", num, BEAM_DEFAULTS.spacing);
  const coreColor = pick("coreColor", col, BEAM_DEFAULTS.startColor as string);
  const glowColor = pick("color", col, BEAM_DEFAULTS.endColor as string);
  const opacity = pick("opacity", num, BEAM_DEFAULTS.thirdPersonOpacity);
  // scale is "the whole third-person beam, length and all"; a filament it only thickens
  const full = length.value * (style.value === "filament" || style.value === "lance" ? 1 : scale.value);
  // a flame beam (BeamRenderer FLAME, JetFlameRenderer.renderBeamFlame) is one flame glow_size wide: its core cone is 0.45 of that
  const flame = style.value === "flame";
  const radius = (flame ? glowSize.value * 0.45 : size.value) * scale.value;
  return {
    style, scale, length, size, glowSize, count, spacing, coreColor, glowColor, opacity,
    drawn: { radius, glow: (flame ? glowSize.value : size.value + glowSize.value) * scale.value, length: Math.min(full, DRAW_CAP), full, cut: full > DRAW_CAP },
  };
}

/** Does the visual come out of a hand? (`from` is a hand point; a list counts when its first is.) */
export const fromHands = (from: AnchorSpec[]) => from[0]?.kind === "point" && HAND_POINTS.has(from[0].point ?? "");

/** Which layer decides `key` for the "wins" label: where the value shown comes from. */
export function layerOf(key: string, opts: Record<string, unknown>, suit: Record<string, unknown> | undefined): Layer {
  if (opts[key] !== undefined) return "visual";
  const sk = SUIT_FALLBACK[key];
  return sk && suit?.[sk] !== undefined ? "suit" : "default";
}
