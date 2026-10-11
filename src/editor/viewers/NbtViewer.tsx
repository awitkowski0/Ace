import { useEffect, useMemo, useState } from "react";
import { registerController } from "./controllers";
import { useBytes } from "./io";
import { parseNbt, summary, TAG, type NbtNode } from "./nbt";
import { VirtualList } from "./VirtualList";
import { formatSize } from "./registry";
import { Message } from "./Placeholders";
import type { ViewerProps } from "./ImageViewer";

interface Row { node: NbtNode; depth: number; path: string }

export default function NbtViewer({ doc, groupId }: ViewerProps) {
  const { data, error } = useBytes(doc);
  const [res, setRes] = useState<{ root: NbtNode; endian: string; compressed: boolean }>();
  const [err, setErr] = useState<string>();
  const [open, setOpen] = useState<Set<string>>(new Set(["/"]));
  const [filter, setFilter] = useState("");
  useEffect(() => {
    if (!data) return;
    setRes(undefined); setErr(undefined);
    parseNbt(new Uint8Array(data)).then((r) => { setRes(r); setOpen(new Set(["/"])); }, (e) => setErr(String(e.message ?? e)));
  }, [data]);

  const rows = useMemo(() => {
    if (!res) return [] as Row[];
    const out: Row[] = [];
    const f = filter.trim().toLowerCase();
    const matches = (n: NbtNode): boolean => !f || n.name.toLowerCase().includes(f) || (n.value ?? "").toLowerCase().includes(f) || !!n.children?.some(matches);
    const walk = (n: NbtNode, depth: number, path: string) => {
      if (!matches(n)) return;
      out.push({ node: n, depth, path });
      if (n.children && (open.has(path) || f)) n.children.forEach((c) => walk(c, depth + 1, path + "/" + c.name));
    };
    walk(res.root, 0, "/");
    return out;
  }, [res, open, filter]);

  const toggle = (p: string) => setOpen((s) => { const n = new Set(s); n.has(p) ? n.delete(p) : n.add(p); return n; });
  const expandAll = () => {
    const s = new Set<string>();
    const w = (n: NbtNode, p: string, d: number) => { if (n.children && d < 6) { s.add(p); n.children.slice(0, 200).forEach((c) => w(c, p + "/" + c.name, d + 1)); } };
    if (res) w(res.root, "/", 0);
    setOpen(s);
  };
  useEffect(() => registerController(groupId, {
    snapshot: () => ({ kind: "nbt", root: res?.root.name, rootType: res ? TAG[res.root.type] : null, rootChildren: res?.root.children?.map((c) => c.name), endian: res?.endian, compressed: res?.compressed, visibleRows: rows.length }),
    ...( { expandAll, toggle } as object),
  }), [groupId, res, rows.length]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error || err) return <Message title="Cannot read NBT" detail={error ?? err} />;
  if (!res) return <div className="vw-empty">Parsing…</div>;
  return (
    <div className="nbt" data-viewer="nbt">
      <div className="iv-bar">
        <button onClick={expandAll}>Expand</button>
        <button onClick={() => setOpen(new Set(["/"]))}>Collapse</button>
        <input className="vw-filter" placeholder="Filter tags / values" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <span className="grow" />
        <span className="iv-dim">NBT · {res.compressed ? "compressed · " : ""}{res.endian}-endian · {formatSize(data?.byteLength ?? 0)} · read-only</span>
      </div>
      <VirtualList className="nbt-list" count={rows.length} rowHeight={22} render={(i) => {
        const { node, depth, path } = rows[i];
        const exp = node.children && (open.has(path) || !!filter.trim());
        return (
          <div className="nbt-row" style={{ paddingLeft: 8 + depth * 16 }} onClick={() => node.children && toggle(path)}>
            <span className="nbt-arrow">{node.children ? (exp ? "▾" : "▸") : ""}</span>
            <span className="nbt-type">{TAG[node.type]}</span>
            <span className="nbt-name">{node.name}</span>
            <span className={"nbt-val t" + node.type}>{summary(node)}</span>
          </div>
        );
      }} />
    </div>
  );
}
