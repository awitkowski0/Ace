import { useEffect, useMemo, useRef, useState } from "react";
import { PopupShell, registerPopup, type PopupProps } from "./popups";
import { useStore } from "../../lib/store";
import { openProjectFlow, openRemoteProject, pickAndOpenFolder, projectName, projectStore } from "../../lib/project";
import { sameLoc, type Location } from "../../lib/ipc";
import { windows, type WinItem } from "../../lib/windows";
import { fuzzy } from "../search/fuzzy";
import { Hl } from "../search/ui";
import { FolderIcon } from "./icons";

const shortPath = (l: Location) => (l.host === "local" ? l.path.replace(/^\/Users\/[^/]+/, "~") : `${l.host}:${l.path}`);

interface Row {
  key: string;
  section: "Open Projects" | "Recent Projects";
  loc: Location;
  name: string;
  current?: boolean;
  label?: string; // window label when open
}

/** IntelliJ New UI project widget dropdown: open projects (✓ current) then recent projects, type-to-filter, Enter switches/opens. */
function RecentProjects({ onClose }: PopupProps) {
  const { recent, root } = useStore(projectStore);
  const [wins, setWins] = useState<WinItem[]>([]);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [branches, setBranches] = useState<Record<string, string | null>>({});
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    windows.list().then(setWins).catch(() => {});
    input.current?.focus();
  }, []);

  const rows = useMemo(() => {
    const open: Row[] = wins.filter((w) => w.project).map((w) => ({ key: "w:" + w.label, section: "Open Projects", loc: w.project!, name: projectName(w.project!), current: w.current, label: w.label }));
    const rec: Row[] = recent.filter((r) => !open.some((o) => sameLoc(o.loc, r))).map((r) => ({ key: "r:" + r.host + r.path, section: "Recent Projects", loc: r, name: projectName(r) }));
    const all = [...open, ...rec];
    if (!q) return all.map((r) => ({ r, idx: [] as number[] }));
    return all.map((r) => ({ r, f: fuzzy(q, r.name) ?? fuzzy(q, shortPath(r.loc)) })).filter((x) => x.f).sort((a, b) => b.f!.score - a.f!.score).map((x) => ({ r: x.r, idx: fuzzy(q, x.r.name) ? x.f!.indices : [] }));
  }, [wins, recent, q]);

  useEffect(() => { setSel((s) => Math.min(s, Math.max(0, rows.length - 1))); }, [rows.length]);
  useEffect(() => {
    // branch per project (local ones read .git/HEAD in Rust, instant)
    for (const { r } of rows) {
      if (r.key in branches || r.loc.host !== "local") continue;
      windows.branch(r.loc).then((b) => setBranches((m) => ({ ...m, [r.key]: b }))).catch(() => {});
    }
  }, [rows]); // eslint-disable-line

  const choose = (row?: Row) => {
    const x = row ?? rows[sel]?.r;
    onClose();
    if (!x) return;
    if (x.label) void windows.focus(x.label);
    else void openProjectFlow(x.loc);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") setSel((s) => (rows.length ? (s + 1) % rows.length : 0));
    else if (e.key === "ArrowUp") setSel((s) => (rows.length ? (s - 1 + rows.length) % rows.length : 0));
    else if (e.key === "Enter") choose();
    else return;
    e.preventDefault();
  };

  let lastSection = "";
  return (
    <PopupShell onClose={onClose} width={620}>
      <div className="popup-tabs"><span className="popup-title">Projects</span></div>
      <div className="se-inputrow">
        <input ref={input} className="se-input" placeholder="Search projects" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} spellCheck={false} />
      </div>
      <div className="rp-list" data-testid="recent-projects">
        {rows.map(({ r, idx }, i) => {
          const head = r.section !== lastSection ? <div className="popup-section">{r.section}</div> : null;
          lastSection = r.section;
          const b = branches[r.key];
          return (
            <div key={r.key}>
              {head}
              <div className={"popup-row se-row rp-row" + (i === sel ? " selected" : "")} data-open={r.label ? "1" : undefined} data-name={r.name}
                onMouseDown={(e) => { e.preventDefault(); setSel(i); }} onClick={() => choose(r)}>
                <span className="rp-check">{r.current || (r.label && root && sameLoc(r.loc, root)) ? "✓" : ""}</span>
                <span className="se-icon"><FolderIcon /></span>
                <span className="se-label"><Hl text={r.name} indices={idx} /></span>
                <span className="se-sec">{shortPath(r.loc)}</span>
                {b && <span className="rp-branch">{b}</span>}
              </div>
            </div>
          );
        })}
        {!rows.length && <div className="se-empty">No projects</div>}
      </div>
      <div className="rp-actions">
        <button onClick={() => { onClose(); void pickAndOpenFolder(); }}>Open…</button>
        <button onClick={() => { onClose(); void openRemoteProject(); }}>Open Remote…</button>
      </div>
    </PopupShell>
  );
}

registerPopup("RecentProjects", RecentProjects);
