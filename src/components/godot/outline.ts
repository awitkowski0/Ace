/** Read-only node outline of a Godot text scene (.tscn). Pure. */
export interface SceneNode {
  name: string;
  type: string;
  /** "." for direct children of the root, null for the root */
  parent: string | null;
  /** res:// path of the instanced scene */
  instance?: string;
  /** res:// path of the attached script */
  script?: string;
  groups: string[];
  line: number;
  depth: number;
}

const attr = (h: string, key: string): string | undefined => {
  const m = new RegExp(`(?:^|\\s)${key}=("(?:[^"\\\\]|\\\\.)*"|[^\\s\\]]+(?:\\([^)]*\\))?)`).exec(h);
  if (!m) return undefined;
  const v = m[1];
  return v.startsWith('"') ? v.slice(1, -1) : v;
};

export function parseScene(text: string): SceneNode[] {
  const ext = new Map<string, string>();
  type Raw = Omit<SceneNode, "depth"> & { path: string };
  const raws: Raw[] = [];
  let cur: Raw | null = null;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith("[")) {
      cur = null;
      if (l.startsWith("[ext_resource")) {
        const id = attr(l, "id");
        const path = attr(l, "path");
        if (id && path) ext.set(id, path);
      } else if (l.startsWith("[node ")) {
        const name = attr(l, "name") ?? "?";
        const parent = attr(l, "parent") ?? null;
        const inst = /instance=ExtResource\(\s*"([^"]+)"\s*\)/.exec(l);
        const groups = /groups=\[([^\]]*)\]/.exec(l)?.[1].split(",").map((g) => g.trim().replace(/^"|"$/g, "")).filter(Boolean) ?? [];
        const path = parent === null ? "" : parent === "." ? name : `${parent}/${name}`;
        cur = { name, type: attr(l, "type") ?? "", parent, instance: inst ? ext.get(inst[1]) : undefined, groups, line: i + 1, path };
        raws.push(cur);
      }
    } else if (cur && l.startsWith("script = ")) {
      const m = /ExtResource\(\s*"([^"]+)"\s*\)/.exec(l);
      if (m) cur.script = ext.get(m[1]);
    }
  }
  // depth + DFS order by node path (file order already lists a parent before its children, but siblings may interleave)
  const kids = new Map<string, Raw[]>();
  let root: Raw | undefined;
  for (const r of raws) {
    if (r.parent === null) { root ??= r; continue; }
    const pp = r.parent === "." ? "" : r.parent;
    (kids.get(pp) ?? kids.set(pp, []).get(pp)!).push(r);
  }
  const out: SceneNode[] = [];
  const walk = (n: Raw, depth: number) => {
    const { path: _p, ...rest } = n;
    out.push({ ...rest, depth });
    for (const c of kids.get(n.path) ?? []) walk(c, depth + 1);
  };
  if (root) walk(root, 0);
  return out;
}

export const nodeDetail = (n: SceneNode) => [n.type || (n.instance ? "instance" : ""), n.instance ? n.instance.split("/").pop() : "", n.script ? `${n.script.split("/").pop()}` : ""].filter(Boolean).join(" · ");
