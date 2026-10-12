/**
 * Constraint data for one Studio: where it lives (bbmodel: `ace_constraints` key of the file = undoable with the text; geo/animation
 * files: Ace app data via pstore, keyed by file path then animation name; never written into a project repo) plus the actions the
 * panel and the viewport call. Pure helpers live in core/constraints.ts.
 */
import { invoke, type Location } from "../../../../lib/ipc";
import {
  bakeConstraints, constraintsFromJson, constraintsToJson, drivenBones, getAnimation, makeFollow, makeLink, makePin, readBbConstraints,
  setBbConstraints, viaOf, type ConsBone, type Constraint, type ConstraintMap, type Doc, type NumVec3, type PointRef,
} from "../../core";
import type { StudioApi, StudioState } from "../state";

type StudioStateLike = Pick<StudioState, "doc" | "anim" | "cons">;
import { handles } from "../studios";
import { initialCons, type ConsUi, type PickState } from "./types";

const NONE: Constraint[] = [];
const hostOf = (api: StudioApi) => { for (const h of handles) if (h.api === api) { const k = h.docKey; return k.slice(0, k.indexOf(":")) || "local"; } return "local"; };
const root = (api: StudioApi): Location => ({ host: hostOf(api), path: api.store.get().path });
const STORE = "constraints";

// ---------------------------------------------------------------- reading

const bbMemo = new WeakMap<object, ConstraintMap>();
/** every animation's constraints for the current doc */
export function allConstraints(s: StudioStateLike): ConstraintMap {
  if (s.doc?.kind === "bbmodel") {
    let m = bbMemo.get(s.doc.root);
    if (!m) bbMemo.set(s.doc.root, (m = readBbConstraints(s.doc)));
    return m;
  }
  return s.cons.byAnim;
}
/** constraints of the animation the Studio shows (stable array identity while nothing changed) */
export function constraintsOf(s: StudioStateLike): readonly Constraint[] {
  return (s.anim ? allConstraints(s)[s.anim] : undefined) ?? NONE;
}

// ---------------------------------------------------------------- loading / writing

export async function loadConstraints(api: StudioApi): Promise<void> {
  const s = api.store.get();
  if (s.cons.loaded) return;
  if (s.doc?.kind === "bbmodel") { api.store.set((st) => ({ cons: { ...st.cons, loaded: true } })); return; }
  let map: ConstraintMap = {};
  try {
    const t = await invoke<string | null>("pstore_get", { root: root(api), name: STORE }).catch(() => null);
    if (t) map = constraintsFromJson(JSON.parse(t));
  } catch { /* unreadable: start empty */ }
  api.store.set((st) => ({ cons: { ...st.cons, byAnim: st.cons.loaded ? st.cons.byAnim : map, loaded: true } }));
}
const save = (api: StudioApi, map: ConstraintMap) =>
  void invoke<void>("pstore_set", { root: root(api), name: STORE, json: JSON.stringify(constraintsToJson(map), null, 1) }).catch(() => {});

/** Replace the list of the current animation. bbmodel: one undoable edit of the file; otherwise app data. */
export function setConstraints(api: StudioApi, list: Constraint[], label: string): void {
  const s = api.store.get();
  if (!s.anim) return;
  const next: ConstraintMap = { ...allConstraints(s), [s.anim]: list };
  if (!list.length) delete next[s.anim];
  if (s.doc?.kind === "bbmodel") {
    try { api.commit(setBbConstraints(s.doc, next), label); } catch { /* unparsable doc */ }
  } else {
    api.store.set((st) => ({ cons: { ...st.cons, byAnim: next } }));
    save(api, next);
  }
}
export function patchConstraint(api: StudioApi, id: string, patch: Partial<Constraint>, label = "Edit Constraint"): void {
  const list = constraintsOf(api.store.get());
  setConstraints(api, list.map((c) => (c.id === id ? ({ ...c, ...patch } as Constraint) : c)), label);
}
export function removeConstraint(api: StudioApi, id: string): void {
  setConstraints(api, constraintsOf(api.store.get()).filter((c) => c.id !== id), "Remove Constraint");
  if (api.store.get().cons.sel === id) setCons(api, { sel: null });
}
export function setCons(api: StudioApi, patch: Partial<ConsUi>): void {
  api.store.set((st) => ({ cons: { ...st.cons, ...patch } }));
}
/** The bbmodel doc changed under us (undo / redo): drop a selection that no longer exists. */
export function syncConstraintSel(api: StudioApi): void {
  const s = api.store.get();
  if (s.cons.sel && !constraintsOf(s).some((c) => c.id === s.cons.sel)) setCons(api, { sel: null });
}

// ---------------------------------------------------------------- creating (viewport picks)

/** The bone to rotate for a point on `bone`: nearest ancestor-or-self animated in this clip, else the nearest armor/biped bone, else the bone itself. */
export function defaultVia(bones: readonly ConsBone[], doc: Doc | null, anim: string | null, bone: string): string | undefined {
  const byName = new Map(bones.map((b) => [b.name, b]));
  const a = doc && anim && doc.kind !== "geo" ? getAnimation(doc, anim) : undefined;
  const chain: string[] = [];
  for (let n: string | undefined = bone, i = 0; n && byName.has(n) && i < 256; n = byName.get(n)?.parent, i++) chain.push(n);
  const animated = chain.find((n) => !!a?.bones.get(n)?.rotation?.keys.length);
  const armor = chain.find((n) => /^(armor|biped)(Head|Body|RightArm|LeftArm|RightLeg|LeftLeg)$/.test(n));
  const via = animated ?? armor ?? bone;
  return via === bone ? undefined : via;
}

export function beginPick(api: StudioApi, kind: "link" | "pin"): void {
  const pick: PickState = { kind, stage: "a", drive: "b" };
  setCons(api, { pick, showPoints: true });
}
export function cancelPick(api: StudioApi): void {
  if (api.store.get().cons.pick) setCons(api, { pick: null });
}
export function addFollow(api: StudioApi, source: string, target: string): Constraint {
  const c = makeFollow(source, target, /Left|Right/.test(source) && /Left|Right/.test(target) && source.replace(/Left|Right/, "") === target.replace(/Left|Right/, ""));
  setConstraints(api, [...constraintsOf(api.store.get()), c], "Add Constraint");
  setCons(api, { sel: c.id });
  return c;
}

/**
 * A viewport click in pick mode landed on `ref`; `world` = its current world position (file space). Link: first click is A, second B
 * (the second limb is the driven one by default). Pin: one click captures the position at the playhead.
 */
export function handlePick(api: StudioApi, ref: PointRef, world: NumVec3): void {
  const s = api.store.get();
  const pick = s.cons.pick;
  if (!pick) return;
  const list = constraintsOf(s);
  if (pick.kind === "pin") {
    const c = makePin(ref, world, Math.round(s.time * 1000) / 1000);
    setConstraints(api, [...list, c], "Add Pin");
    setCons(api, { pick: null, sel: c.id });
    return;
  }
  if (pick.stage === "a") { setCons(api, { pick: { ...pick, stage: "b", a: ref } }); return; }
  const c = makeLink(pick.a!, ref, pick.drive);
  setConstraints(api, [...list, c], "Add Link");
  setCons(api, { pick: null, sel: c.id });
}

// ---------------------------------------------------------------- baking

export interface BakeUi { at: "ticks" | "keys"; simplify: number; after: "keep" | "remove" }
export const DEFAULT_BAKE: BakeUi = { at: "ticks", simplify: 0, after: "keep" };

/** Bake `ids` (default: every enabled constraint) into rotation keys: ONE commit (one undo step). Then disable or remove them. */
export function bakeNow(api: StudioApi, bones: readonly ConsBone[], ids: readonly string[] | undefined, o: BakeUi): { keys: number; bones: string[] } | null {
  const s = api.store.get();
  if (!s.doc || !s.anim || s.doc.kind === "geo") return null;
  const list = constraintsOf(s);
  const chosen = list.filter((c) => (ids ? ids.includes(c.id) : c.enabled));
  if (!chosen.length) return null;
  const r = bakeConstraints(s.doc, bones, list, { anim: s.anim, ids: chosen.map((c) => c.id), at: o.at, simplify: o.simplify });
  let doc = r.doc;
  const done = new Set(chosen.map((c) => c.id));
  const after = list.flatMap((c) => (!done.has(c.id) ? [c] : o.after === "remove" ? [] : [{ ...c, enabled: false } as Constraint]));
  if (doc.kind === "bbmodel") {
    const all = { ...allConstraints(s), [s.anim]: after };
    if (!after.length) delete all[s.anim];
    doc = setBbConstraints(doc, all);
  } else {
    const all = { ...allConstraints(s), [s.anim]: after };
    if (!after.length) delete all[s.anim];
    api.store.set((st) => ({ cons: { ...st.cons, byAnim: all } }));
    save(api, all);
  }
  api.commit(doc, "Bake Constraints");
  if (o.after === "remove" && s.cons.sel && done.has(s.cons.sel)) setCons(api, { sel: null });
  return { keys: r.keys, bones: r.bones };
}

export { drivenBones, viaOf, initialCons };
