import { useEffect, useRef, useState, type ReactNode } from "react";

/** Fixed-row-height virtual list (24px rows). */
export function VirtualList({ count, rowHeight = 24, render, onNearEnd, scrollToIndex, className }: {
  count: number;
  rowHeight?: number;
  render: (i: number) => ReactNode;
  onNearEnd?: () => void;
  scrollToIndex?: number | null;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  const [h, setH] = useState(400);
  useEffect(() => {
    const el = ref.current!;
    const ro = new ResizeObserver(() => setH(el.clientHeight));
    ro.observe(el);
    setH(el.clientHeight);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    if (scrollToIndex == null || !ref.current) return;
    const el = ref.current;
    const y = scrollToIndex * rowHeight;
    if (y < el.scrollTop) el.scrollTop = y;
    else if (y + rowHeight > el.scrollTop + el.clientHeight) el.scrollTop = y + rowHeight - el.clientHeight;
  }, [scrollToIndex, rowHeight]);
  const first = Math.max(0, Math.floor(top / rowHeight) - 4);
  const last = Math.min(count, Math.ceil((top + h) / rowHeight) + 4);
  const rows: ReactNode[] = [];
  for (let i = first; i < last; i++) rows.push(<div key={i} style={{ position: "absolute", top: i * rowHeight, left: 0, right: 0, height: rowHeight }}>{render(i)}</div>);
  return (
    <div
      ref={ref}
      className={className}
      style={{ overflow: "auto", position: "relative", flex: 1, minHeight: 0 }}
      onScroll={(e) => {
        const el = e.currentTarget;
        setTop(el.scrollTop);
        if (onNearEnd && el.scrollTop + el.clientHeight > el.scrollHeight - rowHeight * 20) onNearEnd();
      }}
    >
      <div style={{ height: count * rowHeight, position: "relative", minWidth: "100%" }}>{rows}</div>
    </div>
  );
}
