import { useEffect, useRef, useState } from "react";
import { perfRender } from "../perf";
import {
  CHANNELS, addKeyframe, animLength, deleteKeyframes, getAnimation, insertKeys, AIMED_TIP, channelUse, moveKeyframes, setLength, sortedKeys,
  type Animation, type Doc, type KeyRef, type Keyframe,
} from "../../core";
import { showContextMenu } from "../../../shell/contextMenu";
import { runAction } from "../../../../actions/registry";
import { toolsStore } from "../toolsUi";
import { useStudio, type StudioApi } from "../state";
import {
  LABEL_W, RULER_H, TICK, applyClick, buildRows, clamp, dragDelta, fitView, hasKey, hitKeys, keyEq,
  keysInRect, mergeSel, normRect, r4, rowAt, rowKeys, rowTimes, rulerTicks, shiftRefs, snapTick, timeToX, visibleRows, xToTime, zoomView,
  type Rect, type Row, type View,
} from "./layout";
import { channelColor, channelLabel, drawKey, fitCanvas, keyStyle, palette, triangle } from "./draw";
import { cur, deleteSelectedKeys, setTime } from "./ops";
import { keysInTimeRange, selectRowKeys, selectionLabel, toggleKeys } from "./selection";
import { rowSelectionState, selBadgeTip, toggleRowKeys } from "./rowSelection"; // == selection badge ==
import { badgeSpan, drawSelBadge, drawnBadges } from "./selBadge"; // == selection badge ==
import { addMarkerAtPlayhead, deleteMarkerAt, markersOf, moveMarkerTo, type MarkerView } from "./animCommands";
import { capture } from "./hooks";
import { useSurface } from "./useSurface";

type Drag =
  | { k: "scrub" }
  | { k: "length"; d0: Doc; anim: string; began: boolean }
  | { k: "keys"; d0: Doc; anim: string; base: KeyRef[]; grab: KeyRef; offset: number; startX: number; moved: boolean; dup: boolean; additive: boolean; minT: number; hit: KeyRef[]; stretch: boolean; mid: boolean; toggle: boolean }
  | { k: "range"; t0: number; add: boolean; base: KeyRef[] }
  | { k: "marker"; m: MarkerView; began: boolean }
  | { k: "box"; start: { x: number; y: number }; add: boolean; base: KeyRef[]; moved: boolean }
  | { k: "pan"; x: number; y: number; t0: number; sy: number };


export function DopeSheet() {
  perfRender("DopeSheet");
  const api = useStudio();
  const wrapRef = useRef<HTMLDivElement>(null);
  const view = useRef<View>({ t0: -0.05, pxPerSec: 200 });
  const scrollY = useRef(0);
  /** Bones the user expanded (Blockbench: one row per bone, channels collapsed by default). */
  const expanded = useRef(new Set<string>());
  const rowsCache = useRef<{ anim?: Animation; ver: number; rows: Row[]; height: number }>({ ver: -1, rows: [], height: 0 });
  const ver = useRef(0);
  const drag = useRef<Drag | null>(null);
  const box = useRef<Rect | null>(null);
  const rangeSel = useRef<[number, number] | null>(null);
  const hover = useRef<{ keys?: KeyRef[]; bone?: string; cursor: string }>({ cursor: "default" });
  const lastAnim = useRef<string | null>(null);
  /** the auto-fit view and the width it was fitted to: while the user has not zoomed / panned, a changed canvas width (panel layout settling) re-fits */
  const autoFit = useRef<{ v: unknown; gw: number } | null>(null);
  const size = useRef({ w: 400, h: 200 });
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const tools = toolsStore(api);

  const rowsOf = (anim: Animation | undefined) => {
    const c = rowsCache.current;
    if (c.anim !== anim || c.ver !== ver.current) {
      const collapsed = new Set(anim ? [...anim.bones.keys()].filter((n) => !expanded.current.has(n)) : []);
      const b = buildRows(anim, collapsed);
      rowsCache.current = { anim, ver: ver.current, rows: b.rows, height: b.height };
    }
    return rowsCache.current;
  };

  // ------------------------------------------------------------ drawing
  const { canvasRef, schedule } = useSurface(() => {
    const cv = canvasRef.current;
    const f = cv && fitCanvas(cv);
    if (!f) return;
    const { ctx, w, h } = f;
    size.current = { w, h };
    const s = api.store.get();
    const P = palette();
    const anim = s.doc && s.anim ? cur(api)?.anim : undefined;
    const { rows, height } = rowsOf(anim);
    const gw = w - LABEL_W;
    // new animation -> fit
    if (s.anim !== lastAnim.current || (autoFit.current && view.current === autoFit.current.v && Math.abs(gw - autoFit.current.gw) > 2)) {
      const fresh = s.anim !== lastAnim.current;
      lastAnim.current = s.anim;
      view.current = fitView(anim ? animLength(anim) : 1, gw);
      autoFit.current = { v: view.current, gw };
      if (fresh) scrollY.current = 0;
    }
    const v = view.current;
    const bodyH = h - RULER_H;
    scrollY.current = clamp(scrollY.current, 0, Math.max(0, height - bodyH));
    const sy = scrollY.current;
    // keep playhead visible while playing
    if (s.playing) {
      const px = timeToX(s.time, v);
      if (px < 0 || px > gw) view.current = { ...v, t0: s.time - 20 / v.pxPerSec };
    }
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = P.bg;
    ctx.fillRect(0, 0, w, h);
    if (!anim) {
      ctx.fillStyle = P.dim;
      ctx.font = `12px ${P.font}`;
      ctx.textAlign = "center";
      ctx.fillText(s.doc ? "Select an animation" : "No document", w / 2, h / 2);
      return;
    }
    const len = animLength(anim);
    const clipInfo = s.clipInfo[anim.name];
    const problems = s.problems.filter((p) => p.anim === anim.name);
    const [r0, r1] = visibleRows(rows, sy, sy + bodyH);
    const ticks = rulerTicks(v, gw);

    // ---- grid area (clipped)
    ctx.save();
    ctx.beginPath();
    ctx.rect(LABEL_W, RULER_H, gw, bodyH);
    ctx.clip();
    ctx.translate(LABEL_W, RULER_H - sy);
    for (let i = r0; i < r1; i++) {
      const r = rows[i];
      // no row borders: a faint stripe on every other row (Blockbench), channel rows slightly darker, selected bones tinted
      ctx.fillStyle = r.kind === "channel" ? "rgba(0,0,0,.10)" : i % 2 ? "rgba(255,255,255,.018)" : "transparent";
      ctx.fillRect(0, r.y, gw, r.h);
      if (s.bones.includes(r.bone)) { ctx.fillStyle = "rgba(136,192,208,.06)"; ctx.fillRect(0, r.y, gw, r.h); }
    }
    // vertical grid
    ctx.lineWidth = 1;
    for (const t of ticks) {
      if (t.kind === "tick") continue;
      if (t.kind !== "major") continue;
      ctx.strokeStyle = "rgba(97,110,136,.2)";
      const x = Math.round(t.x) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, sy); ctx.lineTo(x, sy + bodyH); ctx.stroke();
    }
    // beyond-length shade
    const lx = timeToX(len, v);
    if (lx < gw) { ctx.fillStyle = "rgba(20,24,32,.45)"; ctx.fillRect(Math.max(0, lx), sy, gw - Math.max(0, lx), bodyH); }
    // keys
    const tMin = xToTime(-12, v);
    const tMax = xToTime(gw + 12, v);
    const selKeys = s.keys;
    const dragging = drag.current?.k === "keys" && drag.current.moved;
    for (let i = r0; i < r1; i++) {
      const r = rows[i];
      const cy = r.y + r.h / 2;
      const dim = r.kind === "channel" && channelUse(clipInfo, r.bone, r.channel!).dim;
      if (r.kind === "channel") {
        const keys = sortedKeys(anim.bones.get(r.bone)![r.channel!]!);
        // hold bars between equal-valued neighbours
        for (let j = 0; j + 1 < keys.length; j++) {
          const a = keys[j], b = keys[j + 1];
          if (b.time < tMin || a.time > tMax) continue;
          if (sameVec(a.value, b.pre ?? b.value) && !b.pre) {
            ctx.fillStyle = dim ? "rgba(139,149,168,.08)" : "rgba(139,149,168,.18)";
            ctx.fillRect(timeToX(a.time, v), cy - 1, timeToX(b.time, v) - timeToX(a.time, v), 2);
          }
        }
        for (const k of keys) {
          if (k.time < tMin || k.time > tMax) continue;
          const x = timeToX(k.time, v);
          const ref = { bone: r.bone, channel: r.channel!, time: k.time };
          const isSel = hasKey(selKeys, ref);
          const hv = !!hover.current.keys?.some((q) => keyEq(q, ref));
          drawKey(ctx, P, { x, y: cy, style: keyStyle(P, k), selected: isSel, hover: hv, dim: dim && !isSel, r: dragging && isSel ? 5.5 : 4.5 });
        }
      } else {
        const times = rowTimes(anim, r);
        for (const t of times) {
          if (t < tMin || t > tMax) continue;
          const refs = rowKeys(anim, r).filter((q) => Math.abs(q.time - t) < 0.0005);
          const isSel = refs.every((q) => hasKey(selKeys, q));
          const some = refs.some((q) => hasKey(selKeys, q));
          const hv = !!hover.current.keys?.some((q) => refs.some((z) => keyEq(q, z)));
          const first = anim.bones.get(r.bone)![refs[0].channel]!.keys.find((k) => Math.abs(k.time - t) < 0.0005)!;
          const st = keyStyle(P, first);
          // a merged bone key takes its channel's colour when only one channel has a key there, else a neutral tone
          const one = refs.every((q) => q.channel === refs[0].channel);
          drawKey(ctx, P, { x: timeToX(t, v), y: cy, style: { ...st, color: one ? channelColor(P, refs[0].channel) : P.dim }, selected: isSel || some, hover: hv, r: 4.5 });
        }
      }
    }
    // ghost (noise preview)
    const ghost = tools.get().ghost;
    if (ghost) {
      for (const g of ghost) {
        let row = rows.find((r) => r.bone === g.bone && r.kind === "channel" && r.channel === g.channel);
        if (!row) row = rows.find((r) => r.bone === g.bone && r.kind === "bone");
        if (!row) continue;
        const x = timeToX(g.key.time, v);
        if (x < -10 || x > gw + 10) continue;
        drawKey(ctx, P, { x, y: row.y + row.h / 2, style: keyStyle(P, g.key), ghost: true, r: 5 });
      }
    }
    // problem marks on rows
    for (const p of problems) {
      if (p.time === undefined || !p.bone) continue;
      const row = rows.find((r) => r.bone === p.bone && (p.channel ? r.kind === "channel" && r.channel === p.channel : r.kind === "bone"));
      if (!row) continue;
      ctx.fillStyle = p.severity === "error" ? P.red : P.yellow;
      ctx.globalAlpha = 0.7; ctx.fillRect(timeToX(p.time, v) - 3, row.y + row.h - 2, 6, 1.5); ctx.globalAlpha = 1;
    }
    // time-range selection band (⇧-drag in the ruler)
    if (rangeSel.current) {
      const [ra, rb] = rangeSel.current;
      ctx.fillStyle = "rgba(136,192,208,.10)";
      ctx.fillRect(timeToX(Math.min(ra, rb), v), sy, Math.abs(timeToX(rb, v) - timeToX(ra, v)), bodyH);
    }
    // box
    if (box.current) {
      const b = box.current;
      ctx.fillStyle = "rgba(136,192,208,.12)";
      ctx.strokeStyle = P.accent;
      ctx.lineWidth = 1;
      ctx.fillRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
      ctx.strokeRect(b.x0 + 0.5, b.y0 + 0.5, b.x1 - b.x0, b.y1 - b.y0);
    }
    ctx.restore();

    // ---- label column
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, RULER_H, LABEL_W, bodyH);
    ctx.clip();
    ctx.translate(0, RULER_H - sy);
    ctx.fillStyle = P.bgChrome;
    ctx.fillRect(0, sy, LABEL_W, bodyH);
    ctx.textBaseline = "middle";
    const info = s.anim ? s.clipInfo[s.anim] : undefined;
    drawnBadges.clear(); // == selection badge ==
    for (let i = r0; i < r1; i++) {
      const r = rows[i];
      const cy = r.y + r.h / 2;
      const selBone = s.bones.includes(r.bone);
      if (selBone) { ctx.fillStyle = "rgba(136,192,208,.10)"; ctx.fillRect(0, r.y, LABEL_W, r.h); }
      else if (r.kind === "bone" && hover.current.bone === r.bone) { ctx.fillStyle = "rgba(255,255,255,.04)"; ctx.fillRect(0, r.y, LABEL_W, r.h); }
      if (r.kind === "bone") {
        const open = expanded.current.has(r.bone);
        ctx.fillStyle = P.dim;
        ctx.beginPath();
        if (open) { ctx.moveTo(6, cy - 2.5); ctx.lineTo(14, cy - 2.5); ctx.lineTo(10, cy + 3); } else { ctx.moveTo(8, cy - 4); ctx.lineTo(13, cy); ctx.lineTo(8, cy + 4); }
        ctx.closePath(); ctx.fill();
        ctx.font = `12px ${P.font}`;
        ctx.fillStyle = selBone ? P.accent : P.fg;
        ctx.textAlign = "left";
        const aimed = info?.aimed.some((a) => boneOfAim(a) === r.bone);
        const bp = problems.filter((p) => p.bone === r.bone);
        const hov = hover.current.bone === r.bone;
        // == selection badge == ("all 9" / "3/9": every / some keys of this bone selected; click toggles)
        const sbSel = rowSelectionState(s.keys, anim, r);
        const sbX = drawSelBadge(ctx, P, sbSel, cy);
        const sbW = sbSel.state === "none" ? 0 : LABEL_W - 6 - sbX + 4;
        if (sbSel.state === "all") { ctx.fillStyle = P.accentBg; ctx.fillRect(0, r.y + 3, 2, r.h - 6); }
        if (sbSel.state !== "none") drawnBadges.set(r.bone, sbSel.state === "all" ? `all ${sbSel.total}` : `${sbSel.selected}/${sbSel.total}`);
        ctx.fillStyle = selBone ? P.accent : P.fg;
        const maxW = LABEL_W - 24 - sbW - (aimed && hov ? 18 : aimed ? 8 : 0) - (bp.length ? 12 : 0);
        ctx.fillText(ellipsize(ctx, r.bone, maxW), 20, cy + 0.5);
        let bx = LABEL_W - 8 - sbW;
        if (bp.length) {
          bx -= 4;
          ctx.fillStyle = bp.some((p) => p.severity === "error") ? P.red : P.yellow;
          ctx.globalAlpha = 0.8;
          ctx.beginPath(); ctx.arc(bx, cy, 2.5, 0, Math.PI * 2); ctx.fill();
          ctx.globalAlpha = 1;
          bx -= 8;
        }
        // aimed limb: the crosshair shows on hover, a subtle dot otherwise
        if (aimed && hov) drawAimBadge(ctx, P, bx - 14, cy);
        else if (aimed) { ctx.fillStyle = P.yellow; ctx.globalAlpha = 0.45; ctx.beginPath(); ctx.arc(bx - 3, cy, 2, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1; }
      } else {
        const cu = channelUse(info, r.bone, r.channel!);
        const dim = cu.dim;
        ctx.globalAlpha = dim ? 0.45 : cu.aimedXY ? 0.7 : 1;
        ctx.fillStyle = channelColor(P, r.channel);
        ctx.beginPath(); ctx.arc(26, cy, 3, 0, Math.PI * 2); ctx.fill();
        ctx.font = `12px ${P.font}`;
        ctx.fillStyle = P.fg;
        ctx.textAlign = "left";
        ctx.fillText(channelLabel(r.channel!), 36, cy + 0.5);
        if (cu.aimedXY) {
          // aimed limb: pitch + yaw are code-driven in game, only roll is the animator's
          const lw = ctx.measureText(channelLabel(r.channel!)).width;
          ctx.fillStyle = P.yellow;
          ctx.globalAlpha = 0.75;
          ctx.fillText("· roll", 36 + lw + 5, cy + 0.5);
          ctx.fillStyle = P.fg;
        }
        ctx.globalAlpha = 1;
        // == selection badge ==
        const sbc = rowSelectionState(s.keys, anim, r);
        if (sbc.state !== "none") { drawSelBadge(ctx, P, sbc, cy, true); drawnBadges.set(r.bone + ":" + r.channel, sbc.state === "all" ? `all ${sbc.total}` : `${sbc.selected}/${sbc.total}`); }
      }
    }
    ctx.restore();
    ctx.strokeStyle = P.border;
    ctx.beginPath(); ctx.moveTo(LABEL_W - 0.5, 0); ctx.lineTo(LABEL_W - 0.5, h); ctx.stroke();

    // ---- ruler
    ctx.fillStyle = P.bgChrome;
    ctx.fillRect(0, 0, w, RULER_H);
    ctx.strokeStyle = P.border;
    ctx.beginPath(); ctx.moveTo(0, RULER_H - 0.5); ctx.lineTo(w, RULER_H - 0.5); ctx.stroke();
    ctx.save();
    ctx.beginPath(); ctx.rect(LABEL_W, 0, gw, RULER_H); ctx.clip();
    ctx.translate(LABEL_W, 0);
    ctx.fillStyle = "rgba(20,24,32,.35)";
    if (lx < gw) ctx.fillRect(Math.max(0, lx), 0, gw - Math.max(0, lx), RULER_H - 1);
    ctx.textBaseline = "alphabetic";
    for (const t of ticks) {
      const x = Math.round(t.x) + 0.5;
      ctx.strokeStyle = t.kind === "major" ? P.faint : "rgba(97,110,136,.55)";
      const hh = t.kind === "major" ? 6 : t.kind === "minor" ? 3 : 3;
      ctx.beginPath(); ctx.moveTo(x, RULER_H - 1); ctx.lineTo(x, RULER_H - 1 - hh); ctx.stroke();
      if (t.label) {
        ctx.font = `${t.kind === "major" ? 10 : 9}px ${P.mono}`;
        ctx.fillStyle = t.kind === "major" ? P.dim : P.faint;
        ctx.textAlign = "left";
        ctx.fillText(t.label, x + 3, t.kind === "major" ? 11 : 10);
      }
    }
    if (rangeSel.current) {
      const [ra, rb] = rangeSel.current;
      ctx.fillStyle = "rgba(136,192,208,.22)";
      ctx.fillRect(timeToX(Math.min(ra, rb), v), 0, Math.abs(timeToX(rb, v) - timeToX(ra, v)), RULER_H - 1);
    }
    // problem gutter marks
    for (const p of problems) {
      if (p.time === undefined) continue;
      const x = timeToX(p.time, v);
      ctx.fillStyle = p.severity === "error" ? P.red : P.yellow;
      ctx.globalAlpha = 0.75;
      triangle(ctx, x, RULER_H - 5, 5, 4, false);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    // timeline markers (⌘M): flags on the ruler, full-height hairline in the grid
    const mcol = [P.green, P.yellow, P.orange, P.red, P.purple, P.blue, P.cyan, P.fg];
    for (const m of markersOf(api)) {
      const mx = timeToX(m.time, v);
      if (mx < -8 || mx > gw + 8) continue;
      ctx.fillStyle = ctx.strokeStyle = mcol[m.color % mcol.length];
      ctx.globalAlpha = 0.35; ctx.beginPath(); ctx.moveTo(Math.round(mx) + 0.5, RULER_H); ctx.lineTo(Math.round(mx) + 0.5, h); ctx.stroke(); ctx.globalAlpha = 1;
      ctx.beginPath(); ctx.moveTo(mx - 4, RULER_H - 10); ctx.lineTo(mx + 4, RULER_H - 10); ctx.lineTo(mx + 4, RULER_H - 5); ctx.lineTo(mx, RULER_H - 1); ctx.lineTo(mx - 4, RULER_H - 5); ctx.closePath(); ctx.fill();
    }
    // length handle
    ctx.strokeStyle = P.accent;
    ctx.fillStyle = P.accent;
    ctx.globalAlpha = 0.7;
    ctx.beginPath(); ctx.moveTo(Math.round(lx) + 0.5, 0); ctx.lineTo(Math.round(lx) + 0.5, RULER_H); ctx.stroke();
    ctx.fillRect(lx, 0, 6, 4);
    ctx.globalAlpha = 1;
    ctx.restore();
    ctx.fillStyle = P.bgChrome;
    ctx.fillRect(0, 0, LABEL_W - 1, RULER_H - 1);
    ctx.fillStyle = P.dim;
    ctx.font = `11px ${P.font}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    const selLabel = selectionLabel(s.keys.length);
    ctx.fillText(anim.name.replace(/^animation\./, ""), 10, RULER_H / 2, selLabel ? LABEL_W - 98 : LABEL_W - 20);
    if (selLabel) {
      ctx.fillStyle = P.accent;
      ctx.textAlign = "right";
      ctx.fillText(selLabel, LABEL_W - 8, RULER_H / 2, 90);
    }

    // ---- playhead
    const px = LABEL_W + timeToX(s.time, v);
    if (px >= LABEL_W - 1 && px <= w) {
      ctx.save();
      ctx.beginPath(); ctx.rect(LABEL_W, 0, gw, h); ctx.clip();
      ctx.strokeStyle = P.red;
      ctx.fillStyle = P.red;
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.85; ctx.beginPath(); ctx.moveTo(Math.round(px) + 0.5, RULER_H - 2); ctx.lineTo(Math.round(px) + 0.5, h); ctx.stroke(); ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.moveTo(px - 5, 2); ctx.lineTo(px + 5, 2); ctx.lineTo(px + 5, 9); ctx.lineTo(px, RULER_H - 2); ctx.lineTo(px - 5, 9); ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  });

  // redraw on any store change
  useEffect(() => {
    const a = api.store.subscribe(schedule);
    const b = tools.subscribe(schedule);
    return () => { a(); b(); };
  }, [api, tools, schedule]);

  // ------------------------------------------------------------ interaction helpers
  const local = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const ctxInfo = () => {
    const c = cur(api);
    const { rows, height } = rowsOf(c?.anim);
    return { c, rows, height };
  };
  const gridPt = (p: { x: number; y: number }) => ({ gx: p.x - LABEL_W, gy: p.y - RULER_H + scrollY.current });
  /** Ctrl / ⌘ disables tick snapping (Blockbench: ruler scrub, marker and key drags). */
  const snapOn = (e: { ctrlKey: boolean; metaKey: boolean }) => api.store.get().snapTicks && !(e.ctrlKey || e.metaKey);
  const scrubTo = (x: number, snap: boolean) => {
    const t = xToTime(x - LABEL_W, view.current);
    setTime(api, snap ? snapTick(t) : r4(t));
  };

  const hitLength = (x: number, y: number, len: number) => y < RULER_H && Math.abs(x - LABEL_W - timeToX(len, view.current)) <= 5;

  const onPointerDown = (e: React.PointerEvent) => {
    wrapRef.current?.focus({ preventScroll: true });
    const p = local(e);
    const { c, rows } = ctxInfo();
    const cv = canvasRef.current!;
    if (e.button === 1) {
      capture(cv, e.pointerId);
      drag.current = { k: "pan", x: p.x, y: p.y, t0: view.current.t0, sy: scrollY.current };
      return;
    }
    if (e.button !== 0) return;
    capture(cv, e.pointerId);
    const additive = e.shiftKey || ((e.metaKey || e.ctrlKey) && p.x < LABEL_W);
    const stretch = (e.ctrlKey || e.metaKey) && !e.shiftKey;
    if (p.y < RULER_H) {
      if (p.x < LABEL_W) return;
      if (c && hitLength(p.x, p.y, animLength(c.anim))) {
        drag.current = { k: "length", d0: c.doc, anim: c.name, began: false };
        return;
      }
      const mk = markersOf(api).find((m) => Math.abs(p.x - LABEL_W - timeToX(m.time, view.current)) <= 6 && p.y > RULER_H - 12);
      if (mk) { api.store.set({ playing: false }); setTime(api, mk.time); drag.current = { k: "marker", m: mk, began: false }; return; }
      api.store.set({ playing: false });
      if (e.shiftKey && c) {
        // ⇧-drag in the ruler selects every key in the time range (⇧⌘ adds to the selection)
        const t = snapOn(e) ? snapTick(xToTime(p.x - LABEL_W, view.current)) : r4(xToTime(p.x - LABEL_W, view.current));
        const add = e.metaKey || e.ctrlKey;
        const base = add ? api.store.get().keys : [];
        rangeSel.current = [t, t];
        drag.current = { k: "range", t0: t, add, base };
        api.store.set({ keys: mergeSel(base, keysInTimeRange(c.anim, t, t)) });
        schedule();
        return;
      }
      drag.current = { k: "scrub" };
      scrubTo(p.x, snapOn(e));
      return;
    }
    if (!c) return;
    const row = rowAt(rows, p.y - RULER_H + scrollY.current);
    if (p.x < LABEL_W) {
      if (!row) return;
      // == selection badge == clicking the "all 9" / "3/9" badge toggles select-all / select-none for this row
      {
        const st0 = api.store.get();
        const bs0 = badgeSpan(rowSelectionState(st0.keys, c.anim, row));
        if (bs0 && p.x >= bs0.x0 && p.x < bs0.x1) { api.store.set({ keys: toggleRowKeys(st0.keys, c.anim, row), bones: st0.bones.includes(row.bone) ? st0.bones : [...st0.bones, row.bone] }); return; }
      }
      if (row.kind === "bone") {
        if (p.x < 18) { toggleCollapse(row.bone); return; }
        // clicking a bone label selects the bone AND all of its keys (every channel, collapsed or not); ⇧/⌘ toggles
        const st = api.store.get();
        const bs = st.bones;
        const keys = selectRowKeys(st.keys, c.anim, row, additive);
        const removing = additive && bs.includes(row.bone) && !rowKeys(c.anim, row).some((r) => hasKey(keys, r));
        api.store.set({ bones: additive ? (removing ? bs.filter((b) => b !== row.bone) : bs.includes(row.bone) ? bs : [...bs, row.bone]) : [row.bone], keys });
      } else {
        // clicking a channel label selects that channel's keys (⇧/⌘ adds or removes them)
        const st = api.store.get();
        api.store.set({ bones: additive && st.bones.includes(row.bone) ? st.bones : additive ? [...st.bones, row.bone] : [row.bone], keys: selectRowKeys(st.keys, c.anim, row, additive) });
      }
      return;
    }
    const { gx, gy } = gridPt(p);
    const hit = hitKeys(c.anim, rows, view.current, gx, gy);
    const sel = api.store.get().keys;
    if (hit) {
      // ⌘-click toggles a key (a ⌘-drag stretches the selection, so a key that is not selected yet joins it on press)
      const toggle = stretch && hit.every((h) => hasKey(sel, h));
      const next = additive ? applyClick(sel, hit, true) : stretch ? (toggle ? sel : toggleKeys(sel, hit)) : applyClick(sel, hit, false);
      api.store.set({ keys: next, bones: row && !additive && !stretch ? [row.bone] : api.store.get().bones });
      if (additive && !hit.every((h) => hasKey(next, h))) return;
      const grab = hit[0];
      const base = next;
      drag.current = {
        k: "keys", d0: c.doc, anim: c.name, base, grab, offset: xToTime(gx, view.current) - grab.time, startX: p.x,
        moved: false, dup: e.altKey && !stretch, additive, minT: Math.min(...base.map((b) => b.time)), hit, stretch, mid: e.altKey, toggle,
      };
      return;
    }
    const addBox = additive || e.metaKey || e.ctrlKey;
    drag.current = { k: "box", start: { x: gx, y: gy }, add: addBox, base: addBox ? sel : [], moved: false };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const p = local(e);
    const d = drag.current;
    const { c, rows } = ctxInfo();
    if (!d) {
      // hover
      let cursor = "default";
      let hk: KeyRef[] | undefined;
      let text: string | null = null;
      if (c) {
        if (p.y < RULER_H && p.x >= LABEL_W) cursor = hitLength(p.x, p.y, animLength(c.anim)) ? "ew-resize" : "col-resize";
        else if (p.y >= RULER_H && p.x >= LABEL_W) {
          const { gx, gy } = gridPt(p);
          hk = hitKeys(c.anim, rows, view.current, gx, gy);
          if (hk) {
            cursor = "pointer";
            const k = c.anim.bones.get(hk[0].bone)?.[hk[0].channel]?.keys.find((q) => Math.abs(q.time - hk![0].time) < 0.0005);
            text = `${hk.length > 1 ? hk[0].bone : hk[0].bone + " · " + hk[0].channel} @ ${hk[0].time.toFixed(3)}s (${Math.round(hk[0].time * 20)}t)${k ? " · " + (k.lerp ?? k.easing ?? "linear") : ""}`;
          }
        } else if (p.y >= RULER_H && p.x < LABEL_W) {
          const row = rowAt(rows, p.y - RULER_H + scrollY.current);
          // == selection badge == tooltip + pointer cursor over the badge
          if (row) {
            const rs = rowSelectionState(api.store.get().keys, c.anim, row);
            const bsp = badgeSpan(rs);
            if (bsp && p.x >= bsp.x0 && p.x < bsp.x1) { cursor = "pointer"; text = selBadgeTip(row, rs); }
          }
          if (!text && row?.kind === "channel") text = channelUse(api.store.get().clipInfo[c.name], row.bone, row.channel!).tip ?? null;
          if (row?.kind === "bone") {
            const info = api.store.get().clipInfo[c.name];
            if (!text && info?.aimed.some((a) => boneOfAim(a) === row.bone) && p.x > LABEL_W - 44) text = AIMED_TIP;
          }
        }
      }
      const hb = c && p.y >= RULER_H ? rowAt(rows, p.y - RULER_H + scrollY.current)?.bone : undefined;
      const changed = !sameHover(hover.current.keys, hk) || hover.current.bone !== hb;
      hover.current = { keys: hk, bone: hb, cursor };
      canvasRef.current!.style.cursor = cursor;
      setTip((t) => (text ? (t && t.text === text && Math.abs(t.x - p.x) < 3 ? t : { x: p.x + 12, y: p.y + 16, text }) : t ? null : t));
      if (changed) schedule();
      return;
    }
    if (d.k === "pan") {
      view.current = { ...view.current, t0: d.t0 - (p.x - d.x) / view.current.pxPerSec };
      scrollY.current = d.sy - (p.y - d.y);
      schedule();
    } else if (d.k === "scrub") scrubTo(p.x, snapOn(e));
    else if (d.k === "marker") {
      const t = Math.max(0, snapOn(e) ? snapTick(xToTime(p.x - LABEL_W, view.current)) : r4(xToTime(p.x - LABEL_W, view.current)));
      if (!d.began) { d.began = true; api.beginGesture(); }
      if (moveMarkerTo(api, d.m, t)) setTime(api, t);
    }
    else if (d.k === "length" && c) {
      if (!d.began) { d.began = true; api.beginGesture(); }
      const t = Math.max(TICK, snapOn(e) ? snapTick(xToTime(p.x - LABEL_W, view.current)) : r4(xToTime(p.x - LABEL_W, view.current)));
      api.commit(setLength(d.d0, { anim: d.anim, length: t }), "Change Animation Length");
    } else if (d.k === "keys") {
      if (!d.moved && Math.abs(p.x - d.startX) < 3) return;
      const pt = xToTime(p.x - LABEL_W, view.current);
      const delta = dragDelta(d.grab.time, d.offset, pt, snapOn(e), d.dup ? -Infinity : d.minT);
      if (!d.moved) { d.moved = true; api.beginGesture(); }
      applyKeyDrag(api, d, delta);
    } else if (d.k === "range") {
      const t = snapOn(e) ? snapTick(xToTime(p.x - LABEL_W, view.current)) : r4(xToTime(p.x - LABEL_W, view.current));
      rangeSel.current = [d.t0, t];
      if (c) api.store.set({ keys: mergeSel(d.base, keysInTimeRange(c.anim, d.t0, t)) });
      schedule();
    } else if (d.k === "box") {
      const { gx, gy } = gridPt(p);
      if (!d.moved && Math.abs(gx - d.start.x) + Math.abs(gy - d.start.y) < 3) return;
      d.moved = true;
      const r = normRect(d.start, { x: gx, y: gy });
      box.current = r;
      if (c) {
        const inRect = keysInRect(c.anim, rows, view.current, r);
        api.store.set({ keys: d.add ? mergeSel(d.base, inRect) : inRect });
      }
      schedule();
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    try { canvasRef.current?.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
    if (!d) return;
    if ((d.k === "length" || d.k === "marker") && d.began) api.endGesture();
    if (d.k === "keys") {
      if (d.moved) api.endGesture();
      else if (d.toggle) api.store.set({ keys: toggleKeys(api.store.get().keys, d.hit) });
      else if (!d.additive && !d.stretch) api.store.set({ keys: d.hit });
    }
    if (d.k === "range") { rangeSel.current = null; schedule(); }
    if (d.k === "box") {
      box.current = null;
      if (!d.moved && !d.add) api.store.set({ keys: [] });
      schedule();
    }
  };

  const toggleCollapse = (bone: string) => {
    if (expanded.current.has(bone)) expanded.current.delete(bone);
    else expanded.current.add(bone);
    ver.current++;
    schedule();
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const p = local(e);
    const { c, rows } = ctxInfo();
    if (!c || p.x < LABEL_W || p.y < RULER_H) return;
    const { gx, gy } = gridPt(p);
    if (hitKeys(c.anim, rows, view.current, gx, gy)) return;
    const row = rowAt(rows, gy);
    if (!row) return;
    const t = snapOn(e) ? snapTick(xToTime(gx, view.current)) : r4(xToTime(gx, view.current));
    if (t < 0 || t > animLength(c.anim) + 1e-6) return;
    let doc = c.doc;
    const added: KeyRef[] = [];
    const chans = row.kind === "channel" ? [row.channel!] : CHANNELS.filter((ch) => c.anim.bones.get(row.bone)?.[ch]);
    for (const channel of chans) { doc = addKeyframe(doc, { anim: c.name, bone: row.bone, channel, time: t }); added.push({ bone: row.bone, channel, time: t }); }
    api.commit(doc, "Insert Keyframe");
    api.store.set({ keys: added, bones: [row.bone] });
  };

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const p = local(e);
    const { c, rows } = ctxInfo();
    if (c && p.x >= LABEL_W && p.y >= RULER_H) {
      const { gx, gy } = gridPt(p);
      const hit = hitKeys(c.anim, rows, view.current, gx, gy);
      if (hit && !hit.every((h) => hasKey(api.store.get().keys, h))) api.store.set({ keys: hit });
    }
    const s = api.store.get();
    const has = s.keys.length > 0;
    const mk = c && p.y < RULER_H && p.x >= LABEL_W ? markersOf(api).find((m) => Math.abs(p.x - LABEL_W - timeToX(m.time, view.current)) <= 6) : undefined;
    const act = (id: string) => () => runAction(id);
    showContextMenu(e.clientX, e.clientY, [
      ...(mk ? [{ label: `Delete Marker (${mk.time.toFixed(2)}s)`, run: () => deleteMarkerAt(api, mk) }, { separator: true, label: "" }] : []),
      { label: "Add Keyframe", shortcut: "Q", run: act("Studio.AddKeyframe") },
      { label: "Add Keyframe (reset values)", shortcut: "⇧Q", run: act("Studio.AddKeyframeReset") },
      { label: "Set Marker", shortcut: "⌘M", run: () => addMarkerAtPlayhead(api) },
      { separator: true, label: "" },
      { label: "Copy", shortcut: "⌘C", disabled: !has, run: act("Studio.Copy") },
      { label: "Cut", shortcut: "⌘X", disabled: !has, run: act("Studio.Cut") },
      { label: "Paste", shortcut: "⌘V", disabled: !s.clipboard, run: act("Studio.Paste") },
      { label: "Paste with Noise…", shortcut: "⌘⌥V", disabled: !s.clipboard, run: act("Studio.PasteWithNoise") },
      { label: "Add Noise to Selection…", shortcut: "⌘⌥N", disabled: !has, run: act("Studio.AddNoise") },
      { label: "Duplicate", shortcut: "⌘D", disabled: !has, run: act("Studio.Duplicate") },
      { label: "Delete", shortcut: "⌫", disabled: !has, run: () => deleteSelectedKeys(api) },
      { separator: true, label: "" },
      { label: "Mirror Keyframes to Other Side", disabled: !has, run: act("Studio.MirrorKeys") },
      { label: "Interpolation: Linear", disabled: !has, run: act("Studio.Interp.Linear") },
      { label: "Interpolation: Catmull-Rom", disabled: !has, run: act("Studio.Interp.Catmullrom") },
      { label: "Interpolation: Bezier", disabled: !has, run: act("Studio.Interp.Bezier") },
      { label: "Interpolation: Step", disabled: !has, run: act("Studio.Interp.Step") },
      { separator: true, label: "" },
      { label: "Pose Between Frames…", shortcut: "⌥B", run: act("Studio.Breakdown") },
      { label: "Snap Keys to Ticks", disabled: !c, run: act("Studio.SnapKeys") },
      { label: "Select All Keys", shortcut: "⌘A", run: act("Studio.SelectAll") },
      { label: "Invert Selection", shortcut: "⌘I", run: act("Studio.InvertSelection") },
    ]);
  };

  // wheel: zoom / pan / scroll (non-passive)
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const h = (e: WheelEvent) => {
      e.preventDefault();
      const r = cv.getBoundingClientRect();
      const x = e.clientX - r.left - LABEL_W;
      if (e.ctrlKey || e.metaKey) view.current = zoomView(view.current, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018)), x);
      else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) view.current = { ...view.current, t0: view.current.t0 + (e.deltaX || e.deltaY) / view.current.pxPerSec };
      else scrollY.current += e.deltaY;
      schedule();
    };
    cv.addEventListener("wheel", h, { passive: false });
    return () => cv.removeEventListener("wheel", h);
  }, [canvasRef, schedule]);

  // fit command from the toolbar
  useEffect(() => {
    const h = () => {
      const c = cur(api);
      view.current = fitView(c ? animLength(c.anim) : 1, size.current.w - LABEL_W);
      schedule();
    };
    window.addEventListener("animstudio:fit", h);
    return () => window.removeEventListener("animstudio:fit", h);
  }, [api, schedule]);

  return (
    <div className="as-canvas-wrap" ref={wrapRef} tabIndex={-1} data-testid="as-dopesheet" style={{ outline: "none" }}>
      <canvas
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => { if (!drag.current) { hover.current = { cursor: "default" }; setTip(null); schedule(); } }}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
      />
      {tip && <div className="as-tip" style={{ left: Math.min(tip.x, size.current.w - 200), top: tip.y }}>{tip.text}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- helpers

function sameVec(a: Keyframe["value"], b: Keyframe["value"]) {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}
function sameHover(a?: KeyRef[], b?: KeyRef[]) {
  if (!a || !b) return a === b;
  return a.length === b.length && a.every((k, i) => keyEq(k, b[i]));
}
const boneOfAim = (a: string) => ({ head: "armorHead", right_arm: "armorRightArm", left_arm: "armorLeftArm", right_leg: "armorRightLeg", left_leg: "armorLeftLeg" } as Record<string, string>)[a] ?? a;
function ellipsize(ctx: CanvasRenderingContext2D, s: string, max: number): string {
  if (ctx.measureText(s).width <= max) return s;
  let lo = 0, hi = s.length;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (ctx.measureText(s.slice(0, m) + "…").width <= max) lo = m; else hi = m - 1; }
  return s.slice(0, lo) + "…";
}
function drawAimBadge(ctx: CanvasRenderingContext2D, P: ReturnType<typeof palette>, x: number, y: number) {
  ctx.save();
  ctx.strokeStyle = P.yellow;
  ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.arc(x + 7, y, 5, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x + 7, y - 8); ctx.lineTo(x + 7, y - 3); ctx.moveTo(x + 7, y + 3); ctx.lineTo(x + 7, y + 8); ctx.moveTo(x - 1, y); ctx.lineTo(x + 4, y); ctx.moveTo(x + 10, y); ctx.lineTo(x + 15, y); ctx.stroke();
  ctx.restore();
}

function applyKeyDrag(api: StudioApi, d: Extract<Drag, { k: "keys" }>, delta: number): void {
  const s = api.store.get();
  if (d.stretch) {
    // Ctrl / ⌘: scale the selected group in time around its first key (Alt: around the midpoint of the range)
    const times = d.base.map((b) => b.time);
    const lo = Math.min(...times), hi = Math.max(...times);
    const anchor = d.mid ? (lo + hi) / 2 : lo;
    const grab = d.grab.time;
    if (Math.abs(grab - anchor) < 1e-6) return;
    const target = grab + delta;
    const factor = Math.max(0.05, (target - anchor) / (grab - anchor));
    const anim = getAnimation(d.d0, d.anim);
    const items: Array<{ bone: string; channel: KeyRef["channel"]; key: Keyframe }> = [];
    const refs: KeyRef[] = [];
    for (const ref of d.base) {
      const k = anim?.bones.get(ref.bone)?.[ref.channel]?.keys.find((q) => Math.abs(q.time - ref.time) < 0.0005);
      if (!k) continue;
      let t = Math.max(0, anchor + (ref.time - anchor) * factor);
      t = s.snapTicks ? snapTick(t) : r4(t);
      items.push({ bone: ref.bone, channel: ref.channel, key: { ...k, time: t } });
      refs.push({ ...ref, time: t });
    }
    api.commit(insertKeys(deleteKeyframes(d.d0, { anim: d.anim, keys: d.base }), d.anim, items), "Stretch Keyframes");
    api.store.set({ keys: refs });
    return;
  }
  if (d.dup) {
    if (Math.abs(delta) < 1e-6) {
      api.commit(d.d0, "Duplicate Keyframes");
      api.store.set({ keys: d.base });
      return;
    }
    // copies of the base keys at shifted times
    const items: Array<{ bone: string; channel: KeyRef["channel"]; key: Keyframe }> = [];
    const a = dupSource(d);
    for (const ref of d.base) {
      const k = a?.bones.get(ref.bone)?.[ref.channel]?.keys.find((q) => Math.abs(q.time - ref.time) < 0.0005);
      if (k) items.push({ bone: ref.bone, channel: ref.channel, key: { ...k, time: r4(k.time + delta) } });
    }
    api.commit(insertKeys(d.d0, d.anim, items), "Duplicate Keyframes");
    api.store.set({ keys: shiftRefs(d.base, delta) });
    return;
  }
  api.commit(moveKeyframes(d.d0, { anim: d.anim, keys: d.base, delta, anchor: s.anchorMode }), "Move Keyframes");
  api.store.set({ keys: shiftRefs(d.base, delta) });
}
const dupSource = (d: { d0: Doc; anim: string }) => getAnimation(d.d0, d.anim);
