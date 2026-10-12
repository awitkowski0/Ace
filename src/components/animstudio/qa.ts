/** `await __qa.anim()` test hooks for scripts/qa/animstudio.mjs (never the real keyboard / mouse). */
import { editorStore, openFile, saveAll } from "../../editor/store";
import { setPrefs } from "../../editor/viewers/io";
import { controllerFor } from "../../editor/viewers/controllers";
import { local } from "../../lib/ipc";
import { runAction } from "../../actions/registry";
import { monaco } from "../../editor/monacoSetup";
import { modelUri } from "./ui/api";
import { studioOfGroup, allStudios } from "./ui/studios";
import * as refs from "./ui/refimages/refs";
import * as vpApi from "./ui/viewport/api";
import * as texops from "./ui/texops";
import * as consStore from "./ui/constraints/store"; // == constraints hook ==
import { drawnBadges } from "./ui/timeline/selBadge"; // == selection badge ==
import { boneSelectionState } from "./ui/timeline/rowSelection";
import { getAnimation } from "./core";
import { stepOnce } from "./ui/timeline/playback";
import { flushSurfaces } from "./ui/timeline/useSurface";
import { perfCloseFrame, perfStats, perfTime, setPerf, type PerfBin } from "./ui/perf";

const group = () => editorStore.get().activeGroup;
const studio = () => studioOfGroup(group());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(f: () => T | null | undefined | false, ms = 8000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("timeout waiting for studio");
    await sleep(40);
  }
}
const ctl = () => controllerFor(group()) as unknown as Record<string, (...a: unknown[]) => unknown> | undefined;

export const animQa = {
  /** open a file in the Studio (preview mode) and wait until the viewport has a rig */
  async open(path: string, opts: { mode?: "preview" | "split" | "editor" } = {}) {
    await openFile(local(path), {});
    const key = "local:" + path;
    setPrefs(key, { mode: opts.mode ?? "preview" });
    const h = await until(() => studio());
    await until(() => h.api.store.get().doc && h.viewport.current);
    await sleep(250);
    return this.snapshot();
  },
  snapshot: () => ctl()?.snapshot?.(),
  /** call a controller method (select, set, run, undo, redo, text, pick, project, nudge, setView ...) */
  call: async (cmd: string, ...args: unknown[]) => ctl()?.[cmd]?.(...args),
  text: () => studio()?.text() ?? null,
  dirty: () => { const s = editorStore.get(); return s.docs[s.groups[s.activeGroup]?.active ?? ""]?.dirty ?? null; },
  save: async () => { await saveAll(); return true; },
  state: () => studio()?.api.store.get() ?? null,
  set: (patch: Record<string, unknown>) => studio()?.api.store.set(patch as never),
  action: (id: string) => runAction(id),
  studios: () => allStudios().length,
  /** focus the Studio root so focus-gated actions are live */
  focus: () => { studio()?.root.current?.focus(); return document.activeElement === studio()?.root.current; },
  /** apply the quick-fix of problem #i */
  applyFix: (i: number) => {
    const h = studio();
    const st = h?.api.store.get();
    const p = st?.problems[i];
    if (!h || !st?.doc || !p?.fix) return false;
    h.api.commit(p.fix.apply(st.doc), p.fix.title);
    return true;
  },
  /** raw text edit at the start of the Monaco model (QA: simulates typing without needing editor focus) */
  rawEdit: (text: string) => {
    const h = studio();
    const m = h && monaco.editor.getModel(modelUri(h.docKey));
    if (!m) return false;
    m.pushStackElement();
    m.pushEditOperations([], [{ range: m.getFullModelRange().collapseToStart(), text }], () => null);
    m.pushStackElement();
    return true;
  },
  rawUndo: () => { const h = studio(); monaco.editor.getModel(modelUri(h!.docKey))?.undo(); return true; },
  sleep,
  /** call a ViewportApi method (setView, toggleOrtho, resetCamera, focusSelection, frame, projectCube, snapshot ...) */
  vp: (method: string, ...args: unknown[]) => (studio()?.viewport.current as unknown as Record<string, (...a: unknown[]) => unknown> | null)?.[method]?.(...args),
  /** force a synchronous frame (screenshots) */
  renderNow: () => { (studio()?.viewport.current as unknown as { renderNow?: () => void } | null)?.renderNow?.(); return true; },
  _pid: 10,
  /** synthetic pointer event on the viewport canvas at canvas-relative (x, y) CSS px (never the real mouse) */
  ptr(type: string, x: number, y: number, o: { button?: number; shift?: boolean; ctrl?: boolean; meta?: boolean; alt?: boolean } = {}) {
    const c = studio()?.viewport.current?.canvas();
    if (!c) return false;
    const r = c.getBoundingClientRect();
    const buttons = type === "pointerup" ? 0 : (o.button ?? 0) === 2 ? 2 : 1;
    c.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: r.left + x, clientY: r.top + y, button: o.button ?? 0, buttons, pointerId: type === "pointerdown" ? ++animQa._pid : animQa._pid, pointerType: "mouse", isPrimary: true, shiftKey: !!o.shift, ctrlKey: !!o.ctrl, metaKey: !!o.meta, altKey: !!o.alt }));
    return true;
  },
  /** press at a, move in `steps` increments to b, release (all synthetic pointer events on the canvas) */
  async drag(a: [number, number], b: [number, number], o: { button?: number; shift?: boolean; ctrl?: boolean; meta?: boolean; alt?: boolean; steps?: number } = {}) {
    const n = o.steps ?? 6;
    animQa.ptr("pointerdown", a[0], a[1], o);
    for (let i = 1; i <= n; i++) { animQa.ptr("pointermove", a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n, o); await sleep(8); }
    animQa.ptr("pointerup", b[0], b[1], o);
    await sleep(60);
    return true;
  },
  wheel(x: number, y: number, deltaY: number, o: { ctrl?: boolean } = {}) {
    const c = studio()?.viewport.current?.canvas();
    if (!c) return false;
    const r = c.getBoundingClientRect();
    c.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: r.left + x, clientY: r.top + y, deltaY, ctrlKey: !!o.ctrl }));
    return true;
  },
  /** DOM click on an element of the active Studio (outliner rows, panel buttons) with modifier keys, as a real click would deliver */
  click(selector: string, o: { meta?: boolean; shift?: boolean; ctrl?: boolean; alt?: boolean; button?: number; type?: "click" | "contextmenu" | "dblclick" } = {}) {
    const el = studio()?.root.current?.querySelector(selector) as HTMLElement | null;
    if (!el) return false;
    el.dispatchEvent(new MouseEvent(o.type ?? "click", { bubbles: true, cancelable: true, metaKey: !!o.meta, shiftKey: !!o.shift, ctrlKey: !!o.ctrl, altKey: !!o.alt, button: o.button ?? 0, view: window }));
    return true;
  },
  /** UV editor: synthetic pointer drag on an element (face rect, resize handle, box island, background) - never the real mouse */
  uv: {
    rect(selector: string) {
      const el = studio()?.root.current?.querySelector(selector) as HTMLElement | null;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
    },
    /** frame scale: screen px per UV unit (data-k of the frame) and the frame origin */
    view() {
      const f = studio()?.root.current?.querySelector("[data-testid=uv-frame]") as HTMLElement | null;
      return f ? { k: Number(f.dataset.k), zoom: Number(f.dataset.zoom), fx: Number(f.dataset.fx), fy: Number(f.dataset.fy) } : null;
    },
    async drag(selector: string, dx: number, dy: number, o: { shift?: boolean; meta?: boolean; alt?: boolean; button?: number; steps?: number; at?: [number, number]; modsOnDown?: boolean } = {}) {
      const el = studio()?.root.current?.querySelector(selector) as HTMLElement | null;
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const x0 = r.left + (o.at ? o.at[0] : r.width / 2), y0 = r.top + (o.at ? o.at[1] : r.height / 2);
      const init = (x: number, y: number, extra: PointerEventInit = {}): PointerEventInit => ({ bubbles: true, cancelable: true, clientX: x, clientY: y, button: o.button ?? 0, pointerId: 77, pointerType: "mouse", isPrimary: true, shiftKey: !!o.shift, metaKey: !!o.meta, altKey: !!o.alt, ...extra });
      el.dispatchEvent(new PointerEvent("pointerdown", init(x0, y0, { buttons: 1, ...(o.modsOnDown === false ? { shiftKey: false, metaKey: false, altKey: false } : {}) })));
      const n = o.steps ?? 5;
      for (let i = 1; i <= n; i++) { window.dispatchEvent(new PointerEvent("pointermove", init(x0 + (dx * i) / n, y0 + (dy * i) / n, { buttons: 1 }))); await sleep(8); }
      window.dispatchEvent(new PointerEvent("pointerup", init(x0 + dx, y0 + dy, { buttons: 0 })));
      await sleep(80);
      return true;
    },
    wheel(dy: number, o: { meta?: boolean; x?: number; y?: number; dx?: number } = {}) {
      const el = studio()?.root.current?.querySelector("[data-testid=uv-viewport]") as HTMLElement | null;
      if (!el) return false;
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: r.left + (o.x ?? r.width / 2), clientY: r.top + (o.y ?? r.height / 2), deltaY: dy, deltaX: o.dx ?? 0, metaKey: !!o.meta, ctrlKey: false }));
      return true;
    },
  },
  /** textures panel */
  tex: {
    rows: () => { const h = studio(); return h ? texops.textureRows(h.api) : []; },
    addPath: async (path: string) => { const h = studio(); return h ? await texops.opAddTexturePath(h.api, h.docKey.slice(0, h.docKey.indexOf(":")), path) : false; },
    addBytes: (name: string, base64: string) => { const h = studio(); return h ? texops.opAddTextureBytes(h.api, name, Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))) : false; },
    remove: (i: number) => { const h = studio(); return h ? texops.opRemoveTexture(h.api, i) : false; },
    toggle: (i: number, v?: boolean) => { const h = studio(); return h ? texops.opToggleTextureVisible(h.api, i, v) : false; },
    active: (i: number) => { const h = studio(); if (h) texops.opSetActiveTexture(h.api, i); return true; },
    apply: (i: number, scope: "faces" | "all") => { const h = studio(); return h ? texops.opApplyTexture(h.api, i, scope) : false; },
    solo: (i: number) => { const h = studio(); return h ? texops.opSoloTexture(h.api, i) : false; },
    blend: (i: number, b: "normal" | "add") => { const h = studio(); return h ? texops.opSetLayerBlend(h.api, i, b) : false; },
  },
  /** reference images (project scope = file / app data, global = app data) */
  refs: {
    list: () => studio()?.api.store.get().refs ?? [],
    key: () => [studio()?.docKey, allStudios().map((h) => h.docKey + "@" + h.groupId)],
    add: (dataUrl: string, patch: Record<string, unknown> = {}) => { const h = studio(); return h ? refs.addRefFromDataUrl(h.api, dataUrl, patch) : null; },
    update: (uuid: string, patch: Record<string, unknown>) => { const h = studio(); if (h) refs.updateRef(h.api, uuid, patch); return true; },
    deleteSelected: () => { const h = studio(); return h ? vpApi.deleteSelectedRefImage(h.api) : false; },
    remove: (uuid: string) => { const h = studio(); if (h) refs.deleteRef(h.api, uuid); return true; },
    select: (uuid: string | null) => { const h = studio(); if (h) refs.selectRef(h.api, uuid); return true; },
    /** simulate dropping image bytes on the viewport: HTML5 drop with a File */
    async drop(name: string, base64: string) {
      const h = studio();
      const root = h?.root.current?.querySelector(".as-vp");
      if (!root) return false;
      const bin = atob(base64);
      const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], name, { type: "image/png" }));
      root.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
      await sleep(250);
      return !!h!.api && !!document.querySelector("[data-testid=ref-import]");
    },
    confirmImport: async () => { const h = studio(); if (!h) return null; return (await refs.confirmImport(h.api))?.uuid ?? null; },
    reload: async () => { const h = studio(); if (h) await refs.loadRefs(h.api); return h?.api.store.get().refs ?? []; },
  },
  /** FPS meter: `stats()` = the HUD numbers, `set(on)` = toggle (not persisted) */
  perf: {
    stats: () => perfStats(),
    set: (on: boolean) => { setPerf(on, false); return true; },
    /**
     * Playback benchmark. The hidden QA webview never fires rAF, so this drives `frames` synthetic frames through the code the rAF loop
     * runs (`stepOnce` = playback's store update), lets React + the engine sync flush (microtasks), draws the viewport and the pending
     * timeline canvases synchronously, and times every stage. Returns per-frame ms (mean / p95 / max), the per-bin means and React renders per frame.
     */
    async bench(frames = 240, o: { dt?: number; warmup?: number } = {}) {
      const h = studio();
      if (!h) return null;
      const api = h.api;
      const dt = o.dt ?? 1 / 60;
      const was = api.store.get().playing;
      api.store.set({ playing: false });
      setPerf(true, false);
      const stage = { wait: 0, draw: 0, layout: 0 };
      const frame = async () => {
        const t0 = performance.now();
        stepOnce(api, dt);
        await null; await null;
        stage.wait += performance.now() - t0;
        const tl = performance.now();
        void document.body.offsetHeight; // the browser lays the page out once per frame: charge it
        stage.layout += performance.now() - tl;
        const vp = h.viewport.current as unknown as { renderNow?: () => void; gpuFinish?: () => void } | null;
        const t1 = performance.now();
        vp?.renderNow?.();
        perfTime("render", () => vp?.gpuFinish?.());
        const t2 = performance.now();
        flushSurfaces();
        stage.draw += t2 - t1;
        return performance.now() - t0;
      };
      for (let i = 0; i < (o.warmup ?? 30); i++) await frame();
      perfCloseFrame(performance.now(), 0);
      stage.wait = 0; stage.draw = 0; stage.layout = 0;
      const times: number[] = [];
      const bins: Record<PerfBin, number> = { store: 0, flush: 0, pose: 0, render: 0, canvas: 0 };
      const renders: Record<string, number> = {};
      let draws = 0, calls = 0;
      for (let i = 0; i < frames; i++) {
        const ms = await frame();
        times.push(ms);
        await null;
        const smp = perfCloseFrame(performance.now(), ms);
        for (const k of Object.keys(bins) as PerfBin[]) bins[k] += smp.bins[k];
        for (const k in smp.renders) renders[k] = (renders[k] ?? 0) + smp.renders[k];
        draws += smp.draws;
      }
      calls = perfStats().calls;
      setPerf(false, false);
      api.store.set({ playing: was });
      const sorted = [...times].sort((a, b) => a - b);
      const r = (v: number) => Math.round(v * 1000) / 1000;
      return {
        frames, times: times.map(r), meanMs: r(times.reduce((a, b) => a + b, 0) / frames), p95Ms: r(sorted[Math.floor(frames * 0.95)]), maxMs: r(sorted[frames - 1]),
        bins: Object.fromEntries(Object.entries(bins).map(([k, v]) => [k, r(v / frames)])),
        rendersPerFrame: Object.fromEntries(Object.entries(renders).map(([k, v]) => [k, r(v / frames)])), drawsPerFrame: r(draws / frames), calls, stages: { waitMs: r(stage.wait / frames), drawMs: r(stage.draw / frames), layoutMs: r(stage.layout / frames) },
      };
    },
  },
  /** == constraints hook == limb links: scene facts + panel actions without the mouse */
  cons: {
    info: () => (studio()?.viewport.current as unknown as { consInfo?: () => unknown } | null)?.consInfo?.() ?? null,
    list: () => { const st = studio()?.api.store.get(); return st ? [...consStore.constraintsOf(st)] : []; },
    project: (bone: string, p: [number, number, number]) => (studio()?.viewport.current as unknown as { consProject?: (b: string, p: unknown) => unknown } | null)?.consProject?.(bone, p) ?? null,
    begin: (kind: "link" | "pin") => { const h = studio(); if (h) consStore.beginPick(h.api, kind); return true; },
    set: (patch: Record<string, unknown>) => { const h = studio(); if (h) consStore.setCons(h.api, patch as never); return true; },
    patch: (id: string, patch: Record<string, unknown>) => { const h = studio(); if (h) consStore.patchConstraint(h.api, id, patch as never); return true; },
    remove: (id: string) => { const h = studio(); if (h) consStore.removeConstraint(h.api, id); return true; },
    addFollow: (source: string, target: string) => { const h = studio(); return h ? consStore.addFollow(h.api, source, target) : null; },
    reload: async () => { const h = studio(); if (h) { h.api.store.set((st) => ({ cons: { ...st.cons, loaded: false, byAnim: {} } })); await consStore.loadConstraints(h.api); } return true; },
  },
  /** == selection badge == what the dope sheet drew in its label column ("all 9" / "3/9") and the pure state per bone */
  badges: () => Object.fromEntries(drawnBadges),
  boneSel: (bone: string) => { const st = studio()?.api.store.get(); const an = st?.doc && st.anim && st.doc.kind !== "geo" ? getAnimation(st.doc, st.anim) : undefined; return boneSelectionState(st?.keys ?? [], an, bone); },
};
