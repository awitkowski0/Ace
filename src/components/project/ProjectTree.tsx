import { homeShorten, isWithin } from "../../lib/paths";
import { isMac, isMod } from "../../lib/platform";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { dirname, fs, joinPath, locKey, type DirEntry, type Location } from "../../lib/ipc";
import { openFile } from "../../editor/store";
import { promptDialog, confirmDialog } from "../shell/dialogs";
import { showContextMenu } from "../shell/contextMenu";
import type { MenuItem } from "../shell/contextMenu";
import { clipboardItems, makeFileOps, pathItems, systemItems, type Sel } from "./fileOps";
import { ChevronDown, ChevronRight, FileIcon, FolderIcon } from "../shell/icons";
import { projectName } from "../../lib/project";
import { useVcsClass } from "../shell/vcsStatus";
import { scrollRowIntoView, useSpeedSearch } from "../shell/speedSearch";
import "../shell/shell.css";

const ROW_H = 24;
const HIDDEN = new Set([".git", ".DS_Store"]);

interface Row {
  path: string;
  name: string;
  isDir: boolean;
  depth: number;
}

const sortEntries = (a: DirEntry, b: DirEntry) =>
  a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });

export function ProjectTree({ root }: { root: Location }) {
  const host = root.host;
  const [children, setChildren] = useState<Record<string, DirEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([root.path]));
  const [selected, setSelected] = useState<string>(root.path); // lead row (caret)
  const [multi, setMulti] = useState<Set<string>>(() => new Set([root.path]));
  const [anchor, setAnchor] = useState<string>(root.path); // fixed end of a ⇧ range
  const [dropOn, setDropOn] = useState<string | null>(null);
  const drag = useRef<string[] | null>(null);
  const pick = (p: string) => { setSelected(p); setMulti(new Set([p])); setAnchor(p); };
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);
  const box = useRef<HTMLDivElement>(null);
  const loaded = useRef(new Set<string>());
  const loc = useCallback((path: string): Location => ({ host, path }), [host]);
  const vcs = useVcsClass(root);

  const load = useCallback(
    async (path: string) => {
      try {
        const list = (await fs.listDir(loc(path))).filter((e) => !HIDDEN.has(e.name)).sort(sortEntries);
        loaded.current.add(path);
        setChildren((c) => ({ ...c, [path]: list }));
      } catch (e) {
        console.warn("listDir failed", path, e);
      }
    },
    [loc],
  );

  // reset when project changes
  useEffect(() => {
    loaded.current = new Set();
    setChildren({});
    setExpanded(new Set([root.path]));
    pick(root.path);
    load(root.path);
  }, [root.path, root.host, load]);

  // load newly expanded dirs
  useEffect(() => {
    expanded.forEach((p) => !loaded.current.has(p) && load(p));
  }, [expanded, load]);

  // refresh on fs events (debounced; only dirs we've loaded)
  useEffect(() => {
    let timer: number | undefined;
    const dirty = new Set<string>();
    let un: (() => void) | undefined;
    fs.onChanged((e) => {
      if (e.root !== root.path) return;
      for (const p of e.paths) {
        const d = dirname(p);
        if (loaded.current.has(d)) dirty.add(d);
        if (loaded.current.has(p)) dirty.add(p);
      }
      if (!dirty.size) return;
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        [...dirty].forEach(load);
        dirty.clear();
      }, 150);
    }).then((u) => (un = u));
    return () => {
      clearTimeout(timer);
      un?.();
    };
  }, [root.path, host, load]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const rows = useMemo(() => {
    const out: Row[] = [{ path: root.path, name: projectName(root), isDir: true, depth: 0 }];
    const walk = (dir: string, depth: number) => {
      for (const e of children[dir] ?? []) {
        out.push({ path: e.path, name: e.name, isDir: e.isDir, depth });
        if (e.isDir && expanded.has(e.path)) walk(e.path, depth + 1);
      }
    };
    if (expanded.has(root.path)) walk(root.path, 1);
    return out;
  }, [children, expanded, root]);

  const toggle = (p: string, force?: boolean) =>
    setExpanded((s) => {
      const n = new Set(s);
      (force ?? !n.has(p)) ? n.add(p) : n.delete(p);
      return n;
    });

  const activate = (r: Row) => (r.isDir ? toggle(r.path) : openFile(loc(r.path)));

  // IntelliJ speed search over the visible (expanded) rows
  const selIndex = useMemo(() => rows.findIndex((r) => r.path === selected), [rows, selected]);
  const ss = useSpeedSearch({
    rows, text: (r) => r.name, selected: selIndex,
    select: (i) => { pick(rows[i].path); scrollRowIntoView(box.current, i, ROW_H); },
    activate: (i) => activate(rows[i]),
  });

  const targetDir = (r?: Row) => (!r ? root.path : r.isDir ? r.path : dirname(r.path));

  const range = (j: number) => {
    const a = rows.findIndex((r) => r.path === anchor);
    const [lo, hi] = a < 0 ? [j, j] : [Math.min(a, j), Math.max(a, j)];
    setMulti(new Set(rows.slice(lo, hi + 1).map((r) => r.path)));
    setSelected(rows[j].path);
  };
  const sel: Sel[] = useMemo(() => rows.filter((r) => multi.has(r.path)).map((r) => ({ path: r.path, isDir: r.isDir })), [rows, multi]);

  const refresh = async (dirs: string[], select?: string[]) => {
    await Promise.all(dirs.map(load));
    dirs.forEach((d) => toggle(d, true));
    if (select?.length) { setMulti(new Set(select)); setSelected(select[0]); setAnchor(select[0]); }
  };
  const ops = makeFileOps({ host, root: root.path, refresh });

  const create = async (r: Row | undefined, dir: boolean) => {
    const parent = targetDir(r);
    const name = await promptDialog({ title: dir ? "New Directory" : "New File", okLabel: "Create" });
    if (!name?.trim()) return;
    const p = joinPath(parent, name.trim());
    try {
      if (dir) await fs.createDir(loc(p));
      else await fs.writeFile(loc(p), "");
      toggle(parent, true);
      await load(parent);
      pick(p);
      if (!dir) openFile(loc(p));
    } catch (e) {
      await confirmDialog({ title: "Error", message: String(e) });
    }
  };
  const rename = async (r: Row) => {
    if (r.path === root.path) return;
    const name = await promptDialog({ title: "Rename", initial: r.name, okLabel: "Rename" });
    if (!name?.trim() || name === r.name) return;
    const to = joinPath(dirname(r.path), name.trim());
    try {
      await fs.rename(loc(r.path), loc(to));
      await load(dirname(r.path));
      pick(to);
    } catch (e) {
      await confirmDialog({ title: "Error", message: String(e) });
    }
  };
  const notRoot = (l: Sel[]) => l.filter((s) => s.path !== root.path);
  const remove = async (l: Sel[]) => {
    const items = notRoot(l);
    if (items.length && (await ops.remove(items))) pick(dirname(items[0].path));
  };

  const menu = (e: React.MouseEvent, r?: Row) => {
    e.preventDefault();
    let cur = sel;
    if (r && !multi.has(r.path)) { pick(r.path); cur = [{ path: r.path, isDir: r.isDir }]; }
    const target: Sel = r ? { path: r.path, isDir: r.isDir } : { path: root.path, isDir: true };
    const eff = cur.length ? cur : [target];
    const act = notRoot(eff);
    const one = eff.length === 1 && eff[0].path !== root.path ? rows.find((x) => x.path === eff[0].path) : undefined;
    const sp: MenuItem = { separator: true, label: "" };
    showContextMenu(e.clientX, e.clientY, [
      { label: "New File…", run: () => create(r, false) },
      { label: "New Directory…", run: () => create(r, true) },
      sp,
      ...clipboardItems(ops, act, target),
      sp,
      ...pathItems(ops, eff),
      sp,
      { label: "Rename…", shortcut: "⇧F6", disabled: !one, run: () => one && rename(one) },
      { label: ops.local ? "Move to Trash…" : "Delete…", shortcut: "⌫", disabled: !act.length, run: () => remove(act) },
      sp,
      ...systemItems(ops, eff, target),
      sp,
      { label: "Refresh", run: () => load(targetDir(r)) },
    ]);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (ss.onKeyDown(e)) return;
    const i = rows.findIndex((r) => r.path === selected);
    const r = rows[i];
    const move = (j: number, extend = false) => {
      const k = Math.max(0, Math.min(rows.length - 1, j));
      if (extend) range(k); else pick(rows[k].path);
      const top = k * ROW_H;
      const el = box.current!;
      if (top < el.scrollTop) el.scrollTop = top;
      else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight;
    };
    if (isMod(e) && !(isMac && e.ctrlKey)) {
      const cur = sel.length ? sel : r ? [{ path: r.path, isDir: r.isDir }] : [];
      const target = r && { path: r.path, isDir: r.isDir };
      switch (e.code) {
        case "KeyA": setMulti(new Set(rows.slice(rows.length > 1 ? 1 : 0).map((x) => x.path))); break;
        case "KeyC": void (e.shiftKey ? (e.altKey ? ops.copyRelative(cur) : ops.copyAbsolute(cur)) : ops.copy(notRoot(cur))); break;
        case "KeyX": void ops.cut(notRoot(cur)); break;
        case "KeyV": void ops.paste(target); break;
        case "KeyD": void ops.duplicate(notRoot(cur)); break;
        case "KeyR": if (!(e.shiftKey && e.altKey && ops.local)) return; void ops.reveal(cur); break;
        default: return;
      }
      e.preventDefault();
      return;
    }
    switch (e.key) {
      case "ArrowDown": move(i + 1, e.shiftKey); break;
      case "ArrowUp": move(i - 1, e.shiftKey); break;
      case "ArrowRight":
        if (r?.isDir) (expanded.has(r.path) ? move(i + 1) : toggle(r.path, true));
        break;
      case "ArrowLeft":
        if (r?.isDir && expanded.has(r.path) && r.path !== root.path) toggle(r.path, false);
        else if (r) { const pi = rows.findIndex((x) => x.path === dirname(r.path)); if (pi >= 0) move(pi); }
        break;
      case "Enter": r && activate(r); break;
      case "Backspace": case "Delete": void remove(sel.length ? sel : r ? [{ path: r.path, isDir: r.isDir }] : []); break;
      case "F6": if (e.shiftKey && r) rename(r); break;
      default: return;
    }
    e.preventDefault();
  };

  // native Edit-menu ⌘C/⌘X/⌘V arrive as DOM clipboard events on the focused tree
  const onClipboard = (kind: "copy" | "cut" | "paste") => (e: React.ClipboardEvent) => {
    if ((e.target as HTMLElement).closest("input,textarea")) return;
    e.preventDefault();
    const r = rows.find((x) => x.path === selected);
    if (kind === "paste") void ops.paste(r && { path: r.path, isDir: r.isDir });
    else void (kind === "copy" ? ops.copy : ops.cut)(notRoot(sel));
  };

  const onRowClick = (e: React.MouseEvent, r: Row, i: number) => {
    if (isMod(e)) {
      const n = new Set(multi);
      if (n.has(r.path) && n.size > 1) { n.delete(r.path); setSelected([...n].pop()!); } else { n.add(r.path); setSelected(r.path); }
      setMulti(n);
      setAnchor(r.path);
    } else if (e.shiftKey) range(i);
    else { pick(r.path); if (r.isDir) toggle(r.path); }
  };
  const dropTarget = (r: Row) => (r.isDir ? r.path : dirname(r.path));
  const canDrop = (dir: string) => !!drag.current && !drag.current.some((p) => dir === p || isWithin(p, dir));

  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - 10);
  const end = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW_H) + 10);

  return (
    <div className="ss-host" {...ss.hostProps}>
    <div
      ref={box}
      className="tree"
      tabIndex={0}
      data-autofocus
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      onKeyDown={onKey}
      onCopy={onClipboard("copy")}
      onCut={onClipboard("cut")}
      onPaste={onClipboard("paste")}
      onContextMenu={(e) => menu(e)}
    >
      <div style={{ height: rows.length * ROW_H, position: "relative" }}>
        {rows.slice(start, end).map((r, k) => {
          const i = start + k;
          return (
            <div
              key={locKey({ host, path: r.path })}
              className={"tree-row" + (multi.has(r.path) ? " selected" : "") + (dropOn === r.path ? " drop" : "") + " " + vcs(r.path, r.isDir)}
              data-path={r.path}
              draggable={r.depth > 0}
              onDragStart={(e) => {
                const paths = multi.has(r.path) ? sel.map((s) => s.path).filter((p) => p !== root.path) : [r.path];
                if (!multi.has(r.path)) pick(r.path);
                drag.current = paths;
                e.dataTransfer.effectAllowed = "copyMove";
                e.dataTransfer.setData("text/plain", paths.join("\n"));
              }}
              onDragEnd={() => { drag.current = null; setDropOn(null); }}
              onDragOver={(e) => { if (canDrop(dropTarget(r))) { e.preventDefault(); e.dataTransfer.dropEffect = e.altKey ? "copy" : "move"; setDropOn(dropTarget(r)); } }}
              onDrop={(e) => {
                e.preventDefault();
                const paths = drag.current, dir = dropTarget(r), ok = canDrop(dir);
                drag.current = null; setDropOn(null);
                if (paths && ok) void ops.drop(paths, dir, e.altKey);
              }}
              style={{ top: i * ROW_H, height: ROW_H, paddingLeft: 8 + r.depth * 14 }}
              onClick={(e) => onRowClick(e, r, i)}
              onDoubleClick={() => !r.isDir && openFile(loc(r.path))}
              onContextMenu={(e) => { e.stopPropagation(); menu(e, r); }}
            >
              <span className="tree-chev">{r.isDir ? expanded.has(r.path) ? <ChevronDown /> : <ChevronRight /> : null}</span>
              <span className={"tree-icon" + (r.isDir ? " dir" : "")}>{r.isDir ? <FolderIcon /> : <FileIcon />}</span>
              <span className="tree-name">{ss.highlight(i, r.name)}</span>
              {r.depth === 0 && <span className="tree-hint">{homeShorten(r.path)}</span>}
            </div>
          );
        })}
      </div>
    </div>
    {ss.popup}
    </div>
  );
}
