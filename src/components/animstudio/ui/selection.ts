/**
 * Selection logic of the Studio (pure; no React / three). Re-implements Blockbench's selection behaviour (docs/BLOCKBENCH-PARITY.md
 * section 7): Cmd-click toggles, Shift-click range-selects siblings in the Outliner, selecting a group selects everything inside it,
 * toggling one cube of a selected group unselects the group but keeps the rest, viewport Shift-click adds the clicked cube's group
 * (climbing to the parent group when that is already selected), Cmd-drag area select (Shift adds).
 *
 * State model (StudioState): in Edit mode the selection is EITHER a set of groups (`cube === null`, `bones` = the groups; the
 * transforms act on the group trees) OR a set of cubes (`cube` = the primary / last one, `cubes` = all of them; `bones` then merely
 * lists their groups). Mixing the two flattens the groups into their cubes, so every edit has one well-defined set of targets.
 */
export interface CubeRef { bone: string; index: number }
export interface SelValue { bones: string[]; cube: CubeRef | null; cubes: CubeRef[] }
export interface Mods { meta: boolean; shift: boolean }
/** Outliner row in display order. A cube row's `parent` is its group. */
export interface RowRef { t: "bone" | "cube"; bone: string; index?: number; parent: string }
/** Group structure queries (a RigModel provides them). */
export interface Tree {
  /** all cubes of the group and of every descendant group, in outliner order */
  cubesUnder(bone: string): CubeRef[];
  parentOf(bone: string): string | undefined;
  /** is `bone` locked / hidden (cannot be selected from the viewport) */
  blocked?(bone: string): boolean;
}

export const same = (a: CubeRef, b: CubeRef) => a.bone === b.bone && a.index === b.index;
export const keyOf = (c: CubeRef) => `${c.bone}#${c.index}`;
const uniq = <T,>(xs: T[], k: (x: T) => string) => { const seen = new Set<string>(); return xs.filter((x) => { const s = k(x); if (seen.has(s)) return false; seen.add(s); return true; }); };

export const EMPTY: SelValue = { bones: [], cube: null, cubes: [] };

/** Selection from raw store fields; honours `cubes` only while it still contains the primary `cube` (a bare `{cube}` set by older code is a single cube). */
export function selValue(s: { bones: string[]; cube: CubeRef | null; cubes?: CubeRef[] }): SelValue {
  if (!s.cube) return { bones: s.bones, cube: null, cubes: [] };
  const cubes = s.cubes && s.cubes.some((c) => same(c, s.cube!)) ? s.cubes : [s.cube];
  return { bones: s.bones, cube: s.cube, cubes };
}

export const ofGroups = (bones: string[]): SelValue => ({ bones, cube: null, cubes: [] });
export function ofCubes(cubes: CubeRef[], primary?: CubeRef): SelValue {
  const cs = uniq(cubes, keyOf);
  if (!cs.length) return EMPTY;
  const cube = primary && cs.some((c) => same(c, primary)) ? primary : cs[cs.length - 1];
  return { bones: uniq(cs.map((c) => c.bone), (b) => b), cube, cubes: cs };
}

/** Every cube a selection covers (group selections expand to their subtree). */
export function coveredCubes(sel: SelValue, tree: Tree): CubeRef[] {
  if (sel.cube) return sel.cubes;
  return uniq(sel.bones.flatMap((b) => tree.cubesUnder(b)), keyOf);
}

/** Convert whatever is selected into an explicit cube selection (the flattening used when groups and cubes mix). */
const flatten = (sel: SelValue, tree: Tree): CubeRef[] => coveredCubes(sel, tree);

/** Groups of a group selection that are not inside another selected group (their trees move as one). */
export function topGroups(bones: readonly string[], tree: Pick<Tree, "parentOf">): string[] {
  const set = new Set(bones);
  return bones.filter((b) => {
    for (let p = tree.parentOf(b), n = 0; p && n < 1000; p = tree.parentOf(p), n++) if (set.has(p)) return false;
    return true;
  });
}

// ---------------------------------------------------------------- outliner clicks

/**
 * Click on an outliner row. Plain = select only that row (a group selects its whole subtree); Cmd = toggle; Shift = select the range
 * from the previously selected row of the same kind among the siblings (same group) and ADD it; a Shift click without a usable
 * anchor adds just the row. In Animate / Pose only groups are selectable (cube rows select their group).
 */
export function clickRow(rows: readonly RowRef[], cur: SelValue, row: RowRef, mods: Mods, tree: Tree, animate = false): SelValue {
  if (row.t === "cube" && animate) return clickRow(rows, cur, { t: "bone", bone: row.bone, parent: tree.parentOf(row.bone) ?? "" }, mods, tree, true);
  if (row.t === "bone") {
    const multi = mods.meta || mods.shift;
    if (!multi) return ofGroups([row.bone]);
    if (cur.cube) {
      // groups mixed into a cube selection flatten into cubes
      if (mods.meta && !mods.shift) {
        const under = tree.cubesUnder(row.bone);
        const have = under.length > 0 && under.every((u) => cur.cubes.some((c) => same(c, u)));
        const next = have ? cur.cubes.filter((c) => !under.some((u) => same(u, c))) : [...cur.cubes, ...under];
        return ofCubes(next);
      }
      return ofCubes([...cur.cubes, ...tree.cubesUnder(row.bone)]);
    }
    if (mods.shift) {
      const anchor = cur.bones[cur.bones.length - 1];
      const sibs = rows.filter((r) => r.t === "bone" && r.parent === row.parent);
      const ai = sibs.findIndex((r) => r.bone === anchor), bi = sibs.findIndex((r) => r.bone === row.bone);
      if (anchor !== undefined && ai >= 0 && bi >= 0) {
        const [lo, hi] = ai <= bi ? [ai, bi] : [bi, ai];
        const range = sibs.slice(lo, hi + 1).map((r) => r.bone);
        return ofGroups(uniq([...cur.bones, ...range], (b) => b));
      }
      return ofGroups(uniq([...cur.bones, row.bone], (b) => b));
    }
    // Cmd toggle
    return ofGroups(cur.bones.includes(row.bone) ? cur.bones.filter((b) => b !== row.bone) : [...cur.bones, row.bone]);
  }
  // cube row
  const me: CubeRef = { bone: row.bone, index: row.index! };
  const multi = mods.meta || mods.shift;
  if (!multi) return ofCubes([me]);
  const base = flatten(cur, tree);
  if (mods.shift) {
    const anchor = cur.cube;
    const sibs = rows.filter((r) => r.t === "cube" && r.parent === row.parent);
    const ai = anchor ? sibs.findIndex((r) => r.bone === anchor.bone && r.index === anchor.index) : -1;
    const bi = sibs.findIndex((r) => r.index === me.index && r.bone === me.bone);
    if (ai >= 0 && bi >= 0) {
      const [lo, hi] = ai <= bi ? [ai, bi] : [bi, ai];
      const range = sibs.slice(lo, hi + 1).map((r) => ({ bone: r.bone, index: r.index! }));
      return ofCubes([...base, ...range], me);
    }
    return ofCubes(base.some((c) => same(c, me)) ? base : [...base, me], me);
  }
  return toggleCube(cur, me, tree);
}

/** Cmd-click on a cube: toggle it; when it belonged to a selected group the group dissolves into its other cubes (Blockbench). */
export function toggleCube(cur: SelValue, me: CubeRef, tree: Tree): SelValue {
  const base = flatten(cur, tree);
  const has = base.some((c) => same(c, me));
  return has ? ofCubes(base.filter((c) => !same(c, me))) : ofCubes([...base, me], me);
}

// ---------------------------------------------------------------- viewport clicks

/**
 * Viewport click on a cube. Plain = that cube only; Cmd = toggle it; Shift = add the cube's group (the parent group, or its parent
 * when that group is already selected). `edit` false (Animate / Pose) selects the cube's group instead of the cube.
 */
export function pickCube(cur: SelValue, hit: CubeRef, mods: Mods, tree: Tree, edit = true): SelValue {
  if (!edit) {
    if (mods.meta) return ofGroups(cur.bones.includes(hit.bone) ? cur.bones.filter((b) => b !== hit.bone) : [...cur.bones, hit.bone]);
    if (mods.shift) {
      let g = hit.bone;
      while (cur.bones.includes(g) && tree.parentOf(g)) g = tree.parentOf(g)!;
      return ofGroups(uniq([...cur.bones, g], (b) => b));
    }
    return ofGroups([hit.bone]);
  }
  if (mods.shift) return pickGroup(cur, hit.bone, tree);
  if (mods.meta) return toggleCube(cur, hit, tree);
  return ofCubes([hit]);
}

/** Shift-click: add a group (climbing to the parent when the group is already part of the selection). */
export function pickGroup(cur: SelValue, bone: string, tree: Tree): SelValue {
  let g = bone;
  const isSel = (b: string) => (cur.cube ? tree.cubesUnder(b).length > 0 && tree.cubesUnder(b).every((u) => cur.cubes.some((c) => same(c, u))) : cur.bones.includes(b));
  for (let n = 0; isSel(g) && tree.parentOf(g) && n < 1000; n++) g = tree.parentOf(g)!;
  if (cur.cube) return ofCubes([...cur.cubes, ...tree.cubesUnder(g)]);
  return ofGroups(uniq([...cur.bones, g], (b) => b));
}

/** Cmd-drag rectangle result (Shift adds to the current selection). */
export function areaSelect(cur: SelValue, hits: CubeRef[], add: boolean, tree: Tree, edit = true): SelValue {
  if (!edit) {
    const bones = uniq(hits.map((h) => h.bone), (b) => b);
    return ofGroups(add ? uniq([...cur.bones, ...bones], (b) => b) : bones);
  }
  const base = add ? flatten(cur, tree) : [];
  return ofCubes([...base, ...hits]);
}

/** Edit targets: groups to transform as trees (top-most only) and the explicit cubes (cube mode). */
export function targets(sel: SelValue, tree: Pick<Tree, "parentOf">, locked: ReadonlySet<string> = new Set()): { bones: string[]; cubes: CubeRef[] } {
  if (sel.cube) return { bones: [], cubes: sel.cubes.filter((c) => !locked.has(c.bone)) };
  return { bones: topGroups(sel.bones, tree).filter((b) => !locked.has(b)), cubes: [] };
}
