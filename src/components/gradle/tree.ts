/** Pure tree logic of the Gradle window: project hierarchy -> Tasks -> groups -> tasks, and the flattened visible rows. */
export interface GTask { name: string; path: string; group: string | null; description: string | null }
export interface GProject { name: string; path: string; dir: string; description: string | null; tasks: GTask[] }
export interface GModel {
  name: string; dir: string; gradleVersion: string; daemonPid: string | null;
  includedBuilds: { name: string; dir: string }[]; projects: GProject[];
}
export interface Pin { task: string; args?: string; name?: string; [k: string]: unknown }

export type RowKind = "pinned-root" | "pinned" | "project" | "tasks" | "group" | "task";
export interface Row {
  id: string; kind: RowKind; depth: number; label: string; hasChildren: boolean;
  /** task path (task / pinned rows) */
  task?: string; args?: string; description?: string | null; project?: string; pinIndex?: number;
}

const OTHER = "other";
export const groupName = (t: GTask) => t.group?.trim() || OTHER;

export function groupsOf(p: GProject): { name: string; tasks: GTask[] }[] {
  const m = new Map<string, GTask[]>();
  for (const t of p.tasks) {
    const g = groupName(t);
    (m.get(g) ?? m.set(g, []).get(g)!).push(t);
  }
  return [...m.entries()]
    .sort(([a], [b]) => (a === OTHER ? 1 : b === OTHER ? -1 : a.toLowerCase() < b.toLowerCase() ? -1 : 1))
    .map(([name, tasks]) => ({ name, tasks: tasks.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) }));
}

const parentPath = (p: string) => (p.lastIndexOf(":") <= 0 ? ":" : p.slice(0, p.lastIndexOf(":")));

export const pinKey = (p: { task: string; args?: string }) => `${p.task}\0${p.args ?? ""}`;
export const pinLabel = (p: Pin) => p.name || p.task;

export interface Expansion { has(id: string): boolean }

export function visibleRows(model: GModel | null, pins: Pin[], open: Expansion): Row[] {
  const rows: Row[] = [];
  if (pins.length) {
    rows.push({ id: "pinned", kind: "pinned-root", depth: 0, label: "Pinned", hasChildren: true });
    if (open.has("pinned")) {
      pins.forEach((p, i) => rows.push({ id: `pin:${i}:${pinKey(p)}`, kind: "pinned", depth: 1, label: pinLabel(p), hasChildren: false, task: p.task, args: p.args, pinIndex: i, description: p.args ? `${p.task} ${p.args}` : p.task }));
    }
  }
  if (!model) return rows;
  const byParent = new Map<string, GProject[]>();
  for (const p of model.projects) {
    if (p.path === ":") continue;
    const pp = parentPath(p.path);
    (byParent.get(pp) ?? byParent.set(pp, []).get(pp)!).push(p);
  }
  const byPath = new Map(model.projects.map((p) => [p.path, p]));
  const walk = (p: GProject, depth: number) => {
    const id = `proj:${p.path}`;
    const kids = byParent.get(p.path) ?? [];
    const hasTasks = p.tasks.length > 0;
    rows.push({ id, kind: "project", depth, label: p.path === ":" ? model.name : p.name, hasChildren: hasTasks || kids.length > 0, project: p.path, description: p.description });
    if (!open.has(id)) return;
    if (hasTasks) {
      const tid = `tasks:${p.path}`;
      rows.push({ id: tid, kind: "tasks", depth: depth + 1, label: "Tasks", hasChildren: true, project: p.path });
      if (open.has(tid)) {
        for (const g of groupsOf(p)) {
          const gid = `group:${p.path}:${g.name}`;
          rows.push({ id: gid, kind: "group", depth: depth + 2, label: g.name, hasChildren: true, project: p.path });
          if (!open.has(gid)) continue;
          for (const t of g.tasks) rows.push({ id: `task:${t.path}`, kind: "task", depth: depth + 3, label: t.name, hasChildren: false, task: t.path, description: t.description, project: p.path });
        }
      }
    }
    for (const k of kids.sort((a, b) => (a.name < b.name ? -1 : 1))) walk(k, depth + 1);
  };
  const root = byPath.get(":");
  if (root) walk(root, 0);
  else for (const p of model.projects.filter((x) => parentPath(x.path) === ":" || x.path === ":")) walk(p, 0);
  return rows;
}

/** Every container id (for Expand All). */
export function allContainers(model: GModel | null, pins: Pin[]): string[] {
  const ids = pins.length ? ["pinned"] : [];
  for (const p of model?.projects ?? []) {
    ids.push(`proj:${p.path}`);
    if (p.tasks.length) { ids.push(`tasks:${p.path}`); for (const g of groupsOf(p)) ids.push(`group:${p.path}:${g.name}`); }
  }
  return ids;
}

export function allTasks(model: GModel | null): GTask[] {
  return (model?.projects ?? []).flatMap((p) => p.tasks);
}

/** `dir` of every non-root project, relative to the build root (fingerprint input). */
export function subprojectDirs(model: GModel | null, rootPath: string): string[] {
  const base = rootPath.replace(/\/$/, "") + "/";
  return (model?.projects ?? []).map((p) => p.dir).filter((d) => d.startsWith(base)).map((d) => d.slice(base.length)).slice(0, 300);
}

/** Pins from the raw `gradle` section: only entries with a string `task` (unknown keys of an entry are kept). */
export function pinsOf(section: unknown): Pin[] {
  const arr = (section as { pinned?: unknown } | undefined)?.pinned;
  return Array.isArray(arr) ? (arr.filter((p) => p && typeof p === "object" && typeof (p as Pin).task === "string") as Pin[]) : [];
}
