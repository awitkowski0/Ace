import { useEffect, useMemo, useState } from "react";
import { registerController } from "./controllers";
import { detectDelimiter, parseCsv, sortedIndex } from "./csv";
import { VirtualList } from "./VirtualList";
import { extOf } from "./registry";
import type { ViewerProps } from "./ImageViewer";

const RH = 22;
export default function CsvTable({ doc, groupId, text }: ViewerProps & { text: string }) {
  const ext = extOf(doc.name);
  const [header, setHeader] = useState(true);
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 | 0 }>({ col: 0, dir: 0 });
  const { rows, delim } = useMemo(() => { const d = detectDelimiter(text, ext); return { rows: parseCsv(text, d), delim: d }; }, [text, ext]);
  const head = header ? rows[0] ?? [] : [];
  const body = useMemo(() => (header ? rows.slice(1) : rows), [rows, header]);
  const cols = useMemo(() => rows.reduce((m, r) => Math.max(m, r.length), 0), [rows]);
  const order = useMemo(() => sortedIndex(body, sort.col, sort.dir), [body, sort]);
  const widths = useMemo(() => {
    const w: number[] = [];
    for (let c = 0; c < cols; c++) {
      let m = (head[c] ?? "").length + 3;
      for (let r = 0; r < Math.min(body.length, 200); r++) m = Math.max(m, (body[r][c] ?? "").length);
      w.push(Math.min(46, Math.max(6, m)) * 7.4 + 16);
    }
    return w;
  }, [cols, head, body]);
  const cycle = (c: number) => setSort((s) => (s.col !== c ? { col: c, dir: 1 } : { col: c, dir: s.dir === 1 ? -1 : s.dir === -1 ? 0 : 1 }));
  useEffect(() => registerController(groupId, {
    snapshot: () => ({ kind: "csv", rows: body.length, cols, delim, header, sort, first: order.slice(0, 5).map((i) => body[i]), head }),
    ...( { sort: (col: number, dir: 1 | -1 | 0) => setSort({ col, dir }) } as object),
  }), [groupId, body, cols, delim, header, sort, order, head]);
  const total = widths.reduce((a, b) => a + b, 0) + 56;
  return (
    <div className="csv" data-viewer="csv">
      <div className="iv-bar">
        <label className="chk"><input type="checkbox" checked={header} onChange={(e) => setHeader(e.target.checked)} /> First row is header</label>
        <span className="grow" />
        <span className="iv-dim">{body.length.toLocaleString()} rows × {cols} columns · delimiter {delim === "\t" ? "tab" : `"${delim}"`}</span>
      </div>
      <VirtualList
        className="csv-list" count={order.length} rowHeight={RH}
        header={
          <div className="csv-head" style={{ width: total }}>
            <div className="csv-cell rn">#</div>
            {Array.from({ length: cols }, (_, c) => (
              <div key={c} className="csv-cell hd" style={{ width: widths[c] }} onClick={() => cycle(c)} title="Click to sort">
                {header ? head[c] ?? "" : `Column ${c + 1}`}
                <span className="sortmark">{sort.col === c && sort.dir ? (sort.dir === 1 ? " ▲" : " ▼") : ""}</span>
              </div>
            ))}
          </div>
        }
        render={(i) => {
          const r = body[order[i]];
          return (
            <div className="csv-row" style={{ width: total }}>
              <div className="csv-cell rn">{order[i] + 1}</div>
              {Array.from({ length: cols }, (_, c) => <div key={c} className="csv-cell" style={{ width: widths[c] }} title={r[c]}>{r[c] ?? ""}</div>)}
            </div>
          );
        }}
      />
    </div>
  );
}
