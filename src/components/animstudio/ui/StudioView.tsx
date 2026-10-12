/**
 * The Animation Studio: dual preview pane of *.geo.json / *.animation.json / *.bbmodel tabs (docs/ANIMSTUDIO.md).
 * Monaco owns the text; this view parses it (core), shows it, and writes every edit back as one undo stop (api.ts).
 */
import { initPerf, perfRender, perfStats } from "./perf";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import type { Doc as EditorDoc } from "../../../editor/store";
import { registerController, type ViewerController } from "../../../editor/viewers/controllers";
import * as core from "../core";
import {
  clipInfos, clipSemantics, docKindForPath, getAnimations, isArmorAnimationPath, parseDoc, validateSpidey, findPoseSets, getGeo, type Doc,
} from "../core";
import { createStudioHandle } from "./api";
import { assetPath, findSiblingAnimation, findSiblingGeo, findSpidermanGeo, findTexture, fsLike, getPreviewModel, getProjectModel, listGeos, resolveGeoTextures, setPreviewModel, setProjectModel } from "./resolve";
import type { ModelSource } from "./PreviewModelPicker";
import { playerRigModel, rigFromDoc, rigFromGeo, type RigModel } from "./model";
import { StudioContext, useStudioPick, usePickFrom, type StudioState } from "./state";
import { ModeBar, Toolbar } from "./Toolbar";
import { Outliner } from "./Outliner";
import { Properties } from "./Properties";
import { Viewport } from "./viewport/Viewport";
import type { ViewportEngine } from "./viewport/engine";
import { Timeline } from "./timeline/Timeline";
import { startPlayback } from "./timeline/playback";
import { BreakdownPanel } from "./tools/BreakdownPanel";
import { NoiseDialog } from "./tools/NoiseDialog";
import { EditLeft, LeftColumn } from "./LeftColumn";
import { fs } from "../../../lib/ipc";
import { PauseI, PlayI } from "./icons";
import { clearActiveStudio, setActiveStudio } from "./active";
import "./studio.css";

type Props = { doc: EditorDoc; groupId: string; text: string; sync: boolean };

/** UI state kept per file across tab switches (the pane unmounts when another tab is shown). */
const KEEP: (keyof StudioState)[] = ["mode", "tool", "space", "snap", "bones", "cube", "anim", "time", "view", "wire", "xray", "onion", "reference", "grid", "hidden", "locked", "autoKey", "snapTicks", "asGameApplies", "anchorMode", "liveAim", "webAnchor", "strideSpeed", "speed", "loopPreview", "semMode"];
const saved = new Map<string, Partial<StudioState>>();

const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);

export default function StudioView({ doc, groupId, text }: Props) {
  perfRender("StudioView");
  const kind = docKindForPath(doc.loc.path) ?? "geo";
  const handle = useMemo(() => {
    const h = createStudioHandle({ docKey: doc.key, path: doc.loc.path, groupId, kind });
    h.api.store.set({
      mode: kind === "animation" ? "animate" : "edit",
      tool: "move",
      rig: kind === "geo" ? { source: "geo", label: "Geometry" } : kind === "bbmodel" ? { source: "bbmodel", label: "Blockbench model" } : null,
      ...saved.get(doc.key),
    });
    h.syncFromText(text);
    return h;
  }, [doc.key, groupId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => {
    const s = handle.api.store.get();
    saved.set(doc.key, Object.fromEntries(KEEP.map((k) => [k, s[k]])) as Partial<StudioState>);
    handle.dispose();
  }, [handle, doc.key]);
  useEffect(() => { handle.syncFromText(text); }, [handle, text]);
  useEffect(() => startPlayback(handle.api), [handle]);
  useEffect(() => initPerf(), []);
  useEffect(() => { setActiveStudio(handle.api); return () => clearActiveStudio(handle.api); }, [handle]);

  const root = useRef<HTMLDivElement>(null);
  useEffect(() => { handle.root.current = root.current; root.current?.focus({ preventScroll: true }); return () => { handle.root.current = null; }; }, [handle]);

  const host = doc.loc.host;
  const path = doc.loc.path;
  const [engine, setEngine] = useState<ViewportEngine | null>(null);
  const [extRig, setExtRig] = useState<RigModel | null>(null);
  const [rigPath, setRigPath] = useState<string | null>(null);
  /** where the preview model came from (picker badge) and the project default for this animation file */
  const [rigSource, setRigSource] = useState<ModelSource>("player");
  const [projectDefault, setProjectDefault] = useState<string | null>(null);
  const player = useMemo(() => playerRigModel(), []);
  const s = usePickFrom(handle.api.store, "doc", "mode");

  // ------------------------------------------------------------ rig / texture sources
  const loadGeoFile = useCallback(async (geoPath: string): Promise<RigModel | null> => {
    try {
      const d = parseDoc(await fs.readFile({ host, path: geoPath }), "geo");
      return rigFromGeo(d);
    } catch { return null; }
  }, [host]);

  // animation file -> preview model (remembered pick, same-stem geo, else the built-in player rig)
  useEffect(() => {
    if (kind !== "animation") return;
    let dead = false;
    (async () => {
      const [geos, pref, sib, proj0, spidey] = await Promise.all([listGeos(host, path), getPreviewModel(path), findSiblingGeo(host, path), getProjectModel(path), findSpidermanGeo(host, path)]);
      if (dead) return;
      handle.api.store.set((st) => ({ siblings: { ...st.siblings, geos } }));
      const ok = (p: string | null) => (p ? fs.stat({ host, path: p }).then((x) => x.exists, () => false) : Promise.resolve(false));
      const proj = (await ok(proj0)) ? proj0 : null;
      setProjectDefault(proj);
      // per-file pick > same-stem geo > project default > spiderman (armor clips) > built-in player rig
      const [pick, src]: [string | null, ModelSource] = (await ok(pref)) ? [pref, "file"] : sib ? [sib, "sibling"] : proj ? [proj, "project"] : spidey ? [spidey, "spiderman"] : [null, "player"];
      setRigSource(src);
      if (pick) setRigPath(pick);
      else { setRigPath(null); setExtRig(null); }
    })();
    return () => { dead = true; };
  }, [handle, kind, host, path]);
  useEffect(() => {
    if (kind !== "animation") return;
    let dead = false;
    (async () => {
      if (!rigPath) {
        handle.api.store.set({ rig: { source: "player", label: "Player rig (built-in)" }, texture: null });
        setExtRig(null);
        engine?.setTexturePath(host, null);
        return;
      }
      const [rm, tex] = await Promise.all([loadGeoFile(rigPath), findTexture(host, rigPath)]);
      if (dead) return;
      handle.api.store.set({ rig: { source: "geo", label: base(rigPath).replace(/\.geo\.json$/, ""), path: rigPath }, texture: tex });
      setExtRig(rm);
      engine?.setTexturePath(host, tex);
    })();
    return () => { dead = true; };
  }, [handle, kind, host, rigPath, engine, loadGeoFile]);
  useEffect(() => { if (kind === "animation" && engine) engine.setExternalRig(extRig ?? player); }, [engine, kind, extRig, player]);

  // geo file -> texture + same-stem animation
  useEffect(() => {
    if (kind !== "geo") return;
    let dead = false;
    (async () => {
      const [tex, anim] = await Promise.all([findTexture(host, path), findSiblingAnimation(host, path)]);
      if (dead) return;
      handle.api.store.set((st) => ({ texture: tex, siblings: { ...st.siblings, anims: anim ? [anim] : [] } }));
      engine?.setTexturePath(host, tex);
    })();
    return () => { dead = true; };
  }, [handle, kind, host, path, engine]);
  // geo preview texture layers: saved list (app data) reconciled with the disk, stacked in the viewport
  useEffect(() => {
    if (kind !== "geo") return;
    let dead = false;
    void resolveGeoTextures(host, path).then((st) => { if (!dead) handle.api.store.set({ geoTex: st, texActive: st.active }); });
    return () => { dead = true; };
  }, [handle, kind, host, path]);
  useEffect(() => {
    if (kind !== "geo" || !engine) return;
    let last = handle.api.store.get().geoTex;
    engine.setTextureLayers(host, last.layers);
    return handle.api.store.subscribe(() => {
      const g = handle.api.store.get().geoTex;
      if (g !== last) { last = g; engine.setTextureLayers(host, g.layers); }
    });
  }, [handle, kind, host, engine]);
  useEffect(() => {
    if (kind === "bbmodel" && engine) engine.setTexturePath(host, null);
  }, [engine, kind, host]);

  const pickModel = useCallback((p: string | null) => { setRigPath(p); setRigSource(p ? "file" : "player"); void setPreviewModel(path, p); }, [path]);
  const setDefaultModel = useCallback((p: string | null) => { setProjectDefault(p); void setProjectModel(path, p); }, [path]);
  /** extra Toolbar props for the PreviewModelPicker (spread, so Toolbar can adopt them when it is ready) */
  const modelPicker = { projectDefault, onSetProjectDefault: setDefaultModel, modelSource: rigSource };
  const pickExt = useCallback(async (p: string | null) => {
    if (!p) { handle.api.store.set({ ext: null }); return; }
    try {
      const d = parseDoc(await fs.readFile({ host, path: p }), "animation", clipSemantics(p));
      const first = getAnimations(d)[0]?.name ?? null;
      handle.api.store.set({ ext: { path: p, doc: d, anim: first }, time: 0 });
    } catch { handle.api.store.set({ ext: null }); }
  }, [handle, host]);

  // ------------------------------------------------------------ spidey discovery + validation
  useEffect(() => {
    if (kind !== "animation" || !isArmorAnimationPath(path)) return;
    let dead = false;
    findPoseSets(path, fsLike(host)).then((found) => { if (!dead) handle.api.store.set({ poseSets: found.map((f) => f.set) }); }, () => {});
    return () => { dead = true; };
  }, [handle, kind, host, path]);
  useEffect(() => {
    if (kind !== "animation") return;
    let t: number | undefined;
    const run = () => {
      const st = handle.api.store.get();
      if (!st.doc) return;
      if (!st.poseSets.length) { if (st.problems.length || Object.keys(st.clipInfo).length) handle.api.store.set({ problems: [], clipInfo: {} }); return; }
      try {
        const problems = validateSpidey(st.doc, st.poseSets);
        const info = clipInfos(getAnimations(st.doc), st.poseSets);
        handle.api.store.set({ problems, clipInfo: Object.fromEntries(info) });
      } catch { /* a half-edited file can trip the validators; keep the last result */ }
    };
    const schedule = () => { clearTimeout(t); t = window.setTimeout(run, 250); };
    let lastDoc: Doc | null = null, lastSets: unknown = null;
    const unsub = handle.api.store.subscribe(() => {
      const st = handle.api.store.get();
      if (st.doc !== lastDoc || st.poseSets !== lastSets) { lastDoc = st.doc; lastSets = st.poseSets; schedule(); }
    });
    schedule();
    return () => { unsub(); clearTimeout(t); };
  }, [handle, kind]);

  // ------------------------------------------------------------ controller (QA + viewer actions)
  useEffect(() => {
    const api = handle.api;
    const ctl = {
      frameAll: () => handle.viewport.current?.frame(false),
      snapshot: () => studioSnapshot(handle),
      // ---- QA surface
      select: (bones: string[], cube: { bone: string; index: number } | null = null) => api.store.set({ bones, cube }),
      set: (patch: Partial<StudioState>) => api.store.set(patch),
      /** run a core command by name on the current doc and commit it: run("setCube", {bone, index, patch}) */
      run: (name: string, args: unknown, label = name) => {
        const d = api.store.get().doc;
        const fn = (core as unknown as Record<string, (doc: Doc, a: unknown) => Doc>)[name];
        if (!d || typeof fn !== "function") throw new Error(`no command ${name}`);
        api.commit(fn(d, args), label);
        return true;
      },
      undo: () => api.undo(),
      redo: () => api.redo(),
      beginGesture: () => api.beginGesture(),
      endGesture: () => api.endGesture(),
      text: () => handle.text(),
      pick: (x: number, y: number, add?: boolean) => handle.viewport.current?.pick(x, y, add),
      project: (bone: string) => handle.viewport.current?.project(bone),
      nudge: (kindName: "move" | "rotate" | "resize" | "pivot", delta: [number, number, number]) => handle.viewport.current?.nudge(kindName, delta),
      setView: (v: "persp" | "front" | "side" | "top") => handle.viewport.current?.setView(v),
      pickExt,
      pickModel,
      setProjectDefault: setDefaultModel,
    };
    return registerController(groupId, ctl as unknown as ViewerController);
  }, [handle, groupId, pickExt, pickModel, setDefaultModel]);

  // click anywhere in the Studio (except text fields) takes keyboard focus so V/S/R/P/F/⌫/⌘Z reach the Studio actions
  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("input,textarea,select")) return;
    root.current?.focus({ preventScroll: true });
  };

  const animUi = s.mode !== "edit" && kind !== "geo";
  const editUi = !animUi && kind !== "animation" && s.mode === "edit";
  const showDock = !!animUi;
  const displayRig = useDisplayRig(handle, kind, extRig ?? player);
  const layout = animUi ? s.mode : "edit";
  const tb = { handle, onPickModel: pickModel, onPickExt: pickExt, rigPath, ...modelPicker };

  // Blockbench layouts: Edit = UV editor + Textures on the left, Element fields + Outliner on the right, tool row above the viewport.
  // Animate / Pose = Animations + keyframe on the left, Outliner + bone fields on the right. Panel sizes are remembered per mode.
  const left = animUi ? <LeftColumn mode={s.mode} rig={displayRig} /> : editUi ? <EditLeft rig={displayRig} host={host} /> : null;
  const outliner = <Outliner rig={displayRig} />;
  const props = <Properties rig={displayRig} host={host} />;
  return (
    <StudioContext.Provider value={handle.api}>
      <div className="as-root" ref={root} tabIndex={-1} onPointerDown={onPointerDown} onFocusCapture={() => setActiveStudio(handle.api)} data-testid="studio" data-kind={kind} data-mode={s.mode} data-layout={layout}>
        <ModeBar {...tb} />
        <PanelGroup key={layout} direction="horizontal" autoSaveId={`animstudio.h.${layout}`} className="as-groups">
          {left && <Panel id="left" order={1} defaultSize={editUi ? 24 : 19} minSize={13} maxSize={editUi ? 45 : 34} className="as-panel">{left}</Panel>}
          {left && <PanelResizeHandle className="as-handle v" />}
          <Panel id="center" order={2} minSize={30} className="as-panel">
            <Toolbar {...tb} />
            <PanelGroup direction="vertical" autoSaveId={showDock ? "animstudio.v.dock" : "animstudio.v"}>
              <Panel id="viewport" order={1} minSize={25} className="as-panel">
                <Viewport handle={handle} onReady={setEngine}><ExtTransport />{s.mode === "pose" && s.doc && s.doc.kind !== "geo" && <BreakdownPanel />}</Viewport>
              </Panel>
              {showDock && <PanelResizeHandle className="as-handle h" />}
              {showDock && (
                <Panel id="dock" order={2} defaultSize={38} minSize={16} maxSize={75} className="as-panel">
                  <div className="as-dock"><div className="as-dock-tl"><Timeline /></div></div>
                </Panel>
              )}
            </PanelGroup>
          </Panel>
          <PanelResizeHandle className="as-handle v" />
          <Panel id="right" order={3} defaultSize={editUi ? 22 : animUi ? 20 : 22} minSize={14} maxSize={40} className="as-panel">
            {/* Edit: Element fields above the Outliner (Blockbench order); Animate / Pose: Outliner above the bone fields. Split remembered per mode. */}
            <PanelGroup key={layout} direction="vertical" autoSaveId={"animstudio.r." + layout}>
              <Panel id={editUi ? "props" : "outliner"} order={1} defaultSize={editUi ? 42 : animUi ? 58 : 50} minSize={editUi ? 10 : 18} className="as-panel">{editUi ? props : outliner}</Panel>
              <PanelResizeHandle className="as-handle h" />
              <Panel id={editUi ? "outliner" : "props"} order={2} defaultSize={editUi ? 58 : animUi ? 42 : 50} minSize={editUi ? 18 : 10} className="as-panel">{editUi ? outliner : props}</Panel>
            </PanelGroup>
          </Panel>
        </PanelGroup>
        <NoiseDialog />
      </div>
    </StudioContext.Provider>
  );
}

/** The rig the outliner / properties show: geo / bbmodel from the doc, the chosen preview rig for animation files. */
function useDisplayRig(handle: ReturnType<typeof createStudioHandle>, kind: string, ext: RigModel): RigModel | null {
  const { doc } = usePickFrom(handle.api.store, "doc");
  return useMemo(() => {
    if (!doc) return kind === "animation" ? ext : null;
    if (kind === "animation") return ext;
    return rigFromDoc(doc);
  }, [doc, kind, ext]);
}

/** Overlay transport for previewing a sibling animation on a geo file (read-only: no timeline for geo docs). */
function ExtTransport() {
  const { ext } = useStudioPick("ext");
  return ext?.anim ? <ExtTransportBar /> : null;
}
function ExtTransportBar() {
  perfRender("ExtTransport");
  const { ext, time } = useStudioPick("ext", "time");
  const apiStore = useStudioApiStore();
  const [playing, setPlaying] = useState(false);
  const anim = ext?.anim ? core.getAnimation(ext.doc, ext.anim) : undefined;
  const len = anim ? Math.max(0.05, core.animLength(anim)) : 0;
  useEffect(() => {
    if (!playing || !anim) return;
    let raf = 0, last = performance.now();
    const loop = (now: number) => {
      const dt = (now - last) / 1000; last = now;
      const t = apiStore.get().time + dt;
      apiStore.set({ time: anim.loop ? t % len : Math.min(len, t) });
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing, anim, len, apiStore]);
  if (!anim) return null;
  return (
    <div className="as-ext" data-testid="ext-transport" onPointerDown={(e) => e.stopPropagation()}>
      <button className="as-ib" tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={() => setPlaying((p) => !p)} title={playing ? "Pause" : "Play"}>{playing ? <PauseI /> : <PlayI />}</button>
      <input type="range" min={0} max={len} step={0.05} value={Math.min(time, len)} onChange={(e) => apiStore.set({ time: Number(e.target.value) })} />
      <span className="as-ext-t">{time.toFixed(2)}s / {len.toFixed(2)}s</span>
    </div>
  );
}
import { useStudio } from "./state";
const useStudioApiStore = () => useStudio().store;

function studioSnapshot(h: ReturnType<typeof createStudioHandle>) {
  const s = h.api.store.get();
  const doc = s.doc;
  let geo: unknown = null;
  if (doc?.kind === "geo") {
    const g = getGeo(doc).geometries[0];
    geo = g ? { id: g.identifier, bones: g.bones.map((b) => ({ name: b.name, parent: b.parent ?? null, cubes: b.cubes.length })) } : null;
  }
  const anims = doc && doc.kind !== "geo" ? getAnimations(doc).map((a) => a.name) : [];
  return {
    kind: "animstudio", docKind: h.kind, path: s.path, mode: s.mode, tool: s.tool, space: s.space, snap: s.snap, view: s.view,
    parseError: s.parseError, bones: s.bones, cube: s.cube, cubes: s.cubes, uvFaces: s.uvFaces, texActive: s.texActive, geoTex: s.geoTex, anim: s.anim, anims, keys: s.keys.length, time: s.time, playing: s.playing,
    autoKey: s.autoKey, onion: s.onion, wire: s.wire, xray: s.xray, hidden: s.hidden, locked: s.locked,
    rig: s.rig, texture: s.texture, siblings: s.siblings, ext: s.ext ? { path: s.ext.path, anim: s.ext.anim } : null,
    poseSets: s.poseSets.map((p) => p.name), problems: s.problems.length, problemCodes: [...new Set(s.problems.map((p) => p.code))],
    clips: Object.keys(s.clipInfo).length, asGameApplies: s.asGameApplies, anchorMode: s.anchorMode, liveAim: s.liveAim, webAnchor: s.webAnchor, strideSpeed: s.strideSpeed, strideDist: s.strideDist,
    clipKinds: Object.fromEntries(Object.entries(s.clipInfo).map(([k, v]) => [k, v.kind + "/" + v.positions + (v.strideGait ? "/" + v.strideGait : "")])), geo,
    viewport: h.viewport.current?.snapshot() ?? null, perf: perfStats(),
    lastLabel: h.labels?.[h.labels.length - 1] ?? null, commits: h.labels?.length ?? 0, textLen: h.text().length,
    dom: { root: !!h.root.current, canvas: !!h.root.current?.querySelector("canvas"), outlinerRows: h.root.current?.querySelectorAll(".as-row-t").length ?? 0 },
  };
}
export { assetPath };
