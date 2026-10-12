/**
 * A flight profile (data/<ns>/flight_profiles/*.json): the thruster jets on a preview suit, each hung from one of the body's
 * jet anchors, with its flame, and the arm / leg pose. The pose is previewed from one of four sources: the hover clip, the fast
 * clip (player-animator clips, played looping in real time), the propelled pose, or rest. Inherited jets (from `parent`) show
 * dimmed and read-only until the profile declares its own. A jet anchored on a limb rides that limb's live pose (core/flight.ts
 * `followLimb`), so its flame follows the boot or palm; a selected jet gets a move gizmo (`offset`) and a rotate gizmo
 * (`angle`), both relative to the limb: a drag in the scene is turned back into the limb's rest frame before it is written.
 * A clip moves the rig and the jets straight in three.js each frame (Viewport3D `live`), not through React.
 */
import { useMemo, useRef, useState } from "react";
import { openFile } from "../../../editor/store";
import { samplePose, type Animation, type Pose } from "../../animstudio/core";
import { JET_ANCHORS, jetAnchorFrame } from "../core/anchors";
import {
  angleToQuat, antiGravCones, effectiveClips, effectivePose, FLAME_DEFAULTS, flameCones, followPlacement, glowOn, isZero3, jetFrame, limbRotation, offsetForDelta, overrideJets, POSE_INFO, POSE_KEYS,
  propelledPose, quatToAngle, restDelta, setGlowEnabled, readVec3, setJetVec, setPoseValue, type PoseKey,
} from "../core/flight";
import { packRoot, stem } from "../core/kinds";
import { setJson } from "../core/suit";
import { loadCatalog, loadFlight, loadSuitModel, useAsync } from "./data";
import { loadClip, loadPoseChain, openFlightProfile } from "./flightData";
import { NewFlightProfile, ProfileSelect } from "./NewFlightProfile";
import { Docks, ParseError, type ViewProps } from "./PackView";
import { listData, resourceRoots } from "./resolve";
import { BoolField, ColorField, EnumField, NumberField, Row, Section, SceneTree, TextField, Vec3Field, type TreeNode } from "./widgets";
import { Viewport3D, type LiveFrame, type Marker, type Placed } from "./Viewport3D";
import { playerRigModel } from "../../animstudio/ui/model";
import type { NumVec3 } from "../../animstudio/core";

export { openFlightProfile };

type Source = "hover" | "fast" | "propelled" | "rest";
const SOURCES: Array<[Source, string]> = [["hover", "Hover clip"], ["fast", "Fast clip"], ["propelled", "Propelled pose"], ["rest", "Rest"]];

const PLAYER = playerRigModel();

const WHEN = ["always", "hover", "fast", "dash"];
const FLAME_NUM: Array<[string, string, number, number, number, number]> = [
  ["length", "Length", FLAME_DEFAULTS.length, 0.05, 0.05, 8], ["width", "Width", FLAME_DEFAULTS.width, 0.01, 0.01, 2], ["flicker", "Flicker", FLAME_DEFAULTS.flicker, 0.05, 0, 0.9],
  ["hover", "Hover share", FLAME_DEFAULTS.hover, 0.05, 0, 1],
];
const rnd = (n: number, dp: number) => Math.round(n * 10 ** dp) / 10 ** dp;

/** A slider with its number and a reset (removes the key). Drag = one undo step: the gesture closes on release. */
function PoseSlider({ k, value, inherited, own, onChange }: { k: PoseKey; value: number; inherited: number | undefined; own: boolean; onChange: (v: number | undefined, live: boolean) => void }) {
  const info = POSE_INFO[k];
  const cur = useRef(value);
  cur.current = value;
  const live = useRef(false);
  const end = () => { if (live.current) { live.current = false; onChange(cur.current, false); } }; // closes the drag's undo step
  return (
    <Row label={info.label} doc={info.doc} testId={`pe-pose-${k}`}>
      <input type="range" className="pe-range" min={info.min} max={info.max} step={info.step} value={value}
        onChange={(e) => { live.current = true; onChange(Number(e.target.value), true); }} onPointerUp={end} onKeyUp={end} onBlur={end} />
      <input className={"pe-in num pe-range-n" + (own ? "" : " dflt")} value={String(rnd(value, 2))}
        onChange={(e) => { const n = Number(e.target.value); if (e.target.value.trim() !== "" && Number.isFinite(n)) onChange(n, false); }} />
      <button className="pe-link" disabled={!own} title={inherited !== undefined ? `Back to the inherited ${inherited}` : "Back to the default"} onClick={() => onChange(undefined, false)} data-testid={`pe-pose-reset-${k}`}>↺</button>
    </Row>
  );
}

export default function FlightView({ host, path, text, edit }: ViewProps) {
  const { raw, error } = useMemo(() => { try { return { raw: JSON.parse(text) as Record<string, unknown>, error: null }; } catch (e) { return { raw: null, error: e }; } }, [text]);
  const pr = packRoot(path);
  const [roots] = useAsync(() => resourceRoots(host, path), [host, path], [] as string[]);
  const parent = typeof raw?.parent === "string" ? raw.parent : undefined;
  const [inherited] = useAsync(() => (roots.length && parent ? loadFlight(host, roots, parent) : Promise.resolve(null)), [roots, parent], null);
  const [poseChain] = useAsync(() => (roots.length && parent ? loadPoseChain(host, roots, parent) : Promise.resolve([])), [roots, parent], [] as Array<Record<string, unknown> | undefined>);
  const [suits] = useAsync(() => (roots.length && pr ? listData(host, roots, pr.ns, "armors", [".json"]) : Promise.resolve([])), [roots], [] as Array<{ id: string; path: string }>);
  const [preview, setPreview] = useState(() => { try { return localStorage.getItem("packeditor.previewSuit") ?? ""; } catch { return ""; } });
  const [model] = useAsync(() => (roots.length && pr && preview ? loadSuitModel(host, roots, pr.ns, preview) : Promise.resolve(null)), [roots, preview], null);
  const [sel, setSel] = useState<string | null>(null);
  const [mode, setMode] = useState<"translate" | "rotate">("translate");
  const [speed, setSpeed] = useState(0);
  const [source, setSource] = useState<Source | null>(null); // null: the profile's own (propelled / hover clip / rest)
  const [paused, setPaused] = useState(false);
  const [catVer, setCatVer] = useState(0); // bumped when a profile is created
  const head = useRef(0); // the clip's playhead, seconds (advanced by Viewport3D's frames, outside React)
  const liveRef = useRef<(dt: number) => LiveFrame | null>(() => null);
  const dragStart = useRef<NumVec3 | null>(null);
  const lastGlow = useRef(new Map<number, number>()); // the last non-zero glow per jet, for the toggle to restore

  const ownPoses = raw && typeof raw.poses === "object" && raw.poses && !Array.isArray(raw.poses) ? (raw.poses as Record<string, unknown>) : undefined;
  const eff = useMemo(() => effectivePose(ownPoses, poseChain), [ownPoses, poseChain]);
  const clips = useMemo(() => effectiveClips(ownPoses, poseChain), [ownPoses, poseChain]);
  const [hoverClip, hoverBusy] = useAsync(() => (roots.length && clips.hoverIdle ? loadClip(host, roots, clips.hoverIdle) : Promise.resolve(null)), [roots, clips.hoverIdle], null as Animation | null);
  const [fastClip, fastBusy] = useAsync(() => (roots.length && clips.loop ? loadClip(host, roots, clips.loop) : Promise.resolve(null)), [roots, clips.loop], null as Animation | null);
  const [catalog] = useAsync(() => (roots.length && pr ? loadCatalog(host, roots, pr.ns) : Promise.resolve(null)), [roots, catVer], null);
  if (error || !raw) return <ParseError error={error} />;

  const want: Source = source ?? (eff.style === "propelled" ? "propelled" : hoverClip ? "hover" : "rest");
  const clip = want === "hover" ? hoverClip : want === "fast" ? fastClip : null;
  const clipId = want === "hover" ? clips.hoverIdle : want === "fast" ? clips.loop : undefined;
  const clipBusy = want === "hover" ? hoverBusy : fastBusy;
  const shown: Source = want === "propelled" ? "propelled" : clip ? want : "rest"; // an unresolved clip falls back to rest
  const clipNote = (want === "hover" || want === "fast") && !clip && !clipBusy
    ? (clipId ? `Clip "${clipId}" is not in this project's animations/armor: showing rest.` : `No ${want} clip in this profile's chain: showing rest.`) : "";
  /** the preview pose at clip time `t` (file convention: what the rig takes and followLimb reads) */
  const poseAt = (t: number): Pose | null => (shown === "propelled" ? propelledPose(eff.values, speed) : clip ? samplePose(clip, t) : null);
  const pose = poseAt(head.current);
  const pickSource = (v: Source) => { setSource(v); if (v === "fast") setSpeed(1); else if (v === "hover") setSpeed(0); };

  const own = (raw.effects as { jets?: Array<Record<string, unknown>> } | undefined)?.jets;
  const jets = own ?? inherited?.jets.map((j) => j.raw) ?? [];
  const isOwn = !!own;
  const set = (p: Array<string | number>, v: unknown, live = false) => edit((cur) => setJson(cur, p, v), live);

  /** a jet's place at pose `p`: the rest placement (anchor + offset, base aim turned by angle) carried by its limb */
  const placeJet = (j: Record<string, unknown>, p: Pose | null): (Placed & { dir: NumVec3; quat: [number, number, number, number] }) | null => {
    const frame = jetAnchorFrame(String(j.anchor ?? ""));
    if (!frame) return null;
    const angle = readVec3(j.angle);
    const { pos, dir } = followPlacement(String(j.anchor), p, jetFrame(frame, j.aim as string | undefined, readVec3(j.offset), angle));
    return { pos, dir, quat: angleToQuat(angle, limbRotation(String(j.anchor), p)) };
  };
  const markers: Marker[] = jets.flatMap((j, i) => {
    const at = placeJet(j, pose);
    if (!at) return [];
    const f = j.flame && typeof j.flame === "object" ? (j.flame as Record<string, unknown>) : null;
    if (f && typeof f.glow === "number" && f.glow > 0) lastGlow.current.set(i, f.glow);
    return [{
      id: `jet:${i}`, pos: at.pos, dir: at.dir, color: isOwn ? "#64e9ff" : "#7d8ba3", label: String(j.anchor), dim: !isOwn, movable: isOwn, rotatable: isOwn, quat: at.quat,
      cones: f ? flameCones(f as Parameters<typeof flameCones>[0], speed) : undefined,
    } as Marker];
  });
  // a clip frame: the rig's pose and every jet's new place, applied by Viewport3D without a React render
  liveRef.current = (dt) => {
    if (!clip) return null;
    head.current += dt;
    const p = poseAt(head.current);
    const place: Record<string, Placed> = {};
    jets.forEach((j, i) => { const at = placeJet(j, p); if (at) place[`jet:${i}`] = at; });
    return { pose: p, place };
  };
  // the anti-gravity pad under each foot (JetFlameRenderer.drawAntiGrav), when this profile declares one
  const ag = (raw.effects as { antiGrav?: unknown } | undefined)?.antiGrav;
  if (ag && typeof ag === "object" && !Array.isArray(ag)) {
    for (const foot of ["rightFoot", "leftFoot"]) {
      const fr = jetAnchorFrame(foot)!;
      markers.push({ id: `pad:${foot}`, pos: fr.origin, dir: [0, -1, 0], color: "#ff1f3f", label: "", ghost: true, cones: antiGravCones(ag as Parameters<typeof antiGravCones>[0], speed) });
    }
  }
  const nodes: TreeNode[] = [{ id: "profile", label: path.split("/").pop()!.replace(/\.json$/, ""), icon: "i-flight", hint: parent ? `← ${parent.replace(/^thematic:/, "")}` : undefined,
    children: jets.map((j, i) => ({ id: `jet:${i}`, label: String(j.anchor ?? "?"), icon: "i-jet", hint: String(j.when ?? "fast"), dim: !isOwn })) }];

  const i = sel?.startsWith("jet:") ? Number(sel.slice(4)) : -1;
  const j = i >= 0 ? jets[i] : undefined;
  const P = (...k: Array<string | number>) => ["effects", "jets", i, ...k];

  const onDrag = (id: string, delta: NumVec3, phase: "move" | "end") => {
    const n = Number(id.slice(4));
    const frame = jetAnchorFrame(String(jets[n]?.anchor ?? ""));
    if (!frame) return;
    dragStart.current ??= readVec3(jets[n]?.offset);
    // the world drag, turned back into the limb's rest frame (a clip is frozen while dragging, so the pose is the one on screen)
    const o = offsetForDelta(frame, dragStart.current, restDelta(String(jets[n].anchor), pose, delta));
    edit((cur) => setJetVec(cur, n, "offset", o), phase === "move");
    if (phase === "end") dragStart.current = null;
  };
  const onRotate = (id: string, q: [number, number, number, number], phase: "move" | "end") => {
    const n = Number(id.slice(4));
    edit((cur) => setJetVec(cur, n, "angle", quatToAngle(q, limbRotation(String(jets[n]?.anchor ?? ""), pose))), phase === "move");
  };

  const poseSection = (open: boolean) => (
    <Section title="Pose" open={open}>
      <div className="pe-note" data-testid="pe-pose-note">
        {eff.style && eff.style !== "propelled" ? `Only the "propelled" style uses these (this profile's style is "${eff.style}"). ` : ""}
        A jet on an arm, palm, leg or foot rides that limb's pose (offset and angle are relative to the limb); head and body jets stay in the body frame.
      </div>
      {POSE_KEYS.map((k) => (
        <PoseSlider key={k} k={k} value={eff.values[k]} inherited={eff.inherited[k]} own={typeof ownPoses?.[k] === "number"}
          onChange={(v, live) => edit((cur) => setPoseValue(cur, k, v), live)} />
      ))}
    </Section>
  );

  const inspector = (() => {
    if (!j) return (
      <>
        <Section title="Profile">
          <TextField label="Parent" value={parent} mono placeholder="(none)" onChange={(v) => set(["parent"], v || undefined)} />
          {inherited?.path && <div className="pe-btns"><button className="pe-btn" onClick={() => void openFile({ host, path: inherited.path! })}>Open parent</button></div>}
          {!isOwn && inherited?.jets.length ? <div className="pe-btns"><button className="pe-btn" onClick={() => edit((cur) => overrideJets(cur, inherited.jets.map((x) => x.raw)))} data-testid="pe-jets-declare">Declare jets here</button></div> : null}
          {isOwn && <div className="pe-btns"><button className="pe-btn" onClick={() => set(["effects", "jets", jets.length], { anchor: "rightFoot", when: "always", flame: { core: "#FFFFFF", outer: "#FF8800" } })}>+ Jet</button></div>}
        </Section>
        {poseSection(true)}
      </>
    );
    const f = (j.flame ?? {}) as Record<string, unknown>;
    const offset = readVec3(j.offset), angle = readVec3(j.angle);
    if (!isOwn) return (
      <>
        <Section title={`Jet · ${j.anchor} (inherited)`}>
          <div className="pe-note" data-testid="pe-jet-inherited">This jet comes from {parent}. A profile's jets replace its parent's wholesale, so overriding copies all {jets.length} of them into this file; then you can move and turn each.</div>
          <div className="pe-note mono">offset {offset.join(", ")} · angle {angle.join(", ")} · aim {String(j.aim ?? "down")}</div>
          <div className="pe-btns"><button className="pe-btn" onClick={() => edit((cur) => overrideJets(cur, inherited!.jets.map((x) => x.raw)))} data-testid="pe-jet-override">Override in this profile</button></div>
        </Section>
        {poseSection(false)}
      </>
    );
    return (
      <>
        <Section title={`Jet · ${j.anchor}`} right={<button className="pe-link" onClick={() => { set(["effects", "jets", i], undefined); setSel(null); }}>Delete</button>}>
          <EnumField label="Anchor" value={String(j.anchor ?? "")} options={JET_ANCHORS} onChange={(v) => set(P("anchor"), v)} testId="pe-jet-anchor" />
          <EnumField label="Fires" value={j.when as string | undefined} options={WHEN} allowEmpty="(fast)" onChange={(v) => set(P("when"), v)} />
          <EnumField label="Aim" value={j.aim as string | undefined} options={["down", "palm"]} allowEmpty="(down)" onChange={(v) => set(P("aim"), v)} testId="pe-jet-aim" />
        </Section>
        <Section title="Placement">
          <Vec3Field label="Offset (px)" value={offset} step={0.25} axes={["r", "u", "f"]} testId="pe-jet-offset"
            doc="Model pixels (1/16 block) from the anchor: right, up, forward. On a limb anchor (arm, palm, leg, foot) they turn with the limb."
            onChange={(v, l) => edit((cur) => setJetVec(cur, i, "offset", v), l)} />
          <Vec3Field label="Angle (deg)" value={angle} step={1} axes={["p", "y", "r"]} testId="pe-jet-angle"
            doc="Pitch, yaw, roll in degrees, turning the flame from its aim. Roll first, then pitch (forward tips down), then yaw (forward turns right)."
            onChange={(v, l) => edit((cur) => setJetVec(cur, i, "angle", v), l)} />
          <div className="pe-btns">
            <button className="pe-btn sm" disabled={isZero3(offset)} onClick={() => edit((cur) => setJetVec(cur, i, "offset", [0, 0, 0]))} data-testid="pe-jet-offset-reset">Reset offset</button>
            <button className="pe-btn sm" disabled={isZero3(angle)} onClick={() => edit((cur) => setJetVec(cur, i, "angle", [0, 0, 0]))} data-testid="pe-jet-angle-reset">Reset angle</button>
          </div>
        </Section>
        <Section title="Flame">
          <ColorField label="Core" value={f.core as string | undefined} dflt={FLAME_DEFAULTS.core} onChange={(v, l) => set(P("flame", "core"), v, l)} />
          <ColorField label="Outer" value={f.outer as string | undefined} dflt={FLAME_DEFAULTS.outer} onChange={(v, l) => set(P("flame", "outer"), v, l)} />
          <BoolField label="Nozzle glow (wide circle)" value={glowOn(f)} testId="pe-glow-toggle"
            doc="The short, wide, faint cone at the nozzle (the wide circle). Off writes glow: 0; on brings back the last value, or 0.45."
            onChange={(v) => edit((cur) => setGlowEnabled(cur, i, v, lastGlow.current.get(i)))} />
          {glowOn(f) && <NumberField label="Glow" value={f.glow as number | undefined} placeholder={FLAME_DEFAULTS.glow} step={0.05} min={0.05} max={1} testId="pe-glow" onChange={(v, l) => set(P("flame", "glow"), v, l)} />}
          {FLAME_NUM.map(([k, label, d, step, min, max]) => <NumberField key={k} label={label} value={f[k] as number | undefined} placeholder={d} step={step} min={min} max={max} onChange={(v, l) => set(P("flame", k), v, l)} />)}
        </Section>
        {poseSection(false)}
      </>
    );
  })();

  const view = (
    <div className="pe-tabs-host">
      <div className="pe-tabs">
        <button className={mode === "translate" ? "on" : ""} onClick={() => setMode("translate")} data-testid="pe-mode-move" title="Move the selected jet (offset)">Move</button>
        <button className={mode === "rotate" ? "on" : ""} onClick={() => setMode("rotate")} data-testid="pe-mode-rotate" title="Turn the selected jet (angle)">Rotate</button>
        <label className="pe-tabs-l pe-spd">Speed
          <input type="range" className="pe-range" min={0} max={1} step={0.05} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} data-testid="pe-speed" />
          <span className="pe-spd-n">{speed === 0 ? "hover" : speed === 1 ? "full" : speed.toFixed(2)}</span>
        </label>
        <label className="pe-tabs-l pe-spd">Pose
          <select className="pe-in sel" value={want} onChange={(e) => pickSource(e.target.value as Source)} data-testid="pe-pose-source" title="Where the preview's arms and legs come from. The default is the profile's own: propelled, else its hover clip.">
            {SOURCES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
          </select>
        </label>
        {clip && <label className="pe-tabs-l pe-spd" title={`${clipId} (loops in real time)`}><input type="checkbox" checked={paused} onChange={(e) => setPaused(e.target.checked)} data-testid="pe-clip-pause" /> Pause</label>}
        {clipNote && <span className="pe-clip-note" data-testid="pe-clip-note">{clipNote}</span>}
        <label className="pe-pick">Preview on
          <input list="pe-suits-f" className="pe-in" value={preview} placeholder="(player)" onChange={(e) => { setPreview(e.target.value); try { localStorage.setItem("packeditor.previewSuit", e.target.value); } catch { /* per-viewer convenience */ } }} />
          <datalist id="pe-suits-f">{suits.slice(0, 2000).map((s) => <option key={s.id} value={s.id} />)}</datalist>
        </label>
      </div>
      <Viewport3D rig={model?.rig ?? PLAYER} texture={model?.texture ?? null} markers={markers} selected={sel} onSelect={(m) => setSel(m)} mode={mode}
        onDrag={isOwn ? onDrag : undefined} onRotate={isOwn ? onRotate : undefined} pose={pose} live={clip ? liveRef : null} animate={!!clip && !paused} testId="pe-vp3" />
    </div>
  );
  const selfId = `${pr?.ns ?? "thematic"}:${stem(path)}`;
  const profiles = catalog?.flightProfiles ?? [];
  const bar = (
    <>
      <label className="pe-fp-sw">Profile <ProfileSelect value={selfId} options={profiles} testId="pe-fp-switch" onChange={(v) => { if (v && v !== selfId) void openFlightProfile(host, path, v); }} /></label>
      <NewFlightProfile host={host} path={path} ns={pr?.ns ?? "thematic"} profiles={profiles} parent={selfId} label="New child profile…" testId="pe-fp-new"
        onCreated={(_id, file) => { setCatVer((n) => n + 1); void openFile({ host, path: file }); }} />
    </>
  );
  return <Docks id="flight" bar={bar} tree={<SceneTree nodes={nodes} selected={sel ?? "profile"} onSelect={(id) => setSel(id === "profile" ? null : id)} testId="pe-tree" />} view={view} inspector={inspector} />;
}
