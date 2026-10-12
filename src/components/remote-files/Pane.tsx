import { isMod } from "../../lib/platform";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { basename, dirname, fs, joinPath, type Location } from "../../lib/ipc";
import { openFile } from "../../editor/store";
import { openProject } from "../../lib/project";
import { confirmDialog, promptDialog } from "../shell/dialogs";
import { showContextMenu } from "../shell/contextMenu";
import { FileIcon, FolderIcon } from "../shell/icons";
import { fmtDate, fmtMode, humanSize, lsGet, lsSet, rf, type Bookmark, type DiskUsage, type RichEntry } from "./api";
import { beginDrag, type DragPayload, type DropTarget } from "./dnd";

const ROW_H = 24;
type SortKey = "name" | "size" | "modified" | "mode";

export interface PaneHandle {
  refresh(): void;
  cwd(): Location;
  selected(): RichEntry[];
  newFolder(): void;
  rename(): void;
  remove(): void;
  chmod(): void;
}
interface Props {
  paneId: "local" | "remote";
  active: boolean;
  onActivate(): void;
  /** called when a drag from this pane is dropped somewhere */
  onDrop(src: DragPayload, target: DropTarget): void;
}

const errBox = (e: unknown) => confirmDialog({ title: "Error", message: String(e), okLabel: "OK" });

export const Pane = forwardRef<PaneHandle, Props>(function Pane({ paneId, active, onActivate, onDrop }, ref) {
  const remote = paneId === "remote";
  const [hosts, setHosts] = useState<string[]>([]);
  const [host, setHost] = useState(() => (remote ? lsGet("host") ?? "" : "local"));
  const [path, setPath] = useState(() => lsGet("path." + (remote ? "remote" : "local")) ?? "");
  const [entries, setEntries] = useState<RichEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; asc: boolean }>({ key: "name", asc: true });
  const [editing, setEditing] = useState(false);
  const [pathText, setPathText] = useState("");
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [du, setDu] = useState<DiskUsage | null>(null);
  const [tick, setTick] = useState(0);
  const history = useRef<string[]>([]);
  const seq = useRef(0);
  const box = useRef<HTMLDivElement>(null);
  const crumbBox = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(300);
  const loc = useMemo<Location>(() => ({ host, path }), [host, path]);

  // hosts + initial path
  useEffect(() => {
    rf.bookmarks().then(setBookmarks).catch(() => {});
    if (!remote) {
      if (!path) fs.home().then(setPath);
      return;
    }
    rf.hosts().then((h) => {
      setHosts(h);
      if (!host) setHost(h.includes("mc") ? "mc" : h[0] ?? "");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!remote || !host) return;
    lsSet("host", host);
    if (!path) rf.home(host).then(setPath).catch((e) => setError(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host]);

  // load listing
  useEffect(() => {
    if (!host || !path) return;
    const my = ++seq.current;
    setLoading(true);
    rf.list({ host, path })
      .then((l) => {
        if (my !== seq.current) return;
        setEntries(l);
        setError(null);
        setSel((s) => new Set([...s].filter((p) => l.some((e) => e.path === p))));
        lsSet("path." + paneId, path);
      })
      .catch((e) => my === seq.current && (setError(String(e)), setEntries([])))
      .finally(() => my === seq.current && setLoading(false));
  }, [host, path, tick, paneId]);

  // disk usage (remote only, background)
  useEffect(() => {
    if (!remote || !host || !path) return;
    let live = true;
    rf.du({ host, path }).then((d) => live && setDu(d)).catch(() => live && setDu(null));
    return () => { live = false; };
  }, [remote, host, path]);

  // watch the visible remote directory (inotify when available, else cheap 3s poll while focused)
  useEffect(() => {
    if (!remote || !host || !path) return;
    const target = { host, path };
    let timer: number | undefined;
    rf.watchDir(target).catch(() => {});
    let un: (() => void) | undefined;
    let dead = false;
    fs.onChanged((e) => {
      if (e.root !== path) return;
      clearTimeout(timer);
      timer = window.setTimeout(() => setTick((t) => t + 1), 200);
    }).then((u) => (dead ? u() : (un = u)));
    return () => {
      dead = true;
      clearTimeout(timer);
      un?.();
      rf.unwatchDir(target).catch(() => {});
    };
  }, [remote, host, path]);

  // refresh when the window regains focus
  useEffect(() => {
    const f = () => setTick((t) => t + 1);
    window.addEventListener("focus", f);
    return () => window.removeEventListener("focus", f);
  }, []);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const rows = useMemo(() => {
    const k = sort.key, m = sort.asc ? 1 : -1;
    return [...entries].sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      let c = 0;
      if (k === "name") c = a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
      else if (k === "size") c = a.size - b.size;
      else if (k === "modified") c = (a.modified ?? 0) - (b.modified ?? 0);
      else c = a.mode - b.mode;
      return c * m || a.name.localeCompare(b.name);
    });
  }, [entries, sort]);

  const navigate = useCallback((p: string, push = true) => {
    if (push && path) history.current.push(path);
    setPath(p || "/");
    setSel(new Set());
    setAnchor(null);
    box.current && (box.current.scrollTop = 0);
  }, [path]);
  const up = () => path !== "/" && navigate(dirname(path));
  const back = () => { const p = history.current.pop(); if (p) navigate(p, false); };
  const refresh = () => setTick((t) => t + 1);
  const L = (p: string): Location => ({ host, path: p });

  const selectedEntries = () => rows.filter((r) => sel.has(r.path));

  const open = (e: RichEntry) => (e.isDir ? navigate(e.path) : openFile(L(e.path)));

  const newFolder = async () => {
    const name = await promptDialog({ title: "New Folder", okLabel: "Create" });
    if (!name?.trim()) return;
    try { await fs.createDir(L(joinPath(path, name.trim()))); refresh(); } catch (e) { errBox(e); }
  };
  const rename = async () => {
    const [e] = selectedEntries();
    if (!e) return;
    const name = await promptDialog({ title: "Rename", initial: e.name, okLabel: "Rename" });
    if (!name?.trim() || name === e.name) return;
    try { await fs.rename(L(e.path), L(joinPath(dirname(e.path), name.trim()))); refresh(); } catch (x) { errBox(x); }
  };
  const remove = async () => {
    const es = selectedEntries();
    if (!es.length) return;
    const msg = es.length === 1 ? `Delete ${es[0].isDir ? "directory" : "file"} "${es[0].name}"${es[0].isDir ? " and everything in it" : ""}${remote ? ` on ${host}` : ""}?` : `Delete ${es.length} items${remote ? ` on ${host}` : ""}?\n${es.slice(0, 6).map((x) => x.name).join(", ")}${es.length > 6 ? ", …" : ""}`;
    if (!(await confirmDialog({ title: "Delete", message: msg, okLabel: "Delete" }))) return;
    try { for (const e of es) await fs.delete(L(e.path)); } catch (x) { errBox(x); }
    refresh();
  };
  const chmod = async () => {
    const es = selectedEntries();
    if (!es.length) return;
    const cur = (es[0].mode & 0o777).toString(8);
    const txt = await promptDialog({ title: "Permissions (octal such as 644; add -R for recursive: 755 -R)", initial: cur, okLabel: "Apply" });
    if (!txt?.trim()) return;
    const parts = txt.trim().split(/\s+/);
    const recursive = parts.includes("-R");
    const mode = parts.find((p) => p !== "-R");
    if (!mode) return;
    try { for (const e of es) await rf.chmod(L(e.path), mode, recursive); refresh(); } catch (x) { errBox(x); }
  };

  useImperativeHandle(ref, () => ({ refresh, cwd: () => loc, selected: selectedEntries, newFolder, rename, remove, chmod }));

  const isBm = bookmarks.some((b) => b.host === host && b.path === path);
  const toggleBookmark = (p = path, nm?: string) => {
    const has = bookmarks.some((b) => b.host === host && b.path === p);
    const next = has ? bookmarks.filter((b) => !(b.host === host && b.path === p)) : [...bookmarks, { host, path: p, name: nm ?? (basename(p) || p) }];
    setBookmarks(next);
    rf.setBookmarks(next).catch(() => {});
  };
  const bookmarkMenu = (ev: React.MouseEvent) => {
    const r = ev.currentTarget.getBoundingClientRect();
    const mine = bookmarks.filter((b) => b.host === host);
    showContextMenu(r.left, r.bottom + 2, [
      { label: isBm ? "Remove Bookmark" : "Bookmark This Folder", run: () => toggleBookmark() },
      { separator: true, label: "" },
      ...(mine.length ? mine.map((b) => ({ label: `${b.name}   ${b.path}`, run: () => navigate(b.path) })) : [{ label: "No bookmarks", disabled: true }]),
    ]);
  };

  const rowMenu = (ev: React.MouseEvent, e?: RichEntry) => {
    ev.preventDefault();
    onActivate();
    let es = selectedEntries();
    if (e && !sel.has(e.path)) { setSel(new Set([e.path])); setAnchor(e.path); es = [e]; }
    const one = es.length === 1 ? es[0] : undefined;
    showContextMenu(ev.clientX, ev.clientY, [
      { label: one?.isDir ? "Open" : "Open in Editor", disabled: !one, run: () => one && open(one) },
      ...(remote && one?.isDir ? [{ label: "Open as Project", run: () => openProject(L(one.path)) }] : []),
      { label: remote ? "Download" : "Upload", disabled: !es.length, run: () => onDrop({ paneId, entries: es }, { paneId: remote ? "local" : "remote", dir: null }) },
      { separator: true, label: "" },
      { label: "New Folder…", run: newFolder },
      { label: "Rename…", shortcut: "F2", disabled: es.length !== 1, run: rename },
      { label: "Delete…", shortcut: "⌫", disabled: !es.length, run: remove },
      { label: "Permissions…", disabled: !es.length, run: chmod },
      { separator: true, label: "" },
      ...(one?.isDir ? [{ label: "Add to Bookmarks", run: () => toggleBookmark(one.path, one.name) }] : []),
      { label: "Copy Path", run: () => navigator.clipboard.writeText(one?.path ?? path) },
      { label: "Refresh", run: refresh },
    ]);
  };

  const clickRow = (ev: React.MouseEvent, e: RichEntry) => {
    onActivate();
    if (ev.shiftKey && anchor) {
      const a = rows.findIndex((r) => r.path === anchor), b = rows.findIndex((r) => r.path === e.path);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      setSel(new Set(rows.slice(lo, hi + 1).map((r) => r.path)));
    } else if (ev.metaKey || ev.ctrlKey) {
      setSel((s) => { const n = new Set(s); n.has(e.path) ? n.delete(e.path) : n.add(e.path); return n; });
      setAnchor(e.path);
    } else {
      setSel(new Set([e.path]));
      setAnchor(e.path);
    }
  };
  const downRow = (ev: React.MouseEvent, e: RichEntry) => {
    if (ev.button !== 0) return;
    const inSel = sel.has(e.path);
    const entriesForDrag = inSel ? selectedEntries() : [e];
    beginDrag(ev, { paneId, entries: entriesForDrag }, (t) => {
      if (!inSel) { setSel(new Set([e.path])); setAnchor(e.path); }
      onDrop({ paneId, entries: entriesForDrag }, t);
    });
  };

  const onKey = (ev: React.KeyboardEvent) => {
    if (editing) return;
    const i = rows.findIndex((r) => r.path === anchor);
    const go = (j: number) => {
      j = Math.max(0, Math.min(rows.length - 1, j));
      const r = rows[j];
      if (!r) return;
      setSel(new Set([r.path]));
      setAnchor(r.path);
      const el = box.current!, top = j * ROW_H;
      if (top < el.scrollTop) el.scrollTop = top;
      else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight;
    };
    if (ev.key === "ArrowDown") go(i + 1);
    else if (ev.key === "ArrowUp") go(i < 0 ? 0 : i - 1);
    else if (ev.key === "Enter") { const r = rows[i]; r && open(r); }
    else if (ev.key === "Backspace" && !isMod(ev)) up();
    else if (ev.key === "Backspace" || ev.key === "Delete") remove();
    else if (ev.key === "F2") rename();
    else if (ev.key === "a" && isMod(ev)) setSel(new Set(rows.map((r) => r.path)));
    else if (ev.key === "r" && isMod(ev)) refresh();
    else return;
    ev.preventDefault();
  };

  const sortBy = (key: SortKey) => setSort((s) => (s.key === key ? { key, asc: !s.asc } : { key, asc: true }));
  const arrow = (k: SortKey) => (sort.key === k ? (sort.asc ? " ▴" : " ▾") : "");

  const crumbs = useMemo(() => {
    const segs = path.split("/").filter(Boolean);
    return [{ name: "/", path: "/" }, ...segs.map((s, i) => ({ name: s, path: "/" + segs.slice(0, i + 1).join("/") }))];
  }, [path]);

  useEffect(() => { const c = crumbBox.current; if (c) c.scrollLeft = c.scrollWidth; }, [path, editing]);

  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - 5);
  const end = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW_H) + 5);
  const selSize = selectedEntries().reduce((a, r) => a + (r.isDir ? 0 : r.size), 0);

  return (
    <div className={"rf-pane" + (active ? " active" : "")} data-rf-pane={paneId} onMouseDownCapture={onActivate}>
      <div className="rf-pathbar">
        {remote ? (
          <select className="rf-host" value={host} onChange={(e) => { history.current = []; setPath(""); setEntries([]); setHost(e.target.value); }}>
            {!hosts.includes(host) && host && <option value={host}>{host}</option>}
            {hosts.map((h) => <option key={h} value={h}>{h}</option>)}
          </select>
        ) : (
          <span className="rf-host rf-local">Local</span>
        )}
        <button className="icon-btn sm" title="Back" onClick={back} disabled={!history.current.length}>‹</button>
        <button className="icon-btn sm" title="Up" onClick={up}>↑</button>
        {editing ? (
          <input
            className="rf-path-input"
            autoFocus
            value={pathText}
            spellCheck={false}
            onChange={(e) => setPathText(e.target.value)}
            onBlur={() => setEditing(false)}
            onKeyDown={async (e) => {
              e.stopPropagation();
              if (e.key === "Escape") setEditing(false);
              if (e.key === "Enter") {
                let p = pathText.trim();
                setEditing(false);
                if (p === "~" || p.startsWith("~/")) {
                  const home = remote ? await rf.home(host).catch(() => "") : await fs.home();
                  p = home + p.slice(1);
                }
                if (p) navigate(p);
              }
            }}
            onFocus={(e) => e.currentTarget.select()}
          />
        ) : (
          <div className="rf-crumbs" ref={crumbBox} title="Click to edit path" onClick={() => { setPathText(path); setEditing(true); }}>
            {crumbs.map((c, i) => (
              <span key={c.path} className="rf-crumb" onClick={(e) => { e.stopPropagation(); if (c.path !== path) navigate(c.path); }}>
                {c.name}{i > 0 && i < crumbs.length - 1 ? <span className="rf-sep">/</span> : null}
              </span>
            ))}
          </div>
        )}
        <button className="icon-btn sm" title="Bookmarks" onClick={bookmarkMenu}>{isBm ? "★" : "☆"}</button>
        <button className="icon-btn sm" title="Refresh" onClick={refresh}>↻</button>
      </div>
      <div className="rf-head rf-grid">
        <span onClick={() => sortBy("name")}>Name{arrow("name")}</span>
        <span className="rf-num" onClick={() => sortBy("size")}>Size{arrow("size")}</span>
        <span className="rf-col-mod" onClick={() => sortBy("modified")}>Modified{arrow("modified")}</span>
        <span className="rf-col-perm" onClick={() => sortBy("mode")}>Permissions{arrow("mode")}</span>
      </div>
      <div
        className="rf-list"
        ref={box}
        tabIndex={0}
        data-autofocus={remote ? undefined : true}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        onKeyDown={onKey}
        onContextMenu={(e) => rowMenu(e)}
        onMouseDown={(e) => { if (e.target === e.currentTarget) setSel(new Set()); }}
      >
        <div style={{ height: rows.length * ROW_H, position: "relative" }}>
          {rows.slice(start, end).map((r, k) => {
            const i = start + k;
            return (
              <div
                key={r.path}
                className={"rf-row rf-grid" + (sel.has(r.path) ? " selected" : "")}
                style={{ top: i * ROW_H }}
                data-rf-dir={r.isDir ? r.path : undefined}
                onMouseDown={(e) => downRow(e, r)}
                onClick={(e) => clickRow(e, r)}
                onDoubleClick={() => open(r)}
                onContextMenu={(e) => { e.stopPropagation(); rowMenu(e, r); }}
              >
                <span className="rf-name">
                  <span className={"rf-ico" + (r.isDir ? " dir" : "")}>{r.isDir ? <FolderIcon /> : <FileIcon />}</span>
                  <span className="rf-name-text">{r.name}{r.isSymlink ? " →" : ""}</span>
                </span>
                <span className="rf-num">{r.isDir ? "" : humanSize(r.size)}</span>
                <span className="rf-col-mod">{fmtDate(r.modified)}</span>
                <span className="rf-col-perm rf-mono">{fmtMode(r.mode, r.isDir, r.isSymlink)}</span>
              </div>
            );
          })}
        </div>
        {error && (
          <div className="rf-msg err">
            {error}
            <div><button className="primary" onClick={refresh}>Retry</button></div>
          </div>
        )}
        {!error && loading && !entries.length && <div className="rf-msg">{remote ? `Connecting to ${host}…` : "Loading…"}</div>}
        {!error && !loading && !entries.length && path && <div className="rf-msg">Empty folder</div>}
      </div>
      <div className="rf-foot">
        <span>{sel.size ? `${sel.size} selected${selSize ? ` · ${humanSize(selSize)}` : ""}` : `${rows.length} items`}</span>
        <span className="grow" />
        {du && <span>{humanSize(du.avail)} free</span>}
        {loading && <span>…</span>}
      </div>
    </div>
  );
});
