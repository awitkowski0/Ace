import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fs, joinPath, type Location } from "../../lib/ipc";
import { useStore } from "../../lib/store";
import { openFile } from "../../editor/store";
import { gitStore } from "../git/api";
import { useVcsClass } from "../shell/vcsStatus";
import { scrollRowIntoView, useSpeedSearch } from "../shell/speedSearch";
import { promptDialog, confirmDialog } from "../shell/dialogs";
import { showContextMenu } from "../shell/contextMenu";
import { ChevronDown, ChevronRight, SearchIcon } from "../shell/icons";
import { animationTemplate, assetPathspecs, duplicateName, groupAssets, modelTemplate, safeName, suitAnimationTemplate, suitFiles, suitModelTemplate, suitRoot, targetDir, type AssetFile, type AssetGroup, type AssetKind, type AssetType } from "./assets";
import { assetRulesStore } from "./assetConfig";
import { gx } from "./gitops";
import { AssetIcon, Thumb } from "./Thumb";
import { toast } from "./notice";
import { clipboardItems, makeFileOps, pathItems, systemItems, relPath, type Sel } from "../project/fileOps";

const ROW_H = 24;

type Row =
  | { t: "group"; id: string; label: string; count: number; kind: AssetKind | null; depth: 0 }
  | { t: "section"; id: string; label: string; count: number; depth: 1 }
  | { t: "file"; id: string; f: AssetFile; depth: number };

function flatten(groups: AssetGroup[], open: Set<string>, searching: boolean): Row[] {
  const rows: Row[] = [];
  for (const g of groups) {
    rows.push({ t: "group", id: "g:" + g.id, label: g.label, count: g.count, kind: g.kind, depth: 0 });
    if (!searching && !open.has("g:" + g.id)) continue;
    for (const s of g.sections) {
      let depth = 1;
      if (s.label) {
        rows.push({ t: "section", id: "s:" + s.id, label: s.label, count: s.files.length, depth: 1 });
        if (!searching && !open.has("s:" + s.id)) continue;
        depth = 2;
      }
      for (const f of s.files) rows.push({ t: "file", id: f.path, f, depth });
    }
  }
  return rows;
}

/** The Assets tool window: asset roots only, grouped by kind, searchable (docs/PROFILES.md). */
export function AssetTree({ root }: { root: Location }) {
  const [files, setFiles] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);
  const box = useRef<HTMLDivElement>(null);
  const { status } = useStore(gitStore);
  const vcs = useVcsClass(root);
  const isRepo = status?.isRepo;
  const { rules } = useStore(assetRulesStore);

  const scan = useCallback(async () => {
    try {
      setFiles(await gx.lsFiles(root, assetPathspecs()));
      setError(null);
    } catch (e) {
      setError(String(e));
      setFiles([]);
    }
  }, [root.host, root.path, rules]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setFiles(null); if (isRepo !== false) void scan(); }, [scan, isRepo]);
  useEffect(() => {
    let timer: number | undefined;
    let off = false;
    let un: (() => void) | undefined;
    fs.onChanged((e) => {
      if (off || e.root !== root.path || e.kind === "modify") return;
      clearTimeout(timer);
      timer = window.setTimeout(() => void scan(), 900);
    }).then((u) => { if (off) u(); else un = u; });
    return () => { off = true; clearTimeout(timer); un?.(); };
  }, [root.path, scan]);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const groups = useMemo(() => groupAssets(files ?? [], q), [files, q, rules]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = useMemo(() => flatten(groups, open, !!q.trim()), [groups, open, q]);
  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const abs = (rel: string): Location => ({ host: root.host, path: joinPath(root.path, rel) });

  const create = async (type: "animation" | "model", kind: AssetKind | null) => {
    const name = safeName((await promptDialog({ title: type === "animation" ? "New animation" : "New model from template", initial: "", okLabel: "Create" })) ?? "");
    if (!name) return;
    const dir = targetDir(files ?? [], type, kind);
    if (!dir) return void toast("Couldn't find where animations or models live in this project.", "warn", 5000);
    const rel = `${dir}/${name}${type === "animation" ? ".animation.json" : ".geo.json"}`;
    if ((await fs.stat(abs(rel)).catch(() => null))?.exists) return void toast(`${name} already exists.`, "warn");
    await fs.writeFile(abs(rel), type === "animation" ? animationTemplate(name) : modelTemplate(name));
    await scan();
    setSelected(rel);
    await openFile(abs(rel));
  };
  /** New armor suit: geo + animation + texture (+ _shiny) in Thematic's folders. The texture is a copy of the selected suit's (else any suit's) to repaint. */
  const createSuit = async (from: AssetFile | null) => {
    const name = safeName((await promptDialog({ title: "New suit", initial: "", okLabel: "Create" })) ?? "");
    if (!name) return;
    const all = files ?? [];
    const base = suitRoot(all);
    if (!base) return void toast("Couldn't find where suits live in this project.", "warn", 5000);
    const f = suitFiles(base, name);
    const taken = [f.geo, f.animation, f.texture].find((p) => all.includes(p));
    if (taken) return void toast(`${name} already exists.`, "warn");
    const texDir = f.texture.slice(0, f.texture.lastIndexOf("/") + 1);
    const own = from?.info.kind === "armor" ? `${texDir}${from.info.name.replace(/_shiny$/, "")}.png` : "";
    const src = all.includes(own) ? own : all.find((p) => p.startsWith(texDir) && p.endsWith(".png") && !p.endsWith("_shiny.png") && !p.slice(texDir.length).includes("/"));
    await fs.writeFile(abs(f.geo), suitModelTemplate(name));
    await fs.writeFile(abs(f.animation), suitAnimationTemplate(name));
    if (src) {
      await fs.copy(abs(src), abs(f.texture)).catch(() => {});
      const shiny = src.replace(/\.png$/, "_shiny.png");
      if (all.includes(shiny)) await fs.copy(abs(shiny), abs(f.shiny)).catch(() => {});
    }
    await scan();
    setSelected(f.geo);
    toast(src ? `Created ${name}: model, animation and texture${all.includes(src.replace(/\.png$/, "_shiny.png")) ? " (+ shiny)" : ""}. The texture is a copy of ${src.slice(src.lastIndexOf("/") + 1)} - repaint it.` : `Created ${name}: model and animation. Add a texture named ${name}.png.`, "ok", 7000);
    await openFile(abs(f.geo));
  };
  const duplicate = async (f: AssetFile) => {
    if (!["model", "animation", "lang", "pose"].includes(f.info.type)) return void toast("Duplicate works for models, animations and text files.", "info");
    const name = safeName((await promptDialog({ title: "Duplicate as…", initial: f.info.name + "_copy", okLabel: "Duplicate" })) ?? "");
    if (!name) return;
    const to = duplicateName(f.path, name);
    if ((await fs.stat(abs(to)).catch(() => null))?.exists && !(await confirmDialog({ title: "Replace?", message: `${name} already exists. Replace it?`, okLabel: "Replace" }))) return;
    await fs.writeFile(abs(to), await fs.readFile(abs(f.path)));
    await scan();
    setSelected(to);
    await openFile(abs(to));
  };

  const ops = makeFileOps({
    host: root.host, root: root.path,
    refresh: async (_dirs, select) => { await scan(); if (select?.[0]) setSelected(relPath(root.path, select[0])); },
  });

  const menu = (e: React.MouseEvent, r?: Row) => {
    e.preventDefault();
    e.stopPropagation();
    const f = r?.t === "file" ? r.f : null;
    const kind: AssetKind | null = f?.info.kind ?? (r?.t === "group" ? r.kind : null);
    const sel: Sel[] = f ? [{ path: abs(f.path).path, isDir: false }] : [];
    const target: Sel | undefined = sel[0];
    showContextMenu(e.clientX, e.clientY, [
      { label: "New animation…", run: () => void create("animation", kind) },
      { label: "New model from template…", run: () => void create("model", kind) },
      { label: "New suit (model + animation + texture)…", disabled: !suitRoot(files ?? []), run: () => void createSuit(f) },
      { separator: true, label: "" },
      { label: "Duplicate as…", disabled: !f, run: () => f && void duplicate(f) },
      { label: "Open", disabled: !f, run: () => f && void openFile(abs(f.path)) },
      { separator: true, label: "" },
      ...clipboardItems(ops, sel, target, { cut: false }),
      { separator: true, label: "" },
      ...pathItems(ops, sel),
      { separator: true, label: "" },
      ...systemItems(ops, sel, target),
      { separator: true, label: "" },
      { label: "Refresh", run: () => void scan() },
    ]);
  };

  const activate = (r: Row) => {
    if (r.t === "file") { setSelected(r.id); }
    else toggle(r.id);
  };
  const rowText = (r: Row) => (r.t === "file" ? r.f.info.name : r.label);
  const selIndex = useMemo(() => rows.findIndex((r) => r.id === selected), [rows, selected]);
  const ss = useSpeedSearch({
    rows, text: rowText, selected: selIndex,
    select: (i) => { setSelected(rows[i].id); scrollRowIntoView(box.current, i, ROW_H); },
    activate: (i) => { const r = rows[i]; if (r.t === "file") void openFile(abs(r.f.path)); else toggle(r.id); },
  });
  const onKey = (e: React.KeyboardEvent) => {
    if (ss.onKeyDown(e)) return;
    const i = rows.findIndex((r) => r.id === selected);
    const move = (j: number) => {
      const k = Math.max(0, Math.min(rows.length - 1, j));
      if (rows[k]) setSelected(rows[k].id);
      const el = box.current;
      if (el) { const top = k * ROW_H; if (top < el.scrollTop) el.scrollTop = top; else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight; }
    };
    const r = rows[i];
    if (e.key === "ArrowDown") move(i + 1);
    else if (e.key === "ArrowUp") move(i - 1);
    else if (e.key === "ArrowRight" && r && r.t !== "file" && !open.has(r.id)) toggle(r.id);
    else if (e.key === "ArrowLeft" && r && r.t !== "file" && open.has(r.id)) toggle(r.id);
    else if (e.key === "Enter" && r) { if (r.t === "file") void openFile(abs(r.f.path)); else toggle(r.id); }
    else return;
    e.preventDefault();
  };

  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - 10);
  const end = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW_H) + 10);
  return (
    <div className="ap-assets" data-testid="asset-tree">
      <div className="ap-search">
        <SearchIcon />
        <input data-testid="asset-search" data-autofocus placeholder="Search assets" value={q} spellCheck={false} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Escape" && q) { setQ(""); e.stopPropagation(); } else if (e.key === "ArrowDown") { box.current?.focus(); } }} />
      </div>
      <div className="ss-host" style={{ flex: 1, height: "auto" }} {...ss.hostProps}>
      <div ref={box} className="tree ap-tree" tabIndex={0} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)} onKeyDown={onKey} onContextMenu={(e) => menu(e)}>
        {isRepo === false && <div className="ap-empty">This folder isn't under Git yet, so Ace can't list its assets.</div>}
        {files === null && isRepo !== false && <div className="ap-empty">Looking for assets…</div>}
        {files && isRepo !== false && !rows.length && <div className="ap-empty">{error ?? (q ? "No assets match." : "No assets found in this project.")}</div>}
        <div style={{ height: rows.length * ROW_H, position: "relative" }}>
          {rows.slice(start, end).map((r, k) => {
            const i = start + k;
            const isOpen = r.t === "file" ? false : !!q.trim() || open.has(r.id);
            const cls = r.t === "file" ? vcs(joinPath(root.path, r.f.path), false) : "";
            return (
              <div key={r.id} data-row={r.t} data-name={r.t === "file" ? r.f.info.name : r.label} data-path={r.t === "file" ? r.f.path : undefined}
                className={"tree-row ap-row" + (selected === r.id ? " selected" : "") + (r.t !== "file" ? " ap-head ap-" + r.t : "") + " " + cls}
                style={{ top: i * ROW_H, height: ROW_H, paddingLeft: 8 + r.depth * 14 }}
                onClick={() => activate(r)} onDoubleClick={() => r.t === "file" && void openFile(abs(r.f.path))} onContextMenu={(e) => menu(e, r)}>
                <span className="tree-chev">{r.t !== "file" ? isOpen ? <ChevronDown /> : <ChevronRight /> : null}</span>
                {r.t === "file" ? <span className="tree-icon"><Thumb loc={abs(r.f.path)} type={r.f.info.type as AssetType} /></span> : r.t === "group" ? <span className="tree-icon"><AssetIcon type={r.kind === "entity" || r.kind === "armor" ? "pose" : "model"} /></span> : null}
                <span className="tree-name">{ss.highlight(i, rowText(r))}</span>
                {r.t === "file" ? <span className="tree-hint">{r.f.info.sub}</span> : <span className="tree-hint">{r.count}</span>}
              </div>
            );
          })}
        </div>
      </div>
      {ss.popup}
      </div>
    </div>
  );
}
