import { useMemo, useRef, useState } from "react";
import { useStore } from "../../lib/store";
import { basename } from "../../lib/ipc";
import { ChevronDown, ChevronRight, FileIcon } from "../shell/icons";
import { findStore } from "./findStore";
import { absLoc, openAt } from "./nav";
import { RangeHl, VList, dirOf } from "./ui";
import { openPopup } from "../shell/popups";
import { searchText } from "./api";

type Row = { t: "file"; path: string; rel: string; n: number } | { t: "m"; m: import("./api").TextMatch };

export function FindPanel() {
  const s = useStore(findStore);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState(0);
  const box = useRef<HTMLDivElement>(null);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    const byFile = new Map<string, import("./api").TextMatch[]>();
    for (const m of s.matches) (byFile.get(m.path) ?? byFile.set(m.path, []).get(m.path)!).push(m);
    for (const [path, ms] of [...byFile].sort((a, b) => (a[1][0].rel < b[1][0].rel ? -1 : 1))) {
      out.push({ t: "file", path, rel: ms[0].rel, n: ms.length });
      if (!collapsed.has(path)) for (const m of ms) out.push({ t: "m", m });
    }
    return out;
  }, [s.matches, collapsed]);

  const open = (r: Row | undefined) => {
    if (!r || !s.root) return;
    if (r.t === "file") setCollapsed((c) => { const n = new Set(c); n.has(r.path) ? n.delete(r.path) : n.add(r.path); return n; });
    else void openAt(absLoc(s.root, r.m.path), r.m.line, r.m.col);
  };
  const rerun = () => {
    if (!s.root || !s.opts) return;
    const acc: import("./api").TextMatch[] = [];
    findStore.set({ matches: [], done: false });
    searchText(s.root, s.opts, (ms, done, info) => {
      acc.push(...ms);
      findStore.set({ matches: acc.slice(), done, truncated: info.truncated, elapsedMs: info.elapsedMs });
    });
  };

  return (
    <div className="se-findpanel" ref={box} tabIndex={0} data-autofocus
      onKeyDown={(e) => {
        if (e.key === "ArrowDown") setSel((i) => Math.min(rows.length - 1, i + 1));
        else if (e.key === "ArrowUp") setSel((i) => Math.max(0, i - 1));
        else if (e.key === "Enter") open(rows[sel]);
        else if (e.key === "ArrowLeft" && rows[sel]?.t === "file") setCollapsed((c) => new Set(c).add((rows[sel] as { path: string }).path));
        else if (e.key === "ArrowRight" && rows[sel]?.t === "file") setCollapsed((c) => { const n = new Set(c); n.delete((rows[sel] as { path: string }).path); return n; });
        else return;
        e.preventDefault();
      }}>
      <div className="se-fp-bar">
        <span className="se-fp-title">{s.title ? <>Matches for “{s.title}”</> : "No search yet"}</span>
        <span className="dim">{s.matches.length}{s.truncated ? "+" : ""} matches{s.done ? "" : " …"}</span>
        <span style={{ flex: 1 }} />
        <button className="se-btn" onClick={rerun} disabled={!s.opts}>Rerun</button>
        <button className="se-btn" onClick={() => openPopup("FindInPath", { query: s.title })}>New search…</button>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <VList items={rows} height="100%" sel={sel} render={(r, i) =>
          r.t === "file" ? (
            <div className={"popup-row se-row se-filehead" + (i === sel ? " selected" : "")} onMouseDown={() => setSel(i)} onClick={() => open(r)}>
              {collapsed.has(r.path) ? <ChevronRight /> : <ChevronDown />}<span className="se-icon"><FileIcon /></span>
              <span className="se-label">{basename(r.path)}</span><span className="se-sec">{dirOf(r.rel)}</span><span className="se-right">{r.n}</span>
            </div>
          ) : (
            <div className={"popup-row se-row se-matchrow" + (i === sel ? " selected" : "")} onMouseDown={() => setSel(i)} onDoubleClick={() => open(r)}>
              <span className="se-ln">{r.m.line}</span>
              <span className="se-label se-code"><RangeHl text={r.m.text} ranges={r.m.ranges} /></span>
            </div>
          )} />
      </div>
    </div>
  );
}
