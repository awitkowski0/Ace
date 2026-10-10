/** Cyberduck-style transfer conflict prompt: Replace / Skip / Rename / Apply to all. */
import { useEffect, useState } from "react";
import { createStore, useStore } from "../../lib/store";
import { fs, joinPath, type Location } from "../../lib/ipc";
import { fmtDate, humanSize, rf } from "./api";

export type Resolution = "replace" | "skip" | "rename";
export interface Existing { name: string; size: number; modified: number | null; isDir: boolean }
export interface Incoming { name: string; path: string; size: number; modified: number | null; isDir: boolean }

interface Pending { incoming: Incoming; existing: Existing; remaining: number; done(r: Resolution, all: boolean): void }
const pending = createStore<{ cur: Pending | null }>({ cur: null });

const ask = (incoming: Incoming, existing: Existing, remaining: number) =>
  new Promise<{ r: Resolution; all: boolean }>((res) => {
    pending.set({ cur: { incoming, existing, remaining, done: (r, all) => { pending.set({ cur: null }); res({ r, all }); } } });
  });

/** "name.ext" -> "name (1).ext" (first free). */
export function uniqueName(name: string, taken: Set<string>): string {
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let i = 1; i < 10000; i++) {
    const n = `${stem} (${i})${ext}`;
    if (!taken.has(n)) return n;
  }
  return `${stem} (${Date.now()})${ext}`;
}

export interface PlannedTransfer { paths: string[]; names: string[] }

/** Resolve name conflicts of `incoming` against the contents of `destDir`. Returns what to actually transfer. */
export async function resolveConflicts(incoming: Incoming[], dest: Location): Promise<PlannedTransfer> {
  let existing: Existing[] = [];
  try {
    existing = dest.host === "local"
      ? (await fs.listDir(dest)).map((e) => ({ name: e.name, size: e.size, modified: e.modified, isDir: e.isDir }))
      : (await rf.list(dest)).map((e) => ({ name: e.name, size: e.size, modified: e.modified, isDir: e.isDir }));
  } catch { /* destination missing: nothing can conflict */ }
  const byName = new Map(existing.map((e) => [e.name, e]));
  const taken = new Set(byName.keys());
  const out: PlannedTransfer = { paths: [], names: [] };
  let all: Resolution | null = null;
  for (let i = 0; i < incoming.length; i++) {
    const inc = incoming[i];
    const ex = byName.get(inc.name);
    if (!ex) { out.paths.push(inc.path); out.names.push(""); taken.add(inc.name); continue; }
    let r: Resolution | null = all;
    if (!r) {
      const a: { r: Resolution; all: boolean } = await ask(inc, ex, incoming.length - i - 1);
      r = a.r;
      if (a.all) all = r;
    }
    if (r === "skip") continue;
    if (r === "replace") { out.paths.push(inc.path); out.names.push(""); continue; }
    const n = uniqueName(inc.name, taken);
    taken.add(n);
    out.paths.push(inc.path);
    out.names.push(n);
  }
  return out;
}

export { joinPath };

export function ConflictModal() {
  const { cur } = useStore(pending);
  const [all, setAll] = useState(false);
  useEffect(() => setAll(false), [cur]);
  if (!cur) return null;
  const { incoming: i, existing: e } = cur;
  const row = (label: string, size: number, mod: number | null, dir: boolean) => (
    <div className="rf-cf-row"><b>{label}</b><span>{dir ? "folder" : humanSize(size)}</span><span>{fmtDate(mod)}</span></div>
  );
  return (
    <div className="dialog-backdrop" onMouseDown={() => cur.done("skip", false)}>
      <div className="dialog rf-cf" onMouseDown={(ev) => ev.stopPropagation()}
        onKeyDown={(ev) => { if (ev.key === "Escape") cur.done("skip", false); }}>
        <div className="dialog-title">"{i.name}" already exists</div>
        <div className="dialog-msg">A {e.isDir ? "folder" : "file"} with this name is already in the destination.</div>
        {row("Existing", e.size, e.modified, e.isDir)}
        {row("Incoming", i.size, i.modified, i.isDir)}
        {cur.remaining > 0 && (
          <label className="rf-cf-all"><input type="checkbox" checked={all} onChange={(ev) => setAll(ev.target.checked)} /> Apply to all ({cur.remaining} more)</label>
        )}
        <div className="dialog-buttons">
          <button onClick={() => cur.done("skip", all)}>Skip</button>
          <button onClick={() => cur.done("rename", all)}>Rename</button>
          <button className="primary" autoFocus onClick={() => cur.done("replace", all)}>Replace</button>
        </div>
      </div>
    </div>
  );
}
