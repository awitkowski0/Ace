import { useEffect, useMemo, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import "./welcome.css";
import { useStore } from "../../lib/store";
import { invoke, type Location } from "../../lib/ipc";
import { openProject, openProjectFlow, openRemoteProject, pickAndOpenFolder, projectStore, removeRecent } from "../../lib/project";
import { windows } from "../../lib/windows";
import { abbrevPath, initials, isGroup, matchName, tileColor, type RecentGroup, type RecentRow } from "../../lib/recentProjects";
import { fuzzy } from "../search/fuzzy";
import { Hl } from "../search/ui";
import { runAction } from "../../actions/registry";
import { SCHEMES, schemeStore, setScheme } from "../../theme";
import { BranchIcon, ChevronDown, ChevronRight, CloseIcon, FolderIcon, GearIcon, SearchIcon, SparkIcon } from "./icons";
import { showContextMenu } from "./contextMenu";
import { useBranch, useHome, useRecentModel } from "./useRecent";
import { fileManagerName, formatShortcut } from "../../lib/platform";

type Item = { kind: "row" | "group" | "child"; key: string; loc: Location; name: string; idx: number[]; count?: number; open?: boolean };

function AceLogo({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-label="Ace">
      <defs><linearGradient id="ace-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#88c0d0" /><stop offset="1" stopColor="#5e81ac" /></linearGradient></defs>
      <rect x="1" y="1" width="38" height="38" rx="9" fill="url(#ace-g)" />
      <path d="M20 8l9.5 24h-4.2l-2-5.4h-6.6l-2 5.4H10.5zM20 15.4l-2.3 6.4h4.6z" fill="#2e3440" fillRule="evenodd" />
    </svg>
  );
}

function Tile({ k, name, size = 32 }: { k: string; name: string; size?: number }) {
  return <span className="wl-tile" style={{ background: tileColor(k), width: size, height: size, fontSize: size * 0.4 }}>{initials(name)}</span>;
}

function Row({ it, sel, home, onSelect, onOpen, onMenu, onRemove, onToggle }: {
  it: Item; sel: boolean; home: string; onSelect: () => void; onOpen: () => void; onMenu: (e: React.MouseEvent) => void; onRemove: () => void; onToggle: () => void;
}) {
  const branch = useBranch(it.loc);
  const remote = it.loc.host !== "local";
  return (
    <div className={"wl-row" + (it.kind === "child" ? " child" : "") + (sel ? " selected" : "")} role="option" aria-selected={sel} data-key={it.key} data-name={it.name} data-kind={it.kind}
      onMouseDown={onSelect} onDoubleClick={onOpen} onClick={onOpen} onContextMenu={onMenu}>
      {it.kind === "group"
        ? <span className="wl-chev" data-chev onClick={(e) => { e.stopPropagation(); onToggle(); }}>{it.open ? <ChevronDown /> : <ChevronRight />}</span>
        : <span className="wl-chev" />}
      <Tile k={it.key} name={it.name} size={it.kind === "child" ? 26 : 32} />
      <span className="wl-text">
        <span className="wl-name"><Hl text={it.name} indices={it.idx} />{remote && <span className="wl-host">{it.loc.host}</span>}</span>
        <span className="wl-path">{remote ? it.loc.path : abbrevPath(it.loc, home)}</span>
      </span>
      {it.kind === "group" && <span className="wl-count" data-count>{it.count} worktree{it.count === 1 ? "" : "s"}</span>}
      {branch && <span className="wl-branch"><BranchIcon />{branch}</span>}
      <button className="wl-x" title="Remove from Recent Projects" onClick={(e) => { e.stopPropagation(); onRemove(); }} onMouseDown={(e) => e.stopPropagation()}><CloseIcon size={10} /></button>
    </div>
  );
}

function Projects() {
  const { recent } = useStore(projectStore);
  const home = useHome();
  const { entries } = useRecentModel(recent);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const items = useMemo(() => {
    const out: Item[] = [];
    const m = (r: RecentRow) => {
      if (!q) return [] as number[] | null;
      const f = matchName(q, r.name, fuzzy);
      if (f) return f;
      return abbrevPath(r.loc, home).toLowerCase().includes(q.trim().toLowerCase()) ? [] : null;
    };
    for (const e of entries) {
      if (!isGroup(e)) {
        const x = m(e);
        if (x) out.push({ kind: "row", key: e.key, loc: e.loc, name: e.name, idx: x });
        else if (!q) out.push({ kind: "row", key: e.key, loc: e.loc, name: e.name, idx: [] });
        continue;
      }
      const g = e as RecentGroup;
      const gm = m(g.main);
      const kids = g.members.map((c) => ({ c, x: m(c) })).filter((k) => !q || k.x);
      if (q && !gm && !kids.length) continue;
      const open = expanded.has(g.main.key) || (!!q && kids.length > 0);
      out.push({ kind: "group", key: g.main.key, loc: g.main.loc, name: g.main.name, idx: gm ?? [], count: g.members.length, open });
      if (open) for (const k of kids) out.push({ kind: "child", key: k.c.key, loc: k.c.loc, name: k.c.name, idx: k.x ?? [] });
    }
    return out;
  }, [entries, q, expanded, home]);

  const selIdx = Math.max(0, items.findIndex((i) => i.key === sel));
  const cur = items[selIdx] as Item | undefined;
  useEffect(() => { if (!cur && items.length) setSel(items[0].key); }, [items, cur]);
  useEffect(() => { list.current?.querySelector(".wl-row.selected")?.scrollIntoView({ block: "nearest" }); }, [sel, items.length]);
  useEffect(() => { list.current?.focus(); }, []);

  const toggle = (k: string) => setExpanded((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const groupMembers = (it: Item): Location[] => {
    const g = entries.find((e) => isGroup(e) && e.main.key === it.key) as RecentGroup | undefined;
    return g ? [g.main.loc, ...g.members.map((m) => m.loc)] : [it.loc];
  };
  const remove = (it: Item) => {
    const i = items.findIndex((x) => x.key === it.key);
    const next = items[i + 1] ?? items[i - 1];
    if (next) setSel(next.key);
    removeRecent(it.loc);
  };
  const openNew = async (loc: Location) => {
    const r = await windows.open(loc, true);
    if (r.action === "here") await openProject(loc);
  };
  const menu = (e: React.MouseEvent, it: Item) => {
    e.preventDefault();
    setSel(it.key);
    const remote = it.loc.host !== "local";
    showContextMenu(e.clientX, e.clientY, [
      { label: "Open", run: () => void openProjectFlow(it.loc) },
      { label: "Open in New Window", run: () => void openNew(it.loc) },
      { separator: true, label: "" },
      { label: `Show in ${fileManagerName}`, disabled: remote, run: () => void invoke("claude_reveal", { path: it.loc.path }).catch(() => {}) },
      { label: "Copy Path", run: () => void navigator.clipboard?.writeText(remote ? `${it.loc.host}:${it.loc.path}` : it.loc.path).catch(() => {}) },
      { separator: true, label: "" },
      { label: "Remove from Recent Projects", run: () => remove(it) },
      ...(it.kind === "group" ? [{ label: "Remove Project and Worktrees from Recent", run: () => removeRecent(...groupMembers(it)) }] : []),
    ]);
  };

  const onListKey = (e: React.KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const move = (d: number) => { const n = items[Math.min(items.length - 1, Math.max(0, selIdx + d))]; if (n) setSel(n.key); };
    if (e.key === "ArrowDown") move(1);
    else if (e.key === "ArrowUp") { if (selIdx === 0) search.current?.focus(); else move(-1); }
    else if (e.key === "Home") move(-1e9);
    else if (e.key === "End") move(1e9);
    else if (e.key === "Enter" && cur) void openProjectFlow(cur.loc);
    else if ((e.key === "Backspace" || e.key === "Delete") && cur) remove(cur);
    else if (e.key === "ArrowRight" && cur?.kind === "group") { if (!cur.open) toggle(cur.key); else move(1); }
    else if (e.key === "ArrowLeft") {
      if (cur?.kind === "group" && cur.open) toggle(cur.key);
      else if (cur?.kind === "child") { const g = [...items].slice(0, selIdx).reverse().find((x) => x.kind === "group"); if (g) setSel(g.key); }
    } else if (e.key === "Escape") { if (q) setQ(""); }
    else if (e.key.length === 1 && e.key !== " ") { setQ((v) => v + e.key); search.current?.focus(); }
    else return;
    e.preventDefault();
  };

  const empty = !entries.length;
  return (
    <div className="wl-pane">
      <div className="wl-head">
        <div className="wl-search">
          <SearchIcon />
          <input ref={search} placeholder="Search projects" value={q} spellCheck={false} onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || (e.key === "Enter" && items.length)) { e.preventDefault(); list.current?.focus(); if (e.key === "Enter" && cur) void openProjectFlow(cur.loc); }
              else if (e.key === "Escape") { e.preventDefault(); if (q) setQ(""); else list.current?.focus(); }
            }} />
        </div>
        <button className="wl-btn primary" onClick={() => void pickAndOpenFolder()}>Open</button>
        <button className="wl-btn" onClick={() => void openRemoteProject()}>Remote…</button>
      </div>
      {empty ? (
        <div className="wl-empty" data-testid="welcome-empty">
          <AceLogo size={64} />
          <h2>Welcome to Ace</h2>
          <p>Create or open a project to start working.</p>
          <div><button className="wl-btn primary" onClick={() => void pickAndOpenFolder()}>Open</button><button className="wl-btn" onClick={() => void openRemoteProject()}>Remote…</button></div>
        </div>
      ) : (
        <div className="wl-list" ref={list} tabIndex={0} role="listbox" data-testid="welcome-list" onKeyDown={onListKey}>
          {!q && <div className="wl-section">Recent projects</div>}
          {items.map((it) => (
            <Row key={it.kind + it.key} it={it} sel={it.key === sel} home={home} onSelect={() => setSel(it.key)}
              onOpen={() => void openProjectFlow(it.loc)} onMenu={(e) => menu(e, it)} onRemove={() => remove(it)} onToggle={() => toggle(it.key)} />
          ))}
          {!items.length && <div className="wl-none">Nothing found for “{q}”</div>}
        </div>
      )}
    </div>
  );
}

function Customize() {
  const { saved } = useStore(schemeStore);
  return (
    <div className="wl-pane wl-custom">
      <h3>Color theme</h3>
      <select className="wl-select" value={saved} onChange={(e) => setScheme(e.target.value)} data-testid="welcome-theme">
        {SCHEMES.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
      <h3>Profile</h3>
      <button className="wl-btn" onClick={() => runAction("SwitchProfile")}>Switch Profile…</button>
      <h3>Keymap</h3>
      <div className="wl-note">IntelliJ IDEA (macOS) shortcuts. Press <kbd>{formatShortcut("⌘,")}</kbd> for Settings.</div>
      <h3>All settings</h3>
      <button className="wl-btn" onClick={() => runAction("ShowSettings")}><GearIcon /> Settings…</button>
    </div>
  );
}

export function Welcome() {
  const [nav, setNav] = useState<"projects" | "customize">("projects");
  const [version, setVersion] = useState("");
  useEffect(() => { getVersion().then(setVersion).catch(() => {}); }, []);
  return (
    <div className="wl" data-testid="welcome">
      <aside className="wl-side">
        <div className="wl-brand"><AceLogo /><div><div className="wl-title">Ace</div><div className="wl-ver">{version}</div></div></div>
        <nav>
          <div className={"wl-nav" + (nav === "projects" ? " on" : "")} data-nav="projects" onClick={() => setNav("projects")}><FolderIcon />Projects</div>
          <div className={"wl-nav" + (nav === "customize" ? " on" : "")} data-nav="customize" onClick={() => setNav("customize")}><SparkIcon />Customize</div>
        </nav>
      </aside>
      <main className="wl-main">{nav === "projects" ? <Projects /> : <Customize />}</main>
    </div>
  );
}
