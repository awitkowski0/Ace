/**
 * A suit (data/<ns>/armors/**.json): its model with every place the kit renders from (beams, visuals, projectiles, flight
 * jets), the suit's own render settings (each ability's beam: colours, size, first/third person offset - the offset can be
 * dragged in the view) and its flight setup. Where a move leaves the body is the ability's, shared by every suit with it, so
 * that opens the ability.
 */
import { useMemo, useRef, useState } from "react";
import { openFile } from "../../../editor/store";
import type { NumVec3 } from "../../animstudio/core";
import { anchorFrame, jetPosition, localToScene, type AnchorFrame } from "../core/anchors";
import { packRoot, stem } from "../core/kinds";
import { BEAM_DEFAULTS, BEAM_VISUALS, FLIGHT_TYPES, JET_GROUPS, KEYBINDS, beamOf, readRenderSources, readSuit, setJson, type BeamKey, type RenderSource, type Suit } from "../core/suit";
import { abilityPath, flightIdOf, loadFlight, loadSuitModel, useAsync, type Flight } from "./data";
import { Docks, ParseError, type ViewProps } from "./PackView";
import { listData, readText, resourceRoots } from "./resolve";
import { BoolField, ColorField, Empty, EnumField, NumberField, Section, SceneTree, TextField, Vec3Field, type TreeNode } from "./widgets";
import { Viewport3D, type Marker } from "./Viewport3D";

interface AbilityInfo { id: string; path: string | null; sources: RenderSource[] }

const keyShort = (k?: string) => (k ? k.replace("key.thematic.", "").replace("ability_", "A") : "");
const COLORS = ["#88c0d0", "#a3be8c", "#ebcb8b", "#b48ead", "#d08770", "#81a1c1", "#bf616a", "#8fbcbb"];

export default function SuitView({ host, path, text, edit }: ViewProps) {
  const { suit, error } = useMemo(() => { try { return { suit: readSuit(text), error: null }; } catch (e) { return { suit: null as Suit | null, error: e }; } }, [text]);
  const pr = packRoot(path);
  const id = stem(path);
  const [roots] = useAsync(() => resourceRoots(host, path), [host, path], [] as string[]);
  const [model] = useAsync(() => (roots.length && pr ? loadSuitModel(host, roots, pr.ns, id) : Promise.resolve(null)), [roots, id], null);
  const abilityIds = suit?.abilities.map((a) => a.id).join("|") ?? "";
  const [infos] = useAsync(async () => {
    if (!suit || !roots.length) return [] as AbilityInfo[];
    return Promise.all(suit.abilities.map(async (a) => {
      const p = await abilityPath(host, roots, a.id);
      const src = p ? await readText(host, p) : null;
      let sources: RenderSource[] = [];
      try { sources = src ? readRenderSources(src) : []; } catch { sources = []; }
      return { id: a.id, path: p, sources };
    }));
  }, [roots, abilityIds], [] as AbilityInfo[]);
  const flightId = flightIdOf(suit?.flightProfile, suit?.flightType);
  const [flight] = useAsync(() => (roots.length ? loadFlight(host, roots, flightId) : Promise.resolve(null as Flight | null)), [roots, flightId], null as Flight | null);
  const [profiles] = useAsync(() => (roots.length && pr ? listData(host, roots, pr.ns, "flight_profiles", [".json"]) : Promise.resolve([])), [roots], [] as Array<{ id: string; path: string }>);
  const [sel, setSel] = useState<string | null>("suit");
  const drag = useRef<{ index: number; base: NumVec3 } | null>(null);

  if (error || !suit) return <ParseError error={error} />;

  // ---- what renders from where
  const markers: Marker[] = [];
  const frames = new Map<string, AnchorFrame>();
  suit.abilities.forEach((a, ai) => {
    const info = infos.find((x) => x.id === a.id);
    const color = COLORS[ai % COLORS.length];
    info?.sources.forEach((s) => {
      const beam = s.kind ? BEAM_VISUALS.has(s.kind) || s.method === "beam" : s.method === "beam";
      s.from.forEach((spec, fi) => {
        const fr = anchorFrame(spec);
        const mid = `src:${ai}:${s.index}:${fi}`;
        frames.set(mid, fr);
        const b = beamOf(a);
        const t = (b.thirdPersonTranslation as number[] | undefined) ?? [0, 0, 0];
        const origin = beam ? localToScene(fr, t as NumVec3) : fr.origin;
        markers.push({
          id: mid, pos: origin, dir: fr.out, color, label: `${a.id} · ${(s.kind ?? s.method).replace(/^thematic:/, "")}`,
          beam: beam ? { length: 40, width: Math.max(0.15, Number(b.size ?? 0.025) * 16), end: String(b.endColor ?? "#FF0000").replace(/^#(..)(......)$/, "#$2") } : undefined,
          movable: beam,
        });
      });
    });
  });
  flight?.jets.forEach((j) => {
    const pos = jetPosition(j.anchor);
    if (!pos) return;
    const f = j.flame ?? {};
    markers.push({
      id: `jet:${j.index}`, pos, dir: j.aim === "palm" ? [0, -1, 0] : [0, -1, 0], color: "#64e9ff", label: `jet · ${j.anchor}`,
      flame: { length: Number(f.length ?? 0.9) * 16, width: Number(f.width ?? 0.12) * 16, core: String(f.core ?? "#FFFFFF"), outer: String(f.outer ?? "#FF8800") },
    });
  });

  // ---- tree
  const nodes: TreeNode[] = [{
    id: "suit", label: id, icon: "i-suit", hint: suit.tier !== undefined ? `tier ${suit.tier}` : undefined, children: [
      { id: "model", label: "Model", icon: "i-model", hint: model?.geoPath ? "" : "player" },
      { id: "abilities", label: "Abilities", icon: "i-folder", children: suit.abilities.map((a, ai) => ({
        id: `ab:${ai}`, label: a.id, icon: "i-ability", hint: keyShort(a.keybind), dim: a.remove,
        children: infos.find((x) => x.id === a.id)?.sources.flatMap((s) => s.from.map((spec, fi) => ({
          id: `src:${ai}:${s.index}:${fi}`, label: `${(s.kind ?? s.method).replace(/^thematic:/, "")}`, icon: "i-render",
          hint: spec.kind === "bone" ? spec.bone : spec.point,
        }))) ?? [],
      })) },
      { id: "flight", label: "Flight", icon: "i-flight", hint: flightId.replace(/^thematic:/, ""), children: (flight?.jets ?? []).map((j) => ({ id: `jet:${j.index}`, label: j.anchor, icon: "i-jet", hint: j.when })) },
    ],
  }];

  const set = (p: Array<string | number>, v: unknown, live = false) => edit((cur) => setJson(cur, p, v), live);
  const abIndex = sel?.startsWith("ab:") ? Number(sel.slice(3)) : sel?.startsWith("src:") ? Number(sel.split(":")[1]) : -1;

  const onDrag = (mid: string, delta: NumVec3, phase: "move" | "end") => {
    const [, ai] = mid.split(":").map(Number);
    const fr = frames.get(mid);
    const a = suit.abilities[ai];
    if (!fr || !a) return;
    if (!drag.current || drag.current.index !== ai) drag.current = { index: ai, base: [...((beamOf(a).thirdPersonTranslation as NumVec3) ?? [0, 0, 0])] as NumVec3 };
    const base = drag.current.base;
    // scene delta -> the anchor's local frame, in blocks
    const dot = (u: NumVec3) => (delta[0] * u[0] + delta[1] * u[1] + delta[2] * u[2]) / 16;
    const r = (v: number) => Math.round(v * 1000) / 1000;
    const next: NumVec3 = [r(base[0] + dot(fr.x)), r(base[1] + dot(fr.y)), r(base[2] + dot(fr.z))];
    set(["abilities", ai, "assets", "beam", "thirdPersonTranslation"], next, phase === "move");
    if (phase === "end") drag.current = null;
  };

  const inspector = (() => {
    if (sel === "suit") return <SuitInspector suit={suit} set={set} profiles={profiles.map((p) => `${pr?.ns ?? "thematic"}:${p.id}`)} />;
    if (sel === "model") return (
      <Section title="Model">
        <div className="pe-note">{model?.geoPath ? model.geoPath.split("/").slice(-4).join("/") : `No geo/armor/${id}.geo.json: showing the plain player.`}</div>
        <div className="pe-btns">
          {model?.geoPath && <button className="pe-btn" onClick={() => void openFile({ host, path: model.geoPath! })}>Open model</button>}
          {model?.texPath && <button className="pe-btn" onClick={() => void openFile({ host, path: model.texPath! })}>Open texture</button>}
        </div>
      </Section>
    );
    if (sel === "flight" || sel?.startsWith("jet:")) {
      const j = sel.startsWith("jet:") ? flight?.jets[Number(sel.slice(4))] : undefined;
      return (
        <>
          <SuitFlight suit={suit} set={set} profiles={profiles.map((p) => `${pr?.ns ?? "thematic"}:${p.id}`)} />
          <Section title={j ? `Jet · ${j.anchor}` : "Jets"}>
            <div className="pe-note">{flight?.path ? <>Jets come from <b>{flightId}</b>{flight.jets[0] && flight.jets[0].from !== flight.path ? " (inherited)" : ""}: every suit on that profile shares them.</> : `No flight profile ${flightId}.`}</div>
            {j && <div className="pe-kv"><span>when</span><b>{j.when ?? "fast"}</b><span>aim</span><b>{j.aim ?? "down"}</b></div>}
            {(flight?.jets[0]?.from ?? flight?.path) && <div className="pe-btns"><button className="pe-btn" onClick={() => void openFile({ host, path: (flight!.jets[0]?.from ?? flight!.path)! })}>Edit flight profile</button></div>}
          </Section>
        </>
      );
    }
    if (abIndex >= 0) {
      const a = suit.abilities[abIndex];
      const info = infos.find((x) => x.id === a?.id);
      const srcSel = sel?.startsWith("src:") ? info?.sources[Number(sel.split(":")[2])] : undefined;
      return (
        <>
          <Section title={a.id}>
            <EnumField label="Key" value={a.keybind} options={KEYBINDS} allowEmpty="(none)" labels={(k) => k.replace("key.thematic.", "")} onChange={(v) => set(["abilities", abIndex, "keybind"], v)} testId="pe-keybind" />
            {info?.path && <div className="pe-btns"><button className="pe-btn" onClick={() => void openFile({ host, path: info.path! })}>Open ability</button></div>}
            {srcSel && (
              <div className="pe-note">
                <b>{(srcSel.kind ?? srcSel.method).replace(/^thematic:/, "")}</b> comes out of <b>{srcSel.from.map((f) => (f.kind === "bone" ? f.bone : f.point)).join(", ") || "the eyes"}</b>
                {" "}(line {srcSel.line} of the ability). Moving where it leaves the body changes it for every suit with {a.id}; the beam offset below is this suit's own.
              </div>
            )}
          </Section>
          <BeamInspector ability={a} index={abIndex} set={set} />
        </>
      );
    }
    return <Empty title="Nothing selected" />;
  })();

  return (
    <Docks id="suit"
      tree={<SceneTree nodes={nodes} selected={sel} onSelect={setSel} testId="pe-tree"
        onActivate={(n) => { if (n.startsWith("ab:")) { const p = infos.find((x) => x.id === suit.abilities[Number(n.slice(3))]?.id)?.path; if (p) void openFile({ host, path: p }); } }} />}
      view={<Viewport3D rig={model?.rig ?? null} texture={model?.texture ?? null} markers={markers} selected={sel} onSelect={(m) => m && setSel(m)} onDrag={onDrag} testId="pe-vp3" />}
      inspector={inspector}
    />
  );
}

function SuitInspector({ suit, set, profiles }: { suit: Suit; set: (p: Array<string | number>, v: unknown, live?: boolean) => void; profiles: string[] }) {
  return (
    <>
      <Section title="Suit">
        <NumberField label="Tier" value={suit.tier} step={1} min={1} max={10} onChange={(v, l) => set(["tier"], v, l)} testId="pe-tier" doc="Power tier, 1 to 10" />
        <BoolField label="Work in progress" value={suit.wip} dflt={true} onChange={(v) => set(["wip"], v)} doc="A WIP tooltip; the suit bench doesn't offer it" />
      </Section>
      <SuitFlight suit={suit} set={set} profiles={profiles} />
    </>
  );
}

function SuitFlight({ suit, set, profiles }: { suit: Suit; set: (p: Array<string | number>, v: unknown, live?: boolean) => void; profiles: string[] }) {
  return (
    <Section title="Flight">
      <EnumField label="Flight type" value={suit.flightType} options={FLIGHT_TYPES} allowEmpty="(default: NO_HANDS)" onChange={(v) => set(["flight_type"], v)} />
      <EnumField label="Profile" value={suit.flightProfile} options={profiles} allowEmpty="(from flight type)" onChange={(v) => set(["flight_profile"], v)} testId="pe-flight-profile" />
      <EnumField label="Jet limbs" value={suit.jetGroups} options={JET_GROUPS} allowEmpty="(all jets)" onChange={(v) => set(["jet_groups"], v)} />
    </Section>
  );
}

const BEAM_NUM: Array<{ k: BeamKey; label: string; step: number; min?: number; max?: number }> = [
  { k: "size", label: "Core size", step: 0.005, min: 0 }, { k: "glowSize", label: "Glow size", step: 0.01, min: 0 },
  { k: "count", label: "Count", step: 1, min: 1, max: 8 }, { k: "spacing", label: "Spacing", step: 0.01 },
  { k: "thirdPersonOpacity", label: "Opacity", step: 0.05, min: 0, max: 1 }, { k: "firstPersonOpacity", label: "First-person opacity", step: 0.05, min: 0, max: 1 },
  { k: "maxChains", label: "Max chains", step: 1, min: 0 }, { k: "chainRange", label: "Chain range", step: 0.5, min: 0 }, { k: "beamVelocity", label: "Velocity", step: 1, min: 0 },
];

function BeamInspector({ ability, index, set }: { ability: Suit["abilities"][number]; index: number; set: (p: Array<string | number>, v: unknown, live?: boolean) => void }) {
  const own = (ability.assets?.beam ?? {}) as Record<string, unknown>;
  const b = beamOf(ability);
  const P = (k: string) => ["abilities", index, "assets", "beam", k];
  const reset = Object.keys(own).length > 0 && <button className="pe-link" onClick={() => set(["abilities", index, "assets", "beam"], undefined)}>Reset all</button>;
  return (
    <Section title="Beam (this suit)" right={reset}>
      <ColorField label="Start colour" value={own.startColor as string | undefined} dflt={BEAM_DEFAULTS.startColor} onChange={(v, l) => set(P("startColor"), v, l)} testId="pe-beam-start" />
      <ColorField label="End colour" value={own.endColor as string | undefined} dflt={BEAM_DEFAULTS.endColor} onChange={(v, l) => set(P("endColor"), v, l)} testId="pe-beam-end" />
      {BEAM_NUM.map((f) => (
        <NumberField key={f.k} label={f.label} value={own[f.k] as number | undefined} placeholder={BEAM_DEFAULTS[f.k] as number} step={f.step} min={f.min} max={f.max} onChange={(v, l) => set(P(f.k), v, l)} testId={`pe-beam-${f.k}`} />
      ))}
      <Vec3Field label="Offset" value={(b.thirdPersonTranslation as [number, number, number]) ?? [0, 0, 0]} step={0.01} onChange={(v, l) => set(P("thirdPersonTranslation"), v, l)} testId="pe-beam-tp" doc="Third person: moves the beam from where the ability starts it, in that point's own frame (blocks)" />
      <Vec3Field label="First-person offset" value={(b.firstPersonTranslation as [number, number, number]) ?? [0, 0, 0]} step={0.01} onChange={(v, l) => set(P("firstPersonTranslation"), v, l)} testId="pe-beam-fp" />
      <TextField label="Texture" value={own.texture as string | undefined} placeholder="(plain)" mono onChange={(v) => set(P("texture"), v || undefined)} />
    </Section>
  );
}
