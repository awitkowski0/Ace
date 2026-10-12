/**
 * A flight profile (data/<ns>/flight_profiles/*.json): the thruster jets on a preview suit, each hung from one of the body's
 * jet anchors, with its flame. Inherited jets (from `parent`) show greyed until the profile declares its own.
 */
import { useMemo, useState } from "react";
import { openFile } from "../../../editor/store";
import { JET_ANCHORS, jetPosition } from "../core/anchors";
import { packRoot } from "../core/kinds";
import { setJson } from "../core/suit";
import { loadFlight, loadSuitModel, useAsync } from "./data";
import { Docks, ParseError, type ViewProps } from "./PackView";
import { listData, resourceRoots } from "./resolve";
import { ColorField, Empty, EnumField, NumberField, Section, SceneTree, TextField, type TreeNode } from "./widgets";
import { Viewport3D, type Marker } from "./Viewport3D";
import { playerRigModel } from "../../animstudio/ui/model";

const PLAYER = playerRigModel();

const WHEN = ["always", "hover", "fast", "dash"];
const FLAME_NUM: Array<[string, string, number, number, number, number]> = [
  ["length", "Length", 0.9, 0.05, 0.05, 8], ["width", "Width", 0.12, 0.01, 0.01, 2], ["flicker", "Flicker", 0.25, 0.05, 0, 0.9],
  ["glow", "Glow", 1, 0.05, 0, 1], ["hover", "Hover share", 1, 0.05, 0, 1],
];

export default function FlightView({ host, path, text, edit }: ViewProps) {
  const { raw, error } = useMemo(() => { try { return { raw: JSON.parse(text) as Record<string, unknown>, error: null }; } catch (e) { return { raw: null, error: e }; } }, [text]);
  const pr = packRoot(path);
  const [roots] = useAsync(() => resourceRoots(host, path), [host, path], [] as string[]);
  const parent = typeof raw?.parent === "string" ? raw.parent : undefined;
  const [inherited] = useAsync(() => (roots.length && parent ? loadFlight(host, roots, parent) : Promise.resolve(null)), [roots, parent], null);
  const [suits] = useAsync(() => (roots.length && pr ? listData(host, roots, pr.ns, "armors", [".json"]) : Promise.resolve([])), [roots], [] as Array<{ id: string; path: string }>);
  const [preview, setPreview] = useState(() => { try { return localStorage.getItem("packeditor.previewSuit") ?? ""; } catch { return ""; } });
  const [model] = useAsync(() => (roots.length && pr && preview ? loadSuitModel(host, roots, pr.ns, preview) : Promise.resolve(null)), [roots, preview], null);
  const [sel, setSel] = useState<string | null>(null);
  if (error || !raw) return <ParseError error={error} />;

  const own = (raw.effects as { jets?: Array<Record<string, unknown>> } | undefined)?.jets;
  const jets = own ?? inherited?.jets.map((j) => j.raw) ?? [];
  const isOwn = !!own;
  const set = (p: Array<string | number>, v: unknown, live = false) => edit((cur) => setJson(cur, p, v), live);

  const markers: Marker[] = jets.flatMap((j, i) => {
    const pos = jetPosition(String(j.anchor ?? ""));
    if (!pos) return [];
    const f = (j.flame ?? {}) as Record<string, unknown>;
    return [{ id: `jet:${i}`, pos, dir: [0, -1, 0], color: "#64e9ff", label: String(j.anchor), flame: { length: Number(f.length ?? 0.9) * 16, width: Number(f.width ?? 0.12) * 16, core: String(f.core ?? "#FFFFFF"), outer: String(f.outer ?? "#FF8800") } } as Marker];
  });
  const nodes: TreeNode[] = [{ id: "profile", label: path.split("/").pop()!.replace(/\.json$/, ""), icon: "i-flight", hint: parent ? `← ${parent.replace(/^thematic:/, "")}` : undefined,
    children: jets.map((j, i) => ({ id: `jet:${i}`, label: String(j.anchor ?? "?"), icon: "i-jet", hint: String(j.when ?? "fast"), dim: !isOwn })) }];

  const i = sel?.startsWith("jet:") ? Number(sel.slice(4)) : -1;
  const j = i >= 0 ? jets[i] : undefined;
  const P = (...k: Array<string | number>) => ["effects", "jets", i, ...k];
  const inspector = (() => {
    if (!j) return (
      <Section title="Profile">
        <TextField label="Parent" value={parent} mono placeholder="(none)" onChange={(v) => set(["parent"], v || undefined)} />
        {inherited?.path && <div className="pe-btns"><button className="pe-btn" onClick={() => void openFile({ host, path: inherited.path! })}>Open parent</button></div>}
        {!isOwn && inherited?.jets.length ? <div className="pe-btns"><button className="pe-btn" onClick={() => set(["effects", "jets"], inherited.jets.map((x) => x.raw))}>Declare jets here</button></div> : null}
        {isOwn && <div className="pe-btns"><button className="pe-btn" onClick={() => set(["effects", "jets", jets.length], { anchor: "rightFoot", when: "always", flame: { core: "#FFFFFF", outer: "#FF8800" } })}>+ Jet</button></div>}
      </Section>
    );
    if (!isOwn) return <Empty title="Inherited" detail={<>These jets come from {parent}. Select the profile and declare jets here to change them for this one.</>} />;
    const f = (j.flame ?? {}) as Record<string, unknown>;
    return (
      <>
        <Section title={`Jet · ${j.anchor}`} right={<button className="pe-link" onClick={() => { set(["effects", "jets", i], undefined); setSel(null); }}>Delete</button>}>
          <EnumField label="Anchor" value={String(j.anchor ?? "")} options={JET_ANCHORS} onChange={(v) => set(P("anchor"), v)} testId="pe-jet-anchor" />
          <EnumField label="Fires" value={j.when as string | undefined} options={WHEN} allowEmpty="(fast)" onChange={(v) => set(P("when"), v)} />
          <EnumField label="Aim" value={j.aim as string | undefined} options={["down", "palm"]} allowEmpty="(down)" onChange={(v) => set(P("aim"), v)} />
        </Section>
        <Section title="Flame">
          <ColorField label="Core" value={f.core as string | undefined} dflt="#FFFFFF" onChange={(v, l) => set(P("flame", "core"), v, l)} />
          <ColorField label="Outer" value={f.outer as string | undefined} dflt="#FF8800" onChange={(v, l) => set(P("flame", "outer"), v, l)} />
          {FLAME_NUM.map(([k, label, d, step, min, max]) => <NumberField key={k} label={label} value={f[k] as number | undefined} placeholder={d} step={step} min={min} max={max} onChange={(v, l) => set(P("flame", k), v, l)} />)}
        </Section>
      </>
    );
  })();

  const view = (
    <div className="pe-tabs-host">
      <div className="pe-tabs">
        <label className="pe-pick">Preview on
          <input list="pe-suits-f" className="pe-in" value={preview} placeholder="(player)" onChange={(e) => { setPreview(e.target.value); try { localStorage.setItem("packeditor.previewSuit", e.target.value); } catch { /* per-viewer convenience */ } }} />
          <datalist id="pe-suits-f">{suits.slice(0, 2000).map((s) => <option key={s.id} value={s.id} />)}</datalist>
        </label>
      </div>
      <Viewport3D rig={model?.rig ?? PLAYER} texture={model?.texture ?? null} markers={markers} selected={sel} onSelect={(m) => setSel(m)} testId="pe-vp3" />
    </div>
  );
  return <Docks id="flight" tree={<SceneTree nodes={nodes} selected={sel ?? "profile"} onSelect={(id) => setSel(id === "profile" ? null : id)} testId="pe-tree" />} view={view} inspector={inspector} />;
}
