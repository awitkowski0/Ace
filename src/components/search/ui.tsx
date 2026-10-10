import { useEffect, useRef, useState, type ReactNode } from "react";

/** Render `text` with `indices` (code point positions, offset by `offset`) bolded. */
export function Hl({ text, indices, offset = 0 }: { text: string; indices?: number[]; offset?: number }) {
  if (!indices || !indices.length) return <>{text}</>;
  const set = new Set(indices.map((i) => i - offset));
  const out: ReactNode[] = [];
  let buf = "", on = false, k = 0;
  const flush = () => { if (buf) out.push(on ? <b key={k++} className="se-hl">{buf}</b> : buf); buf = ""; };
  let i = 0;
  for (const ch of text) {
    const m = set.has(i++);
    if (m !== on) { flush(); on = m; }
    buf += ch;
  }
  flush();
  return <>{out}</>;
}

/** Render text with utf16 ranges highlighted. `replacement` (if set) shows old struck + new inserted. */
export function RangeHl({ text, ranges, replacement }: { text: string; ranges: [number, number][]; replacement?: string }) {
  const out: ReactNode[] = [];
  let p = 0, k = 0;
  for (const [s, e] of ranges) {
    if (s < p) continue;
    if (s > p) out.push(text.slice(p, s));
    if (replacement !== undefined) {
      out.push(<span key={k++} className="se-old">{text.slice(s, e)}</span>);
      out.push(<span key={k++} className="se-new">{replacement}</span>);
    } else out.push(<mark key={k++} className="se-mark">{text.slice(s, e)}</mark>);
    p = e;
  }
  if (p < text.length) out.push(text.slice(p));
  return <>{out}</>;
}

/** Fixed row-height windowed list. */
export function VList<T>({ items, rowH = 24, height, sel, render, onScrollEnd }: {
  items: T[]; rowH?: number; height: number | string; sel: number; render: (item: T, i: number) => ReactNode; onScrollEnd?: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  const [h, setH] = useState(400);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setH(el.clientHeight));
    ro.observe(el);
    setH(el.clientHeight);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const el = box.current;
    if (!el || sel < 0) return;
    const y = sel * rowH;
    if (y < el.scrollTop) el.scrollTop = y;
    else if (y + rowH > el.scrollTop + el.clientHeight) el.scrollTop = y + rowH - el.clientHeight;
  }, [sel, rowH]);
  const first = Math.max(0, Math.floor(top / rowH) - 5);
  const last = Math.min(items.length, Math.ceil((top + h) / rowH) + 5);
  return (
    <div ref={box} className="se-vlist" style={{ height }} onScroll={(e) => setTop(e.currentTarget.scrollTop)}>
      <div style={{ height: items.length * rowH, position: "relative" }}>
        {items.slice(first, last).map((it, j) => (
          <div key={first + j} style={{ position: "absolute", top: (first + j) * rowH, left: 0, right: 0, height: rowH }}>{render(it, first + j)}</div>
        ))}
      </div>
    </div>
  );
}

export const kindColor: Record<string, string> = {
  class: "var(--nord13)", interface: "var(--nord13)", enum: "var(--nord13)", type: "var(--nord13)", module: "var(--nord15)",
  function: "var(--nord8)", signal: "var(--nord12)", variable: "var(--nord9)", constant: "var(--nord15)",
};
export const kindLetter: Record<string, string> = {
  class: "C", interface: "I", enum: "E", type: "T", module: "M", function: "f", signal: "S", variable: "v", constant: "c",
};
export function KindBadge({ kind }: { kind: string }) {
  return <span className="se-badge" style={{ color: kindColor[kind] ?? "var(--fg-dim)", borderColor: kindColor[kind] ?? "var(--border)" }}>{kindLetter[kind] ?? "?"}</span>;
}

export const dirOf = (rel: string) => { const i = rel.lastIndexOf("/"); return i < 0 ? "" : rel.slice(0, i); };
