import { useEffect, useMemo, useRef, useState } from "react";
import {
  addNoise, animLength, applyNoise, copyKeys, getAnimation, pasteWithNoise, previewPasteWithNoise, samplePose, setLength,
  type Clipboard, type ClipKey, type Doc, type Pose, type KeyRef, type NoiseOptions, type PasteNoiseOptions,
} from "../../core";
import { useStudio, type StudioApi } from "../state";
import { toolsStore, useToolsUi } from "../toolsUi";
import { cur, playheadTime } from "../timeline/ops";
import { useStudioSel } from "../timeline/hooks";
import { r4, snapTick } from "../timeline/layout";
import { ensureStyles } from "../timeline/styles";

export type TargetMode = "same" | "selected" | "mirror";
export interface NoiseForm {
  repeat: number; every: number; rot: number; pos: number; scale: number;
  axes: [boolean, boolean, boolean]; kind: "perlin" | "random"; frequency: number; seed: number; keepEnds: boolean; target: TargetMode;
}
export const DEFAULT_FORM: NoiseForm = { repeat: 1, every: 0.5, rot: 3, pos: 0.3, scale: 2, axes: [true, true, true], kind: "perlin", frequency: 1.7, seed: 1, keepEnds: true, target: "same" };

export function noiseOptions(f: NoiseForm): NoiseOptions {
  return { amplitude: { rotation: f.rot, position: f.pos, scale: f.scale }, axes: f.axes, kind: f.kind, frequency: f.frequency, seed: f.seed, keepEnds: f.keepEnds };
}
export function pasteOptions(f: NoiseForm, targetTime: number, selectedBones: readonly string[]): PasteNoiseOptions {
  return {
    ...noiseOptions(f), targetTime, repeat: Math.max(1, Math.floor(f.repeat)), every: f.every,
    mirrorLR: f.target === "mirror", targetBones: f.target === "selected" && selectedBones.length ? [...selectedBones] : undefined,
  };
}

export function NoiseDialog() {
  const api = useStudio();
  ensureStyles();
  const ui = useToolsUi(api);
  if (!ui.noise) return null;
  return <NoiseBody api={api} mode={ui.noise.mode} />;
}

interface PreviewOk { ok: true; keys: ClipKey[]; pose: Pose; maxT: number; len: number; doc: Doc }
interface PreviewErr { ok: false; error: string }
const n = (v: string) => { const x = parseFloat(v); return Number.isFinite(x) ? x : 0; };

function NoiseBody({ api, mode }: { api: StudioApi; mode: "paste" | "add" }) {
  const doc = useStudioSel((s) => s.doc);
  const animName = useStudioSel((s) => s.anim);
  const time = useStudioSel((s) => s.time);
  const bonesSel = useStudioSel((s) => s.bones);
  const keysSel = useStudioSel((s) => s.keys);
  const clipboard = useStudioSel((s) => s.clipboard);
  const ref = useRef<HTMLDivElement>(null);
  const [f, setF] = useState<NoiseForm>(() => ({ ...DEFAULT_FORM, every: Math.max(0.05, snapTick(api.store.get().clipboard?.duration || 0.5)), seed: 1 }));
  const [startAt, setStartAt] = useState<"playhead" | "custom">("playhead");
  const [startText, setStartText] = useState("0");
  const [extend, setExtend] = useState(true);
  const set = <K extends keyof NoiseForm>(k: K, v: NoiseForm[K]) => setF((p) => ({ ...p, [k]: v }));

  // the source: clipboard for paste; for "add" a snapshot of the selected keys
  const source: Clipboard | null = useMemo(() => {
    if (mode === "paste") return clipboard;
    return doc && animName && keysSel.length ? copyKeys(doc, animName, keysSel) : null;
  }, [mode, clipboard, doc, animName, keysSel]);

  const t0 = startAt === "playhead" ? (() => { const c = cur(api); return c ? playheadTime(api, c.anim) : time; })() : r4(n(startText));
  const preview = useMemo((): PreviewOk | PreviewErr | null => {
    if (!doc || !animName || !source || !source.keys.length) return null;
    try {
      let keys: ClipKey[];
      let next;
      if (mode === "paste") {
        const o = pasteOptions(f, t0, bonesSel);
        keys = previewPasteWithNoise(source, o);
        next = pasteWithNoise(doc, animName, source, o);
      } else {
        const a = getAnimation(doc, animName)!;
        const sel: ClipKey[] = keysSel.flatMap((r) => { const k = a.bones.get(r.bone)?.[r.channel]?.keys.find((q) => Math.abs(q.time - r.time) < 0.0005); return k ? [{ bone: r.bone, channel: r.channel, key: k }] : []; });
        keys = addNoise(sel, noiseOptions(f));
        next = applyNoise(doc, animName, keysSel, noiseOptions(f));
      }
      const anim = getAnimation(next, animName)!;
      return { ok: true, keys, pose: samplePose(anim, time), maxT: Math.max(0, ...keys.map((k) => k.key.time)), len: animLength(anim), doc: next };
    } catch (e) {
      return { ok: false, error: String((e as Error).message) };
    }
  }, [doc, animName, source, mode, f, t0, bonesSel, keysSel, time]);
  const ok = !!preview?.ok;

  useEffect(() => {
    const tu = toolsStore(api);
    if (preview?.ok) { api.store.set({ previewPose: preview.pose }); tu.set({ ghost: preview.keys }); }
    else { api.store.set({ previewPose: null }); tu.set({ ghost: null }); }
  }, [api, preview]);
  useEffect(() => () => { api.store.set({ previewPose: null }); toolsStore(api).set({ ghost: null }); }, [api]);
  useEffect(() => { ref.current?.focus({ preventScroll: true }); }, []);

  const close = () => { api.store.set({ previewPose: null }); toolsStore(api).set({ noise: null, ghost: null }); };
  const commit = () => {
    const c = cur(api);
    if (!c || !preview?.ok) return;
    let next = preview.doc;
    if (extend && preview.maxT > animLength(c.anim) + 1e-6) next = setLength(next, { anim: c.name, length: snapTick(preview.maxT) });
    api.commit(next, mode === "paste" ? "Paste with Noise" : "Add Noise");
    const refs: KeyRef[] = preview.keys.map((k) => ({ bone: k.bone, channel: k.channel, time: k.key.time }));
    api.store.set({ keys: refs });
    close();
  };
  const commitRef = useRef(commit); commitRef.current = commit;
  const closeRef = useRef(close); closeRef.current = close;
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeRef.current(); }
      else if (e.key === "Enter" && (e.target as HTMLElement).tagName !== "BUTTON" && (e.target as HTMLElement).tagName !== "SELECT") { e.preventDefault(); commitRef.current(); }
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, []);

  const exceeds = !!preview?.ok && preview.maxT > preview.len + 1e-6;
  const pasteMode = mode === "paste";
  return (
    <div className="as-modal-bg" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="as-modal" ref={ref} tabIndex={-1} data-testid="as-noise" style={{ outline: "none" }}>
        <div className="hd">{pasteMode ? "Paste with Noise" : "Add Noise to Selection"}</div>
        <div className="bd">
          {!source || !source.keys.length ? (
            <div className="as-hint" style={{ padding: "8px 0" }}>{pasteMode ? "Nothing on the key clipboard. Copy keys first (⌘C), then paste with noise." : "Select some keyframes first."}</div>
          ) : (
            <div className="as-hint">{source.keys.length} key{source.keys.length === 1 ? "" : "s"} · {new Set(source.keys.map((k) => k.bone)).size} bone(s) · {source.duration.toFixed(2)}s</div>
          )}
          {pasteMode && (
            <>
              <div className="as-sub">Placement</div>
              <div className="as-row">
                <span className="as-lbl">Start</span>
                <div className="as-seg">
                  <button className={startAt === "playhead" ? "on" : ""} onClick={() => setStartAt("playhead")}>At playhead</button>
                  <button className={startAt === "custom" ? "on" : ""} onClick={() => { setStartAt("custom"); setStartText(String(t0)); }}>At time</button>
                </div>
                {startAt === "custom" ? <input className="as-in num" style={{ width: 64 }} value={startText} onChange={(e) => setStartText(e.target.value)} /> : <span className="as-hint">{t0.toFixed(2)}s</span>}
              </div>
              <div className="as-row">
                <span className="as-lbl">Repeat</span>
                <input className="as-in num" style={{ width: 56 }} type="number" min={1} max={200} value={f.repeat} data-testid="as-n-repeat" onChange={(e) => set("repeat", Math.max(1, Math.floor(n(e.target.value))))} />
                <span className="as-hint">×  every</span>
                <input className="as-in num" style={{ width: 64 }} value={f.every} onChange={(e) => set("every", Math.max(0.05, n(e.target.value)))} disabled={f.repeat < 2} />
                <span className="as-hint">s</span>
              </div>
              <div className="as-row">
                <span className="as-lbl">Target bones</span>
                <div className="as-seg">
                  <button className={f.target === "same" ? "on" : ""} onClick={() => set("target", "same")}>Same</button>
                  <button className={f.target === "selected" ? "on" : ""} disabled={!bonesSel.length} title={bonesSel.length ? bonesSel.join(", ") : "Select target bones in the outliner"} onClick={() => set("target", "selected")}>Selected</button>
                  <button className={f.target === "mirror" ? "on" : ""} onClick={() => set("target", "mirror")} title="Swap left/right bones, flip yaw/roll">Mirror L↔R</button>
                </div>
              </div>
            </>
          )}
          <div className="as-sub">Amplitude</div>
          <AmpRow label="Rotation" unit="°" value={f.rot} onChange={(v) => set("rot", v)} testid="as-n-rot" />
          <AmpRow label="Position" unit="px" value={f.pos} onChange={(v) => set("pos", v)} />
          <AmpRow label="Scale" unit="%" value={f.scale} onChange={(v) => set("scale", v)} />
          <div className="as-row">
            <span className="as-lbl">Axes</span>
            {(["X", "Y", "Z"] as const).map((a, i) => (
              <label key={a} className="as-chk"><input type="checkbox" checked={f.axes[i]} onChange={(e) => { const ax = [...f.axes] as NoiseForm["axes"]; ax[i] = e.target.checked; set("axes", ax); }} />{a}</label>
            ))}
          </div>
          <div className="as-sub">Noise</div>
          <div className="as-row">
            <span className="as-lbl">Type</span>
            <div className="as-seg">
              <button className={f.kind === "perlin" ? "on" : ""} onClick={() => set("kind", "perlin")}>Smooth (Perlin)</button>
              <button className={f.kind === "random" ? "on" : ""} onClick={() => set("kind", "random")}>Random per key</button>
            </div>
          </div>
          {f.kind === "perlin" && (
            <div className="as-row">
              <span className="as-lbl">Frequency</span>
              <input className="as-slider" type="range" min={0.2} max={12} step={0.1} value={f.frequency} onChange={(e) => set("frequency", n(e.target.value))} />
              <span className="as-pct">{f.frequency.toFixed(1)}/s</span>
            </div>
          )}
          <div className="as-row">
            <span className="as-lbl">Seed</span>
            <input className="as-in num" style={{ width: 90 }} data-testid="as-n-seed" value={f.seed} onChange={(e) => set("seed", Math.floor(n(e.target.value)))} />
            <button className="as-btn" style={{ border: "1px solid var(--border)", height: 22 }} onClick={() => set("seed", Math.floor(Math.random() * 1e6))} data-testid="as-n-reroll">Re-roll</button>
            <label className="as-chk" style={{ marginLeft: "auto" }} title="First and last key of each bone+channel stay exact so loops stay seamless"><input type="checkbox" checked={f.keepEnds} onChange={(e) => set("keepEnds", e.target.checked)} />Keep ends</label>
          </div>
          {exceeds && (
            <label className="as-chk"><input type="checkbox" checked={extend} onChange={(e) => setExtend(e.target.checked)} />Extend animation length to fit ({preview?.ok ? preview.maxT.toFixed(2) : ""}s)</label>
          )}
          {preview && !preview.ok && <div className="as-hint" style={{ color: "var(--nord11)" }}>{preview.error}</div>}
          {ok && <div className="as-hint">Preview is live in the viewport; ghost diamonds in the dope sheet show where keys will land.</div>}
        </div>
        <div className="ft">
          <button className="as-btn" onClick={close}>Cancel</button>
          <button className="as-btn primary" disabled={!ok} onClick={commit} data-testid="as-n-commit">{pasteMode ? "Paste" : "Apply"}</button>
        </div>
      </div>
    </div>
  );
}

function AmpRow({ label, unit, value, onChange, testid }: { label: string; unit: string; value: number; onChange: (v: number) => void; testid?: string }) {
  return (
    <div className="as-row">
      <span className="as-lbl">{label}</span>
      <input className="as-in num" style={{ width: 70 }} type="number" step={unit === "°" ? 0.5 : 0.1} min={0} value={value} data-testid={testid} onChange={(e) => onChange(Math.max(0, n(e.target.value)))} />
      <span className="as-hint">{unit}</span>
    </div>
  );
}
