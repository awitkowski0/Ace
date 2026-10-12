import { useEffect, useMemo, useRef, useState } from "react";
import { AIMED_TIP, DEFAULT_BEZIER, EASING_NAMES, channelUse, addToComp, applyEasing, evalMolang, findKey, getAnimation, mapKeyValues, moveKeyframes, patchKeyframes, retimeKeyframe, setBezierHandles, type BezierHandles, type Comp, type Keyframe, type KeyPatch, type KeyRef, type Vec3 } from "../../core";
import { interpolationOf, resetBezierHandles, setInterpolation, type Interpolation } from "./animCommands";
import { useStudio } from "../state";
import { cur } from "./ops";
import { useStudioSel } from "./hooks";
import { ensureStyles } from "./styles";
import { r4, shiftRefs } from "./layout";
import { applyValueOp, describeOp, evalArithmetic, parseValueOp, scrubDelta, type ValueOp } from "./valueExpr";

interface Sel { ref: KeyRef; key: Keyframe }

/** "12.5" -> 12.5 ; "math.sin(query.anim_time*90)*5" -> that string (molang). Empty -> undefined. */
export function parseComp(text: string): Comp | undefined {
  const t = text.trim();
  if (!t) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : t;
}
export const compText = (c: Comp) => (typeof c === "number" ? String(+c.toFixed(4)) : c);

const ARGS_HINT = /Back|Elastic|Bounce|^step$/i;

export function EasingCurve({ name, args, w = 34, h = 18 }: { name?: string; args?: number[]; w?: number; h?: number }) {
  const d = useMemo(() => {
    const pts: string[] = [];
    const lo = -0.3, span = 1.6;
    for (let i = 0; i <= 28; i++) {
      const p = i / 28;
      const y = name === "catmullrom" ? p : applyEasing(name, p, args);
      pts.push(`${i ? "L" : "M"}${(2 + p * (w - 4)).toFixed(1)},${(h - 2 - ((y - lo) / span) * (h - 4)).toFixed(1)}`);
    }
    return pts.join("");
  }, [name, args, w, h]);
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ flex: "none" }}>
      <line x1={2} x2={w - 2} y1={h - 2 - (0.3 / 1.6) * (h - 4)} y2={h - 2 - (0.3 / 1.6) * (h - 4)} stroke="var(--border)" />
      <line x1={2} x2={w - 2} y1={h - 2 - (1.3 / 1.6) * (h - 4)} y2={h - 2 - (1.3 / 1.6) * (h - 4)} stroke="var(--border)" />
      <path d={d} fill="none" stroke="var(--accent)" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

function EasingPicker({ value, mixed, onPick }: { value: string; mixed: boolean; onPick: (n: string) => void }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!pos) return;
    const h = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest(".as-dd-pop") && e.target !== btn.current) setPos(null); };
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setPos(null); } };
    window.addEventListener("mousedown", h, true);
    window.addEventListener("keydown", k, true);
    return () => { window.removeEventListener("mousedown", h, true); window.removeEventListener("keydown", k, true); };
  }, [pos]);
  return (
    <div className="as-dd">
      <button
        ref={btn} data-testid="as-easing"
        onClick={() => { const r = btn.current!.getBoundingClientRect(); setPos({ x: Math.min(r.left, window.innerWidth - 240), y: Math.min(r.bottom + 2, window.innerHeight - 310) }); }}
      >
        {!mixed && <EasingCurve name={value} />}
        <span>{mixed ? "mixed" : value}</span>
        <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M3 5.5h10L8 11z" /></svg>
      </button>
      {pos && (
        <div className="as-dd-pop" style={{ left: pos.x, top: pos.y }}>
          {EASING_NAMES.map((n) => (
            <div key={n} className={"as-dd-item" + (n === value && !mixed ? " on" : "")} onClick={() => { onPick(n); setPos(null); }}>
              <EasingCurve name={n} /> <span>{n}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const AXES = ["X", "Y", "Z"];
type Scrub = (e: React.PointerEvent, axis: number) => void;
/** X/Y/Z fields of one channel. `count` = keys of this channel in the selection: with several, a plain number sets all of them and +/-/*// offsets each. */
function VecEditor({ label, vals, count, onOp, onScrub, dimAxes }: { label: string; vals: Array<Comp | null>; count: number; onOp: (axis: number, op: ValueOp) => void; onScrub: Scrub; dimAxes?: number[] }) {
  const [draft, setDraft] = useState<{ axis: number; text: string } | null>(null);
  const many = count > 1;
  const op = draft ? parseValueOp(draft.text, many) : undefined;
  return (
    <div>
      <div className="as-grid">
        <span className="as-hint" style={{ gridColumn: "1 / -1" }}>{label}{many ? ` · ${count} keys` : ""}</span>
        {vals.map((v, a) => (
          <CompField key={a} value={v} axis={a} dim={dimAxes?.includes(a)} many={many} onOp={(o) => onOp(a, o)} onScrub={onScrub} onDraft={(t) => setDraft(t === null ? null : { axis: a, text: t })} />
        ))}
      </div>
      {many && (
        <div className="as-hint as-multihint" data-testid="as-multihint">
          {draft && op ? describeOp(op, AXES[draft.axis], count) : "Type a number to set all · +5 -10 *1.5 /2 offset each key · drag X Y Z to scrub"}
        </div>
      )}
    </div>
  );
}
function CompField({ value, axis, many, onOp, onScrub, onDraft, dim }: { value: Comp | null; axis: number; dim?: boolean; many: boolean; onOp: (op: ValueOp) => void; onScrub: Scrub; onDraft: (t: string | null) => void }) {
  const shown = value === null ? "" : compText(value);
  const [t, setT] = useState<string | null>(null);
  const edit = (v: string | null) => { setT(v); onDraft(v); };
  const done = () => {
    const op = t === null ? undefined : parseValueOp(t, many);
    edit(null);
    if (op) onOp(op);
  };
  const col = axis === 0 ? "var(--nord11)" : axis === 1 ? "var(--nord14)" : "var(--nord9)";
  return (
    <div className={"as-axf" + (dim ? " aimed" : "")} style={dim ? { opacity: 0.45 } : undefined} title={dim ? AIMED_TIP : undefined} data-aimed={dim ? "1" : undefined}>
      <span className="as-scrub" data-testid={"as-scrub-" + "xyz"[axis]} style={{ color: col }} title="Drag to offset (⇧ fine, ⌥ coarse)" onPointerDown={(e) => onScrub(e, axis)}>{AXES[axis]}</span>
      <input
        className={"as-in num" + (value === null ? " mixed" : "")}
        style={{ borderLeft: `2px solid ${col}`, width: "100%" }}
        data-testid={"as-comp-" + "xyz"[axis]}
        value={t ?? shown} placeholder={value === null ? "mixed" : ""}
        title={typeof value === "string" ? `Molang: ${value} = ${evalMolang(value, { anim_time: 0 }).toFixed(3)} at t=0` : many ? "Number sets every key; +5 / -10 / *1.5 / /2 offset each key; =-10 sets a negative" : "Number or molang expression"}
        onChange={(e) => edit(e.target.value)} onBlur={done}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") { edit(null); (e.target as HTMLInputElement).blur(); } e.stopPropagation(); }}
      />
    </div>
  );
}

export function KeyframeInspector() {
  const api = useStudio();
  ensureStyles();
  const doc = useStudioSel((s) => s.doc);
  const animName = useStudioSel((s) => s.anim);
  const keys = useStudioSel((s) => s.keys);
  const clipInfo = useStudioSel((s) => (s.anim ? s.clipInfo[s.anim] : undefined));
  const sels: Sel[] = useMemo(() => {
    const a = doc && animName ? getAnimation(doc, animName) : undefined;
    if (!a) return [];
    return keys.flatMap((ref) => { const key = findKey(a, ref); return key ? [{ ref, key }] : []; });
  }, [doc, animName, keys]);

  if (!sels.length) {
    return <div className="as-insp"><div className="as-empty">No keyframe selected<span className="as-hint">Select keys in the timeline, or press Q to add one.</span></div></div>;
  }
  const patchEach = (fn: (k: Keyframe, ref: KeyRef) => KeyPatch | null, label: string) => {
    const c = cur(api);
    if (!c) return;
    let d = c.doc;
    for (const { ref, key } of sels) {
      const p = fn(key, ref);
      if (p) d = patchKeyframes(d, { anim: c.name, keys: [ref], patch: p });
    }
    if (d !== c.doc) api.commit(d, label);
  };
  const same = <T,>(f: (k: Keyframe) => T, eq: (a: T, b: T) => boolean = Object.is): T | null => {
    const first = f(sels[0].key);
    return sels.every((s) => eq(f(s.key), first)) ? first : null;
  };
  const vecOf = (which: "value" | "pre", ch: KeyRef["channel"]): Array<Comp | null> => [0, 1, 2].map((a) => {
    const vs = sels.filter((s) => s.ref.channel === ch).map((s) => (which === "pre" ? s.key.pre ?? s.key.value : s.key.value)[a]);
    return vs.every((v) => v === vs[0]) ? vs[0] : null;
  });
  /** typed op on one axis of one channel's keys: a plain number SETS it on each key, `+5`/`*1.5` offset each key's own value */
  const applyOp = (which: "value" | "pre", ch: KeyRef["channel"], axis: number, op: ValueOp) => {
    const c = cur(api);
    if (!c) return;
    const refs = sels.filter((s) => s.ref.channel === ch).map((s) => s.ref);
    const d = mapKeyValues(c.doc, { anim: c.name, keys: refs, channel: ch, which, map: (v, ctx) => (ctx.axis === axis ? applyValueOp(op, v) : v) });
    if (d !== c.doc) api.commit(d, op.kind === "set" ? "Edit Keyframe" : "Offset Keyframes");
  };
  /** drag the X/Y/Z tag: every selected key of the channel moves by the same delta, live; the whole scrub is one undo step */
  const startScrub = (e: React.PointerEvent, which: "value" | "pre", ch: KeyRef["channel"], axis: number) => {
    const c = cur(api);
    if (!c || e.button !== 0) return;
    e.preventDefault();
    const d0 = c.doc, name = c.name, x0 = e.clientX;
    const refs = sels.filter((s) => s.ref.channel === ch).map((s) => s.ref);
    let began = false;
    const move = (m: PointerEvent) => {
      const delta = scrubDelta(m.clientX - x0, ch, { shift: m.shiftKey, alt: m.altKey, ctrl: m.ctrlKey || m.metaKey });
      if (!began) { if (Math.abs(m.clientX - x0) < 2) return; began = true; api.beginGesture(); }
      api.commit(mapKeyValues(d0, { anim: name, keys: refs, channel: ch, which, map: (v, ctx) => (ctx.axis === axis ? addToComp(v, delta) : v) }), "Scrub Keyframes");
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", up); if (began) api.endGesture(); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };
  const patchAll = (patch: KeyPatch, label: string) => {
    const c = cur(api);
    if (c) api.commit(patchKeyframes(c.doc, { anim: c.name, keys: sels.map((s) => s.ref), patch }), label);
  };
  /** Time for many keys: shift the whole selection (keeps spacing). `+0.1` / `-0.05` = by that much, a plain number = the first key lands there. */
  const shiftSelection = (text: string) => {
    const c = cur(api);
    if (!c) return;
    const refs = sels.map((s) => s.ref);
    const min = Math.min(...refs.map((r) => r.time));
    const t = text.trim();
    const n = evalArithmetic(t);
    if (n === null) return;
    const delta = r4(Math.max(t[0] === "+" || t[0] === "-" ? n : n - min, -min));
    if (!delta) return;
    api.commit(moveKeyframes(c.doc, { anim: c.name, keys: refs, delta, anchor: api.store.get().anchorMode }), "Move Keyframes");
    api.store.set({ keys: shiftRefs(refs, delta) });
  };
  const allSplit = sels.every((s) => !!s.key.pre);
  const anySplit = sels.some((s) => !!s.key.pre);
  const CH_LABEL = { rotation: "Rotation", position: "Position", scale: "Scale" } as const;
  const easing = same((k) => (k.lerp === "catmullrom" ? "catmullrom" : k.easing ?? "linear"));
  const args = same((k) => (k.easingArgs ?? []).join(","));
  const interps = sels.map((q) => interpolationOf(q.key));
  const interp = interps.every((i) => i === interps[0]) ? interps[0] : null;
  const single = sels.length === 1 ? sels[0] : null;
  /** every selected key is on an aimed limb's rotation: pitch + yaw are code-driven in game */
  const aimedXY = (ch: string) => sels.length > 0 && sels.every((q) => channelUse(clipInfo, q.ref.bone, ch).aimedXY);
  const chans = [...new Set(sels.map((s) => s.ref.channel))];
  const bones = [...new Set(sels.map((s) => s.ref.bone))];
  return (
    <div className="as-insp" data-testid="as-inspector">
      <h4>Keyframe{sels.length > 1 ? `s (${sels.length})` : ""}</h4>
      <div className="as-hint" style={{ marginTop: -4 }}>
        {bones.length === 1 ? bones[0] : `${bones.length} bones`} · {chans.length === 1 ? chans[0] : "mixed channels"}
      </div>
      {single && (
        <div className="as-row">
          <label>Time</label>
          <TimeField value={single.ref.time} onCommit={(t) => { const c = cur(api); if (!c) return; api.commit(retimeKeyframe(c.doc, { anim: c.name, ...single.ref, newTime: t }), "Retime Keyframe"); api.store.set({ keys: [{ ...single.ref, time: t }] }); }} />
          <span className="as-hint">{Math.round(single.ref.time * 20)}t</span>
        </div>
      )}
      {sels.length > 1 && (
        <div className="as-row">
          <label>Time</label>
          <ShiftField value={Math.min(...sels.map((q) => q.ref.time))} onCommit={shiftSelection} />
          <span className="as-hint" title="Moves every selected key by the same amount; +0.1 / -0.05 shifts by that much">shifts all {sels.length}</span>
        </div>
      )}
      {(["rotation", "position", "scale"] as const).filter((ch) => chans.includes(ch)).map((ch) => {
        const n = sels.filter((q) => q.ref.channel === ch).length;
        return (
          <div key={ch} data-testid={`as-insp-${ch}`}>
            <VecEditor dimAxes={aimedXY(ch) ? [0, 1] : undefined} label={CH_LABEL[ch] + (allSplit ? " · post (value at and after the key)" : "")} vals={vecOf("value", ch)} count={n} onOp={(a, o) => applyOp("value", ch, a, o)} onScrub={(e, a) => startScrub(e, "value", ch, a)} />
            {allSplit && <VecEditor dimAxes={aimedXY(ch) ? [0, 1] : undefined} label={CH_LABEL[ch] + " · pre (value just before the key)"} vals={vecOf("pre", ch)} count={n} onOp={(a, o) => applyOp("pre", ch, a, o)} onScrub={(e, a) => startScrub(e, "pre", ch, a)} />}
          </div>
        );
      })}
      <label className="as-chk">
        <input type="checkbox" checked={allSplit} ref={(el) => { if (el) el.indeterminate = anySplit && !allSplit; }}
          onChange={(e) => patchEach((k) => (e.target.checked ? (k.pre ? null : { pre: [...k.value] as Vec3 }) : k.pre ? { clearPre: true } : null), e.target.checked ? "Split Keyframe Pre/Post" : "Merge Keyframe Pre/Post")} />
        Split pre / post
      </label>
      <h4>Interpolation</h4>
      <div className="as-seg" data-testid="as-lerp">
        {([["linear", "Linear"], ["catmullrom", "Catmull-Rom"], ["bezier", "Bezier"], ["step", "Step"]] as const).map(([id, lab]) => (
          <button key={id} className={interp === id ? "on" : ""} disabled={id === "bezier" && doc?.kind !== "bbmodel"}
            title={id === "bezier" ? (doc?.kind === "bbmodel" ? "Bezier curve with handles" : "Bezier is saved in .bbmodel only; Bedrock export bakes it (use Bake Animation)") : undefined}
            onClick={() => { void setInterpolation(api, id as Interpolation); }}>{lab}</button>
        ))}
      </div>
      {single && interp === "bezier" && doc?.kind === "bbmodel" && <BezierEditor anim={animName!} sel={single} />}
      <div className="as-row">
        <label>Easing</label>
        <EasingPicker value={easing ?? "linear"} mixed={easing === null} onPick={(n) => patchAll({ easing: n }, "Change Easing")} />
      </div>
      {easing !== null && easing !== "catmullrom" && (ARGS_HINT.test(easing) || args) && (
        <div className="as-row">
          <label>Args</label>
          <ArgsField value={args ?? ""} onCommit={(a) => patchAll({ easingArgs: a }, "Change Easing Args")} />
        </div>
      )}
      <div className="as-hint">{doc?.semantics === "player" ? "Player clips: the easing shapes the segment that leaves this key." : "The easing shapes the segment that ends at this key."}</div>
    </div>
  );
}

function BezierEditor({ anim, sel }: { anim: string; sel: Sel }) {
  const api = useStudio();
  const [axis, setAxis] = useState(0);
  const b: BezierHandles = sel.key.bezier ?? DEFAULT_BEZIER;
  const set = (patch: Partial<BezierHandles>) => {
    const c = cur(api);
    if (c) api.commit(setBezierHandles(c.doc, { anim, key: sel.ref, patch }), "Edit Bezier Handles");
  };
  const upd = (name: "leftTime" | "leftValue" | "rightTime" | "rightValue", v: number) => {
    const arr = [...b[name]] as [number, number, number];
    arr[axis] = v;
    set({ [name]: arr } as Partial<BezierHandles>);
  };
  const F = ({ label, name }: { label: string; name: "leftTime" | "leftValue" | "rightTime" | "rightValue" }) => (
    <div className="as-row"><label>{label}</label><NumInput value={b[name][axis]} onCommit={(v) => upd(name, v)} /></div>
  );
  return (
    <div data-testid="as-bezier" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div className="as-seg">{["X", "Y", "Z"].map((a, i) => <button key={a} className={axis === i ? "on" : ""} onClick={() => setAxis(i)}>{a}</button>)}</div>
      <F label="Left time" name="leftTime" /><F label="Left value" name="leftValue" />
      <F label="Right time" name="rightTime" /><F label="Right value" name="rightValue" />
      <label className="as-chk"><input type="checkbox" checked={b.linked} onChange={(e) => set({ linked: e.target.checked })} /> Linked handles</label>
      <button className="as-btn" style={{ alignSelf: "flex-start", padding: "0 10px" }} onClick={() => { void resetBezierHandles(api); }}>Reset handles</button>
    </div>
  );
}
function NumInput({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
  const [t, setT] = useState<string | null>(null);
  const done = () => { const v = parseFloat(t ?? ""); setT(null); if (Number.isFinite(v) && v !== value) onCommit(v); };
  return <input className="as-in num" style={{ width: 80 }} value={t ?? String(+value.toFixed(4))} onChange={(e) => setT(e.target.value)} onBlur={done} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); e.stopPropagation(); }} />;
}

function ArgsField({ value, onCommit }: { value: string; onCommit: (a: number[]) => void }) {
  const [t, setT] = useState<string | null>(null);
  const done = () => {
    const nums = (t ?? "").split(/[,\s]+/).filter(Boolean).map(Number);
    const ok = nums.every(Number.isFinite);
    setT(null);
    if (ok && nums.join(",") !== value) onCommit(nums);
  };
  return <input className="as-in num" style={{ flex: 1 }} placeholder="e.g. 1.2" value={t ?? value} onChange={(e) => setT(e.target.value)} onBlur={done} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); e.stopPropagation(); }} />;
}
function TimeField({ value, onCommit }: { value: number; onCommit: (t: number) => void }) {
  const [t, setT] = useState<string | null>(null);
  const done = () => {
    const v = parseFloat(t ?? "");
    setT(null);
    if (Number.isFinite(v) && v >= 0 && Math.abs(v - value) > 1e-6) onCommit(r4(v));
  };
  return <input className="as-in num" style={{ width: 80 }} value={t ?? String(+value.toFixed(4))} onChange={(e) => setT(e.target.value)} onBlur={done} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); e.stopPropagation(); }} />;
}

/** Time field for several keys: shows the first key's time; commits raw text (number = first key lands there, +x/-x = shift by x). */
function ShiftField({ value, onCommit }: { value: number; onCommit: (text: string) => void }) {
  const [t, setT] = useState<string | null>(null);
  const done = () => { const v = t; setT(null); if (v !== null && v.trim()) onCommit(v); };
  return <input className="as-in num" style={{ width: 80 }} data-testid="as-time-shift" value={t ?? String(+value.toFixed(4))} onChange={(e) => setT(e.target.value)} onBlur={done} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") { setT(null); (e.target as HTMLInputElement).blur(); } e.stopPropagation(); }} />;
}
