/**
 * Constraints panel (Animate / Pose, left column): limb links for the current animation. Link two points so two limbs meet, pin a
 * point in place, or make one limb copy another's rotation. Constraints drive the preview live; "Bake" writes them to normal
 * rotation keys (the game only reads keys).
 */
import { perfRender } from "../perf";
import { useMemo, useState } from "react";
import { animLength, getAnimation, mirrorBoneName, viaOf, type Constraint, type Drive } from "../../core";
import { useStudio, useStudioPick } from "../state";
import type { RigModel } from "../model";
import { Check, IconBtn, NumField, Section, Seg, Vec3Field } from "../widgets";
import { TrashIcon } from "../icons";
import { ensureStyles } from "../timeline/styles";
import { DEFAULT_BAKE, addFollow, bakeNow, beginPick, cancelPick, constraintsOf, patchConstraint, removeConstraint, setCons, type BakeUi } from "./store";

const KIND_LABEL: Record<Constraint["kind"], string> = { link: "Link", pin: "Pin", follow: "Follow" };
const CSS = `
.as-cons { font-size:12px; }
.as-cons .hint { margin:2px 10px 6px; padding:5px 8px; border-radius:5px; background:rgba(136,192,208,.12); color:var(--fg); display:flex; align-items:center; gap:8px; line-height:1.35; }
.as-cons .hint b { color:var(--accent); font-weight:600; }
.as-cons .hint .x { margin-left:auto; color:var(--fg-dim); }
.as-cons .empty { margin:4px 10px 8px; color:var(--fg-faint); line-height:1.4; }
.as-cons .crow { height:24px; display:flex; align-items:center; gap:6px; padding:0 8px 0 10px; border-left:2px solid transparent; }
.as-cons .crow:hover { background:var(--bg-hover); }
.as-cons .crow.sel { background:var(--bg-selected); border-left-color:var(--accent); }
.as-cons .crow.off .nm { color:var(--fg-faint); }
.as-cons .crow .nm { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.as-cons .crow .kd { font-size:10px; padding:0 5px; border-radius:7px; background:var(--bg-input); color:var(--fg-faint); }
.as-cons .crow input[type=checkbox] { margin:0; }
.as-cons .detail { padding:4px 10px 8px 12px; display:flex; flex-direction:column; gap:5px; background:rgba(0,0,0,.08); }
.as-cons .detail .ln { display:flex; align-items:center; gap:6px; min-height:22px; }
.as-cons .detail .ln > span.l { width:62px; color:var(--fg-dim); flex:none; }
.as-cons .detail .ln .as-sel { flex:1; min-width:0; }
.as-cons .detail .sub { color:var(--fg-faint); font-size:11px; line-height:1.35; }
.as-cons .foot { padding:6px 10px 2px; display:flex; flex-direction:column; gap:6px; border-top:1px solid var(--border); margin-top:6px; }
.as-cons .foot .ln { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
.as-cons .btn { height:22px; padding:0 9px; border-radius:4px; background:var(--bg-input); border:1px solid var(--border); color:var(--fg); white-space:nowrap; }
.as-cons .btn:hover:not(:disabled) { background:var(--bg-selected); }
.as-cons .btn.primary { background:var(--accent-bg); border-color:transparent; color:#fff; }
.as-cons .btn:disabled { opacity:.4; }
.as-livechip { height:18px; padding:0 8px; margin-right:4px; border-radius:9px; background:rgba(235,203,139,.16); color:var(--nord13); font-size:11px; display:inline-flex; align-items:center; gap:5px; white-space:nowrap; min-width:0; overflow:hidden; text-overflow:ellipsis; flex:0 1 auto; }
.as-livechip:hover { background:rgba(235,203,139,.26); }
.as-livechip i { width:6px; height:6px; border-radius:50%; background:var(--nord13); flex:none; }
@container astb (max-width: 760px) { .as-livechip .long { display:none; } }
`;
let injected = false;
export function ensureConsStyles(): void {
  ensureStyles();
  if (injected || typeof document === "undefined") return;
  injected = true;
  const el = document.createElement("style");
  el.id = "as-cons-css";
  el.textContent = CSS;
  document.head.appendChild(el);
}

export function ConstraintsPanel({ rig }: { rig: RigModel | null }) {
  perfRender("ConstraintsPanel");
  ensureConsStyles();
  const api = useStudio();
  const s = useStudioPick("doc", "anim", "cons", "bones");
  const list = constraintsOf(s);
  const [open, setOpen] = useState(true);
  const [bake, setBake] = useState<BakeUi>(DEFAULT_BAKE);
  const [msg, setMsg] = useState("");
  const anim = s.doc && s.doc.kind !== "geo" && s.anim ? getAnimation(s.doc, s.anim) : undefined;
  const length = anim ? animLength(anim) : 0;
  const bones = useMemo(() => rig?.bones ?? [], [rig]);
  const names = bones.map((b) => b.name);
  const sel = list.find((c) => c.id === s.cons.sel) ?? null;
  const pick = s.cons.pick;
  const can = !!anim;
  const chain = (bone: string) => {
    const by = new Map(bones.map((b) => [b.name, b]));
    const out: string[] = [];
    for (let n: string | undefined = bone, i = 0; n && by.has(n) && i < 64; n = by.get(n)?.parent, i++) out.push(n);
    return out.length ? out : [bone];
  };
  const patch = (id: string, p: Partial<Constraint>, label?: string) => patchConstraint(api, id, p, label);
  const doBake = (ids?: string[]) => {
    const r = bakeNow(api, bones, ids, bake);
    setMsg(r ? `Baked ${r.keys} keys on ${r.bones.join(", ")}` : "Nothing to bake");
  };
  const addFollowDefault = () => {
    const src = names.includes(s.bones[0] ?? "") ? s.bones[0] : names.find((n) => /RightArm$/.test(n)) ?? names[0];
    const m = mirrorBoneName(src);
    addFollow(api, src, m !== src && names.includes(m) ? m : names.find((n) => n !== src) ?? src);
  };
  const driveLabel = (c: Constraint) => (c.kind === "link" ? `A ${viaOf(c.a)}  ·  B ${viaOf(c.b)}` : "");

  return (
    <Section
      title={`Constraints${list.length ? ` (${list.length})` : ""}`} collapsed={!open} onToggle={() => setOpen(!open)}
      right={
        <>
          <IconBtn title="Link two points: they meet on a point" disabled={!can} onClick={() => beginPick(api, "link")} id="cons-link"><span style={{ fontSize: 11 }}>Link</span></IconBtn>
          <IconBtn title="Pin a point where it is now (planted hand / foot)" disabled={!can} onClick={() => beginPick(api, "pin")} id="cons-pin"><span style={{ fontSize: 11 }}>Pin</span></IconBtn>
          <IconBtn title="One limb copies another limb's rotation" disabled={!can || names.length < 2} onClick={() => addFollowDefault()} id="cons-follow"><span style={{ fontSize: 11 }}>Follow</span></IconBtn>
        </>
      }
    >
      <div className="as-cons" data-testid="as-cons">
        <div className="crow" style={{ height: 22, gap: 2 }}><span style={{ flex: 1, color: "var(--fg-faint)", fontSize: 11 }}>Preview</span>
          <IconBtn title={s.cons.live ? "Live: constraints drive the preview (click to switch off)" : "Constraints are off in the preview (click to turn on)"} on={s.cons.live} onClick={() => setCons(api, { live: !s.cons.live })} id="cons-live"><span style={{ fontSize: 11 }}>Live</span></IconBtn>
          <IconBtn title="Show contact points" on={s.cons.showPoints} onClick={() => setCons(api, { showPoints: !s.cons.showPoints })} id="cons-dots"><span style={{ fontSize: 13, lineHeight: 1 }}>{"●"}</span></IconBtn>
        </div>
        {pick && (
          <div className="hint" data-testid="as-cons-hint">
            <span>{pick.kind === "pin" ? <>Click the point to <b>pin</b></> : pick.stage === "a" ? <>Click point <b>A</b> on a limb</> : <>Click point <b>B</b> on the other limb</>} (snaps to corners, edge middles, face centres)</span>
            <button className="as-ib x" onClick={() => cancelPick(api)} tabIndex={-1}>Esc</button>
          </div>
        )}
        {!list.length && !pick && <div className="empty">No constraints. <b>Link</b> makes two limbs meet on points, <b>Pin</b> plants a point, <b>Follow</b> copies a rotation. They preview live; <b>Bake</b> writes normal keys.</div>}
        {list.map((c) => (
          <div key={c.id}>
            <div className={"crow" + (c.id === s.cons.sel ? " sel" : "") + (c.enabled ? "" : " off")} data-cid={c.id} data-kind={c.kind} onClick={() => setCons(api, { sel: c.id === s.cons.sel ? null : c.id })}>
              <input type="checkbox" checked={c.enabled} title="Enabled" onClick={(e) => e.stopPropagation()} onChange={(e) => patch(c.id, { enabled: e.target.checked }, e.target.checked ? "Enable Constraint" : "Disable Constraint")} />
              <span className="nm" title={c.name}>{c.name}</span>
              <span className="kd">{KIND_LABEL[c.kind]}</span>
              <IconBtn title="Remove" onClick={() => removeConstraint(api, c.id)}><TrashIcon /></IconBtn>
            </div>
            {c.id === s.cons.sel && (
              <div className="detail" data-testid="as-cons-detail">
                {c.kind === "link" && (
                  <>
                    <div className="ln"><span className="l">Moves</span>
                      <Seg<Drive> value={c.drive} onChange={(d) => patch(c.id, { drive: d })} options={[{ id: "a", label: "A", title: `Only A (${viaOf(c.a)}) rotates` }, { id: "b", label: "B", title: `Only B (${viaOf(c.b)}) rotates` }, { id: "both", label: "Both", title: "Both rotate and meet in the middle" }]} id="cons-drive" />
                    </div>
                    <div className="sub">{driveLabel(c)}. The driven bone rotates about its pivot, keeping its roll. While you drag one end the other follows; with Both, released ends settle to meet in the middle.</div>
                    {([["a", c.a], ["b", c.b]] as const).map(([k, pt]) => (
                      <div className="ln" key={k}><span className="l">{k.toUpperCase()} rotates</span>
                        <select className="as-sel" value={viaOf(pt)} onChange={(e) => patch(c.id, { [k]: { ...pt, via: e.target.value === pt.bone ? undefined : e.target.value } } as Partial<Constraint>)}>
                          {chain(pt.bone).map((n) => <option key={n} value={n}>{n}</option>)}
                        </select>
                      </div>
                    ))}
                  </>
                )}
                {c.kind === "pin" && (
                  <>
                    <div className="ln"><span className="l">Holds</span><span>{viaOf(c.point)} @ {c.frame.toFixed(2)}s</span>
                      <button className="btn" onClick={() => setCons(api, { pick: { kind: "pin", stage: "a", drive: "b" } })} title="Pick the point again to recapture it at the playhead">Re-pin</button></div>
                    <div className="sub">The point stays at its world position from the frame it was pinned, while its bone rotates about its pivot.</div>
                  </>
                )}
                {c.kind === "follow" && (
                  <>
                    <div className="ln"><span className="l">Copies</span>
                      <select className="as-sel" value={c.source} onChange={(e) => patch(c.id, { source: e.target.value })}>{names.map((n) => <option key={n}>{n}</option>)}</select></div>
                    <div className="ln"><span className="l">Onto</span>
                      <select className="as-sel" value={c.target} onChange={(e) => patch(c.id, { target: e.target.value })}>{names.map((n) => <option key={n}>{n}</option>)}</select></div>
                    <Check label="Mirror L ↔ R (flip yaw and roll)" checked={c.mirror} onChange={(v) => patch(c.id, { mirror: v })} />
                    <Vec3Field label="Offset" value={c.offset} step={1} onCommit={(v) => patch(c.id, { offset: v })} />
                  </>
                )}
                <div className="ln"><span className="l">Influence</span><NumField value={c.influence} step={0.1} width={64} onCommit={(v) => patch(c.id, { influence: Math.min(1, Math.max(0, v)) })} /></div>
                <div className="ln"><span className="l">Range s</span>
                  <NumField label="in" value={c.start} step={0.05} width={78} onCommit={(v) => patch(c.id, { start: Math.max(0, v) })} />
                  <NumField label="out" value={c.end ?? length} step={0.05} width={78} onCommit={(v) => patch(c.id, { end: v >= length - 1e-6 ? null : Math.max(c.start, v) })} />
                </div>
                <div className="ln"><span className="l">Blend ticks</span>
                  <NumField label="in" value={c.blendIn} step={1} width={78} onCommit={(v) => patch(c.id, { blendIn: Math.max(0, Math.round(v)) })} />
                  <NumField label="out" value={c.blendOut} step={1} width={78} onCommit={(v) => patch(c.id, { blendOut: Math.max(0, Math.round(v)) })} />
                </div>
              </div>
            )}
          </div>
        ))}
        {(list.length > 0 || pick) && (
          <div className="foot">
            <Check label="Key constrained bones when I drag" checked={s.cons.keyConstrained} onChange={(v) => setCons(api, { keyConstrained: v })} id="cons-keyboth" />
            <div className="ln"><span style={{ color: "var(--fg-dim)" }}>Bake at</span>
              <Seg value={bake.at} onChange={(at) => setBake({ ...bake, at })} options={[{ id: "ticks", label: "Every tick", title: "A key every 0.05 s" }, { id: "keys", label: "Key times", title: "Only where the animation already has keys" }]} id="cons-bake-at" />
            </div>
            <div className="ln"><NumField label="Simplify °" value={bake.simplify} step={0.1} width={104} onCommit={(v) => setBake({ ...bake, simplify: Math.max(0, v) })} />
              <Seg value={bake.after} onChange={(after) => setBake({ ...bake, after })} options={[{ id: "keep", label: "Keep off", title: "Keep the constraints, disabled" }, { id: "remove", label: "Remove", title: "Remove the constraints after baking" }]} id="cons-bake-after" />
            </div>
            <div className="ln">
              <button className="btn primary" disabled={!list.some((c) => c.enabled)} onClick={() => doBake()} data-testid="as-cons-bake-all" title="Write every enabled constraint into rotation keys (one undo step)">Bake all</button>
              <button className="btn" disabled={!sel} onClick={() => sel && doBake([sel.id])} data-testid="as-cons-bake-sel">Bake selected</button>
              <span style={{ color: "var(--fg-faint)", fontSize: 11 }} data-testid="as-cons-msg">{msg}</span>
            </div>
          </div>
        )}
      </div>
    </Section>
  );
}
