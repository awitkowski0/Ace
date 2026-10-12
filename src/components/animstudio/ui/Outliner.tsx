/**
 * Right panel (top): bone / group tree with cubes. Per-row visibility + lock, optional extra columns (F4: export, shade, auto UV, mirror UV),
 * search, drag re-parent (bones and cubes), inline rename (F2 / double click), group / ungroup, sort, collapse / unfold, context menu.
 */
import { perfRender } from "./perf";
import { useEffect, useMemo, useRef, useState } from "react";
import { getAnimation } from "../core";
import { showContextMenu } from "../../shell/contextMenu";
import { runAction } from "../../../actions/registry";
import { useStudio, useStudioPick } from "./state";
import { boneTree, rigTree, type RigModel, type TreeBone } from "./model";
import { clickRow, selValue, topGroups, type RowRef } from "./selection";
import { FLAG_NAMES, bbFlagMap, canEditDoc, flagValue, opAddBone, opAddCube, opMoveCube, opRenameBone, opReparent, opReparentMany, opToggleFlag, type FlagName } from "./ops";
import { BoneIcon, ChevronD, ChevronR, CubeIcon, EyeIcon, LockIcon, PlusIcon, SearchI, TrashIcon, CopyIcon } from "./icons";
import { Section, IconBtn } from "./widgets";
import { boneSelectionState, selBadgeTip } from "./timeline/rowSelection"; // == selection badge ==
import { toolsStore, useToolsUi } from "./toolsUi";
import { allStudios } from "./studios";

type Row =
  | { t: "bone"; node: TreeBone; depth: number }
  | { t: "cube"; bone: string; index: number; label: string; depth: number };

const FLAG_UI: Record<FlagName, { glyph: string; title: string }> = {
  export: { glyph: "E", title: "Export" },
  shade: { glyph: "S", title: "Shading" },
  autouv: { glyph: "A", title: "Auto UV" },
  mirror_uv: { glyph: "M", title: "Mirror UV" },
};

/** outliner row height in px (.as-row-t: --row-h, borders included) and the windowing thresholds */
const ROW_H = 24, ROW_OVERSCAN = 12, WINDOW_MIN_ROWS = 300;

export function Outliner({ rig }: { rig: RigModel | null }) {
  perfRender("Outliner");
  const api = useStudio();
  const s = useStudioPick("mode", "doc", "anim", "bones", "cube", "cubes", "hidden", "locked", "keys");
  const ui = useToolsUi(api);
  const [q, setQ] = useState("");
  const [drop, setDrop] = useState<string | null>(null);
  const dragging = useRef<{ bone?: string; cube?: { bone: string; index: number } } | null>(null);
  const editable = canEditDoc(s.doc) && s.mode === "edit";
  const renameable = canEditDoc(s.doc);
  const collapsed = useMemo(() => new Set(ui.collapsed), [ui.collapsed]);
  const flags = useMemo(() => bbFlagMap(s.doc), [s.doc]);
  const isBb = s.doc?.kind === "bbmodel";
  const animated = useMemo(() => {
    const a = s.doc && s.doc.kind !== "geo" && s.anim ? getAnimation(s.doc, s.anim) : undefined;
    return new Set(a ? [...a.bones.keys()] : []);
  }, [s.doc, s.anim]);
  // == selection badge == Animate / Pose: a quiet marker on bones whose keyframes are all (or partly) selected
  const animObj = useMemo(() => (s.doc && s.doc.kind !== "geo" && s.anim ? getAnimation(s.doc, s.anim) : undefined), [s.doc, s.anim]);
  const keyMark = (name: string) => {
    if (s.mode === "edit" || !animObj || !s.keys.length) return null;
    const st = boneSelectionState(s.keys, animObj, name);
    if (st.state === "none") return null;
    return <span className={"as-keymark" + (st.state === "all" ? " all" : "")} title={selBadgeTip({ kind: "bone", bone: name }, st)} data-keymark={st.state}>{st.state === "all" ? "all" : `${st.selected}/${st.total}`}</span>;
  };
  const setCollapsed = (fn: (c: Set<string>) => void) => { const n = new Set(collapsed); fn(n); toolsStore(api).set({ collapsed: [...n] }); };

  const rows = useMemo<Row[]>(() => {
    if (!rig) return [];
    const tree = boneTree(rig);
    const needle = q.trim().toLowerCase();
    const match = new Set<string>();
    if (needle) {
      const rec = (n: TreeBone): boolean => {
        let hit = n.bone.name.toLowerCase().includes(needle) || n.bone.cubes.some((c) => (c.name ?? `cube ${c.index}`).toLowerCase().includes(needle));
        for (const c of n.children) hit = rec(c) || hit;
        if (hit) match.add(n.bone.name);
        return hit;
      };
      tree.forEach(rec);
    }
    const out: Row[] = [];
    const rec = (n: TreeBone, depth: number) => {
      if (needle && !match.has(n.bone.name)) return;
      out.push({ t: "bone", node: n, depth });
      if (collapsed.has(n.bone.name) && !needle) return;
      n.children.forEach((c) => rec(c, depth + 1));
      for (const c of n.bone.cubes) out.push({ t: "cube", bone: n.bone.name, index: c.index, label: c.name ?? `Cube ${c.index + 1}  ${c.size.map((v) => +v.toFixed(2)).join("×")}`, depth: depth + 1 });
    };
    tree.forEach((n) => rec(n, 0));
    return out;
  }, [rig, q, collapsed]);

  const tree = useMemo(() => rigTree(rig), [rig]);
  const rowRefs = useMemo<RowRef[]>(() => rows.map((r) => (r.t === "bone" ? { t: "bone", bone: r.node.bone.name, parent: r.node.bone.parent ?? "" } : { t: "cube", bone: r.bone, index: r.index, parent: r.bone })), [rows]);
  const sel = selValue(s);
  const selCubeKeys = useMemo(() => new Set(sel.cubes.map((c) => `${c.bone}#${c.index}`)), [s.cube, s.cubes]); // eslint-disable-line react-hooks/exhaustive-deps
  /** group rows read as selected when the group is selected, or when every cube inside a cube selection is */
  const boneSelected = (name: string): boolean => {
    if (!sel.cube) return sel.bones.includes(name);
    const under = tree.cubesUnder(name);
    return under.length > 0 && under.every((c) => selCubeKeys.has(`${c.bone}#${c.index}`));
  };
  const parentSelected = (name: string): boolean => { for (let p = tree.parentOf(name); p; p = tree.parentOf(p)) if (!sel.cube && sel.bones.includes(p)) return true; return false; };
  useEffect(() => { if (ui.renaming && !rig?.bones.some((b) => b.name === ui.renaming)) toolsStore(api).set({ renaming: null }); }, [rig, ui.renaming, api]);
  const setRenaming = (v: string | null) => toolsStore(api).set({ renaming: v });

  const animate = s.mode !== "edit";
  /** the groups a drag of `bone` moves: the whole group selection when `bone` is part of it */
  const dragged = (bone: string): string[] => (!sel.cube && sel.bones.includes(bone) ? topGroups(sel.bones, tree) : [bone]);
  /** Blockbench outliner clicks (ui/selection.ts): plain selects, Cmd toggles, Shift adds the range between the previous and this row */
  const clickSel = (row: RowRef, e: React.MouseEvent) => {
    const next = clickRow(rowRefs, selValue(api.store.get()), row, { meta: e.metaKey || e.ctrlKey, shift: e.shiftKey }, tree, animate);
    api.store.set({ bones: next.bones, cube: next.cube, cubes: next.cubes });
  };
  const selectBone = (name: string, e: React.MouseEvent) => clickSel({ t: "bone", bone: name, parent: rig?.bones.find((b) => b.name === name)?.parent ?? "" }, e);
  const toggle = (key: "hidden" | "locked", name: string) => api.store.set((st) => ({ [key]: st[key].includes(name) ? st[key].filter((b) => b !== name) : [...st[key], name] }) as never);

  const menu = (e: React.MouseEvent, bone?: string, cube?: { bone: string; index: number }) => {
    e.preventDefault();
    e.stopPropagation();
    if (cube ? !selCubeKeys.has(`${cube.bone}#${cube.index}`) : bone && !boneSelected(bone)) api.store.set(cube ? { bones: [cube.bone], cube, cubes: [cube] } : { bones: [bone!], cube: null, cubes: [] });
    const act = (id: string) => () => runAction(id);
    showContextMenu(e.clientX, e.clientY, [
      { label: "New Bone", run: () => opAddBone(api, bone), disabled: !editable },
      { label: "New Cube", run: () => opAddCube(api, bone), disabled: !editable },
      { label: "Add Group", shortcut: "⌘G", run: act("Studio.AddGroup"), disabled: !editable },
      { label: "Group Elements", shortcut: "⌘⇧G", run: act("Studio.GroupElements"), disabled: !editable || !bone },
      { label: "Ungroup", run: act("Studio.Ungroup"), disabled: !editable || !bone || !!cube },
      { separator: true, label: "" },
      { label: "Copy", shortcut: "⌘C", run: act("Studio.Copy"), disabled: !editable || !bone },
      { label: "Cut", shortcut: "⌘X", run: act("Studio.Cut"), disabled: !editable || !bone },
      { label: "Paste", shortcut: "⌘V", run: act("Studio.Paste"), disabled: !editable || !ui.elemClip },
      { label: "Rename", shortcut: "F2", run: () => bone && setRenaming(bone), disabled: !bone || !renameable },
      { label: "Duplicate", shortcut: "⌘D", run: act("Studio.Duplicate"), disabled: !editable || !bone },
      { label: "Delete", shortcut: "⌫", run: act("Studio.Delete"), disabled: !editable || !bone },
      { separator: true, label: "" },
      { label: "Hide Everything Except Selection", shortcut: "I", run: act("Studio.HideOthers"), disabled: !editable || !bone },
      { label: "Show All", run: act("Studio.ShowAll") },
      { label: "Unlock All", run: act("Studio.UnlockAll") },
      { label: "Sort Outliner", run: act("Studio.SortOutliner"), disabled: !editable },
      { label: "Collapse Groups", run: act("Studio.CollapseGroups") },
      { label: "Unfold Groups", run: act("Studio.UnfoldGroups") },
      { separator: true, label: "" },
      { label: "Toggle More Options", shortcut: "F4", run: act("Studio.OutlinerOptions") },
      { label: "Reveal in Text", run: () => api.revealInText({ bone }), disabled: !bone },
    ]);
  };

  // Big rigs (a 324-bone armor is ~2500 rows) only mount the rows in view: every DOM change elsewhere in the Studio (the playhead label, the pose
  // fields) otherwise re-lays out the whole list, ~60 ms per playback frame. Small trees render in full.
  const treeEl = useRef<HTMLDivElement>(null);
  const windowed = rows.length > WINDOW_MIN_ROWS;
  const [win, setWin] = useState({ top: 0, h: 600 });
  useEffect(() => {
    const el = treeEl.current;
    if (!el || !windowed) return;
    const upd = () => setWin((w) => (w.top === el.scrollTop && w.h === el.clientHeight ? w : { top: el.scrollTop, h: el.clientHeight }));
    upd();
    el.addEventListener("scroll", upd, { passive: true });
    const ro = new ResizeObserver(upd);
    ro.observe(el);
    return () => { el.removeEventListener("scroll", upd); ro.disconnect(); };
  }, [windowed]);
  const from = windowed ? Math.max(0, Math.floor(win.top / ROW_H) - ROW_OVERSCAN) : 0;
  const to = windowed ? Math.min(rows.length, Math.ceil((win.top + win.h) / ROW_H) + ROW_OVERSCAN) : rows.length;

  const flagCols = (g: { flags: Partial<Record<FlagName, boolean>>; names: FlagName[]; target: { bone: string; index?: number }; geoMirror?: boolean }) =>
    ui.outlinerOptions && editable
      ? g.names.map((f) => {
          const on = f === "mirror_uv" && !isBb ? !!g.geoMirror : flagValue(g.flags, f);
          return (
            <span key={f} className={"as-tog opt" + (on ? " on" : "")} title={`${FLAG_UI[f].title}: ${on ? "on" : "off"}`} data-act={f} style={{ opacity: on ? 1 : 0.45, fontSize: 10, fontWeight: 600 }}
              onClick={(e) => { e.stopPropagation(); opToggleFlag(api, f, g.target); }}>{FLAG_UI[f].glyph}</span>
          );
        })
      : null;
  const boneFlagNames: FlagName[] = isBb ? ["export", "mirror_uv"] : ["mirror_uv"];
  const cubeFlagNames: FlagName[] = isBb ? FLAG_NAMES : ["mirror_uv"];

  const body = (
    <div className="as-tree" data-testid="as-tree" ref={treeEl} onContextMenu={(e) => menu(e)}
      onDragOver={(e) => { if (dragging.current) { e.preventDefault(); setDrop("(root)"); } }}
      onDrop={() => { if (dragging.current?.bone) opReparentMany(api, dragged(dragging.current.bone), null); dragging.current = null; setDrop(null); }}>
      {!rig && <div className="as-empty">No model</div>}
      {rig && !rows.length && <div className="as-empty">{q ? "No matches" : "Empty model. Add a bone to start."}</div>}
      {windowed && from > 0 && <div style={{ height: from * ROW_H }} />}
      {rows.slice(from, to).map((r) => {
        if (r.t === "cube") {
          const csel = selCubeKeys.has(`${r.bone}#${r.index}`);
          const inGroup = !sel.cube && (sel.bones.includes(r.bone) || parentSelected(r.bone));
          const cf = flags.cubes.get(`${r.bone}#${r.index}`);
          const gc = rig?.bones.find((b) => b.name === r.bone)?.cubes[r.index];
          return (
            <div key={`${r.bone}#${r.index}`} className={"as-row-t" + (csel ? " sel" : inGroup ? " sel2" : "")} style={{ paddingLeft: 8 + r.depth * 14 + 14 }} data-cube={`${r.bone}#${r.index}`}
              draggable={editable}
              onDragStart={(e) => { dragging.current = { cube: { bone: r.bone, index: r.index } }; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", r.label); }}
              onDragEnd={() => { dragging.current = null; setDrop(null); }}
              onClick={(e) => clickSel({ t: "cube", bone: r.bone, index: r.index, parent: r.bone }, e)} onContextMenu={(e) => menu(e, r.bone, { bone: r.bone, index: r.index })}>
              <span className="as-ico cube"><CubeIcon /></span>
              <span className="as-name dim">{r.label}</span>
              {flagCols({ flags: cf ?? {}, names: cubeFlagNames, target: { bone: r.bone, index: r.index }, geoMirror: !!gc?.mirror })}
            </div>
          );
        }
        const b = r.node.bone;
        const bsel = boneSelected(b.name);
        const hidden = s.hidden.includes(b.name);
        const locked = s.locked.includes(b.name);
        const hasKids = r.node.children.length > 0 || b.cubes.length > 0;
        const bf = flags.groups.get(b.name);
        return (
          <div
            key={b.name} className={"as-row-t" + (bsel ? " sel" : parentSelected(b.name) ? " sel2" : "") + (hidden ? " off" : "") + (drop === b.name ? " drop" : "")}
            style={{ paddingLeft: 8 + r.depth * 14 }} data-bone={b.name}
            draggable={editable && !ui.renaming}
            onDragStart={(e) => { dragging.current = { bone: b.name }; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", b.name); }}
            onDragEnd={() => { dragging.current = null; setDrop(null); }}
            onDragOver={(e) => { const d = dragging.current; if (d && d.bone !== b.name) { e.preventDefault(); e.stopPropagation(); setDrop(b.name); } }}
            onDrop={(e) => {
              e.stopPropagation();
              const d = dragging.current;
              if (d?.bone && d.bone !== b.name) opReparentMany(api, dragged(d.bone), b.name);
              else if (d?.cube) opMoveCube(api, d.cube, b.name);
              dragging.current = null; setDrop(null);
            }}
            onClick={(e) => selectBone(b.name, e)}
            onDoubleClick={() => renameable && setRenaming(b.name)}
            onContextMenu={(e) => menu(e, b.name)}
          >
            <span className="as-chev" onClick={(e) => { e.stopPropagation(); if (hasKids) setCollapsed((c) => { c.has(b.name) ? c.delete(b.name) : c.add(b.name); }); }}>
              {hasKids ? (collapsed.has(b.name) ? <ChevronR /> : <ChevronD />) : null}
            </span>
            <span className="as-ico bone"><BoneIcon /></span>
            {ui.renaming === b.name ? (
              <RenameInput initial={b.name} onDone={(v) => { setRenaming(null); if (v) opRenameBone(api, b.name, v); setTimeout(() => allStudios().find((h) => h.api === api)?.root.current?.focus({ preventScroll: true }), 0); }} />
            ) : (
              <span className={"as-name" + (animated.has(b.name) ? " anim" : "")}>{b.name}</span>
            )}
            {keyMark(b.name)}
            {flagCols({ flags: bf ?? {}, names: boneFlagNames, target: { bone: b.name }, geoMirror: !!(b as { mirror?: boolean }).mirror })}
            <span className="as-tog" onClick={(e) => { e.stopPropagation(); toggle("hidden", b.name); }} title={hidden ? "Show" : "Hide"} data-act="eye"><EyeIcon off={hidden} /></span>
            <span className={"as-tog" + (locked ? " on" : "")} onClick={(e) => { e.stopPropagation(); toggle("locked", b.name); }} title={locked ? "Unlock" : "Lock"} data-act="lock"><LockIcon on={locked} /></span>
          </div>
        );
      })}
      {windowed && to < rows.length && <div style={{ height: (rows.length - to) * ROW_H }} />}
    </div>
  );

  return (
    <Section
      title="Outliner" grow
      right={
        <>
          <IconBtn title="New Bone" disabled={!editable} onClick={() => opAddBone(api, s.bones[0])} id="add-bone"><PlusIcon /></IconBtn>
          <IconBtn title="New Cube" disabled={!editable} onClick={() => opAddCube(api)} id="add-cube"><CubeIcon size={15} /></IconBtn>
          <IconBtn title="Duplicate (⌘D)" disabled={!editable} onClick={() => runAction("Studio.Duplicate")} id="dup"><CopyIcon /></IconBtn>
          <IconBtn title="Delete (⌫)" disabled={!editable} onClick={() => runAction("Studio.Delete")} id="del"><TrashIcon /></IconBtn>
          <IconBtn title="More options (F4)" on={ui.outlinerOptions} onClick={() => runAction("Studio.OutlinerOptions")} id="opts"><span style={{ fontSize: 11, fontWeight: 700 }}>⋯</span></IconBtn>
        </>
      }
    >
      <div className="as-search"><SearchI /><input placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") setQ(""); }} spellCheck={false} /></div>
      {body}
    </Section>
  );
}

function RenameInput({ initial, onDone }: { initial: string; onDone: (v: string | null) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  const finish = (v: string | null) => { if (done.current) return; done.current = true; onDone(v); };
  return (
    <input
      ref={ref} className="as-rename" defaultValue={initial} spellCheck={false} data-testid="as-rename" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}
      onBlur={(e) => finish(e.target.value)}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") finish((e.target as HTMLInputElement).value); else if (e.key === "Escape") finish(null); }}
    />
  );
}
