/** Right panel: bone / cube properties (Edit), pose values (Animate/Pose) and the timeline agent's inspectors. */
import { perfRender } from "./perf";
import { useMemo, useState } from "react";
import {
  addKeyframe, allGroups, getAnimation, getBb, getKey, mirrorBoneName, samplePose, setBbGroup, type Doc, type NumVec3,
} from "../core";
import { useStudio, useStudioPick, useStudioState } from "./state";
import { ROOT_BONE, bbFlagMap, canEditDoc, cmdSetBone, cmdSetCube, editTargets, flagValue, opRenameBone, opToggleFlag, type BonePatchF, type CubePatchF, type FlagName } from "./ops";
import type { CubeRef } from "./selection";
import { toolsStore } from "./toolsUi";
import { ActionControl } from "./tools/ActionControl";
import { Check, Empty, NumField, Section, Vec3Field, Vec3Multi, common, commonNum } from "./widgets";
import type { RBone, RCube, RigModel } from "./model";

/** Lower half of the right column: bone / cube fields (Edit) or the pose fields of the selected bone (Animate / Pose). */
export function Properties({ rig, host }: { rig: RigModel | null; host: string }) {
  perfRender("Properties");
  const s = useStudioPick("mode", "doc");
  const animMode = s.mode !== "edit" && s.doc && s.doc.kind !== "geo";
  return (
    <div className="as-props" data-testid="as-props">
      {animMode ? <PoseProps /> : <ModelProps rig={rig} host={host} />}
      <ActionControl />
    </div>
  );
}

// ------------------------------------------------------------------ edit mode

function ModelProps({ rig, host }: { rig: RigModel | null; host: string }) {
  void host;
  const s = useStudioPick("doc", "bones", "cube", "cubes", "rig", "locked");
  const editable = canEditDoc(s.doc);
  if (editable && s.doc && rig) {
    const t = editTargets(s, rig);
    if (t.cubes.length) return <CubeProps doc={s.doc} rig={rig} refs={t.cubes} />;
    const bones = s.bones.filter((b) => b !== ROOT_BONE && rig.bones.some((x) => x.name === b));
    if (bones.length) return <BoneProps doc={s.doc} rig={rig} names={bones} />;
  }
  if (!editable && rig && s.bones[0]) return <ReadonlyBone rig={rig} name={s.bones[0]} />;
  return (
    <Section title="Element">
      {!rig ? <Empty>No model loaded</Empty> : (
        <div className="as-info">
          <div><span>Source</span><b>{s.rig?.label ?? rig.source}</b></div>
          {rig.identifier && <div><span>Identifier</span><b>{rig.identifier}</b></div>}
          <div><span>Bones</span><b>{rig.bones.filter((b) => b.name !== ROOT_BONE).length}</b></div>
          <div><span>Cubes</span><b>{rig.bones.reduce((n, b) => n + b.cubes.length, 0)}</b></div>
          <div><span>Texture</span><b>{rig.texW}×{rig.texH}</b></div>
          {!editable && <div className="as-note">{rig.source === "player" ? "Built-in preview rig. Pick a model in the toolbar." : "This document has no geometry to edit."}</div>}
          {editable && <div className="as-note">Select a bone or cube in the outliner or viewport. Cmd-click adds, Shift-click selects a range.</div>}
        </div>
      )}
    </Section>
  );
}

function ReadonlyBone({ rig, name }: { rig: RigModel; name: string }) {
  const b = rig.bones.find((x) => x.name === name);
  if (!b) return null;
  return (
    <Section title="Bone">
      <div className="as-info">
        <div><span>Name</span><b>{b.name}</b></div>
        {b.parent && <div><span>Parent</span><b>{b.parent}</b></div>}
        <div><span>Pivot</span><b>{b.pivot.join(", ")}</b></div>
        {b.rotation && <div><span>Rotation</span><b>{b.rotation.join(", ")}</b></div>}
        <div><span>Cubes</span><b>{b.cubes.length}</b></div>
      </div>
    </Section>
  );
}

/** Text field that commits on Enter / blur (Esc reverts). */
function TextField({ id, value, onCommit, placeholder }: { id?: string; value: string; onCommit: (v: string) => void; placeholder?: string }) {
  const [t, setT] = useState<string | null>(null);
  const done = () => { const v = (t ?? value).trim(); setT(null); if (v !== value) onCommit(v); };
  return (
    <input
      className="as-in" style={{ flex: 1, minWidth: 0 }} data-id={id} value={t ?? value} placeholder={placeholder} spellCheck={false}
      onChange={(e) => setT(e.target.value)} onBlur={done}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") { setT(null); (e.target as HTMLInputElement).blur(); } }}
    />
  );
}

type Target = { bone: string; index?: number };
/** Toggle row for one flag over several targets: checked when all have it, indeterminate when they differ. */
function FlagChecks({ doc, targets, names }: { doc: Doc; targets: Target[]; names: Array<[FlagName, string]> }) {
  const api = useStudio();
  const fm = useMemo(() => bbFlagMap(doc), [doc]);
  return (
    <>
      {names.map(([f, label]) => {
        const vals = targets.map((t) => flagValue(t.index === undefined ? fm.groups.get(t.bone) : fm.cubes.get(`${t.bone}#${t.index}`), f));
        const c = common(vals);
        return (
          <div className="as-row" key={f}><span className="as-row-l" /><div className="as-row-f"><Check id={`flag-${f}`} label={label} checked={c === true} mixed={c === undefined} onChange={() => { opToggleFlag(api, f, targets.length === 1 ? targets[0] : undefined); }} /></div></div>
        );
      })}
    </>
  );
}

function BoneProps({ doc, rig, names }: { doc: Doc; rig: RigModel; names: string[] }) {
  const api = useStudio();
  const isBb = doc.kind === "bbmodel";
  const bones = names.map((n) => rig.bones.find((b) => b.name === n)!).filter(Boolean);
  const first = bones[0];
  if (!first) return null;
  const multi = bones.length > 1;
  /** edit one axis of a vec3 field on every selected bone (the other axes keep each bone's own value) */
  const axis = (get: (b: RBone) => NumVec3, set: (b: RBone, v: NumVec3) => BonePatchF, label: string) => (i: 0 | 1 | 2, v: number) => {
    let d = doc;
    for (const b of bones) {
      const cur = get(b);
      const nv: NumVec3 = [cur[0], cur[1], cur[2]];
      nv[i] = v;
      d = cmdSetBone(d, b.name, set(b, nv));
    }
    api.commit(d, label);
  };
  const vec = (get: (b: RBone) => NumVec3): Array<number | undefined> => [0, 1, 2].map((i) => commonNum(bones.map((b) => get(b)[i])));
  const patchAll = (p: BonePatchF, label: string) => { let d = doc; for (const b of bones) d = cmdSetBone(d, b.name, p); api.commit(d, label); };
  const binding = !multi && isBb ? bbBinding(doc, first.name) : "";
  const targets = bones.map((b) => ({ bone: b.name }));
  return (
    <Section title={(isBb ? "Group" : "Bone") + (multi ? `s  ·  ${bones.length}` : "")}>
      {!multi && <div className="as-row"><span className="as-row-l">Name</span><div className="as-row-f"><TextField id="bone-name" value={first.name} onCommit={(v) => v && opRenameBone(api, first.name, v)} /></div></div>}
      {!multi && first.parent && <div className="as-row"><span className="as-row-l">Parent</span><div className="as-row-f"><span className="as-ro">{first.parent}</span></div></div>}
      <Vec3Multi id="bone-pivot" label="Pivot" value={vec((b) => b.pivot)} step={1} onAxis={axis((b) => b.pivot, (_b, v) => ({ pivot: v }), "Set Pivot")} />
      <Vec3Multi id="bone-rot" label="Rotation" value={vec((b) => b.rotation ?? [0, 0, 0])} step={1}
        onAxis={axis((b) => b.rotation ?? [0, 0, 0], (_b, v) => ({ rotation: v[0] === 0 && v[1] === 0 && v[2] === 0 ? null : v }), "Set Rotation")} />
      {!isBb && <div className="as-row"><span className="as-row-l">Inflate</span><div className="as-row-f"><NumField id="bone-inflate" value={commonNum(bones.map((b) => (b as RBone & { inflate?: number }).inflate ?? 0))} step={0.1} placeholder="—" onCommit={(v) => patchAll({ inflate: v === 0 ? null : v }, "Set Inflate")} /></div></div>}
      {isBb ? (
        <>
          <FlagChecks doc={doc} targets={targets} names={[["mirror_uv", "Mirror UV"], ["export", "Export"]]} />
          {!multi && <div className="as-row"><span className="as-row-l">Binding</span><div className="as-row-f"><TextField id="bone-binding" value={binding} placeholder="Bedrock bone binding (molang)" onCommit={(v) => api.commit(setBbGroup(doc, { group: first.name, patch: { bedrockBinding: v || null } }), "Set Binding")} /></div></div>}
        </>
      ) : (
        <div className="as-row"><span className="as-row-l" /><div className="as-row-f"><Check id="bone-mirror" label="Mirror UV" checked={common(bones.map((b) => !!(b as RBone & { mirror?: boolean }).mirror)) === true} mixed={common(bones.map((b) => !!(b as RBone & { mirror?: boolean }).mirror)) === undefined} onChange={(v) => patchAll({ mirror: v ? true : null }, "Set Mirror")} /></div></div>
      )}
    </Section>
  );
}

function CubeProps({ doc, rig, refs }: { doc: Doc; rig: RigModel; refs: CubeRef[] }) {
  const api = useStudio();
  const isBb = doc.kind === "bbmodel";
  const items = refs.map((r) => ({ ref: r, bone: rig.bones.find((b) => b.name === r.bone)!, cube: rig.bones.find((b) => b.name === r.bone)?.cubes.find((c) => c.index === r.index)! })).filter((x) => x.bone && x.cube);
  if (!items.length) return null;
  const multi = items.length > 1;
  const one = items[0];
  const nz = (v: NumVec3) => (v[0] === 0 && v[1] === 0 && v[2] === 0 ? null : v);
  const vec = (get: (c: RCube, b: RBone) => NumVec3): Array<number | undefined> => [0, 1, 2].map((i) => commonNum(items.map((x) => get(x.cube, x.bone)[i])));
  /** edit one axis on every selected cube; the other axes keep each cube's own value */
  const axis = (get: (c: RCube, b: RBone) => NumVec3, set: (v: NumVec3) => CubePatchF, label: string) => (i: 0 | 1 | 2, v: number) => {
    let d = doc;
    for (const x of items) {
      const cur = get(x.cube, x.bone);
      const nv: NumVec3 = [cur[0], cur[1], cur[2]];
      nv[i] = v;
      d = cmdSetCube(d, x.ref.bone, x.ref.index, set(nv));
    }
    api.commit(d, label);
  };
  const patchAll = (p: CubePatchF, label: string) => { let d = doc; for (const x of items) d = cmdSetCube(d, x.ref.bone, x.ref.index, p); api.commit(d, label); };
  const targets = items.map((x) => ({ bone: x.ref.bone, index: x.ref.index }));
  return (
    <Section title={multi ? `Cubes  ·  ${items.length}` : `Cube  ·  ${one.bone.name} #${one.cube.index + 1}`}>
      {isBb && !multi && <div className="as-row"><span className="as-row-l">Name</span><div className="as-row-f"><TextField id="cube-name" value={one.cube.name ?? ""} onCommit={(v) => patchAll({ name: v }, "Rename Cube")} /></div></div>}
      <Vec3Multi id="cube-origin" label="Origin" value={vec((c) => c.origin)} step={1} onAxis={axis((c) => c.origin, (v) => ({ origin: v }), "Move Cube")} />
      <Vec3Multi id="cube-size" label="Size" value={vec((c) => c.size)} step={1} onAxis={axis((c) => c.size, (v) => ({ size: v.map((n) => Math.max(0, n)) as NumVec3 }), "Resize Cube")} />
      <Vec3Multi id="cube-pivot" label="Pivot" value={vec((c, b) => c.pivot ?? b.pivot)} step={1} onAxis={axis((c, b) => c.pivot ?? b.pivot, (v) => ({ pivot: v }), "Set Pivot")} />
      <Vec3Multi id="cube-rot" label="Rotation" value={vec((c) => c.rotation ?? [0, 0, 0])} step={1} onAxis={axis((c) => c.rotation ?? [0, 0, 0], (v) => ({ rotation: nz(v) }), "Rotate Cube")} />
      <div className="as-row"><span className="as-row-l">Inflate</span><div className="as-row-f"><NumField id="cube-inflate" value={commonNum(items.map((x) => x.cube.inflate ?? 0))} step={0.1} placeholder="—" onCommit={(v) => patchAll({ inflate: v === 0 ? null : v }, "Set Inflate")} /></div></div>
      {isBb
        ? <FlagChecks doc={doc} targets={targets} names={[["mirror_uv", "Mirror UV"], ["shade", "Shading"], ["autouv", "Auto UV"], ["export", "Export"]]} />
        : <div className="as-row"><span className="as-row-l" /><div className="as-row-f"><Check id="cube-mirror" label="Mirror UV" checked={common(items.map((x) => !!x.cube.mirror)) === true} mixed={common(items.map((x) => !!x.cube.mirror)) === undefined} onChange={(v) => patchAll({ mirror: v ? true : null }, "Set Mirror")} /></div></div>}
    </Section>
  );
}

function bbBinding(doc: Doc, group: string): string {
  const m = getBb(doc);
  const g = allGroups(m).find((x) => x.name === group);
  for (const n of [g?.defNode, g?.outlinerNode]) {
    const v = n && getKey(n, "bedrock_binding");
    if (v && v.t === "s") return v.value;
  }
  return "";
}

// ------------------------------------------------------------------ animate / pose

function PoseProps() {
  perfRender("PoseProps");
  const api = useStudio();
  const s = useStudioState();
  const bones = s.bones;
  const anim = s.doc && s.anim ? getAnimation(s.doc, s.anim) : undefined;
  const pose = useMemo(() => (anim ? samplePose(anim, s.time) : {}), [anim, s.time]);
  if (!bones.length || !anim || !s.doc) {
    return <Section title="Pose"><Empty>{anim ? "Select a bone to pose it." : "No animation selected."}</Empty></Section>;
  }
  const bp = (b: string) => ({ ...pose[b], ...s.previewPose?.[b] });
  const time = Math.round((s.snapTicks ? Math.round(s.time / 0.05) * 0.05 : s.time) * 10000) / 10000;
  const mirror = toolsStore(api).get().mirrorAnimating;
  const cur = (b: string, channel: "rotation" | "position" | "scale"): NumVec3 => (bp(b)[channel] as NumVec3 | undefined) ?? (channel === "scale" ? [1, 1, 1] : [0, 0, 0]);
  const vec = (channel: "rotation" | "position" | "scale"): Array<number | undefined> => [0, 1, 2].map((i) => commonNum(bones.map((b) => cur(b, channel)[i])));
  /** a typed axis sets that axis on every selected bone's key at the playhead (other axes keep each bone's own value) */
  const key = (channel: "rotation" | "position" | "scale") => (axis: 0 | 1 | 2, nv: number) => {
    let d = s.doc!;
    const keys: Array<{ bone: string; channel: "rotation" | "position" | "scale"; time: number }> = [];
    for (const bone of bones) {
      const v: NumVec3 = [...cur(bone, channel)] as NumVec3;
      v[axis] = nv;
      d = addKeyframe(d, { anim: anim.name, bone, channel, time, value: v });
      keys.push({ bone, channel, time });
      // Mirror Animating: the counterpart bone gets the mirrored value (x-axis flip: rotation y,z and position x negated)
      const other = mirror ? mirrorBoneName(bone) : undefined;
      if (other && other !== bone && !bones.includes(other)) {
        const mv: NumVec3 = channel === "rotation" ? [v[0], -v[1], -v[2]] : channel === "position" ? [-v[0], v[1], v[2]] : v;
        d = addKeyframe(d, { anim: anim.name, bone: other, channel, time, value: mv });
        keys.push({ bone: other, channel, time });
      }
    }
    api.commit(d, bones.length > 1 ? "Set Keyframes" : "Set Keyframe");
    api.store.set({ keys });
  };
  return (
    <Section title={bones.length > 1 ? `Pose  ·  ${bones.length} bones` : `Pose  ·  ${bones[0]}`}>
      <Vec3Multi id="pose-rot" label="Rotation" value={vec("rotation")} step={1} onAxis={key("rotation")} />
      <Vec3Multi id="pose-pos" label="Position" value={vec("position")} step={1} onAxis={key("position")} />
      <Vec3Multi id="pose-scale" label="Scale" value={vec("scale")} step={0.1} onAxis={key("scale")} />
      <div className="as-note as-note-live"><span>Edits set a key at {time.toFixed(2)}s{bones.length > 1 ? " for every selected bone" : ""}.</span></div>
    </Section>
  );
}
