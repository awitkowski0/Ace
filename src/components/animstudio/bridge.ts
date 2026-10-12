/**
 * Frontend half of the live Studio bridge (src-tauri/src/studio_bridge.rs <-> tools/ace-mcp). Rust evals
 * `window.__aceStudioBridge(op, args)` in a project window and returns the JSON result. Ops (fixed set, no arbitrary JS):
 *   file_text {file}                    -> {open, text?, dirty?}   live editor buffer of an open file
 *   apply_text {file, text, label}      -> {applied}               edit through the Studio's commit (one Monaco undo stop)
 *   open {file, anim?, t?, mode?}       -> state of that Studio
 *   state {}                            -> open Studios
 *   screenshot {file?, anim?, t?, frames?, from?, to?, times?, view?, width?} -> {png(base64), width, height, times}
 *   set_time {t, file?, anim?} / select {file?, bones?, anim?, cube?, keys?}
 *   run_game {}                         -> Asset Dev "Run Game"
 * Everything heavy (Monaco, editor store) is imported lazily so the eager module graph stays light.
 */
import { getAnimations, clipSemantics, parseDoc, docKindForPath, animLength } from "./core";
import { allStudios, type StudioHandle } from "./ui/studios";

type Args = Record<string, any>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const keyOf = (file: string) => "local:" + file;
const tick = async () => { await Promise.resolve(); await Promise.resolve(); await sleep(0); };

const studioFor = (file?: string): StudioHandle | null => {
  const hs = allStudios();
  if (file) return hs.find((h) => h.docKey === keyOf(file)) ?? null;
  const store = (h: StudioHandle) => h.root.current && document.contains(h.root.current) && h.root.current.offsetParent !== null;
  return hs.find(store) ?? hs[0] ?? null;
};

async function until<T>(f: () => T | null | undefined | false, ms = 10_000, what = "the Studio"): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(40);
  }
}

async function modelFor(file: string) {
  const { monaco } = await import("../../editor/monacoSetup");
  const { modelUri } = await import("./ui/api");
  return monaco.editor.getModel(modelUri(keyOf(file)));
}
const lf = (s: string) => s.replace(/\r\n/g, "\n");

function describe(h: StudioHandle) {
  const s = h.api.store.get();
  return {
    file: s.path, mode: s.mode, anim: s.anim, time: s.time, playing: s.playing, view: s.view,
    bones: s.bones, cube: s.cube, keys: s.keys.slice(0, 40), length: s.doc && s.anim ? lenOf(h) : null,
    anims: s.doc && s.doc.kind !== "geo" ? getAnimations(s.doc).map((a) => a.name).slice(0, 80) : [],
    problems: { errors: s.problems.filter((p) => p.severity === "error").length, warnings: s.problems.filter((p) => p.severity === "warning").length },
    parseError: s.parseError, rig: s.rig?.label ?? null,
  };
}
function lenOf(h: StudioHandle): number | null {
  const s = h.api.store.get();
  const a = s.doc && s.anim ? getAnimations(s.doc).find((x) => x.name === s.anim) : undefined;
  return a ? animLength(a) : null;
}

async function openStudio(a: Args): Promise<StudioHandle> {
  const file = String(a.file);
  const kind = docKindForPath(file);
  if (!kind) throw new Error("not a geo/animation/bbmodel file");
  const { openFile, editorStore } = await import("../../editor/store");
  const { setPrefs } = await import("../../editor/viewers/io");
  const { local } = await import("../../lib/ipc");
  let h = studioFor(file);
  if (!h) {
    await openFile(local(file), {});
    setPrefs(keyOf(file), { mode: "preview" });
    h = await until(() => studioFor(file), 12_000, "the Studio to open the file");
    await until(() => h!.api.store.get().doc && h!.viewport.current, 12_000, "the viewport");
    await sleep(200);
  } else {
    const g = Object.values(editorStore.get().groups).find((x: any) => x.tabs?.includes(keyOf(file))) as any;
    if (g) { editorStore.set({ activeGroup: g.id }); await openFile(local(file), { group: g.id }); }
  }
  return h;
}

function applyArgs(h: StudioHandle, a: Args) {
  const patch: Record<string, unknown> = { playing: false };
  const s = h.api.store.get();
  if (a.mode) patch.mode = a.mode;
  if (a.anim) {
    if (!s.doc || !getAnimations(s.doc).some((x) => x.name === a.anim)) throw new Error(`no animation "${a.anim}" in ${s.path}`);
    patch.anim = a.anim;
  }
  if (typeof a.t === "number") patch.time = Math.max(0, a.t);
  if (a.view) patch.view = a.view;
  h.api.store.set(patch as never);
}

async function shoot(h: StudioHandle, a: Args) {
  const vp = h.viewport.current;
  const host = h.root.current;
  const canvas = host?.querySelector("canvas") as HTMLCanvasElement | null;
  if (!vp || !canvas) throw new Error("the Studio viewport is not ready (is the Studio tab visible?)");
  const s0 = h.api.store.get();
  const saved = { time: s0.time, playing: s0.playing, anim: s0.anim, view: s0.view };
  applyArgs(h, { anim: a.anim, view: a.view });
  let times: number[] = Array.isArray(a.times) && a.times.length ? a.times.map(Number) : typeof a.t === "number" && !a.frames ? [a.t] : [];
  if (!times.length && a.frames) {
    const len = lenOf(h) ?? 1;
    const from = typeof a.from === "number" ? a.from : 0;
    const to = typeof a.to === "number" ? a.to : len;
    const n = Math.max(2, Math.min(12, Number(a.frames)));
    times = Array.from({ length: n }, (_, i) => Math.round((from + ((to - from) * i) / (n - 1)) * 1000) / 1000);
    // a looping clip's last frame equals its first: sample just before the end instead
    if (to >= len - 1e-6) times[n - 1] = Math.max(from, Math.round((to - 0.05) * 1000) / 1000);
  }
  if (!times.length) times = [s0.time];
  const frameW = Math.max(160, Math.min(1600, Number(a.width) || 480));
  const shots: HTMLCanvasElement[] = [];
  try {
    for (const t of times) {
      h.api.store.set({ time: t, playing: false });
      await tick();
      vp.render();
      // read right after render, in the same task, so the WebGL drawing buffer is still valid
      const c = document.createElement("canvas");
      const k = frameW / canvas.width;
      c.width = frameW;
      c.height = Math.max(1, Math.round(canvas.height * k));
      const ctx = c.getContext("2d")!;
      ctx.drawImage(canvas, 0, 0, c.width, c.height);
      shots.push(c);
    }
  } finally {
    h.api.store.set({ time: saved.time, playing: saved.playing, anim: saved.anim, view: saved.view });
    await tick();
    vp.render();
  }
  const out = document.createElement("canvas");
  out.width = shots.reduce((w, c) => w + c.width, 0);
  out.height = shots[0].height;
  const octx = out.getContext("2d")!;
  octx.fillStyle = "#2e3440";
  octx.fillRect(0, 0, out.width, out.height);
  let x = 0;
  shots.forEach((c, i) => {
    octx.drawImage(c, x, 0);
    if (shots.length > 1) {
      octx.fillStyle = "rgba(236,239,244,0.9)";
      octx.font = "bold 14px sans-serif";
      octx.fillText(`${times[i]}s`, x + 8, 20);
    }
    x += c.width;
  });
  const png = out.toDataURL("image/png").replace(/^data:image\/png;base64,/, "");
  return { png, width: out.width, height: out.height, times, note: shots.length > 1 ? "strip, left to right" : undefined };
}

const ops: Record<string, (a: Args) => Promise<unknown> | unknown> = {
  async file_text(a) {
    const key = keyOf(String(a.file));
    const { editorStore } = await import("../../editor/store");
    const d = editorStore.get().docs[key];
    if (!d || d.viewer || d.error) return { open: false };
    const h = studioFor(a.file);
    const m = await modelFor(a.file);
    const text = m ? lf(m.getValue()) : h ? h.text() : null;
    if (text == null) return { open: false };
    return { open: true, text, dirty: d.dirty };
  },
  async apply_text(a) {
    const file = String(a.file);
    const text = lf(String(a.text));
    const kind = docKindForPath(file);
    if (!kind) throw new Error("not a studio file");
    const parsed = parseDoc(text, kind, clipSemantics(file)); // refuse text that does not parse
    const h = studioFor(file);
    if (h) { h.api.commit(parsed, String(a.label ?? "Claude edit")); return { applied: true, via: "studio" }; }
    const m = await modelFor(file);
    if (!m) throw new Error("file is not open in Ace");
    const { monaco } = await import("../../editor/monacoSetup");
    const { minimalEdit } = await import("./core");
    const cur = lf(m.getValue());
    if (cur !== text) {
      const e = minimalEdit(cur, text);
      const a1 = m.getPositionAt(e.start);
      const a2 = m.getPositionAt(e.end);
      m.pushStackElement();
      m.pushEditOperations([], [{ range: new monaco.Range(a1.lineNumber, a1.column, a2.lineNumber, a2.column), text: e.text }], () => null);
      m.pushStackElement();
    }
    return { applied: true, via: "editor" };
  },
  async open(a) {
    const h = await openStudio(a);
    applyArgs(h, a);
    await tick();
    return describe(h);
  },
  state() {
    const hs = allStudios();
    return { studios: hs.map(describe), active: studioFor()?.api.store.get().path ?? null };
  },
  async screenshot(a) {
    const h = a.file ? await openStudio(a) : studioFor();
    if (!h) throw new Error("no Studio is open - use studio_open first");
    return shoot(h, a);
  },
  async set_time(a) {
    const h = a.file ? await openStudio(a) : studioFor();
    if (!h) throw new Error("no Studio is open");
    applyArgs(h, { t: a.t, anim: a.anim });
    await tick();
    return describe(h);
  },
  async select(a) {
    const h = a.file ? await openStudio(a) : studioFor();
    if (!h) throw new Error("no Studio is open");
    if (a.anim) applyArgs(h, { anim: a.anim });
    h.api.store.set({ ...(a.bones ? { bones: a.bones, cube: null } : {}), ...(a.cube ? { cube: a.cube, bones: [a.cube.bone] } : {}), ...(a.keys ? { keys: a.keys } : {}) } as never);
    await tick();
    return describe(h);
  },
  async run_game() {
    const m = await import("../profiles/rungame");
    await m.runGame();
    const s = m.gameStore.get();
    return { state: s.state, task: s.task };
  },
};

declare global {
  interface Window { __aceStudioBridge?: (op: string, args: Args) => Promise<unknown> }
}
window.__aceStudioBridge = async (op, args) => {
  const f = ops[op];
  if (!f) throw new Error("unknown bridge op " + op);
  return f(args ?? {});
};
