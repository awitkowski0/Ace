import { useEffect, useRef, useState } from "react";
import { perfRender } from "../perf";
import {
  CHANNELS, animLength, channelUse, evalMolang, getAnimation, moveKeyframes, offsetKeys, sampleChannel,
  type Animation, type ChannelName, type Doc, type KeyRef, type Keyframe,
} from "../../core";
import { useStudio } from "../state";
import { AXIS_NAMES, axisColor, channelLabel, fitCanvas, palette, triangle } from "./draw";
import { RULER_H, applyClick, clamp, dragDelta, fitView, hasKey, keyEq, mergeSel, r4, rulerTicks, shiftRefs, snapTick, timeToX, xToTime, zoomView, type View } from "./layout";
import { cur, setTime } from "./ops";
import { selectionLabel } from "./selection";
import { capture } from "./hooks";
import { useSurface } from "./useSurface";

const GL = 52; // value-axis gutter
interface VView { v0: number; pxPerUnit: number } // value at bottom edge
type Drag =
  | { k: "scrub" }
  | { k: "pan"; x: number; y: number; t0: number; v0: number }
  | { k: "box"; start: { x: number; y: number }; add: boolean; base: KeyRef[]; moved: boolean }
  | { k: "pt"; d0: Doc; anim: string; base: KeyRef[]; grab: KeyRef; axis: number; offT: number; startV: number; startX: number; startY: number; moved: boolean; additive: boolean; hit: KeyRef };

interface Curve { bone: string; channel: ChannelName }

/** Channels to show: those of the selected keys, else of the selected bones, else every animated channel. */
export function graphChannels(anim: Animation, bones: readonly string[], keys: readonly KeyRef[]): Curve[] {
  const out: Curve[] = [];
  const push = (bone: string, channel: ChannelName) => { if (anim.bones.get(bone)?.[channel] && !out.some((o) => o.bone === bone && o.channel === channel)) out.push({ bone, channel }); };
  if (bones.length) for (const b of bones) for (const c of CHANNELS) push(b, c);
  else if (keys.length) for (const k of keys) push(k.bone, k.channel);
  else for (const b of anim.bones.keys()) for (const c of CHANNELS) push(b, c);
  return out;
}
const num = (k: Keyframe, a: number, which: "value" | "pre" = "value") => {
  const v = (which === "pre" ? k.pre : undefined) ?? k.value;
  const c = v[a];
  return typeof c === "number" ? c : evalMolang(c, { anim_time: k.time });
};

/** Nice grid step for value axis. */
export function niceStep(pxPerUnit: number, minPx = 36): number {
  const raw = minPx / pxPerUnit;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}

export function GraphEditor() {
  perfRender("GraphEditor");
  const api = useStudio();
  const view = useRef<View>({ t0: -0.1, pxPerSec: 200 });
  const vv = useRef<VView>({ v0: -10, pxPerUnit: 4 });
  const drag = useRef<Drag | null>(null);
  const size = useRef({ w: 400, h: 200 });
  const lastAnim = useRef<string | null>(null);
  const fitReq = useRef(true);
  const hover = useRef<{ ref: KeyRef; axis: number } | null>(null);
  const box = useRef<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [empty, setEmpty] = useState(false);

  const v2y = (val: number) => size.current.h - (val - vv.current.v0) * vv.current.pxPerUnit;
  const y2v = (y: number) => (size.current.h - y) / vv.current.pxPerUnit + vv.current.v0;

  const fitAll = (anim: Animation, curves: Curve[], w: number, h: number) => {
    view.current = fitView(animLength(anim), w - GL);
    let lo = Infinity, hi = -Infinity;
    for (const c of curves) for (const k of anim.bones.get(c.bone)![c.channel]!.keys) for (let a = 0; a < 3; a++) { const v = num(k, a); lo = Math.min(lo, v); hi = Math.max(hi, v); }
    if (!isFinite(lo)) { lo = -1; hi = 1; }
    if (hi - lo < 1e-6) { lo -= 1; hi += 1; }
    const pad = (hi - lo) * 0.12;
    const bodyH = h - RULER_H;
    const ppu = bodyH / (hi - lo + 2 * pad);
    vv.current = { pxPerUnit: ppu, v0: lo - pad - (RULER_H * 0.5) / ppu };
  };

  const { canvasRef, schedule } = useSurface(() => {
    const cv = canvasRef.current;
    const f = cv && fitCanvas(cv);
    if (!f) return;
    const { ctx, w, h } = f;
    size.current = { w, h };
    const s = api.store.get();
    const P = palette();
    const c = cur(api);
    ctx.fillStyle = P.bg;
    ctx.fillRect(0, 0, w, h);
    if (!c) return;
    const curves = graphChannels(c.anim, s.bones, s.keys);
    setEmpty((e) => (e !== (curves.length === 0) ? curves.length === 0 : e));
    if (s.anim !== lastAnim.current || fitReq.current) {
      lastAnim.current = s.anim;
      fitReq.current = false;
      fitAll(c.anim, curves, w, h);
    }
    const v = view.current;
    const gw = w - GL;
    const len = animLength(c.anim);
    // ---- value grid
    ctx.save();
    ctx.beginPath(); ctx.rect(GL, RULER_H, gw, h - RULER_H); ctx.clip();
    const step = niceStep(vv.current.pxPerUnit);
    const vTop = y2v(RULER_H), vBot = y2v(h);
    ctx.font = `10px ${P.mono}`;
    ctx.lineWidth = 1;
    for (let q = Math.ceil(vBot / step); q * step <= vTop; q++) {
      const y = Math.round(v2y(q * step)) + 0.5;
      ctx.strokeStyle = q === 0 ? "rgba(139,149,168,.55)" : "rgba(97,110,136,.2)";
      ctx.beginPath(); ctx.moveTo(GL, y); ctx.lineTo(w, y); ctx.stroke();
    }
    const ticks = rulerTicks(v, gw);
    for (const t of ticks) {
      if (t.kind !== "major") continue;
      const x = GL + Math.round(t.x) + 0.5;
      ctx.strokeStyle = "rgba(97,110,136,.25)";
      ctx.beginPath(); ctx.moveTo(x, RULER_H); ctx.lineTo(x, h); ctx.stroke();
    }
    const lx = GL + timeToX(len, v);
    if (lx < w) { ctx.fillStyle = "rgba(20,24,32,.4)"; ctx.fillRect(Math.max(GL, lx), RULER_H, w, h); }
    // ---- curves
    const keyPts: Array<{ x: number; y: number; ref: KeyRef; axis: number; sel: boolean }> = [];
    const steps = Math.max(8, Math.ceil(gw / 2));
    for (const cu of curves) {
      const ch = c.anim.bones.get(cu.bone)![cu.channel]!;
      const tA = Math.max(0, xToTime(0, v)), tB = Math.min(len > 0 ? len : xToTime(gw, v), xToTime(gw, v));
      const cuse = channelUse(s.clipInfo[c.name], cu.bone, cu.channel);
      for (let a = 0; a < 3; a++) {
        ctx.beginPath();
        ctx.strokeStyle = axisColor(P, a);
        ctx.lineWidth = 1.5;
        // aimed limb: pitch (X) and yaw (Y) are code-driven in game, drawn faint
        ctx.globalAlpha = cuse.dim || (cuse.aimedXY && a < 2) ? 0.28 : 0.9;
        let started = false;
        const last = ch.keys.reduce((m, k) => Math.max(m, k.time), 0);
        const stop = Math.max(tB, Math.min(last, xToTime(gw, v)));
        for (let i = 0; i <= steps; i++) {
          const t = tA + ((stop - tA) * i) / steps;
          const val = sampleChannel(c.anim, cu.bone, cu.channel, t, { wrap: false });
          if (!val) continue;
          const x = GL + timeToX(t, v), y = v2y(val[a]);
          if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      // label at first key
      const k0 = ch.keys[0];
      if (k0) {
        ctx.font = `10px ${P.font}`;
        ctx.fillStyle = P.dim;
        ctx.textAlign = "left";
        ctx.fillText(`${cu.bone}.${channelLabel(cu.channel)}`, Math.max(GL + 4, GL + timeToX(k0.time, v) + 6), clamp(v2y(num(k0, 0)) - 8, RULER_H + 10, h - 4));
      }
      for (const k of ch.keys) {
        const ref = { bone: cu.bone, channel: cu.channel, time: k.time };
        const sel = hasKey(s.keys, ref);
        for (let a = 0; a < 3; a++) keyPts.push({ x: GL + timeToX(k.time, v), y: v2y(num(k, a)), ref, axis: a, sel });
      }
    }
    for (const p of keyPts) {
      if (p.x < GL - 6 || p.x > w + 6) continue;
      const hv = hover.current && keyEq(hover.current.ref, p.ref) && hover.current.axis === p.axis;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.sel || hv ? 4.5 : 3.5, 0, Math.PI * 2);
      ctx.fillStyle = p.sel ? "#fff" : axisColor(P, p.axis);
      ctx.fill();
      ctx.lineWidth = p.sel ? 1.5 : 1;
      ctx.strokeStyle = p.sel ? axisColor(P, p.axis) : P.borderStrong;
      ctx.stroke();
    }
    ctx.restore();
    // ---- value labels gutter
    ctx.fillStyle = P.bgChrome;
    ctx.fillRect(0, RULER_H, GL, h - RULER_H);
    ctx.fillStyle = P.dim;
    ctx.font = `10px ${P.mono}`;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let q = Math.ceil(vBot / step); q * step <= vTop; q++) {
      const y = v2y(q * step);
      if (y > RULER_H + 6 && y < h - 4) ctx.fillText(String(+(q * step).toPrecision(6)), GL - 5, y);
    }
    ctx.strokeStyle = P.borderStrong;
    ctx.beginPath(); ctx.moveTo(GL - 0.5, 0); ctx.lineTo(GL - 0.5, h); ctx.stroke();
    // ---- ruler
    ctx.fillStyle = P.bgChrome;
    ctx.fillRect(0, 0, w, RULER_H);
    ctx.beginPath(); ctx.moveTo(0, RULER_H - 0.5); ctx.lineTo(w, RULER_H - 0.5); ctx.stroke();
    ctx.save();
    ctx.beginPath(); ctx.rect(GL, 0, gw, RULER_H); ctx.clip();
    ctx.textBaseline = "alphabetic";
    for (const t of ticks) {
      const x = GL + Math.round(t.x) + 0.5;
      ctx.strokeStyle = t.kind === "major" ? P.dim : P.faint;
      const hh = t.kind === "major" ? 9 : t.kind === "minor" ? 5 : 3;
      ctx.beginPath(); ctx.moveTo(x, RULER_H - 1); ctx.lineTo(x, RULER_H - 1 - hh); ctx.stroke();
      if (t.label) { ctx.font = `${t.kind === "major" ? 11 : 9}px ${P.mono}`; ctx.fillStyle = t.kind === "major" ? P.fg : P.faint; ctx.textAlign = "left"; ctx.fillText(t.label, x + 3, t.kind === "major" ? 12 : 10); }
    }
    ctx.restore();
    // axis legend
    ctx.font = `600 10px ${P.font}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    for (let a = 0; a < 3; a++) { ctx.fillStyle = axisColor(P, a); ctx.fillText(AXIS_NAMES[a], 8 + a * 14, RULER_H / 2); }
    if (box.current) {
      const b = box.current;
      ctx.fillStyle = "rgba(136,192,208,.12)"; ctx.strokeStyle = P.accent; ctx.lineWidth = 1;
      ctx.fillRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
      ctx.strokeRect(b.x0 + 0.5, b.y0 + 0.5, b.x1 - b.x0, b.y1 - b.y0);
    }
    const selLabel = selectionLabel(s.keys.length);
    if (selLabel) { ctx.fillStyle = P.accent; ctx.font = `10px ${P.font}`; ctx.textAlign = "right"; ctx.textBaseline = "middle"; ctx.fillText(selLabel, w - 8, RULER_H / 2); }
    // playhead
    const px = GL + timeToX(s.time, v);
    if (px >= GL && px <= w) {
      ctx.strokeStyle = P.red; ctx.fillStyle = P.red;
      ctx.beginPath(); ctx.moveTo(Math.round(px) + 0.5, RULER_H - 2); ctx.lineTo(Math.round(px) + 0.5, h); ctx.stroke();
      triangle(ctx, px, RULER_H - 9, 11, 8, true); ctx.fill();
    }
  });

  useEffect(() => api.store.subscribe(schedule), [api, schedule]);

  const local = (e: { clientX: number; clientY: number }) => { const r = canvasRef.current!.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const pickPoint = (x: number, y: number): { ref: KeyRef; axis: number } | null => {
    const c = cur(api);
    if (!c) return null;
    const s = api.store.get();
    let best: { ref: KeyRef; axis: number; d: number } | null = null;
    for (const cu of graphChannels(c.anim, s.bones, s.keys)) {
      for (const k of c.anim.bones.get(cu.bone)![cu.channel]!.keys) {
        const px = GL + timeToX(k.time, view.current);
        if (Math.abs(px - x) > 8) continue;
        for (let a = 0; a < 3; a++) {
          const d = Math.hypot(px - x, v2y(num(k, a)) - y);
          if (d <= 8 && (!best || d < best.d)) best = { ref: { bone: cu.bone, channel: cu.channel, time: k.time }, axis: a, d };
        }
      }
    }
    return best;
  };

  const onDown = (e: React.PointerEvent) => {
    const p = local(e);
    const cv = canvasRef.current!;
    const c = cur(api);
    if (e.button === 1) { capture(cv, e.pointerId); drag.current = { k: "pan", x: p.x, y: p.y, t0: view.current.t0, v0: vv.current.v0 }; return; }
    if (e.button !== 0 || !c) return;
    capture(cv, e.pointerId);
    if (p.y < RULER_H && p.x >= GL) {
      api.store.set({ playing: false });
      drag.current = { k: "scrub" };
      const t = xToTime(p.x - GL, view.current);
      setTime(api, api.store.get().snapTicks && !e.shiftKey ? snapTick(t) : r4(t));
      return;
    }
    const hit = pickPoint(p.x, p.y);
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    if (hit) {
      const sel = api.store.get().keys;
      const next = applyClick(sel, [hit.ref], additive);
      api.store.set({ keys: next });
      if (additive && !hasKey(next, hit.ref)) return;
      const k = c.anim.bones.get(hit.ref.bone)![hit.ref.channel]!.keys.find((q) => Math.abs(q.time - hit.ref.time) < 0.0005)!;
      drag.current = {
        k: "pt", d0: c.doc, anim: c.name, base: next, grab: hit.ref, axis: hit.axis,
        offT: xToTime(p.x - GL, view.current) - hit.ref.time, startV: num(k, hit.axis), startX: p.x, startY: p.y, moved: false, additive, hit: hit.ref,
      };
      return;
    }
    // empty-area drag = box select (⇧/⌘ keeps the previous selection); middle mouse pans
    drag.current = { k: "box", start: { x: p.x, y: p.y }, add: additive, base: additive ? api.store.get().keys : [], moved: false };
  };

  const onMove = (e: React.PointerEvent) => {
    const p = local(e);
    const d = drag.current;
    if (!d) {
      const h = pickPoint(p.x, p.y);
      const changed = (h?.axis !== hover.current?.axis) || (h && hover.current ? !keyEq(h.ref, hover.current.ref) : !!h !== !!hover.current);
      hover.current = h;
      canvasRef.current!.style.cursor = h ? "pointer" : p.y < RULER_H ? "col-resize" : "default";
      if (changed) schedule();
      return;
    }
    if (d.k === "scrub") {
      const t = xToTime(p.x - GL, view.current);
      setTime(api, api.store.get().snapTicks && !e.shiftKey ? snapTick(t) : r4(t));
    } else if (d.k === "pan") {
      view.current = { ...view.current, t0: d.t0 - (p.x - d.x) / view.current.pxPerSec };
      vv.current = { ...vv.current, v0: d.v0 + (p.y - d.y) / vv.current.pxPerUnit };
      schedule();
    } else if (d.k === "box") {
      if (!d.moved && Math.hypot(p.x - d.start.x, p.y - d.start.y) < 3) return;
      d.moved = true;
      const r = { x0: Math.min(d.start.x, p.x), y0: Math.min(d.start.y, p.y), x1: Math.max(d.start.x, p.x), y1: Math.max(d.start.y, p.y) };
      box.current = r;
      const c2 = cur(api);
      if (c2) {
        const inside: KeyRef[] = [];
        for (const cu of graphChannels(c2.anim, api.store.get().bones, d.base)) {
          for (const k of c2.anim.bones.get(cu.bone)![cu.channel]!.keys) {
            const px = GL + timeToX(k.time, view.current);
            if (px < r.x0 || px > r.x1) continue;
            if ([0, 1, 2].some((a) => { const y = v2y(num(k, a)); return y >= r.y0 && y <= r.y1; })) inside.push({ bone: cu.bone, channel: cu.channel, time: k.time });
          }
        }
        api.store.set({ keys: d.add ? mergeSel(d.base, inside) : inside });
      }
      schedule();
    } else if (d.k === "pt") {
      if (!d.moved && Math.hypot(p.x - d.startX, p.y - d.startY) < 3) return;
      if (!d.moved) { d.moved = true; api.beginGesture(); }
      const lockV = e.shiftKey && Math.abs(p.y - d.startY) > Math.abs(p.x - d.startX);
      const lockT = e.shiftKey && !lockV;
      const snap = api.store.get().snapTicks;
      const minT = Math.min(...d.base.map((b) => b.time));
      const dt = lockV ? 0 : dragDelta(d.grab.time, d.offT, xToTime(p.x - GL, view.current), snap, minT);
      const dv = lockT ? 0 : Math.round((y2v(p.y) - d.startV) * 1000) / 1000;
      let doc = dt ? moveKeyframes(d.d0, { anim: d.anim, keys: d.base, delta: dt, anchor: api.store.get().anchorMode }) : d.d0;
      if (dv) {
        // every selected key (any bone/channel) moves by the same value delta on the grabbed axis
        const vec = [0, 0, 0]; vec[d.axis] = dv;
        doc = offsetKeys(doc, { anim: d.anim, keys: shiftRefs(d.base, dt), delta: { rotation: vec, position: vec, scale: vec } });
      }
      api.commit(doc, "Edit Keyframe Curve");
      api.store.set({ keys: shiftRefs(d.base, dt) });
    }
  };

  const onUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    try { canvasRef.current?.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (d?.k === "box") {
      box.current = null;
      if (!d.moved && !d.add) api.store.set({ keys: [] });
      schedule();
    }
    if (d?.k === "pt") {
      if (d.moved) api.endGesture();
      else if (!d.additive) api.store.set({ keys: [d.hit] });
    }
  };

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const h = (e: WheelEvent) => {
      e.preventDefault();
      const r = cv.getBoundingClientRect();
      const x = e.clientX - r.left - GL, y = e.clientY - r.top;
      if (e.ctrlKey || e.metaKey) {
        const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018));
        if (e.altKey) { const val = y2v(y); const ppu = clamp(vv.current.pxPerUnit * f, 0.01, 4000); vv.current = { pxPerUnit: ppu, v0: val - (size.current.h - y) / ppu }; }
        else view.current = zoomView(view.current, f, x);
      } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) view.current = { ...view.current, t0: view.current.t0 + (e.deltaX || e.deltaY) / view.current.pxPerSec };
      else vv.current = { ...vv.current, v0: vv.current.v0 - e.deltaY / vv.current.pxPerUnit };
      schedule();
    };
    cv.addEventListener("wheel", h, { passive: false });
    const fit = () => { fitReq.current = true; schedule(); };
    window.addEventListener("animstudio:fit", fit);
    return () => { cv.removeEventListener("wheel", h); window.removeEventListener("animstudio:fit", fit); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasRef, schedule]);

  return (
    <div className="as-canvas-wrap" data-testid="as-graph" tabIndex={-1} style={{ outline: "none" }}>
      <canvas ref={canvasRef} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={() => { hover.current = null; schedule(); }} />
      {empty && <div className="as-empty" style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>Nothing to graph: this animation has no keyframes yet.</div>}
    </div>
  );
}
void keyEq;
