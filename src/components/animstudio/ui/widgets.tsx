/** Small IntelliJ-style form widgets for the Studio panels. */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useStudio } from "./state";

export function IconBtn(p: { title: string; on?: boolean; disabled?: boolean; onClick?: () => void; children: ReactNode; id?: string; wide?: boolean }) {
  return (
    <button className={"as-ib" + (p.on ? " on" : "") + (p.wide ? " wide" : "")} title={p.title} disabled={p.disabled} onClick={p.onClick} data-id={p.id} tabIndex={-1}
      onMouseDown={(e) => e.preventDefault()}>
      {p.children}
    </button>
  );
}

export function Seg<T extends string>(p: { value: T; options: { id: T; label: string; disabled?: boolean; title?: string }[]; onChange: (v: T) => void; id?: string }) {
  return (
    <div className="as-seg" data-id={p.id}>
      {p.options.map((o) => (
        <button key={o.id} className={p.value === o.id ? "on" : ""} disabled={o.disabled} title={o.title} data-v={o.id} tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={() => p.onChange(o.id)}>{o.label}</button>
      ))}
    </div>
  );
}

export function Section(p: { title: string; children: ReactNode; right?: ReactNode; grow?: boolean; collapsed?: boolean; onToggle?: () => void }) {
  return (
    <section className={"as-sec" + (p.grow ? " grow" : "")}>
      <header className="as-sec-h" onClick={p.onToggle}>
        <span className="as-sec-t">{p.title}</span>
        <span className="as-sec-r" onClick={(e) => e.stopPropagation()}>{p.right}</span>
      </header>
      {!p.collapsed && <div className="as-sec-b">{p.children}</div>}
    </section>
  );
}

const fmt = (v: number) => (Number.isInteger(v) ? String(v) : String(Math.round(v * 10000) / 10000));

/** Numeric input: Enter/blur commits, Esc reverts, ↑/↓ steps (⇧ = ×10 coarse? no: ⇧ = fine 0.1), drag the label to scrub. */
export function NumField(p: { label?: string; value: number | undefined; step?: number; onCommit: (v: number) => void; disabled?: boolean; placeholder?: string; width?: number; id?: string }) {
  const { beginGesture, endGesture } = useStudio();
  const [text, setText] = useState(p.value === undefined ? "" : fmt(p.value));
  const editing = useRef(false);
  useEffect(() => { if (!editing.current) setText(p.value === undefined ? "" : fmt(p.value)); }, [p.value]);
  const step = p.step ?? 1;
  const commit = (t: string) => {
    editing.current = false;
    const v = Number(t.trim());
    if (t.trim() === "" || !Number.isFinite(v)) { setText(p.value === undefined ? "" : fmt(p.value)); return; }
    if (v !== p.value) p.onCommit(v);
    setText(fmt(v));
  };
  const scrub = (e: React.PointerEvent) => {
    if (p.disabled || p.value === undefined) return;
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const x0 = e.clientX, v0 = p.value;
    beginGesture();
    const mv = (ev: PointerEvent) => {
      const d = Math.round((ev.clientX - x0) / 3);
      const v = Math.round((v0 + d * step * (ev.shiftKey ? 0.1 : 1)) * 10000) / 10000;
      setText(fmt(v));
      p.onCommit(v);
    };
    const up = () => { el.removeEventListener("pointermove", mv); el.removeEventListener("pointerup", up); endGesture(); };
    el.addEventListener("pointermove", mv);
    el.addEventListener("pointerup", up);
  };
  return (
    <label className="as-num" style={p.width ? { width: p.width } : undefined}>
      {p.label !== undefined && <span className="as-num-l" onPointerDown={scrub} title="Drag to scrub">{p.label}</span>}
      <input
        data-id={p.id} value={text} disabled={p.disabled} placeholder={p.placeholder} spellCheck={false}
        onFocus={(e) => { editing.current = true; e.currentTarget.select(); }}
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") { commit((e.target as HTMLInputElement).value); (e.target as HTMLInputElement).blur(); }
          else if (e.key === "Escape") { editing.current = false; setText(p.value === undefined ? "" : fmt(p.value)); (e.target as HTMLInputElement).blur(); }
          else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && p.value !== undefined) {
            e.preventDefault();
            const v = Math.round((Number(text) + (e.key === "ArrowUp" ? 1 : -1) * step * (e.shiftKey ? 0.1 : 1)) * 10000) / 10000;
            if (Number.isFinite(v)) { setText(fmt(v)); p.onCommit(v); }
          }
        }}
      />
    </label>
  );
}

export function Vec3Field(p: { label: string; value: readonly number[] | undefined; step?: number; onCommit: (v: [number, number, number]) => void; disabled?: boolean; id?: string }) {
  const v = p.value;
  const set = (i: number) => (n: number) => {
    const b = [v?.[0] ?? 0, v?.[1] ?? 0, v?.[2] ?? 0] as [number, number, number];
    b[i] = n;
    p.onCommit(b);
  };
  return (
    <div className="as-row">
      <span className="as-row-l">{p.label}</span>
      <div className="as-row-f">
        {["X", "Y", "Z"].map((a, i) => <NumField key={a} label={a} id={p.id ? `${p.id}-${a.toLowerCase()}` : undefined} value={v?.[i]} step={p.step} disabled={p.disabled} placeholder="0" onCommit={set(i)} />)}
      </div>
    </div>
  );
}

/** Vec3 row for multi-selections: `value[i]` undefined = the selected elements differ on that axis (blank); a commit changes ONE axis and gets the axis index. */
export function Vec3Multi(p: { label: string; value: ReadonlyArray<number | undefined>; step?: number; onAxis: (axis: 0 | 1 | 2, v: number) => void; disabled?: boolean; id?: string }) {
  return (
    <div className="as-row">
      <span className="as-row-l">{p.label}</span>
      <div className="as-row-f">
        {["X", "Y", "Z"].map((a, i) => <NumField key={a} label={a} id={p.id ? `${p.id}-${a.toLowerCase()}` : undefined} value={p.value[i]} step={p.step} disabled={p.disabled} placeholder="—" onCommit={(v) => p.onAxis(i as 0 | 1 | 2, v)} />)}
      </div>
    </div>
  );
}

/** The common value of `xs` or undefined when they differ (mixed values show blank, like Blockbench). */
export function common<T extends number | boolean | string | undefined>(xs: readonly T[]): T | undefined {
  return xs.length && xs.every((x) => x === xs[0]) ? xs[0] : undefined;
}
export function commonNum(xs: readonly number[]): number | undefined {
  return xs.length && xs.every((x) => Math.abs(x - xs[0]) < 1e-6) ? xs[0] : undefined;
}

export function Check(p: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; id?: string; mixed?: boolean }) {
  return (
    <label className="as-check" data-id={p.id}>
      <input type="checkbox" checked={p.checked} disabled={p.disabled} ref={(el) => { if (el) el.indeterminate = !!p.mixed; }} onChange={(e) => p.onChange(e.target.checked)} />
      <span>{p.label}</span>
    </label>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="as-empty">{children}</div>;
}
