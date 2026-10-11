import { useEffect, useMemo, useState } from "react";
import { fs } from "../../lib/ipc";
import { registerController } from "./controllers";
import { mimeOf } from "./io";
import { listZip, readEntry, type ZipEntry } from "./zip";
import { VirtualList } from "./VirtualList";
import { extOf, formatSize } from "./registry";
import { hexDump, Message } from "./Placeholders";
import type { ViewerProps } from "./ImageViewer";

interface Row { path: string; name: string; depth: number; dir: boolean; entry?: ZipEntry }
const IMG = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"]);

export default function ArchiveViewer({ doc, groupId }: ViewerProps) {
  const [entries, setEntries] = useState<ZipEntry[]>();
  const [size, setSize] = useState(0);
  const [err, setErr] = useState<string>();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState<string>();
  const [prev, setPrev] = useState<{ kind: "text" | "image" | "binary" | "error"; text?: string; url?: string; note?: string }>();
  const [filter, setFilter] = useState("");

  const read = useMemo(() => async (o: number, l: number) => new Uint8Array(await fs.readBytes(doc.loc, o, l)), [doc.loc.host, doc.loc.path, doc.rev]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    let dead = false;
    setEntries(undefined); setErr(undefined);
    fs.stat(doc.loc).then(async (s) => { setSize(s.size); const e = await listZip(s.size, read); if (!dead) setEntries(e); }).catch((e) => !dead && setErr(String(e?.message ?? e)));
    return () => { dead = true; };
  }, [read]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = useMemo(() => {
    if (!entries) return [] as Row[];
    const f = filter.trim().toLowerCase();
    if (f) return entries.filter((e) => !e.dir && e.name.toLowerCase().includes(f)).slice(0, 5000).map((e) => ({ path: e.name, name: e.name, depth: 0, dir: false, entry: e }));
    // synthesize directories; list children of open dirs
    const dirs = new Set<string>();
    for (const e of entries) { const parts = e.name.split("/"); for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/") + "/"); }
    const all: Row[] = [];
    for (const d of dirs) all.push({ path: d, name: d.slice(d.slice(0, -1).lastIndexOf("/") + 1, -1), depth: d.split("/").length - 2, dir: true });
    for (const e of entries) if (!e.dir) all.push({ path: e.name, name: e.name.slice(e.name.lastIndexOf("/") + 1), depth: e.name.split("/").length - 1, dir: false, entry: e });
    all.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    // dirs sort before their children by path prefix; hide children of closed dirs
    return all.filter((r) => { const parts = r.path.split("/").filter(Boolean); for (let i = 1; i < parts.length; i++) if (!open.has(parts.slice(0, i).join("/") + "/")) return false; return true; });
  }, [entries, open, filter]);

  useEffect(() => {
    const en = entries?.find((e) => e.name === sel);
    if (!en) return setPrev(undefined);
    let dead = false, url: string | undefined;
    (async () => {
      try {
        if (en.size > 8 * 1024 * 1024) return setPrev({ kind: "error", note: `${formatSize(en.size)} is too large to preview` });
        const b = await readEntry(en, read);
        if (dead) return;
        const ext = extOf(en.name);
        if (IMG.has(ext)) { url = URL.createObjectURL(new Blob([b as BlobPart], { type: mimeOf(ext) })); return setPrev({ kind: "image", url }); }
        const head = b.subarray(0, 8192);
        if (head.includes(0)) return setPrev({ kind: "binary", text: hexDump(b, 1024) });
        setPrev({ kind: "text", text: new TextDecoder().decode(b.subarray(0, 512 * 1024)) });
      } catch (e) { if (!dead) setPrev({ kind: "error", note: String((e as Error).message ?? e) }); }
    })();
    return () => { dead = true; if (url) URL.revokeObjectURL(url); };
  }, [sel, entries, read]);

  useEffect(() => registerController(groupId, {
    snapshot: () => ({ kind: "archive", entries: entries?.length, files: entries?.filter((e) => !e.dir).length, sel, preview: prev?.kind, previewText: prev?.text?.slice(0, 60) }),
    ...( { select: setSel, openDir: (p: string) => setOpen((s) => new Set(s).add(p)) } as object),
  }), [groupId, entries, sel, prev]);

  if (err) return <Message title="Cannot read archive" detail={err} />;
  if (!entries) return <div className="vw-empty">Reading…</div>;
  return (
    <div className="zv" data-viewer="archive">
      <div className="iv-bar">
        <input className="vw-filter" placeholder="Filter entries" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <span className="grow" />
        <span className="iv-dim">{entries.filter((e) => !e.dir).length.toLocaleString()} files · {formatSize(size)} · read-only</span>
      </div>
      <div className="zv-split">
        <VirtualList className="zv-list" count={rows.length} rowHeight={22} render={(i) => {
          const r = rows[i];
          return (
            <div className={"zv-row" + (sel === r.path ? " sel" : "")} style={{ paddingLeft: 8 + r.depth * 14 }}
              onClick={() => r.dir ? setOpen((s) => { const n = new Set(s); n.has(r.path) ? n.delete(r.path) : n.add(r.path); return n; }) : setSel(r.path)}>
              <span className="nbt-arrow">{r.dir ? (open.has(r.path) ? "▾" : "▸") : ""}</span>
              <span className="zv-name" title={r.path}>{r.name}</span>
              {r.entry && <span className="zv-size">{formatSize(r.entry.size)}</span>}
            </div>
          );
        }} />
        <div className="zv-prev">
          {!prev && <div className="vw-empty">Select an entry to preview it</div>}
          {prev?.kind === "image" && <div className="zv-img iv-checker"><img src={prev.url} style={{ imageRendering: "pixelated" }} alt={sel} /></div>}
          {(prev?.kind === "text" || prev?.kind === "binary") && <pre className="zv-text">{prev.text}</pre>}
          {prev?.kind === "error" && <div className="vw-empty">{prev.note}</div>}
        </div>
      </div>
    </div>
  );
}
