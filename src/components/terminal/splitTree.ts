/** Pure split-tree model for a terminal tab (unit-tested in splitTree.test.ts). "row" = panes side by side, "col" = stacked. */
export type Dir = "row" | "col";
export type Leaf = { t: "leaf"; pane: string };
export type Split = { t: "split"; id: string; dir: Dir; ratio: number; a: Node; b: Node };
export type Node = Leaf | Split;
export type Direction = "left" | "right" | "up" | "down";
export interface Rect { x: number; y: number; w: number; h: number }

let splitSeq = 0;
export const leaf = (pane: string): Leaf => ({ t: "leaf", pane });

export function leaves(n: Node): string[] {
  return n.t === "leaf" ? [n.pane] : [...leaves(n.a), ...leaves(n.b)];
}

/** Replace `target` by a split holding [target, newPane] (the new pane goes right / below). */
export function splitLeaf(root: Node, target: string, newPane: string, dir: Dir): Node {
  if (root.t === "leaf") return root.pane === target ? { t: "split", id: `s${++splitSeq}`, dir, ratio: 0.5, a: root, b: leaf(newPane) } : root;
  return { ...root, a: splitLeaf(root.a, target, newPane, dir), b: splitLeaf(root.b, target, newPane, dir) };
}

/** Remove a leaf; its sibling takes the parent's place. null when the tree becomes empty. */
export function removeLeaf(root: Node, pane: string): Node | null {
  if (root.t === "leaf") return root.pane === pane ? null : root;
  const a = removeLeaf(root.a, pane);
  const b = removeLeaf(root.b, pane);
  if (!a) return b;
  if (!b) return a;
  return a === root.a && b === root.b ? root : { ...root, a, b };
}

export function setRatio(root: Node, id: string, ratio: number): Node {
  if (root.t === "leaf") return root;
  if (root.id === id) return { ...root, ratio: clamp(ratio) };
  return { ...root, a: setRatio(root.a, id, ratio), b: setRatio(root.b, id, ratio) };
}
const clamp = (r: number) => Math.min(0.9, Math.max(0.1, r));

const weight = (n: Node, dir: Dir): number => (n.t === "split" && n.dir === dir ? weight(n.a, dir) + weight(n.b, dir) : 1);
/** Ghostty "equalize_splits": every pane of a same-direction run gets the same share. */
export function equalize(n: Node): Node {
  if (n.t === "leaf") return n;
  const wa = weight(n.a, n.dir);
  const wb = weight(n.b, n.dir);
  return { ...n, ratio: wa / (wa + wb), a: equalize(n.a), b: equalize(n.b) };
}

export function layoutRects(n: Node, r: Rect = { x: 0, y: 0, w: 1, h: 1 }, out = new Map<string, Rect>()): Map<string, Rect> {
  if (n.t === "leaf") return out.set(n.pane, r);
  if (n.dir === "row") {
    layoutRects(n.a, { x: r.x, y: r.y, w: r.w * n.ratio, h: r.h }, out);
    layoutRects(n.b, { x: r.x + r.w * n.ratio, y: r.y, w: r.w * (1 - n.ratio), h: r.h }, out);
  } else {
    layoutRects(n.a, { x: r.x, y: r.y, w: r.w, h: r.h * n.ratio }, out);
    layoutRects(n.b, { x: r.x, y: r.y + r.h * n.ratio, w: r.w, h: r.h * (1 - n.ratio) }, out);
  }
  return out;
}

const EPS = 1e-6;
const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

/** Nearest pane in a direction (no wrap-around), by on-screen geometry. */
export function neighbor(root: Node, pane: string, dir: Direction): string | null {
  const rects = layoutRects(root);
  const c = rects.get(pane);
  if (!c) return null;
  let best: { id: string; gap: number; ov: number } | null = null;
  for (const [id, r] of rects) {
    if (id === pane) continue;
    let gap: number, ov: number;
    if (dir === "right") { gap = r.x - (c.x + c.w); ov = overlap(c.y, c.y + c.h, r.y, r.y + r.h); }
    else if (dir === "left") { gap = c.x - (r.x + r.w); ov = overlap(c.y, c.y + c.h, r.y, r.y + r.h); }
    else if (dir === "down") { gap = r.y - (c.y + c.h); ov = overlap(c.x, c.x + c.w, r.x, r.x + r.w); }
    else { gap = c.y - (r.y + r.h); ov = overlap(c.x, c.x + c.w, r.x, r.x + r.w); }
    if (gap < -EPS || ov < EPS) continue;
    if (!best || gap < best.gap - EPS || (Math.abs(gap - best.gap) < EPS && ov > best.ov)) best = { id, gap, ov };
  }
  return best?.id ?? null;
}

/** Next / previous pane in reading order, wrapping (Ghostty goto_split:next / previous). */
export function cycle(root: Node, pane: string, delta: 1 | -1): string {
  const l = leaves(root);
  const i = l.indexOf(pane);
  return l[(i + delta + l.length) % l.length] ?? pane;
}

/** The split that a resize in `dir` moves: nearest ancestor on the matching axis. Returns the id and the signed ratio step. */
export function resizeTarget(root: Node, pane: string, dir: Direction): { id: string; sign: 1 | -1; dir: Dir } | null {
  const axis: Dir = dir === "left" || dir === "right" ? "row" : "col";
  const sign: 1 | -1 = dir === "right" || dir === "down" ? 1 : -1;
  let found: { id: string; sign: 1 | -1; dir: Dir } | null = null;
  const walk = (n: Node): boolean => {
    if (n.t === "leaf") return n.pane === pane;
    const inside = walk(n.a) || walk(n.b);
    if (inside && !found && n.dir === axis) found = { id: n.id, sign, dir: axis };
    return inside;
  };
  walk(root);
  return found;
}

export function findSplit(root: Node, id: string): Split | null {
  if (root.t === "leaf") return null;
  return root.id === id ? root : findSplit(root.a, id) ?? findSplit(root.b, id);
}

/** Move the divider that borders `pane` in `dir` by `delta` (fraction of that split's extent). */
export function resizePane(root: Node, pane: string, dir: Direction, delta: number): Node {
  const t = resizeTarget(root, pane, dir);
  if (!t) return root;
  const s = findSplit(root, t.id)!;
  return setRatio(root, t.id, s.ratio + t.sign * delta);
}

export interface SplitRect { id: string; dir: Dir; rect: Rect; ratio: number }
/** Every split with the rectangle it occupies (unit square), for drawing / dragging dividers. */
export function layoutSplits(n: Node, r: Rect = { x: 0, y: 0, w: 1, h: 1 }, out: SplitRect[] = []): SplitRect[] {
  if (n.t === "leaf") return out;
  out.push({ id: n.id, dir: n.dir, rect: r, ratio: n.ratio });
  if (n.dir === "row") {
    layoutSplits(n.a, { x: r.x, y: r.y, w: r.w * n.ratio, h: r.h }, out);
    layoutSplits(n.b, { x: r.x + r.w * n.ratio, y: r.y, w: r.w * (1 - n.ratio), h: r.h }, out);
  } else {
    layoutSplits(n.a, { x: r.x, y: r.y, w: r.w, h: r.h * n.ratio }, out);
    layoutSplits(n.b, { x: r.x, y: r.y + r.h * n.ratio, w: r.w, h: r.h * (1 - n.ratio) }, out);
  }
  return out;
}
