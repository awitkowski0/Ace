/**
 * The ability view's Beam inspector: the look of one `component.visual("thematic:beam", {...})` call as fields (an empty field
 * removes the key from the script's literal and shows what the lower layers give), plus the preview suit's own
 * `assets.beam` for this ability (a different file: see crossFile.ts). Which layer decides each setting is on every row.
 */
import type { ReactNode } from "react";
import { BEAM_FIELDS, effectiveBeam, hexColor, layerOf, type BeamField, type BeamVisual, type EffectiveBeam, type Eff, type Layer } from "../core/beam";
import { BEAM_DEFAULTS, type BeamKey } from "../core/suit";
import { BoolField, ColorField, EnumField, NumberField, Section, TextField } from "./widgets";

/** The preview suit's entry for this ability, as the inspector needs it. */
export interface SuitLayer {
  id: string;
  path: string;
  /** `abilities[index]` of the suit file; -1: the suit does not list this ability */
  index: number;
  /** its own `assets.beam` (only what it sets) */
  own: Record<string, unknown>;
}
/** What the last edit of another file did, for the line under the suit section. */
export interface CrossStatus { via: "buffer" | "disk"; name: string; undo?: () => void }

const KEY_OF: Record<string, keyof EffectiveBeam> = { style: "style", scale: "scale", length: "length", size: "size", glowSize: "glowSize", count: "count", spacing: "spacing", opacity: "opacity", color: "glowColor", coreColor: "coreColor" };
const GROUPS: Array<{ id: BeamField["group"]; title: string }> = [
  { id: "shape", title: "Shape and scale" },
  { id: "look", title: "Look" },
  { id: "colour", title: "Colours" },
  { id: "more", title: "More (by style)" },
];

const LAYER_DOC: Record<Layer, string> = {
  visual: "Set here, in the script's visual(\"thematic:beam\", { ... }): it wins over the suit and the default.",
  suit: "Not set in the script: the preview suit's assets.beam decides.",
  default: "Not set in the script or by the suit: the built-in default.",
};
const Badge = ({ layer }: { layer: Layer }) => <span className={"pe-layer " + layer} title={LAYER_DOC[layer]} data-layer={layer}>{layer}</span>;

/** A field row with its layer badge and a reset for a value the script sets. */
function Wrap({ layer, onReset, children, testId }: { layer: Layer; onReset?: () => void; children: ReactNode; testId?: string }) {
  return (
    <div className="pe-bf" data-testid={testId}>
      <div className="pe-bf-w">{children}</div>
      <Badge layer={layer} />
      {onReset ? <button className="pe-link pe-bf-x" title="Remove it from the script" onClick={onReset}>×</button> : <span className="pe-bf-x" />}
    </div>
  );
}

export function BeamInspector({ bv, hands, suit, suitText, setOpt, setSuit, status, openSuit }: {
  bv: BeamVisual;
  hands: boolean;
  suit: SuitLayer | null;
  /** the preview suit's file name, for messages */
  suitText: string | null;
  setOpt: (key: string, value: unknown, live?: boolean) => void;
  setSuit: (key: string, value: unknown) => void;
  status: CrossStatus | null;
  openSuit: () => void;
}) {
  const eff = effectiveBeam(bv.opts, suit?.own, hands);
  const lowerOf = (key: string) => effectiveBeam({ ...bv.opts, [key]: undefined }, suit?.own, hands)[KEY_OF[key]] as Eff<unknown>;

  const field = (f: BeamField): ReactNode => {
    const own = bv.opts[f.key];
    const rawSrc = bv.raw[f.key];
    const layer: Layer = rawSrc !== undefined ? "visual" : layerOf(f.key, bv.opts, suit?.own);
    if (rawSrc !== undefined) {
      return (
        <Wrap key={f.key} layer="visual" testId={`pe-beam-opt-${f.key}`}>
          <div className="pe-row"><div className="pe-row-l" title={f.doc}>{f.key}</div><div className="pe-row-r pe-ro" title="An expression in the script: edit it in the code pane">{rawSrc}</div></div>
        </Wrap>
      );
    }
    const reset = own !== undefined ? () => setOpt(f.key, undefined) : undefined;
    const low = KEY_OF[f.key] ? lowerOf(f.key) : undefined;
    const testId = `pe-beam-opt-${f.key}`;
    if (f.kind === "num") {
      const d = f.key === "firstPersonScale" ? eff.scale.value : (low?.value as number | undefined) ?? (f.dflt as number | undefined);
      return (
        <Wrap key={f.key} layer={layer} onReset={reset}>
          <NumberField label={f.key} value={typeof own === "number" ? own : undefined} placeholder={d} step={f.step} min={f.min} doc={f.doc} testId={testId}
            onChange={(v, l) => setOpt(f.key, v, l)} onClear={() => setOpt(f.key, undefined)} />
        </Wrap>
      );
    }
    if (f.kind === "enum") {
      const d = (low?.value as string | undefined) ?? (f.dflt as string | undefined);
      return (
        <Wrap key={f.key} layer={layer} onReset={reset}>
          <EnumField label={f.key} value={typeof own === "string" ? own : undefined} options={f.options!} allowEmpty={d ? `(${d})` : "(default)"} doc={f.doc} testId={testId} onChange={(v) => setOpt(f.key, v)} />
        </Wrap>
      );
    }
    if (f.kind === "color") {
      return (
        <Wrap key={f.key} layer={layer} onReset={reset}>
          <ColorField label={f.key} value={own === undefined ? undefined : hexColor(own) ?? undefined} dflt={low?.value as string} doc={f.doc} testId={testId} onChange={(v, l) => setOpt(f.key, v, l)} />
        </Wrap>
      );
    }
    if (f.kind === "bool") {
      return (
        <Wrap key={f.key} layer={layer} onReset={reset}>
          <BoolField label={f.key} value={typeof own === "boolean" ? own : undefined} dflt={f.dflt as boolean | undefined} doc={f.doc} testId={testId} onChange={(v) => setOpt(f.key, v)} />
        </Wrap>
      );
    }
    return (
      <Wrap key={f.key} layer={layer} onReset={reset}>
        <TextField label={f.key} value={typeof own === "string" ? own : undefined} mono placeholder={String(suit?.own[f.suit ?? ""] ?? "")} doc={f.doc} testId={testId} onChange={(v) => setOpt(f.key, v === "" ? undefined : v)} />
      </Wrap>
    );
  };

  return (
    <>
      <Section title={`Beam · line ${bv.line}`}>
        <div className="pe-note">
          Each setting comes from the first layer that has it: <b>visual</b> (this script's literal), then <b>suit</b> (the preview suit's assets.beam), then <b>default</b>.
          An empty box removes the key and shows what the lower layers give.
        </div>
        {!bv.editable && <div className="pe-note warn" data-testid="pe-beam-readonly">This visual's options are not an object literal, so they can't be edited here.</div>}
        <div className="pe-kv" data-testid="pe-beam-eff">
          <span>Draws</span><b>{eff.style.value}, {fmt(eff.drawn.full)} blocks{eff.scale.value !== 1 ? ` (x${fmt(eff.scale.value)})` : ""}, {fmt(eff.drawn.radius * 2)} wide</b>
        </div>
      </Section>
      {bv.editable && GROUPS.map((g) => (
        <Section key={g.id} title={g.title} open={g.id !== "more"}>
          {BEAM_FIELDS.filter((f) => f.group === g.id).map(field)}
        </Section>
      ))}
      <Section title={suit ? `Suit · ${suit.id}` : "Suit"} right={suit && suit.index >= 0 ? <button className="pe-link" onClick={openSuit}>Open</button> : undefined}>
        <SuitFields suit={suit} suitText={suitText} setSuit={setSuit} />
        {status && (
          <div className="pe-note" data-testid="pe-beam-status" data-via={status.via}>
            {status.via === "buffer"
              ? <>Edited the open tab {status.name} (unsaved; undo it there with Cmd/Ctrl+Z, and save it with the tab).</>
              : <>Written to {status.name} on disk (not in the editor's undo history).{status.undo && <> <button className="pe-link" data-testid="pe-beam-undo" onClick={status.undo}>Undo</button></>}</>}
          </div>
        )}
      </Section>
    </>
  );
}

const fmt = (n: number) => String(Math.round(n * 1000) / 1000);

const SUIT_NUM: Array<{ k: BeamKey; label: string; step: number; min?: number; max?: number }> = [
  { k: "size", label: "size", step: 0.005, min: 0 }, { k: "glowSize", label: "glowSize", step: 0.01, min: 0 },
  { k: "spacing", label: "spacing", step: 0.01, min: 0 }, { k: "count", label: "count", step: 1, min: 1 },
  { k: "thirdPersonOpacity", label: "thirdPersonOpacity", step: 0.05, min: 0, max: 1 }, { k: "firstPersonOpacity", label: "firstPersonOpacity", step: 0.05, min: 0, max: 1 },
];

function SuitFields({ suit, suitText, setSuit }: { suit: SuitLayer | null; suitText: string | null; setSuit: (key: string, value: unknown) => void }) {
  if (!suit) return <div className="pe-note" data-testid="pe-suit-none">Pick a suit under "Preview on" to see and set its beam for this ability. It colours and sizes the beam wherever the script says "(the suit's)".</div>;
  if (suit.index < 0) return <div className="pe-note" data-testid="pe-suit-missing">{suitText ?? suit.id} does not list this ability itself (abilities it inherits from a parent suit are not followed here), so there is no assets.beam to edit.</div>;
  const own = suit.own;
  return (
    <>
      <div className="pe-note">This suit's <span className="mono">assets.beam</span> for the ability, in {suitText}. It only applies to settings the script leaves empty.</div>
      <ColorField label="startColor" value={hexColor(own.startColor) ?? undefined} dflt={BEAM_DEFAULTS.startColor} doc="The core colour (the visual's coreColor)." testId="pe-suit-beam-startColor" onChange={(v, l) => { if (!l) setSuit("startColor", v); }} />
      <ColorField label="endColor" value={hexColor(own.endColor) ?? undefined} dflt={BEAM_DEFAULTS.endColor} doc="The outer, glow colour (the visual's color)." testId="pe-suit-beam-endColor" onChange={(v, l) => { if (!l) setSuit("endColor", v); }} />
      {SUIT_NUM.map((f) => (
        <NumberField key={f.k} label={f.label} value={typeof own[f.k] === "number" ? (own[f.k] as number) : undefined} placeholder={BEAM_DEFAULTS[f.k] as number} step={f.step} min={f.min} max={f.max}
          testId={`pe-suit-beam-${f.k}`} onChange={(v, l) => { if (!l) setSuit(f.k, v); }} onClear={() => setSuit(f.k, undefined)} />
      ))}
      <TextField label="texture" value={typeof own.texture === "string" ? own.texture : undefined} mono placeholder="(plain glow)" testId="pe-suit-beam-texture" onChange={(v) => setSuit("texture", v === "" ? undefined : v)} />
    </>
  );
}
