import { useEffect, useLayoutEffect, useRef, useState } from "react";

/** Fixed-row-height windowed list: only the rows in view (+overscan) exist in the DOM. */
export function VirtualList({ count, rowHeight, render, className, header, onScrollEl }: {
  count: number; rowHeight: number; render: (i: number) => React.ReactNode; className?: string; header?: React.ReactNode; onScrollEl?: (el: HTMLDivElement | null) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, h: 600 });
  useLayoutEffect(() => {
    const el = ref.current!;
    onScrollEl?.(el);
    const upd = () => setView({ top: el.scrollTop, h: el.clientHeight });
    upd();
    el.addEventListener("scroll", upd, { passive: true });
    const ro = new ResizeObserver(upd);
    ro.observe(el);
    return () => { el.removeEventListener("scroll", upd); ro.disconnect(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const el = ref.current; if (el && el.scrollTop > Math.max(0, count * rowHeight - el.clientHeight)) el.scrollTop = 0; }, [count, rowHeight]);
  const first = Math.max(0, Math.floor(view.top / rowHeight) - 8);
  const last = Math.min(count, Math.ceil((view.top + view.h) / rowHeight) + 8);
  const rows: React.ReactNode[] = [];
  for (let i = first; i < last; i++) rows.push(<div key={i} className="vl-row" style={{ position: "absolute", top: i * rowHeight, height: rowHeight, left: 0, right: 0 }}>{render(i)}</div>);
  return (
    <div className={"vl " + (className ?? "")} ref={ref}>
      {header}
      <div style={{ position: "relative", height: count * rowHeight, minWidth: "100%" }}>{rows}</div>
    </div>
  );
}
