/**
 * Inspector and scene-tree building blocks: property rows in the Godot manner (name on the left, editor on the right, drag a
 * number's name to scrub it), plus a collapsible tree. Every editor reports changes through `onChange(value, live)`: `live`
 * is true while a scrub or colour drag is still going (one undo step is opened on the first live change and closed after).
 */
import { useEffect, useRef, useState, type ReactNode } from "react";

/** Pointer capture, tolerating synthetic pointers (no capture for them). */
export function capture(el: Element, id: number) {
  try { el.setPointerCapture(id); } catch { /* not a live pointer */ }
}

export interface Commit<T> { (value: T, live?: boolean): void }

export function Section({ title, children, right, open: initial = true }: { title: string; children: ReactNode; right?: ReactNode; open?: boolean }) {
  const [open, setOpen] = useState(initial);
  return (
    <div className="pe-sec">
      <div className="pe-sec-h" onClick={() => setOpen(!open)}>
        <span className={"pe-caret" + (open ? " open" : "")}>▸</span>
        <span className="pe-sec-t">{title}</span>
        {right && <span className="pe-sec-r" onClick={(e) => e.stopPropagation()}>{right}</span>}
      </div>
      {open && <div className="pe-sec-b">{children}</div>}
    </div>
  );
}

export function Row({ label, doc, children, onScrub, testId }: { label: string; doc?: string; children: ReactNode; onScrub?: (dx: number, phase: "start" | "move" | "end") => void; testId?: string }) {
  const start = (e: React.PointerEvent) => {
    if (!onScrub || e.button !== 0) return;
    e.preventDefault();
    const x0 = e.clientX;
    const el = e.currentTarget as HTMLElement;
    capture(el, e.pointerId);
    onScrub(0, "start");
    const move = (ev: PointerEvent) => onScrub(ev.clientX - x0, "move");
    const up = (ev: PointerEvent) => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      onScrub(ev.clientX - x0, "end");
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };
  return (
    <div className="pe-row" data-testid={testId}>
      <div className={"pe-row-l" + (onScrub ? " scrub" : "")} title={doc} onPointerDown={start}>{label}</div>
      <div className="pe-row-r">{children}</div>
    </div>
  );
}

const fmt = (v: number, step: number) => {
  const dp = step >= 1 ? 0 : Math.min(4, Math.ceil(-Math.log10(step)) + 1);
  return String(Math.round(v * 10 ** dp) / 10 ** dp);
};

/** A number box; dragging the row's label scrubs it (shift: x10 finer, alt: x10 coarser). */
export function NumberField({ label, value, onChange, step = 0.01, min, max, doc, testId, placeholder }: {
  label: string; value: number | undefined; onChange: Commit<number>; step?: number; min?: number; max?: number; doc?: string; testId?: string; placeholder?: number;
}) {
  const clamp = (v: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));
  const base = useRef(0);
  const [draft, setDraft] = useState<string | null>(null);
  const shown = value ?? placeholder;
  const scrub = (dx: number, phase: "start" | "move" | "end") => {
    if (phase === "start") { base.current = shown ?? 0; return; }
    const v = clamp(Number(fmt(base.current + Math.round(dx / 2) * step, step)));
    if (phase === "end" && dx === 0) return;
    onChange(v, phase === "move");
  };
  return (
    <Row label={label} doc={doc} onScrub={scrub} testId={testId}>
      <input
        className={"pe-in num" + (value === undefined ? " dflt" : "")}
        value={draft ?? (shown === undefined ? "" : fmt(shown, step))}
        onFocus={() => { base.current = shown ?? 0; }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => { if (draft !== null) { const n = Number(draft); if (draft.trim() !== "" && Number.isFinite(n)) onChange(clamp(n)); setDraft(null); } }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          else if (e.key === "Escape") { setDraft(null); (e.target as HTMLInputElement).blur(); }
          else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            const k = (e.key === "ArrowUp" ? 1 : -1) * step * (e.shiftKey ? 10 : 1);
            onChange(clamp(Number(fmt((shown ?? 0) + k, step))));
          }
        }}
        onPointerDown={() => { base.current = shown ?? 0; }}
        placeholder={placeholder === undefined ? "" : String(placeholder)}
      />
    </Row>
  );
}

export function Vec3Field({ label, value, onChange, step = 0.01, doc, testId, axes = ["x", "y", "z"] }: {
  label: string; value: [number, number, number]; onChange: Commit<[number, number, number]>; step?: number; doc?: string; testId?: string; axes?: [string, string, string];
}) {
  const [draft, setDraft] = useState<(string | null)[]>([null, null, null]);
  const base = useRef(value);
  const set = (i: number, v: number, live = false) => {
    const next = [...value] as [number, number, number];
    next[i] = Number(fmt(v, step));
    onChange(next, live);
  };
  return (
    <div className="pe-row" data-testid={testId}>
      <div className="pe-row-l" title={doc}>{label}</div>
      <div className="pe-row-r vec">
        {[0, 1, 2].map((i) => (
          <label key={i} className={"pe-axis a" + i}>
            <span
              className="pe-axis-k"
              onPointerDown={(e) => {
                e.preventDefault();
                const x0 = e.clientX;
                const el = e.currentTarget;
                base.current = value;
                capture(el, e.pointerId);
                const mv = (ev: PointerEvent) => set(i, base.current[i] + Math.round((ev.clientX - x0) / 2) * step, true);
                const up = (ev: PointerEvent) => { el.removeEventListener("pointermove", mv); el.removeEventListener("pointerup", up); set(i, base.current[i] + Math.round((ev.clientX - x0) / 2) * step, false); };
                el.addEventListener("pointermove", mv);
                el.addEventListener("pointerup", up);
              }}
              title={axes[i]}
            >{axes[i]}</span>
            <input
              className="pe-in num"
              value={draft[i] ?? fmt(value[i], step)}
              onChange={(e) => setDraft((d) => d.map((x, j) => (j === i ? e.target.value : x)))}
              onBlur={() => {
                const s = draft[i];
                if (s !== null) { const n = Number(s); if (s.trim() !== "" && Number.isFinite(n)) set(i, n); setDraft((d) => d.map((x, j) => (j === i ? null : x))); }
              }}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
            />
          </label>
        ))}
      </div>
    </div>
  );
}

export function TextField({ label, value, onChange, doc, testId, mono, placeholder, multiline }: {
  label: string; value: string | undefined; onChange: Commit<string>; doc?: string; testId?: string; mono?: boolean; placeholder?: string; multiline?: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => setDraft(null), [value]);
  const commit = () => { if (draft !== null && draft !== (value ?? "")) onChange(draft); setDraft(null); };
  return (
    <Row label={label} doc={doc} testId={testId}>
      {multiline ? (
        <textarea className={"pe-in txt" + (mono ? " mono" : "")} rows={3} value={draft ?? value ?? ""} placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)} onBlur={commit}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) (e.target as HTMLTextAreaElement).blur(); }} />
      ) : (
        <input className={"pe-in" + (mono ? " mono" : "")} value={draft ?? value ?? ""} placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)} onBlur={commit}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") { setDraft(null); (e.target as HTMLInputElement).blur(); } }} />
      )}
    </Row>
  );
}

export function EnumField({ label, value, options, onChange, doc, testId, allowEmpty, labels }: {
  label: string; value: string | undefined; options: readonly string[]; onChange: Commit<string | undefined>; doc?: string; testId?: string; allowEmpty?: string; labels?: (o: string) => string;
}) {
  const known = value === undefined || options.includes(value);
  return (
    <Row label={label} doc={doc} testId={testId}>
      <select className="pe-in sel" value={value ?? ""} onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}>
        {allowEmpty !== undefined && <option value="">{allowEmpty}</option>}
        {!known && <option value={value}>{value}</option>}
        {options.map((o) => <option key={o} value={o}>{labels ? labels(o) : o}</option>)}
      </select>
    </Row>
  );
}

export function BoolField({ label, value, onChange, doc, testId, dflt }: { label: string; value: boolean | undefined; onChange: Commit<boolean>; doc?: string; testId?: string; dflt?: boolean }) {
  const v = value ?? dflt ?? false;
  return (
    <Row label={label} doc={doc} testId={testId}>
      <label className={"pe-check" + (value === undefined ? " dflt" : "")}>
        <input type="checkbox" checked={v} onChange={(e) => onChange(e.target.checked)} /> {v ? "On" : "Off"}
      </label>
    </Row>
  );
}

/** `#RRGGBB` or `#AARRGGBB` (alpha kept as written when the picker changes the colour). */
export function ColorField({ label, value, onChange, doc, testId, dflt }: { label: string; value: string | undefined; onChange: Commit<string>; doc?: string; testId?: string; dflt?: string }) {
  const v = value ?? dflt ?? "#FFFFFF";
  const m = /^#([0-9a-fA-F]{2})?([0-9a-fA-F]{6})$/.exec(v.length === 9 ? v : v.length === 7 ? "#" + v.slice(1) : "#FFFFFF");
  const alpha = v.length === 9 ? v.slice(1, 3) : "";
  const rgb = m ? "#" + (v.length === 9 ? v.slice(3) : v.slice(1)) : "#ffffff";
  const live = useRef(false);
  return (
    <Row label={label} doc={doc} testId={testId}>
      <span className={"pe-color" + (value === undefined ? " dflt" : "")}>
        <input type="color" value={rgb.toLowerCase()}
          onInput={(e) => { live.current = true; onChange("#" + alpha + (e.target as HTMLInputElement).value.slice(1).toUpperCase(), true); }}
          onChange={(e) => { live.current = false; onChange("#" + alpha + e.target.value.slice(1).toUpperCase(), false); }}
          onBlur={(e) => { if (live.current) { live.current = false; onChange("#" + alpha + e.target.value.slice(1).toUpperCase(), false); } }} />
        <TextInline value={v} onChange={(s) => /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(s) && onChange(s.toUpperCase())} />
      </span>
    </Row>
  );
}

function TextInline({ value, onChange }: { value: string; onChange: (s: string) => void }) {
  const [d, setD] = useState<string | null>(null);
  return <input className="pe-in mono hex" value={d ?? value} onChange={(e) => setD(e.target.value)} onBlur={() => { if (d !== null) onChange(d); setD(null); }}
    onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />;
}

// ---------------------------------------------------------------- scene tree

export interface TreeNode {
  id: string;
  label: string;
  icon?: string;
  hint?: string;
  dim?: boolean;
  children?: TreeNode[];
}

export function SceneTree({ nodes, selected, onSelect, onActivate, testId }: {
  nodes: TreeNode[]; selected: string | null; onSelect: (id: string) => void; onActivate?: (id: string) => void; testId?: string;
}) {
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const flat: Array<{ n: TreeNode; depth: number }> = [];
  const walk = (ns: TreeNode[], depth: number) => {
    for (const n of ns) {
      flat.push({ n, depth });
      if (n.children?.length && !closed.has(n.id)) walk(n.children, depth + 1);
    }
  };
  walk(nodes, 0);
  const idx = flat.findIndex((f) => f.n.id === selected);
  return (
    <div className="pe-tree" tabIndex={0} data-testid={testId}
      onKeyDown={(e) => {
        if (e.key === "ArrowDown" && idx < flat.length - 1) { e.preventDefault(); onSelect(flat[idx + 1].n.id); }
        else if (e.key === "ArrowUp" && idx > 0) { e.preventDefault(); onSelect(flat[idx - 1].n.id); }
        else if (e.key === "ArrowLeft" && selected) setClosed((s) => new Set(s).add(selected));
        else if (e.key === "ArrowRight" && selected) setClosed((s) => { const n = new Set(s); n.delete(selected); return n; });
        else if (e.key === "Enter" && selected) onActivate?.(selected);
      }}>
      {flat.map(({ n, depth }) => (
        <div key={n.id} className={"pe-tn" + (n.id === selected ? " sel" : "") + (n.dim ? " dim" : "")} style={{ paddingLeft: 6 + depth * 14 }}
          data-node={n.id} onClick={() => onSelect(n.id)} onDoubleClick={() => onActivate?.(n.id)}>
          <span className="pe-tn-c" onClick={(e) => { if (!n.children?.length) return; e.stopPropagation(); setClosed((s) => { const x = new Set(s); if (x.has(n.id)) x.delete(n.id); else x.add(n.id); return x; }); }}>
            {n.children?.length ? (closed.has(n.id) ? "▸" : "▾") : ""}
          </span>
          {n.icon && <span className={"pe-tn-i " + n.icon} />}
          <span className="pe-tn-l">{n.label}</span>
          {n.hint && <span className="pe-tn-h">{n.hint}</span>}
        </div>
      ))}
    </div>
  );
}

export function Empty({ title, detail }: { title: string; detail?: ReactNode }) {
  return <div className="pe-empty"><div className="pe-empty-t">{title}</div>{detail && <div className="pe-empty-d">{detail}</div>}</div>;
}
