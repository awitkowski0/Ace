/**
 * An ability script (data/<ns>/abilities/**.js): where each of its renders leaves the body (drag the point on a preview suit),
 * and, when it has them, its command console (pages, desktop windows, widgets, theme - Ultron's Hive Control) and its
 * radial wheel, laid out the way the client draws them.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import type { NumVec3 } from "../../animstudio/core";
import { POINTS, POINT_DOC, anchorFrame, anchorValue, offsetForSceneDelta, type AnchorSpec } from "../core/anchors";
import { clampRect, readConsole, setConsoleProps, themeTokens, THEME_KEYS, type ConsoleModel, type ConsoleTarget, type ConsoleWindow } from "../core/console";
import { effectiveBeam, fromHands, readBeamVisuals, setBeamOption, setSuitBeam, suitAbilityIndex, suitBeamOwn, type BeamVisual } from "../core/beam";
import { applyEdits } from "../core/jsdsl";
import { packRoot, stem } from "../core/kinds";
import { readRenderSources, readSuit, setRenderFrom, type RenderSource } from "../core/suit";
import { addTimingRow, buildTimeline, findStatRows, findTuneRows, setLastsLiteral, setStatCell, setTuneCell, type StatRow, type TuneRow, type StatCol, type TimingCtx } from "../core/timing";
import { loadSuitModel, useAsync } from "./data";
import { BeamInspector, type CrossStatus, type SuitLayer } from "./BeamPanel";
import { TimelineView, TimingInspector, type TimingStatus } from "./TimingPanel";
import { currentText, editFile } from "./crossFile";
import { loadTimingFiles, newRowTarget, type TimingFiles } from "./timingData";
import { Docks, ParseError, type ViewProps } from "./PackView";
import { listData, resourceRoots, tr, translations } from "./resolve";
import { addAbilityLang, awaitingLang, langPath } from "./newAbilityData";
import { capture, BoolField, ColorField, Empty, EnumField, NumberField, Section, SceneTree, TextField, Vec3Field, type TreeNode } from "./widgets";
import { Viewport3D, type Marker } from "./Viewport3D";
import { playerRigModel } from "../../animstudio/ui/model";
import { openFile } from "../../../editor/store";

const PLAYER = playerRigModel();

type Tab = "renders" | "beam" | "timing" | "console" | "wheel";
const NO_FILES: TimingFiles = { files: [], ownDefaults: [] };
const baseName = (p: string) => p.replace(/\\/g, "/").split("/").pop() ?? p;

export default function AbilityView({ host, path, text, edit }: ViewProps) {
  const parsed = useMemo(() => {
    try { return { sources: readRenderSources(text), beams: readBeamVisuals(text), console: readConsole(text), error: null }; } catch (e) { return { sources: [] as RenderSource[], beams: [] as BeamVisual[], console: null as ConsoleModel | null, error: e }; }
  }, [text]);
  const pr = packRoot(path);
  const [roots] = useAsync(() => resourceRoots(host, path), [host, path], [] as string[]);
  const [lang] = useAsync(() => (roots.length && pr ? translations(host, roots, pr.ns) : Promise.resolve({} as Record<string, string>)), [roots], {} as Record<string, string>);
  const [suits] = useAsync(() => (roots.length && pr ? listData(host, roots, pr.ns, "armors", [".json"]) : Promise.resolve([])), [roots], [] as Array<{ id: string; path: string }>);
  const [preview, setPreview] = useState<string>(() => { try { return localStorage.getItem("packeditor.previewSuit") ?? ""; } catch { return ""; } });
  const [model] = useAsync(() => (roots.length && pr && preview ? loadSuitModel(host, roots, pr.ns, preview) : Promise.resolve(null)), [roots, preview], null);
  const [sel, setSel] = useState<string | null>(null);
  const [picked, setTab] = useState<Tab | null>(null);
  // until a tab is picked, open on what the file is mostly about (the text can arrive after the first render)
  const tab: Tab = picked ?? (parsed.console?.windows.length ? "console" : parsed.console?.wheel ? "wheel" : "renders");
  const [page, setPage] = useState<string | null>(null);
  const drag = useRef<{ id: string; base: AnchorSpec } | null>(null);

  // ---- the beam's suit layer and the timing sheets: other files, read through the buffer when they are open
  const name = stem(path);
  const isJs = path.endsWith(".js");
  const [rev, setRev] = useState(0);
  const suitEntry = suits.find((s) => s.id === preview);
  const [suitFile] = useAsync(() => (suitEntry ? currentText(host, suitEntry.path) : Promise.resolve(null)), [suitEntry?.path, rev], null as string | null);
  const suitLayer: SuitLayer | null = useMemo(() => {
    if (!suitEntry) return null;
    const index = suitFile && pr ? suitAbilityIndex(suitFile, pr.ns, name) : -1;
    return { id: suitEntry.id, path: suitEntry.path, index, own: index >= 0 && suitFile ? suitBeamOwn(suitFile, index) : {} };
  }, [suitEntry, suitFile, name]); // eslint-disable-line react-hooks/exhaustive-deps
  const suitOptions = useMemo(() => {
    if (!suitFile || !suitLayer || suitLayer.index < 0) return undefined;
    try { return readSuit(suitFile).abilities[suitLayer.index]?.options; } catch { return undefined; }
  }, [suitFile, suitLayer]);
  const [tfiles] = useAsync(() => (roots.length && pr && isJs ? loadTimingFiles(host, roots, pr) : Promise.resolve(NO_FILES)), [roots, rev, isJs], NO_FILES);
  const stats = useMemo(() => findStatRows(tfiles.files, name), [tfiles, name]);
  const ctx: TimingCtx = useMemo(() => ({ stat: stats[0], tune: findTuneRows(tfiles.files, name), suitOptions }), [stats, tfiles, name, suitOptions]);
  const timeline = useMemo(() => buildTimeline(text, ctx), [text, ctx]);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const [xstatus, setXStatus] = useState<{ beam: CrossStatus | null; timing: TimingStatus | null; err: string | null }>({ beam: null, timing: null, err: null });
  /** Edit another file, one at a time; reports how it went under the section that asked. */
  const cross = useCallback((which: "beam" | "timing", file: string, fn: (cur: string) => string | null) => {
    queue.current = queue.current.then(async () => {
      try {
        const r = await editFile(host, file, fn);
        if (!r) return;
        const st = { via: r.via, name: baseName(file), undo: r.undo ? () => { void r.undo!().then((ok) => { setXStatus((x) => ({ ...x, [which]: null, err: ok ? null : `${baseName(file)} changed since, so it was not restored.` })); setRev((n) => n + 1); }); } : undefined };
        setXStatus((x) => ({ ...x, [which]: st, err: null }));
        setRev((n) => n + 1);
      } catch (e) { setXStatus((x) => ({ ...x, err: String((e as Error)?.message ?? e) })); }
    });
  }, [host]);

  if (parsed.error) return <ParseError error={parsed.error} />;
  const { sources, beams, console: con } = parsed;
  const beamSrc = sources.filter((s) => s.kind === "thematic:beam").map((s) => s.index);
  const beamIdxOfSource = (si: number) => beamSrc.indexOf(si);
  const target = pr ? newRowTarget(tfiles, pr.root, pr.ns) : "";

  // ---- tree
  const nodes: TreeNode[] = [];
  nodes.push({ id: "renders", label: "Renders", icon: "i-folder", children: sources.map((s) => ({
    id: `src:${s.index}`, label: (s.kind ?? s.method).replace(/^thematic:/, ""), icon: "i-render",
    hint: s.from.length ? s.from.map((f) => (f.kind === "bone" ? f.bone : f.point)).join(", ") : s.fromRaw === undefined ? "eyes" : "?",
  })) });
  if (beams.length) nodes.push({ id: "beam", label: "Beam", icon: "i-render", children: beams.map((b) => ({ id: `beam:${b.index}`, label: `beam look · line ${b.line}`, icon: "i-render" })) });
  if (isJs) nodes.push({ id: "timing", label: "Timing", icon: "i-theme", hint: timeline.total === null ? undefined : `${Math.round(timeline.total * 100) / 100} s`, children: timeline.steps.filter((s) => s.kind === "phase").map((s) => ({ id: `phase:${s.name}`, label: s.name, icon: "i-entry", hint: s.seconds === null ? "?" : `${s.seconds} s` })) });
  if (con?.windows.length || con?.pages.length) {
    nodes.push({ id: "console", label: "Console", icon: "i-console", children: [
      { id: "theme", label: "Theme", icon: "i-theme" },
      ...con.pages.map((p) => ({ id: `page:${p.id}`, label: tr(lang, p.props.label) || p.id, icon: "i-page", children: con.windows.filter((w) => w.page === p.id).map((w) => winNode(w, lang)) })),
      ...con.windows.filter((w) => !w.page).map((w) => winNode(w, lang)),
    ] });
  }
  if (con?.wheel) nodes.push({ id: "wheel", label: "Wheel", icon: "i-wheel", children: con.wheel.entries.map((e) => ({ id: `entry:${e.id}`, label: tr(lang, e.props.label) || e.id, icon: "i-entry", dim: e.dynamic })) });

  const select = (id: string | null) => {
    setSel(id);
    if (!id) return;
    if (id === "beam" || id.startsWith("beam:")) setTab("beam");
    else if (id === "timing" || id.startsWith("phase:")) setTab("timing");
    else if (id === "renders" || id.startsWith("src:")) setTab("renders");
    else if (id === "wheel" || id.startsWith("entry:")) setTab("wheel");
    else if (id === "console" || id === "theme" || id.startsWith("win:") || id.startsWith("w:") || id.startsWith("page:")) {
      setTab("console");
      if (id.startsWith("page:")) setPage(id.slice(5));
      const w = id.startsWith("win:") || id.startsWith("w:") ? con?.windows.find((x) => x.id === id.split(":")[1]) : undefined;
      if (w?.page) setPage(w.page);
    }
  };

  const setFrom = (index: number, v: unknown, live = false) => edit((cur) => setRenderFrom(cur, index, v), live);
  const setOpt = (bi: number) => (key: string, v: unknown, live = false) => edit((cur) => setBeamOption(cur, bi, key, v), live);
  const setSuit = (key: string, v: unknown) => {
    if (!suitLayer || suitLayer.index < 0 || !pr) return;
    cross("beam", suitLayer.path, (cur) => { const i = suitAbilityIndex(cur, pr.ns, name); return i < 0 ? null : setSuitBeam(cur, i, key, v); });
  };
  const timingEdits = {
    setStat: (row: StatRow, col: StatCol, v: number) => cross("timing", row.path, (cur) => setStatCell(cur, name, col, v)),
    setTune: (row: TuneRow, v: number) => cross("timing", row.path, (cur) => setTuneCell(cur, name, row.key, v, row.own ? "own" : "all")),
    setLiteral: (phase: string, v: number) => edit((cur) => { const e = setLastsLiteral(cur, phase, v); return e ? applyEdits(cur, [e]) : cur; }),
    addRow: () => { if (pr && target) cross("timing", target, (cur) => addTimingRow(cur, pr.ns, name)); },
  };
  const setCon = (t: ConsoleTarget, v: Record<string, unknown>, live = false) => edit((cur) => setConsoleProps(cur, t, v), live);

  // ---- 3D markers: every anchor of every source
  const markers: Marker[] = sources.flatMap((s) => (s.from.length ? s.from : s.fromRaw === undefined ? [{ kind: "point", point: "eyes", offset: [0, 0, 0], relative: "facing" } as AnchorSpec] : []).map((spec, fi) => {
    const fr = anchorFrame(spec);
    const bv = s.kind === "thematic:beam" ? beams[beamIdxOfSource(s.index)] : undefined;
    // a beam visual is drawn from its point along the look (forward), as wide and long as the layers say
    const eff = bv ? effectiveBeam(bv.opts, suitLayer?.own, fromHands(bv.from)) : undefined;
    const label = `${(s.kind ?? s.method).replace(/^thematic:/, "")} · ${spec.kind === "bone" ? spec.bone : spec.point}${eff && eff.scale.value !== 1 ? ` · x${eff.scale.value}` : ""}`;
    return {
      id: `src:${s.index}:${fi}`, pos: fr.origin, dir: eff ? ([0, 0, -1] as NumVec3) : fr.out, color: "#88c0d0", label, movable: s.fromRaw !== undefined,
      beam: eff ? { length: eff.drawn.length * 16, width: Math.max(0.12, eff.drawn.radius * 16), glow: Math.max(0.3, eff.drawn.glow * 16), core: eff.coreColor.value, end: eff.glowColor.value, count: eff.count.value, spacing: eff.spacing.value * 16, fade: eff.drawn.cut, opacity: eff.opacity.value } : undefined,
    };
  }));
  const selSrc = sel?.startsWith("src:") ? sources[Number(sel.split(":")[1])] : undefined;
  const selBeam = sel === "beam" ? 0 : sel?.startsWith("beam:") ? Number(sel.slice(5)) : -1;
  const selMarker = selBeam >= 0 ? (beamSrc[selBeam] === undefined ? null : `src:${beamSrc[selBeam]}:0`) : sel && sel.split(":").length === 2 ? sel + ":0" : sel;

  const onDrag = (mid: string, delta: NumVec3, phase: "move" | "end") => {
    const [, si, fi] = mid.split(":").map(Number);
    const s = sources[si];
    const spec = s?.from[fi];
    if (!s || !spec) return;
    if (!drag.current || drag.current.id !== mid) drag.current = { id: mid, base: spec };
    const off = offsetForSceneDelta(drag.current.base, delta).map((v) => Math.round(v * 1000) / 1000) as NumVec3;
    const next = anchorValue({ ...drag.current.base, offset: off });
    const list = Array.isArray(s.fromRaw) ? s.from.map((f, i) => (i === fi ? next : anchorValue(f))) : next;
    setFrom(si, list, phase === "move");
    if (phase === "end") drag.current = null;
  };

  const view = (
    <div className="pe-tabs-host">
      <div className="pe-tabs">
        <button className={tab === "renders" ? "on" : ""} onClick={() => setTab("renders")}>Renders</button>
        {beams.length > 0 && <button className={tab === "beam" ? "on" : ""} onClick={() => select(selBeam >= 0 ? sel! : "beam:0")} data-testid="pe-tab-beam">Beam</button>}
        {isJs && <button className={tab === "timing" ? "on" : ""} onClick={() => select("timing")} data-testid="pe-tab-timing">Timing</button>}
        {(con?.windows.length ?? 0) > 0 && <button className={tab === "console" ? "on" : ""} onClick={() => setTab("console")} data-testid="pe-tab-console">Console</button>}
        {con?.wheel && <button className={tab === "wheel" ? "on" : ""} onClick={() => setTab("wheel")}>Wheel</button>}
        {(tab === "renders" || tab === "beam") && (
          <label className="pe-pick">Preview on
            <input list="pe-suits" className="pe-in" value={preview} placeholder="(player)" onChange={(e) => { setPreview(e.target.value); try { localStorage.setItem("packeditor.previewSuit", e.target.value); } catch { /* per-viewer convenience */ } }} />
            <datalist id="pe-suits">{suits.slice(0, 2000).map((s) => <option key={s.id} value={s.id} />)}</datalist>
          </label>
        )}
      </div>
      {(tab === "renders" || tab === "beam") && <Viewport3D rig={model?.rig ?? PLAYER} texture={model?.texture ?? null} markers={markers} selected={selMarker} onSelect={(m) => m && select(m.split(":").slice(0, 2).join(":"))} onDrag={onDrag} testId="pe-vp3" />}
      {tab === "timing" && <TimelineView tl={timeline} sel={sel} select={select} />}
      {tab === "console" && con && <ConsoleCanvas con={con} lang={lang} page={page ?? con.pages[0]?.id ?? null} setPage={setPage} sel={sel} select={select} setCon={setCon} />}
      {tab === "wheel" && con?.wheel && <WheelPreview con={con} lang={lang} sel={sel} select={select} />}
    </div>
  );

  const inspector = (() => {
    if (selSrc) return <SourceInspector s={selSrc} setFrom={(v, l) => setFrom(selSrc.index, v, l)} onBeam={beamIdxOfSource(selSrc.index) >= 0 ? () => select(`beam:${beamIdxOfSource(selSrc.index)}`) : undefined} />;
    if (selBeam >= 0) {
      const bv = beams[selBeam];
      return bv ? <BeamInspector bv={bv} hands={fromHands(bv.from)} suit={suitLayer} suitText={suitEntry ? baseName(suitEntry.path) : null} setOpt={setOpt(selBeam)} setSuit={setSuit} status={xstatus.beam}
        openSuit={() => suitEntry && void openFile({ host, path: suitEntry.path })} /> : <Empty title="No such beam" />;
    }
    if (sel === "timing" || sel?.startsWith("phase:")) return <TimingInspector name={name} ctx={ctx} stats={stats} timeline={timeline} previewId={preview} target={target} edits={timingEdits} status={xstatus.timing} sel={sel} />;
    if (!con) return sources.length ? <Empty title="Select a render" detail="Pick one in the tree or the view to move where it comes out." /> : <Empty title="This ability draws nothing from the body" />;
    if (sel === "theme" || sel === "console") return <ThemeInspector con={con} setCon={setCon} />;
    if (sel?.startsWith("page:")) {
      const p = con.pages.find((x) => x.id === sel.slice(5));
      return p ? (
        <Section title={`Page · ${p.id}`}>
          <TextField label="Label" value={p.props.label as string} mono onChange={(v) => setCon({ t: "page", id: p.id }, { label: v })} />
          <TextField label="Icon" value={p.props.icon as string} mono placeholder="(none)" onChange={(v) => setCon({ t: "page", id: p.id }, { icon: v || undefined })} />
        </Section>
      ) : null;
    }
    if (sel?.startsWith("win:")) {
      const w = con.windows.find((x) => x.id === sel.slice(4));
      return w ? <WindowInspector w={w} lang={lang} setCon={setCon} /> : null;
    }
    if (sel?.startsWith("w:")) {
      const [, win, wid] = sel.split(":");
      const w = con.windows.find((x) => x.id === win)?.widgets.find((x) => x.id === wid);
      return w ? <PropsInspector title={`${w.kind} · ${w.id}`} props={w.props} lang={lang} onChange={(k, v, l) => setCon({ t: "widget", window: win, id: wid }, { [k]: v }, l)} /> : null;
    }
    if (sel === "wheel" && con.wheel) return (
      <Section title="Wheel">
        <ColorField label="Colour" value={con.wheel.props.color as string} onChange={(v, l) => setCon({ t: "wheel" }, { color: v }, l)} />
        <ColorField label="Accent" value={con.wheel.props.accent as string} onChange={(v, l) => setCon({ t: "wheel" }, { accent: v }, l)} />
      </Section>
    );
    if (sel?.startsWith("entry:") && con.wheel) {
      const e = con.wheel.entries.find((x) => x.id === sel.slice(6));
      if (!e) return null;
      if (e.dynamic) return <Empty title="Built in a loop" detail="This entry's id is computed in the script, so edit it there." />;
      return <PropsInspector title={`Entry · ${e.id}`} props={e.props} lang={lang} onChange={(k, v, l) => setCon({ t: "entry", id: e.id }, { [k]: v }, l)} />;
    }
    return <ThemeInspector con={con} setCon={setCon} />;
  })();

  return <Docks id="ability" tree={<SceneTree nodes={nodes} selected={sel} onSelect={select} testId="pe-tree" />} view={view} inspector={inspector} bar={<><NewAbilityLangNote host={host} path={path} />{xstatus.err && <span className="pe-note warn" data-testid="pe-cross-error">{xstatus.err}</span>}</>} />;
}

const winNode = (w: ConsoleWindow, lang: Record<string, string>): TreeNode => ({
  id: `win:${w.id}`, label: tr(lang, w.props.title) || w.id, icon: "i-window", hint: w.page ? undefined : "every page",
  children: w.widgets.map((x) => ({ id: `w:${w.id}:${x.id}`, label: tr(lang, x.props.label) || x.id, icon: "i-widget", hint: x.kind })),
});

function SourceInspector({ s, setFrom, onBeam }: { s: RenderSource; setFrom: (v: unknown, live?: boolean) => void; onBeam?: () => void }) {
  const list = s.from.length ? s.from : [{ kind: "point", point: "eyes", offset: [0, 0, 0], relative: "facing" } as AnchorSpec];
  const write = (i: number, a: AnchorSpec, live = false) => {
    const v = anchorValue(a);
    setFrom(Array.isArray(s.fromRaw) ? list.map((f, j) => (j === i ? v : anchorValue(f))) : v, live);
  };
  return (
    <>
      <Section title={(s.kind ?? s.method).replace(/^thematic:/, "")}>
        <div className="pe-note">Line {s.line}. {s.fromRaw === undefined ? "No from: it leaves the eyes. Pick a point to set one." : ""}</div>
        {onBeam && <div className="pe-btns"><button className="pe-btn" data-testid="pe-to-beam" onClick={onBeam}>Edit the beam's look</button></div>}
      </Section>
      {list.map((a, i) => (
        <Section key={i} title={list.length > 1 ? `From #${i + 1}` : "Comes out of"}>
          <EnumField label="Point" value={a.kind === "bone" ? "(bone)" : a.point} options={[...POINTS, "(bone)"]} labels={(o) => (o === "(bone)" ? "a model bone" : `${o} · ${POINT_DOC[o as keyof typeof POINT_DOC]}`)}
            onChange={(v) => write(i, v === "(bone)" ? { kind: "bone", bone: "armorRightArm", offset: [0, 0, 0], relative: "facing" } : { ...a, kind: "point", point: v as AnchorSpec["point"], bone: undefined })} testId="pe-from-point" />
          {a.kind === "bone" && <TextField label="Bone" value={a.bone} mono onChange={(v) => write(i, { ...a, bone: v })} />}
          {a.point !== "arm" && <Vec3Field label="Offset" value={a.offset} step={0.01} axes={a.kind === "bone" ? ["x", "y", "z"] : ["right", "up", "fwd"]} onChange={(v, l) => write(i, { ...a, offset: v }, l)} testId="pe-from-offset" doc="Blocks" />}
          {a.kind === "point" && <EnumField label="Relative to" value={a.relative} options={["facing", "look", "world"]} onChange={(v) => write(i, { ...a, relative: (v ?? "facing") as AnchorSpec["relative"] })} />}
          {a.point === "arm" && <EnumField label="Side" value={a.side ?? "right"} options={["right", "left"]} onChange={(v) => write(i, { ...a, side: v as "right" | "left" })} />}
          {a.point === "arm" && <NumberField label="Sweep" value={a.sweep} step={1} onChange={(v, l) => write(i, { ...a, sweep: v }, l)} doc="Degrees turned every tick" />}
        </Section>
      ))}
    </>
  );
}

function ThemeInspector({ con, setCon }: { con: ConsoleModel; setCon: (t: ConsoleTarget, v: Record<string, unknown>, live?: boolean) => void }) {
  const tok = themeTokens(con.theme);
  const T = (k: string) => (v: unknown, l?: boolean) => setCon({ t: "theme" }, { [k]: v }, l);
  return (
    <Section title="Theme">
      {THEME_KEYS.map((k) => <ColorField key={k} label={k} value={con.theme[k] as string | undefined} dflt={(tok as Record<string, unknown>)[k] as string} onChange={T(k)} testId={`pe-theme-${k}`} />)}
      <NumberField label="Opacity" value={con.theme.opacity as number | undefined} placeholder={0.85} step={0.01} min={0.2} max={1} onChange={T("opacity")} />
      <NumberField label="Font scale" value={con.theme.fontScale as number | undefined} placeholder={1} step={0.05} min={0.6} max={2} onChange={T("fontScale")} />
      <NumberField label="Gap" value={con.theme.gap as number | undefined} placeholder={0} step={1} min={0} max={12} onChange={T("gap")} />
      <NumberField label="Corner radius" value={con.theme.radius as number | undefined} placeholder={0} step={1} min={0} max={3} onChange={T("radius")} />
      <BoolField label="Scanlines" value={con.theme.scanlines as boolean | undefined} onChange={T("scanlines")} />
    </Section>
  );
}

function WindowInspector({ w, lang, setCon }: { w: ConsoleWindow; lang: Record<string, string>; setCon: (t: ConsoleTarget, v: Record<string, unknown>, live?: boolean) => void }) {
  const t: ConsoleTarget = { t: "window", id: w.id };
  return (
    <Section title={`Window · ${tr(lang, w.props.title) || w.id}`}>
      <TextField label="Title" value={w.props.title as string} mono onChange={(v) => setCon(t, { title: v })} />
      {(["x", "y", "w", "h"] as const).map((k) => (
        <NumberField key={k} label={{ x: "Left", y: "Top", w: "Width", h: "Height" }[k]} value={w.rect[k]} step={0.005} min={0} max={1} onChange={(v, l) => setCon(t, { [k]: v }, l)} testId={`pe-win-${k}`} doc="Share of the screen" />
      ))}
      <BoolField label="Resizable" value={w.props.resizable as boolean | undefined} dflt={true} onChange={(v) => setCon(t, { resizable: v })} />
      <BoolField label="Starts minimized" value={w.props.minimized as boolean | undefined} onChange={(v) => setCon(t, { minimized: v })} />
    </Section>
  );
}

/** A generic object's literal props: strings, numbers, booleans and colours get editors; anything structured shows as text. */
function PropsInspector({ title, props, lang, onChange }: { title: string; props: Record<string, unknown>; lang: Record<string, string>; onChange: (k: string, v: unknown, live?: boolean) => void }) {
  return (
    <Section title={title}>
      {Object.entries(props).map(([k, v]) => {
        if (typeof v === "number") return <NumberField key={k} label={k} value={v} step={Number.isInteger(v) ? 1 : 0.01} onChange={(x, l) => onChange(k, x, l)} />;
        if (typeof v === "boolean") return <BoolField key={k} label={k} value={v} onChange={(x) => onChange(k, x)} />;
        if (typeof v === "string" && /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v)) return <ColorField key={k} label={k} value={v} onChange={(x, l) => onChange(k, x, l)} />;
        if (typeof v === "string") return <TextField key={k} label={k} value={v} mono doc={lang[v] ? `"${lang[v]}"` : undefined} onChange={(x) => onChange(k, x)} />;
        return <div key={k} className="pe-row"><div className="pe-row-l">{k}</div><div className="pe-row-r pe-ro">{v === undefined ? "(in code)" : JSON.stringify(v)}</div></div>;
      })}
    </Section>
  );
}

// ---------------------------------------------------------------- console desktop

function ConsoleCanvas({ con, lang, page, setPage, sel, select, setCon }: {
  con: ConsoleModel; lang: Record<string, string>; page: string | null; setPage: (p: string) => void; sel: string | null; select: (id: string) => void;
  setCon: (t: ConsoleTarget, v: Record<string, unknown>, live?: boolean) => void;
}) {
  const tok = themeTokens(con.theme);
  const box = useRef<HTMLDivElement>(null);
  const shown = con.windows.filter((w) => !w.page || w.page === page);
  const start = (e: React.PointerEvent, w: ConsoleWindow, mode: "move" | "size") => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    select(`win:${w.id}`);
    const el = box.current!.getBoundingClientRect();
    const x0 = e.clientX, y0 = e.clientY;
    const r0 = w.rect;
    const target = e.currentTarget as HTMLElement;
    capture(target, e.pointerId);
    const calc = (ev: PointerEvent) => {
      const dx = (ev.clientX - x0) / el.width, dy = (ev.clientY - y0) / el.height;
      return clampRect(mode === "move" ? { ...r0, x: r0.x + dx, y: r0.y + dy } : { ...r0, w: r0.w + dx, h: r0.h + dy });
    };
    const mv = (ev: PointerEvent) => { const r = calc(ev); setCon({ t: "window", id: w.id }, mode === "move" ? { x: r.x, y: r.y } : { w: r.w, h: r.h }, true); };
    const up = (ev: PointerEvent) => {
      target.removeEventListener("pointermove", mv); target.removeEventListener("pointerup", up);
      const r = calc(ev);
      if (Math.abs(ev.clientX - x0) + Math.abs(ev.clientY - y0) > 1) setCon({ t: "window", id: w.id }, mode === "move" ? { x: r.x, y: r.y } : { w: r.w, h: r.h }, false);
    };
    target.addEventListener("pointermove", mv);
    target.addEventListener("pointerup", up);
  };
  return (
    <div className="pe-stage">
      <div className="pe-screen console" ref={box} data-testid="pe-console" style={{ background: tok.background, color: tok.text, ["--c-accent" as string]: tok.accent, ["--c-border" as string]: tok.border, ["--c-surface" as string]: tok.surface, ["--c-alt" as string]: tok.surfaceAlt, ["--c-muted" as string]: tok.textMuted, ["--c-active" as string]: tok.borderActive }}
        onPointerDown={() => select("theme")}>
        {con.pages.length > 0 && (
          <div className="pe-ctabs" onPointerDown={(e) => e.stopPropagation()}>
            {con.pages.map((p) => <button key={p.id} className={p.id === page ? "on" : ""} onClick={() => { setPage(p.id); select(`page:${p.id}`); }}>{tr(lang, p.props.label) || p.id}</button>)}
          </div>
        )}
        {shown.map((w) => {
          const on = sel === `win:${w.id}` || sel?.startsWith(`w:${w.id}:`);
          return (
            <div key={w.id} className={"pe-cwin" + (on ? " on" : "")} data-win={w.id}
              style={{ left: `${w.rect.x * 100}%`, top: `${w.rect.y * 100}%`, width: `${w.rect.w * 100}%`, height: `${w.rect.h * 100}%`, opacity: tok.opacity }}
              onPointerDown={(e) => start(e, w, "move")}>
              <div className="pe-cwin-t">{tr(lang, w.props.title) || w.id}</div>
              <div className="pe-cwin-b">
                {w.widgets.map((x) => (
                  <div key={x.id} className={"pe-cw k-" + x.kind + (sel === `w:${w.id}:${x.id}` ? " on" : "")} onPointerDown={(e) => { e.stopPropagation(); select(`w:${w.id}:${x.id}`); }}>
                    <span className="pe-cw-l">{tr(lang, x.props.label) || x.id}</span>
                    {typeof x.props.hotkey === "string" && <span className="pe-cw-k">{x.props.hotkey}</span>}
                    {x.kind === "units" && <span className="pe-cw-cards">{Array.from({ length: Number(x.props.slots ?? 3) }, (_, i) => <i key={i} />)}</span>}
                    {x.kind === "map" && <span className="pe-cw-map" />}
                  </div>
                ))}
              </div>
              <span className="pe-cwin-r" onPointerDown={(e) => start(e, w, "size")} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function WheelPreview({ con, lang, sel, select }: { con: ConsoleModel; lang: Record<string, string>; sel: string | null; select: (id: string) => void }) {
  const wheel = con.wheel!;
  const es = wheel.entries;
  const color = (wheel.props.color as string) ?? "#2E3440";
  const accent = (wheel.props.accent as string) ?? "#88C0D0";
  const R = 120;
  return (
    <div className="pe-stage">
      <svg className="pe-wheel" viewBox="-160 -160 320 320" onPointerDown={() => select("wheel")}>
        <circle r={R + 18} fill={color} opacity={0.85} stroke={accent} strokeWidth={2} />
        <circle r={42} fill="#0008" />
        {es.map((e, i) => {
          const a = (i / Math.max(1, es.length)) * Math.PI * 2 - Math.PI / 2;
          const on = sel === `entry:${e.id}`;
          return (
            <g key={e.id} transform={`translate(${Math.cos(a) * 88} ${Math.sin(a) * 88})`} onPointerDown={(ev) => { ev.stopPropagation(); select(`entry:${e.id}`); }} style={{ cursor: "pointer" }}>
              <circle r={22} fill={on ? accent : "#0006"} stroke={accent} strokeWidth={on ? 2 : 1} />
              <text textAnchor="middle" dy="4" fontSize="9" fill="#fff">{(tr(lang, e.props.label) || e.id).slice(0, 10)}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** After "Create ability": the new ability has no display name yet. Offers the two lang entries (HUD name and guide/menu name). */
function NewAbilityLangNote({ host, path }: { host: string; path: string }) {
  const [, bump] = useState(0);
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const info = awaitingLang.get(path);
  if (done) return <span className="pe-note" data-testid="pe-lang-done">Added the display name to {done}. Save it with the lang file's tab.</span>;
  if (!info) return null;
  return (
    <span className="pe-langnote" data-testid="pe-lang-note">
      <span>
        Add a display name in lang: <span className="mono">{info.id}</span> and <span className="mono">ability.thematic.{info.id}</span> in <span className="mono">{langPath("").replace(/^\//, "")}</span>.
      </span>
      <button className="pe-btn" data-testid="pe-lang-add" onClick={() => {
        setErr(null);
        addAbilityLang(host, info.root, info.id, info.title).then((p) => { awaitingLang.delete(path); setDone(p); }, (e) => setErr(String(e?.message ?? e)));
      }}>Add “{info.title}”</button>
      <button className="pe-btn" onClick={() => { awaitingLang.delete(path); bump((n) => n + 1); }}>Dismiss</button>
      {err && <span className="pe-note warn" data-testid="pe-lang-error">{err}</span>}
    </span>
  );
}
