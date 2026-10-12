import { useMemo, useState } from "react";
import { KIND_TIP, addAnimation, animLength, deleteAnimation, duplicateAnimation, getAnimations, renameAnimation, setLength, setLoop, type ClipInfo, type LoopMode } from "../../core";
import { confirmDialog, promptDialog } from "../../../shell/dialogs";
import { showContextMenu } from "../../../shell/contextMenu";
import { runAction } from "../../../../actions/registry";
import { useStudio } from "../state";
import { IcCopy, IcEdit, IcPlus, IcTrash } from "./icons";
import { useStudioSel } from "./hooks";
import { ensureStyles } from "./styles";

const LOOPS: Array<{ v: string; label: string; mode: LoopMode }> = [
  { v: "true", label: "Loop", mode: true },
  { v: "false", label: "Play once", mode: false },
  { v: "hold", label: "Hold on last frame", mode: "hold_on_last_frame" },
];
const loopKey = (l: LoopMode) => (l === true ? "true" : l === "hold_on_last_frame" ? "hold" : "false");

/** Unique `base`, `base_2`… name given the existing names. */
export function uniqueName(base: string, taken: readonly string[]): string {
  if (!taken.includes(base)) return base;
  const m = /^(.*?)(?:_(\d+))?$/.exec(base)!;
  for (let i = (m[2] ? parseInt(m[2], 10) : 1) + 1; ; i++) {
    const n = `${m[1]}_${i}`;
    if (!taken.includes(n)) return n;
  }
}

export function AnimationsPanel() {
  const api = useStudio();
  ensureStyles();
  const doc = useStudioSel((s) => s.doc);
  const sel = useStudioSel((s) => s.anim);
  const clipInfo = useStudioSel((s) => s.clipInfo);
  const problems = useStudioSel((s) => s.problems);
  const [q, setQ] = useState("");
  const anims = useMemo(() => (doc ? getAnimations(doc) : []), [doc]);
  const names = anims.map((a) => a.name);
  const shown = anims.filter((a) => !q || a.name.toLowerCase().includes(q.toLowerCase()) || clipInfo[a.name]?.role?.toLowerCase().includes(q.toLowerCase()));
  const probBy = useMemo(() => {
    const m = new Map<string, { e: number; w: number }>();
    for (const p of problems) {
      const c = m.get(p.anim) ?? { e: 0, w: 0 };
      if (p.severity === "error") c.e++; else if (p.severity === "warning") c.w++;
      m.set(p.anim, c);
    }
    return m;
  }, [problems]);
  const current = anims.find((a) => a.name === sel);

  const select = (name: string) => api.store.set({ anim: name, keys: [], time: 0, playing: false, previewPose: null });
  const guard = (fn: () => void) => { try { fn(); } catch (e) { void confirmDialog({ title: "Animation", message: String((e as Error).message), okLabel: "OK" }); } };

  const add = async () => {
    if (!doc) return;
    const prefix = names[0]?.startsWith("animation.") ? "animation." : "";
    const name = await promptDialog({ title: "New animation", initial: uniqueName(prefix + "new_animation", names), okLabel: "Create" });
    if (!name?.trim()) return;
    guard(() => { api.commit(addAnimation(doc, { name: name.trim(), length: 1, loop: false }), "Add Animation"); select(name.trim()); });
  };
  const rename = async () => {
    if (!doc || !current) return;
    const name = await promptDialog({ title: "Rename animation", initial: current.name, okLabel: "Rename" });
    if (!name?.trim() || name === current.name) return;
    guard(() => { api.commit(renameAnimation(doc, { name: current.name, newName: name.trim() }), "Rename Animation"); api.store.set({ anim: name.trim() }); });
  };
  const dup = () => {
    if (!doc || !current) return;
    const n = uniqueName(current.name, names);
    guard(() => { api.commit(duplicateAnimation(doc, { name: current.name, newName: n }), "Duplicate Animation"); select(n); });
  };
  const del = async () => {
    if (!doc || !current) return;
    if (!(await confirmDialog({ title: "Delete animation", message: `Delete "${current.name}"? You can undo this with ⌘Z.`, okLabel: "Delete" }))) return;
    const i = names.indexOf(current.name);
    const next = names[i + 1] ?? names[i - 1] ?? null;
    guard(() => { api.commit(deleteAnimation(doc, { name: current.name }), "Delete Animation"); api.store.set({ anim: next, keys: [], time: 0 }); });
  };

  return (
    <div className="as-panel" data-testid="as-animations">
      <div className="as-ph">
        <span className="title">Animations</span>
        <button className="as-btn" title="New animation" onClick={add} disabled={!doc}><IcPlus /></button>
        <button className="as-btn" title="More animation actions (duplicate, rename, delete, flip, bake...)" disabled={!current} data-testid="as-anim-more" onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const act = (id: string) => () => runAction(id);
          showContextMenu(r.left, r.bottom + 2, [
            { label: "Duplicate", run: dup },
            { label: "Rename", shortcut: "F2", run: rename },
            { label: "Delete", run: del },
            { separator: true, label: "" },
            { label: "Flip Animation X (swap left / right)", run: act("Studio.FlipX") },
            { label: "Flip Animation Y", run: act("Studio.FlipY") },
            { label: "Flip Animation Z", run: act("Studio.FlipZ") },
            { separator: true, label: "" },
            { label: "Scale Animation Time…", run: act("Studio.ScaleAnimation") },
            { label: doc?.kind === "bbmodel" ? "Bake Bezier Segments" : "Bake Animation", run: act("Studio.BakeAnimation") },
            { label: "Snap Keyframes to Ticks", run: act("Studio.SnapKeys") },
            { separator: true, label: "" },
            { label: "Set Animation End to Playhead", shortcut: "⌘End", run: act("Studio.SetAnimationEnd") },
          ]);
        }}>⋯</button>
      </div>
      <input className="as-in as-search" placeholder="Search animations…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="as-list">
        {shown.map((a) => (
          <AnimRow key={a.name} name={a.name} selected={a.name === sel} info={clipInfo[a.name]} probs={probBy.get(a.name)} length={animLength(a)} onClick={() => select(a.name)} onDouble={rename} />
        ))}
        {!shown.length && <div className="as-empty">{doc ? (anims.length ? "No matches" : "No animations. Click + to add one.") : "No document"}</div>}
      </div>
      {current && doc && (
        <div className="as-pf">
          <label>Loop</label>
          <select className="as-sel" value={loopKey(current.loop)} onChange={(e) => guard(() => api.commit(setLoop(doc, { anim: current.name, loop: LOOPS.find((l) => l.v === e.target.value)!.mode }), "Change Loop Mode"))}>
            {LOOPS.map((l) => <option key={l.v} value={l.v}>{l.label}</option>)}
          </select>
          <label>Length</label>
          <LengthField key={current.name + animLength(current)} value={animLength(current)} onCommit={(v) => guard(() => api.commit(setLength(doc, { anim: current.name, length: v }), "Change Animation Length"))} />
        </div>
      )}
    </div>
  );
}

function LengthField({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
  const [t, setT] = useState(String(+value.toFixed(4)));
  const done = () => { const v = parseFloat(t); if (isFinite(v) && v > 0 && Math.abs(v - value) > 1e-9) onCommit(Math.round(v * 10000) / 10000); else setT(String(+value.toFixed(4))); };
  return (
    <div className="as-row">
      <input className="as-in num" style={{ width: 70 }} value={t} onChange={(e) => setT(e.target.value)} onBlur={done} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
      <span className="as-hint" style={{ whiteSpace: "nowrap" }}>s · {Math.round(value * 20)}t</span>
    </div>
  );
}

function AnimRow(p: { name: string; selected: boolean; info?: ClipInfo; probs?: { e: number; w: number }; length: number; onClick: () => void; onDouble: () => void }) {
  const i = p.info;
  const m = /^(animation\.[^.]*\.|animation\.)?(.*)$/.exec(p.name)!;
  const chips: Array<{ cls: string; text: string; tip: string }> = [];
  if (i) {
    chips.push({ cls: "kind " + i.kind, text: i.kindLabel, tip: KIND_TIP[i.kind] });
    if (i.role) chips.push({ cls: "role", text: i.role, tip: "Role" });
    if (i.playback) chips.push({ cls: "pb", text: i.playback, tip: "Playback" });
    if (i.usedByStates.length > 0) chips.push({ cls: "state", text: i.usedByStates.length === 1 ? i.usedByStates[0] : `${i.usedByStates.length} states`, tip: "Used by: " + i.usedByStates.join(", ") });
    if (i.mirrored) chips.push({ cls: "mir", text: "mirrored", tip: "Mirrored L\u2194R in game" });
    if (i.inPoseSet) chips.push({ cls: i.poseOnly ? "pose" : "", text: i.poseOnly ? "pose-only" : "broadcast", tip: i.poseOnly ? "Applied only through the limb driver (not broadcast)" : "Broadcast through playerAnimator" });
    if (i.spin) chips.push({ cls: "", text: "spin", tip: `Whole-body spin about the hinge: ${i.spin.axis} x${i.spin.turns}${i.spin.ticks ? ` over ${i.spin.ticks} ticks` : " over the move's own trick length"}` });
    if (i.aimed.length) chips.push({ cls: "pose", text: "aimed " + i.aimed.map((a) => a.replace("_", " ")).join(" + "), tip: "Pitch and yaw of these limbs are pointed at the web anchor in game; only roll is yours" });
    chips.push({ cls: i.positions === "ignored" ? "warn" : "", text: i.positions === "ignored" ? "positions ignored" : i.positions === "limb-driver" ? "positions: wall crawl" : "positions play", tip: i.positions === "ignored" ? "Position keys on this clip are never played in game" : i.positions === "limb-driver" ? "The wall crawl plays this clip's limb positions timed to the stride" : "Position keys reach the model through ordinary clip playback" });
    if (i.strideGait) chips.push({ cls: "pb", text: i.strideGait === "gait" ? "stride: crawl gait" : "stride: walk cycle", tip: i.strideGait === "gait" ? "One clip per CrawlGait stride (distance along the face)" : "One clip per vanilla walk cycle (distance walked)" });
    for (const u of i.extraUses) chips.push({ cls: "state", text: u, tip: "Also played by the game for: " + u });
  }
  const probTip = [p.probs?.e ? `${p.probs.e} error(s)` : "", p.probs?.w ? `${p.probs.w} warning(s)` : ""].filter(Boolean).join(", ");
  const tip = [p.name, ...chips.map((c) => `${c.tip}: ${c.text}`), probTip].filter(Boolean).join("\n");
  return (
    <div className={"as-arow" + (p.selected ? " sel" : "")} onClick={p.onClick} onDoubleClick={p.onDouble} title={tip} data-anim={p.name} data-kind={i?.kind}>
      <div className="nm">
        <span className="t"><i>{m[1] ?? ""}</i>{m[2]}</span>
        {!!probTip && <i className={"pdot " + (p.probs?.e ? "err" : "warn")} />}
        <span className="as-hint">{p.length.toFixed(2)}s</span>
      </div>
    </div>
  );
}
