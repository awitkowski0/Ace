/** Reference Images panel (Blockbench "Reference Images" list + properties) and the import dialog. Floats over the viewport. */
import { useEffect } from "react";
import { REF_LAYERS, type RefImage } from "../../core";
import { useStudio, useStudioPick } from "../state";
import { EyeIcon, LockIcon, PlusIcon, TrashIcon } from "../icons";
import { Check, NumField } from "../widgets";
import { addRefFromClipboard, addRefFromPicker, confirmImport, deleteRef, naturalSize, refUi, selectRef, toggleAllRefs, toggleRefEditMode, updateRef, useRefUi } from "./refs";

const sel = "as-select as-ref-sel";

export function RefPanel() {
  const api = useStudio();
  const s = useStudioPick("refs", "refSel", "refEdit", "refsHidden");
  const cur = s.refs.find((r) => r.uuid === s.refSel) ?? null;
  if (!s.refEdit) return null;
  const up = (patch: Partial<RefImage>, label?: string) => cur && updateRef(api, cur.uuid, patch, label);
  const linkedSize = async (axis: 0 | 1, v: number) => {
    if (!cur) return;
    const [nw, nh] = await naturalSize(cur.source);
    const ratio = nw / nh;
    up({ size: axis === 0 ? [v, Math.round(v / ratio)] : [Math.round(v * ratio), v] }, "Resize Reference Image");
  };
  return (
    <div className="as-refpanel" data-testid="ref-panel" onPointerDown={(e) => e.stopPropagation()}>
      <div className="as-refpanel-h">
        <b>Reference Images</b>
        <span className="as-grow" />
        <button className="as-ib" title="Add Reference Image… (file)" data-id="ref-add" onClick={() => addRefFromPicker(api)}><PlusIcon /></button>
        <button className="as-ib as-tx" title="Paste Reference Image (clipboard)" data-id="ref-paste" onClick={() => void addRefFromClipboard(api)}>Paste</button>
        <button className={"as-ib" + (s.refsHidden ? " on" : "")} title={s.refsHidden ? "Show All Reference Images" : "Hide All Reference Images"} data-id="ref-hide-all" onClick={() => toggleAllRefs(api)}><EyeIcon off={s.refsHidden} /></button>
        <button className="as-ib as-tx" title="Leave Reference Image mode" data-id="ref-done" onClick={() => toggleRefEditMode(api)}>Done</button>
      </div>
      <div className="as-reflist">
        {s.refs.length === 0 && <div className="as-note">No reference images. Drop an image onto the viewport, paste one, or press +.</div>}
        {s.refs.map((r) => (
          <div key={r.uuid} className={"as-refrow" + (r.uuid === s.refSel ? " sel" : "")} data-ref-row={r.uuid} onClick={() => selectRef(api, r.uuid)}>
            <img src={r.source} alt="" draggable={false} />
            <span className="as-refname">{r.name}</span>
            <span className="as-refscope">{r.scope === "global" ? "all" : r.view_mode === "blueprint" ? r.attached_side : ""}</span>
            <button className={"as-tog" + (r.visibility ? "" : " on")} title="Visibility" onClick={(e) => { e.stopPropagation(); updateRef(api, r.uuid, { visibility: !r.visibility }, "Toggle Reference Image"); }}><EyeIcon off={!r.visibility} /></button>
            <button className={"as-tog" + (r.locked ? " on" : "")} title="Lock" onClick={(e) => { e.stopPropagation(); updateRef(api, r.uuid, { locked: !r.locked }, "Lock Reference Image"); }}><LockIcon on={r.locked} /></button>
            <button className="as-tog" title="Delete (Del)" onClick={(e) => { e.stopPropagation(); deleteRef(api, r.uuid); }}><TrashIcon /></button>
          </div>
        ))}
      </div>
      {cur && (
        <div className="as-refprops" data-testid="ref-props">
          <Row l="Name"><input className="as-ref-name" value={cur.name} onChange={(e) => up({ name: e.target.value }, "Rename Reference Image")} spellCheck={false} onKeyDown={(e) => e.stopPropagation()} /></Row>
          <Row l="Layer">
            <select className={sel} data-id="ref-layer" value={cur.layer} onChange={(e) => up({ layer: e.target.value as RefImage["layer"] }, "Reference Image Layer")}>
              {REF_LAYERS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
            </select>
          </Row>
          <Row l="Mode">
            <select className={sel} data-id="ref-mode" value={cur.view_mode} onChange={(e) => up({ view_mode: e.target.value as RefImage["view_mode"] }, "Reference Image Mode")}>
              <option value="flat_image">Flat Image</option>
              <option value="plane">3D Plane</option>
              <option value="blueprint">Blueprint</option>
            </select>
            {cur.view_mode === "blueprint" && (
              <select className={sel} data-id="ref-side" value={cur.attached_side} onChange={(e) => up({ attached_side: e.target.value as RefImage["attached_side"] }, "Reference Image View")}>
                {([["north", "Front"], ["south", "Back"], ["east", "Right"], ["west", "Left"], ["top", "Top"], ["bottom", "Bottom"]] as const).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            )}
          </Row>
          <Row l="Scope">
            <select className={sel} data-id="ref-scope" value={cur.scope} onChange={(e) => up({ scope: e.target.value as RefImage["scope"] }, "Reference Image Scope")}>
              <option value="project">Just this project</option>
              <option value="global">All projects</option>
            </select>
          </Row>
          {cur.view_mode === "plane" ? (
            <>
              <Row l="Position"><V3 v={cur.plane_position} on={(v) => up({ plane_position: v })} id="ref-ppos" /></Row>
              <Row l="Rotation"><V3 v={cur.plane_rotation} on={(v) => up({ plane_rotation: v })} id="ref-prot" /></Row>
            </>
          ) : (
            <Row l="Position">
              <NumField label="X" id="ref-px" value={cur.position[0]} onCommit={(v) => up({ position: [v, cur.position[1]] })} />
              <NumField label="Y" id="ref-py" value={cur.position[1]} onCommit={(v) => up({ position: [cur.position[0], v] })} />
            </Row>
          )}
          <Row l="Size">
            <NumField label="W" id="ref-w" value={cur.size[0]} onCommit={(v) => void linkedSize(0, v)} />
            <NumField label="H" id="ref-h" value={cur.size[1]} onCommit={(v) => void linkedSize(1, v)} />
          </Row>
          {cur.view_mode !== "plane" && <Row l="Rotation"><NumField label="°" id="ref-rot" value={cur.rotation} onCommit={(v) => up({ rotation: v })} /></Row>}
          <Row l="Opacity">
            <input type="range" min={0} max={100} step={1} data-id="ref-opacity" value={Math.round(cur.opacity * 100)} onChange={(e) => up({ opacity: Number(e.target.value) / 100 }, "Reference Image Opacity")} />
            <span className="as-tx">{Math.round(cur.opacity * 100)}</span>
          </Row>
          <Row l="Flip">
            <button className={"as-btn" + (cur.flip_x ? " on" : "")} data-id="ref-flipx" onClick={() => up({ flip_x: !cur.flip_x }, "Flip Reference Image")}>X</button>
            <button className={"as-btn" + (cur.flip_y ? " on" : "")} data-id="ref-flipy" onClick={() => up({ flip_y: !cur.flip_y }, "Flip Reference Image")}>Y</button>
          </Row>
          <Row l=""><Check label="Visible" id="ref-visible" checked={cur.visibility} onChange={(v) => up({ visibility: v })} /><Check label="Locked" id="ref-locked" checked={cur.locked} onChange={(v) => up({ locked: v })} /></Row>
          <Row l=""><Check label="Clear Mode" id="ref-clear" checked={cur.clear_mode} onChange={(v) => up({ clear_mode: v })} />{cur.view_mode === "plane" && <Check label="Hide Backside" id="ref-cull" checked={cur.cull_backface} onChange={(v) => up({ cull_backface: v })} />}</Row>
          <Row l="Modes">
            {(["edit", "animate", "pose"] as const).map((m) => (
              <Check key={m} label={m[0].toUpperCase() + m.slice(1)} id={"ref-mode-" + m} checked={!cur.modes.length || cur.modes.includes(m)}
                onChange={(on) => { const all = ["edit", "animate", "pose"]; const base = cur.modes.length ? cur.modes : all; const next = on ? [...base, m] : base.filter((x) => x !== m); up({ modes: next.length === 3 ? [] : next }, "Reference Image Modes"); }} />
            ))}
          </Row>
        </div>
      )}
    </div>
  );
}

const Row = ({ l, children }: { l: string; children: React.ReactNode }) => <div className="as-row"><span className="as-row-l">{l}</span><div className="as-row-f">{children}</div></div>;
const V3 = ({ v, on, id }: { v: [number, number, number]; on: (v: [number, number, number]) => void; id: string }) => (
  <>{(["X", "Y", "Z"] as const).map((a, i) => <NumField key={a} label={a} id={`${id}-${a.toLowerCase()}`} value={v[i]} onCommit={(n) => { const b: [number, number, number] = [...v]; b[i] = n; on(b); }} />)}</>
);

/** Blockbench's import dialog: preview, View Mode, Layer, "Add globally". */
export function RefImportDialog() {
  const api = useStudio();
  const ui = useRefUi(api);
  const p = ui.importing;
  useEffect(() => {
    if (!p) return;
    const kd = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); refUi(api).set({ importing: null }); }
      else if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); void confirmImport(api); }
    };
    window.addEventListener("keydown", kd, true);
    return () => window.removeEventListener("keydown", kd, true);
  }, [p, api]);
  if (!p) return null;
  const set = (patch: Partial<typeof p>) => refUi(api).set({ importing: { ...p, ...patch } });
  return (
    <div className="as-refdlg-back" data-testid="ref-import" onPointerDown={(e) => e.stopPropagation()}>
      <div className="as-refdlg">
        <div className="as-refdlg-t">Add Reference Image</div>
        <img src={p.source} alt="" className="as-refdlg-img" draggable={false} />
        <div className="as-note">{p.name} · {p.w} × {p.h}</div>
        <Row l="View Mode">
          <select className={sel} data-id="imp-mode" value={p.viewMode} onChange={(e) => set({ viewMode: e.target.value as "flat_image" | "plane" })}>
            <option value="flat_image">Flat Image</option>
            <option value="plane">3D Plane</option>
          </select>
        </Row>
        <Row l="Layer">
          <select className={sel} data-id="imp-layer" value={p.layer} onChange={(e) => set({ layer: e.target.value as RefImage["layer"] })}>
            {REF_LAYERS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
          </select>
        </Row>
        <Row l=""><Check label="Add globally (all projects)" id="imp-global" checked={p.global} onChange={(v) => set({ global: v })} /></Row>
        <div className="as-refdlg-f">
          <button className="as-btn" data-id="imp-cancel" onClick={() => refUi(api).set({ importing: null })}>Cancel</button>
          <button className="as-btn primary" data-id="imp-ok" onClick={() => void confirmImport(api)}>Add</button>
        </div>
      </div>
    </div>
  );
}
