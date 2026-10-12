/**
 * A HUD (data/<ns>/huds/*.js|json): the screen at a GUI-scaled size with every element where HudLayout puts it, filled with
 * sample values. Drag an element to move it (its offset from its anchor is rewritten); arrows nudge a pixel; the inspector
 * holds the rest.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  HUD_ANCHORS, HUD_KINDS, HUD_VALUES, HUD_WHEN, addHudElement, argb, elementRect, enumName, fillPlaceholders, nearestAnchor, offsetForRect,
  readHud, removeHudElement, setHudProp, type HudAnchor, type HudDoc, type HudElement, type HudKind,
} from "../core/hud";
import { Docks, ParseError, type ViewProps } from "./PackView";
import { capture, BoolField, ColorField, Empty, EnumField, NumberField, Section, SceneTree, TextField, type TreeNode } from "./widgets";

const SIZES: Array<[number, number, string]> = [[480, 270, "1080p · GUI 4"], [427, 240, "1080p · GUI 4.5"], [640, 360, "1080p · GUI 3"], [320, 240, "4:3 small"]];
const camelOf = (e: string) => e.toLowerCase().replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

export default function HudView({ path, text, edit }: ViewProps) {
  const form: "js" | "json" = path.endsWith(".js") ? "js" : "json";
  const { hud, error } = useMemo(() => { try { return { hud: readHud(text, form), error: null }; } catch (e) { return { hud: null as HudDoc | null, error: e }; } }, [text, form]);
  const [sel, setSel] = useState<number | null>(null);
  const [size, setSize] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const [sw, sh] = SIZES[size];
  const [hu, setHu] = useState(2); // CSS px per GUI px
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHu(el.clientWidth / sw));
    ro.observe(el);
    setHu(el.clientWidth / sw);
    return () => ro.disconnect();
  }, [sw, hud === null]);
  if (error || !hud) return <ParseError error={error} />;

  const set = (i: number, k: string, v: unknown, live = false) => edit((cur) => setHudProp(cur, form, i, k, v), live);
  const setMany = (i: number, kv: Record<string, unknown>, live = false) => edit((cur) => Object.entries(kv).reduce((t, [k, v]) => setHudProp(t, form, i, k, v), cur), live);

  const nodes: TreeNode[] = [{ id: "hud", label: path.split("/").pop()!, icon: "i-hud", children: hud.elements.map((e) => ({
    id: String(e.index), label: e.kind === "TEXT" ? (e.primary ?? "text") : e.kind === "BAR" ? `bar · ${e.primary ?? ""}` : `image · ${(e.primary ?? "").split("/").pop()}`,
    icon: e.kind === "TEXT" ? "i-text" : e.kind === "BAR" ? "i-bar" : "i-image", hint: enumName(e.props.when) || undefined,
  })) }];

  const startDrag = (ev: React.PointerEvent, el: HudElement) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    setSel(el.index);
    const b = box.current!.getBoundingClientRect();
    const k = b.width / sw;
    const r0 = elementRect(el, sw, sh);
    const x0 = ev.clientX, y0 = ev.clientY;
    const t = ev.currentTarget as HTMLElement;
    capture(t, ev.pointerId);
    const at = (e: PointerEvent) => offsetForRect(el, r0.x + Math.round((e.clientX - x0) / k), r0.y + Math.round((e.clientY - y0) / k), sw, sh);
    const mv = (e: PointerEvent) => { const [x, y] = at(e); setMany(el.index, { x, y }, true); };
    const up = (e: PointerEvent) => {
      t.removeEventListener("pointermove", mv); t.removeEventListener("pointerup", up);
      if (Math.abs(e.clientX - x0) + Math.abs(e.clientY - y0) < 2) return;
      const [x, y] = at(e);
      setMany(el.index, { x, y }, false);
    };
    t.addEventListener("pointermove", mv);
    t.addEventListener("pointerup", up);
  };

  const cur = sel !== null ? hud.elements[sel] : undefined;
  const add = (kind: HudKind) => {
    const defaults: Record<HudKind, Record<string, unknown>> = {
      TEXT: { text: "{ammo}", anchor: "BOTTOM_RIGHT", x: -12, y: -12 },
      BAR: { value: "reloadProgress", anchor: "BOTTOM_CENTER", x: 0, y: -40, width: 60, height: 3, color: "#FFFFFFFF", background: "#80000000" },
      TEXTURE: { texture: "thematic:textures/gui/scope.png", anchor: "CENTER", x: 0, y: 0, width: 32, height: 32 },
    };
    edit((c) => addHudElement(c, form, kind, defaults[kind]));
    setSel(hud.elements.length);
  };

  const view = (
    <div className="pe-tabs-host">
      <div className="pe-tabs">
        <span className="pe-tabs-l">Screen</span>
        <select className="pe-in sel" value={size} onChange={(e) => setSize(Number(e.target.value))}>{SIZES.map(([w, h, n], i) => <option key={i} value={i}>{w}×{h} · {n}</option>)}</select>
        <span className="pe-grow" />
        {HUD_KINDS.map((k) => <button key={k} className="pe-btn sm" onClick={() => add(k)} data-testid={`pe-add-${k.toLowerCase()}`}>+ {k === "TEXT" ? "Text" : k === "BAR" ? "Bar" : "Image"}</button>)}
      </div>
      <div className="pe-stage" tabIndex={0}
        onKeyDown={(e) => {
          if (!cur) return;
          const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
          if (d) { e.preventDefault(); const m = e.shiftKey ? 10 : 1; setMany(cur.index, { x: Number(cur.props.x ?? 0) + d[0] * m, y: Number(cur.props.y ?? 0) + d[1] * m }); }
          if (e.key === "Backspace" || e.key === "Delete") { e.preventDefault(); edit((c) => removeHudElement(c, form, cur.index)); setSel(null); }
        }}>
        <div className="pe-screen hud" ref={box} style={{ aspectRatio: `${sw} / ${sh}`, ["--hu" as string]: `${hu}px` }} data-testid="pe-hud" onPointerDown={() => setSel(null)}>
          <div className="pe-scene-bg" />
          {[1, 2].map((i) => <i key={"v" + i} className="pe-third v" style={{ left: `${(i * 100) / 3}%` }} />)}
          {[1, 2].map((i) => <i key={"h" + i} className="pe-third h" style={{ top: `${(i * 100) / 3}%` }} />)}
          {hud.elements.map((el) => <HudBox key={el.index} el={el} sw={sw} sh={sh} on={sel === el.index} onDown={(e) => startDrag(e, el)} />)}
        </div>
      </div>
    </div>
  );

  const inspector = cur ? (
    <>
      <Section title={cur.kind === "TEXT" ? "Text" : cur.kind === "BAR" ? "Bar" : "Image"} right={<button className="pe-link" onClick={() => { edit((c) => removeHudElement(c, form, cur.index)); setSel(null); }}>Delete</button>}>
        {cur.kind === "TEXT" && <TextField label="Text" value={cur.primary} mono onChange={(v) => set(cur.index, "@primary", v)} doc="{ammo}, {capacity}, {fireMode}, {gunName}, {reloadProgress}" testId="pe-hud-text" />}
        {cur.kind === "BAR" && <EnumField label="Value" value={cur.primary} options={HUD_VALUES.filter((v) => v !== "NONE").map(camelOf)} onChange={(v) => set(cur.index, "@primary", v)} />}
        {cur.kind === "TEXTURE" && <TextField label="Texture" value={cur.primary} mono onChange={(v) => set(cur.index, "@primary", v)} />}
        <EnumField label="Anchor" value={enumName(cur.props.anchor) || "TOP_LEFT"} options={HUD_ANCHORS} testId="pe-hud-anchor"
          onChange={(a) => {
            // re-anchor in place: the box stays where it is on screen
            const r = elementRect(cur, sw, sh);
            const moved: HudElement = { ...cur, props: { ...cur.props, anchor: a, x: 0, y: 0 } };
            const [x, y] = offsetForRect(moved, r.x, r.y, sw, sh);
            setMany(cur.index, { anchor: a, x, y });
          }} />
        <NumberField label="X" value={cur.props.x as number | undefined} placeholder={0} step={1} onChange={(v, l) => set(cur.index, "x", v, l)} testId="pe-hud-x" />
        <NumberField label="Y" value={cur.props.y as number | undefined} placeholder={0} step={1} onChange={(v, l) => set(cur.index, "y", v, l)} testId="pe-hud-y" />
        {cur.kind !== "TEXT" && <NumberField label="Width" value={cur.props.width as number | undefined} step={1} min={0} onChange={(v, l) => set(cur.index, "width", v, l)} />}
        {cur.kind !== "TEXT" && <NumberField label="Height" value={cur.props.height as number | undefined} step={1} min={0} onChange={(v, l) => set(cur.index, "height", v, l)} />}
        {cur.kind === "TEXT" && <NumberField label="Scale" value={cur.props.scale as number | undefined} placeholder={1} step={0.05} min={0.25} onChange={(v, l) => set(cur.index, "scale", v, l)} />}
        {cur.kind !== "TEXTURE" && <ColorField label="Colour" value={cur.props.color as string | undefined} dflt="#FFFFFFFF" onChange={(v, l) => set(cur.index, "color", v, l)} />}
        {cur.kind === "BAR" && <ColorField label="Background" value={cur.props.background as string | undefined} dflt="#00000000" onChange={(v, l) => set(cur.index, "background", v, l)} />}
        {cur.kind === "TEXT" && <BoolField label="Shadow" value={cur.props.shadow as boolean | undefined} dflt onChange={(v) => set(cur.index, "shadow", v)} />}
        {cur.kind === "TEXTURE" && <EnumField label="Fit" value={enumName(cur.props.fit) || undefined} options={["FIXED", "COVER"]} allowEmpty="(fixed)" onChange={(v) => set(cur.index, "fit", v)} />}
        <EnumField label="Shown" value={cur.props.when === undefined ? undefined : camelOf(enumName(cur.props.when))} options={HUD_WHEN.map(camelOf)} allowEmpty="(always)" onChange={(v) => set(cur.index, "when", v)} />
      </Section>
    </>
  ) : <Empty title="Select an element" detail="Drag it on the screen; arrows nudge (shift: 10 px)." />;

  return <Docks id="hud" tree={<SceneTree nodes={nodes} selected={sel === null ? "hud" : String(sel)} onSelect={(id) => setSel(id === "hud" ? null : Number(id))} testId="pe-tree" />} view={view} inspector={inspector} />;
}

function HudBox({ el, sw, sh, on, onDown }: { el: HudElement; sw: number; sh: number; on: boolean; onDown: (e: React.PointerEvent) => void }) {
  const r = elementRect(el, sw, sh);
  const pct = (v: number, of: number) => `${(v / of) * 100}%`;
  const style: React.CSSProperties = { left: pct(r.x, sw), top: pct(r.y, sh), width: pct(Math.max(r.w, 2), sw), height: pct(Math.max(r.h, 2), sh) };
  const color = argb(el.props.color);
  let body: React.ReactNode = null;
  if (el.kind === "TEXT") {
    const scale = Number(el.props.scale ?? 1);
    body = <span className="pe-hud-txt" style={{ color, fontSize: `calc(var(--hu) * ${8 * scale})`, textShadow: el.props.shadow === false ? "none" : `calc(var(--hu) * ${scale}) calc(var(--hu) * ${scale}) 0 #3f3f3f` }}>{fillPlaceholders(el.primary ?? "")}</span>;
  } else if (el.kind === "BAR") {
    const frac = 0.6;
    body = <span className="pe-hud-bar" style={{ background: el.props.background ? argb(el.props.background) : "transparent" }}><i style={{ width: `${frac * 100}%`, background: color }} /></span>;
  } else body = <span className="pe-hud-img">{(el.primary ?? "").split("/").pop()}</span>;
  return <div className={"pe-hud-el" + (on ? " on" : "")} style={style} data-el={el.index} onPointerDown={onDown}>{body}{on && <AnchorMark a={(enumName(el.props.anchor) || "TOP_LEFT") as HudAnchor} />}</div>;
}

function AnchorMark({ a }: { a: HudAnchor }) {
  return <span className="pe-anchor-tag">{a.toLowerCase().replace("_", " ")}</span>;
}

export { nearestAnchor };
