import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { dirname, fs, joinPath, locKey, type DirEntry, type Location } from "../../lib/ipc";
import { openFile } from "../../editor/store";
import { promptDialog, confirmDialog } from "../shell/dialogs";
import { showContextMenu } from "../shell/contextMenu";
import { ChevronDown, ChevronRight, FileIcon, FolderIcon } from "../shell/icons";
import { projectName } from "../../lib/project";

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
  const [selected, setSelected] = useState<string>(root.path);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);
  const box = useRef<HTMLDivElement>(null);
  const loaded = useRef(new Set<string>());
  const loc = useCallback((path: string): Location => ({ host, path }), [host]);

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
    setSelected(root.path);
    load(root.path);
  }, [root.path, root.host, load]);

  // load newly expanded dirs
  useEffect(() => {
    expanded.forEach((p) => !loaded.current.has(p) && load(p));
  }, [expanded, load]);

  // refresh on fs events (debounced; only dirs we've loaded)
  useEffect(() => {
    if (host !== "local") return;
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

  const targetDir = (r?: Row) => (!r ? root.path : r.isDir ? r.path : dirname(r.path));

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
      setSelected(p);
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
      setSelected(to);
    } catch (e) {
      await confirmDialog({ title: "Error", message: String(e) });
    }
  };
  const remove = async (r: Row) => {
    if (r.path === root.path) return;
    if (!(await confirmDialog({ title: "Delete", message: `Delete ${r.isDir ? "directory" : "file"} "${r.name}"?`, okLabel: "Delete" }))) return;
    try {
      await fs.delete(loc(r.path));
      await load(dirname(r.path));
    } catch (e) {
      await confirmDialog({ title: "Error", message: String(e) });
    }
  };

  const menu = (e: React.MouseEvent, r?: Row) => {
    e.preventDefault();
    if (r) setSelected(r.path);
    showContextMenu(e.clientX, e.clientY, [
      { label: "New File…", run: () => create(r, false) },
      { label: "New Directory…", run: () => create(r, true) },
      { separator: true, label: "" },
      { label: "Rename…", shortcut: "⇧F6", disabled: !r || r.path === root.path, run: () => r && rename(r) },
      { label: "Delete…", shortcut: "⌫", disabled: !r || r.path === root.path, run: () => r && remove(r) },
      { separator: true, label: "" },
      { label: "Copy Path", run: () => navigator.clipboard.writeText(r?.path ?? root.path) },
      { label: "Refresh", run: () => load(targetDir(r)) },
    ]);
  };

  const onKey = (e: React.KeyboardEvent) => {
    const i = rows.findIndex((r) => r.path === selected);
    const r = rows[i];
    const move = (j: number) => {
      const t = rows[Math.max(0, Math.min(rows.length - 1, j))];
      setSelected(t.path);
      const top = Math.max(0, Math.min(rows.length - 1, j)) * ROW_H;
      const el = box.current!;
      if (top < el.scrollTop) el.scrollTop = top;
      else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight;
    };
    switch (e.key) {
      case "ArrowDown": move(i + 1); break;
      case "ArrowUp": move(i - 1); break;
      case "ArrowRight":
        if (r?.isDir) (expanded.has(r.path) ? move(i + 1) : toggle(r.path, true));
        break;
      case "ArrowLeft":
        if (r?.isDir && expanded.has(r.path) && r.path !== root.path) toggle(r.path, false);
        else if (r) { const pi = rows.findIndex((x) => x.path === dirname(r.path)); if (pi >= 0) move(pi); }
        break;
      case "Enter": r && activate(r); break;
      case "Backspace": case "Delete": r && remove(r); break;
      case "F6": if (e.shiftKey && r) rename(r); break;
      default: return;
    }
    e.preventDefault();
  };

  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - 10);
  const end = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW_H) + 10);

  return (
    <div
      ref={box}
      className="tree"
      tabIndex={0}
      data-autofocus
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      onKeyDown={onKey}
      onContextMenu={(e) => menu(e)}
    >
      <div style={{ height: rows.length * ROW_H, position: "relative" }}>
        {rows.slice(start, end).map((r, k) => {
          const i = start + k;
          return (
            <div
              key={locKey({ host, path: r.path })}
              className={"tree-row" + (selected === r.path ? " selected" : "")}
              style={{ top: i * ROW_H, height: ROW_H, paddingLeft: 8 + r.depth * 14 }}
              onClick={() => { setSelected(r.path); if (r.isDir) toggle(r.path); }}
              onDoubleClick={() => !r.isDir && openFile(loc(r.path))}
              onContextMenu={(e) => { e.stopPropagation(); menu(e, r); }}
            >
              <span className="tree-chev">{r.isDir ? expanded.has(r.path) ? <ChevronDown /> : <ChevronRight /> : null}</span>
              <span className={"tree-icon" + (r.isDir ? " dir" : "")}>{r.isDir ? <FolderIcon /> : <FileIcon />}</span>
              <span className="tree-name">{r.name}</span>
              {r.depth === 0 && <span className="tree-hint">{r.path.replace(/^\/Users\/[^/]+/, "~")}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
