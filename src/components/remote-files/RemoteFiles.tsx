import { useEffect, useRef, useState } from "react";
import { useStore } from "../../lib/store";
import { fs, joinPath } from "../../lib/ipc";
import { confirmDialog } from "../shell/dialogs";
import { clearFinishedTransfers, ensureTransferListener, humanSize, rf, transferStore } from "./api";
import { Pane, type PaneHandle } from "./Pane";
import type { DragPayload, DropTarget } from "./dnd";
import "./remote-files.css";

export function RemoteFiles() {
  const left = useRef<PaneHandle>(null);
  const right = useRef<PaneHandle>(null);
  const [activeId, setActive] = useState<"local" | "remote">("remote");
  const [wide, setWide] = useState(true);
  const root = useRef<HTMLDivElement>(null);
  const { items } = useStore(transferStore);

  useEffect(() => {
    ensureTransferListener();
    const el = root.current!;
    const ro = new ResizeObserver(() => setWide(el.clientWidth >= 640));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pane = (id: "local" | "remote") => (id === "local" ? left : right).current;
  const act = () => pane(activeId);

  // refresh both panes when a transfer finishes
  const doneCount = items.filter((t) => t.state === "done").length;
  const prevDone = useRef(0);
  useEffect(() => {
    if (doneCount > prevDone.current) {
      const t = setTimeout(() => { left.current?.refresh(); right.current?.refresh(); }, 150);
      prevDone.current = doneCount;
      return () => clearTimeout(t);
    }
    prevDone.current = doneCount;
  }, [doneCount]);

  const upload = (entries = left.current?.selected() ?? [], dir?: string) => {
    const r = right.current;
    if (!r || !entries.length) return;
    const c = r.cwd();
    rf.upload(c.host, entries.map((e) => e.path), dir ?? c.path).catch((e) => confirmDialog({ title: "Upload failed", message: String(e) }));
  };
  const download = (entries = right.current?.selected() ?? [], dir?: string) => {
    const l = left.current, r = right.current;
    if (!l || !r || !entries.length) return;
    rf.download(r.cwd().host, entries.map((e) => e.path), dir ?? l.cwd().path).catch((e) => confirmDialog({ title: "Download failed", message: String(e) }));
  };

  const onDrop = async (src: DragPayload, t: DropTarget) => {
    const dstHandle = pane(t.paneId as "local" | "remote");
    if (!dstHandle) return;
    const dstDir = t.dir ?? dstHandle.cwd().path;
    if (src.paneId === t.paneId) {
      // move within the same filesystem
      const host = dstHandle.cwd().host;
      if (!t.dir) return;
      try {
        for (const e of src.entries) await fs.rename({ host, path: e.path }, { host, path: joinPath(dstDir, e.name) });
      } catch (e) {
        await confirmDialog({ title: "Move failed", message: String(e) });
      }
      pane(src.paneId as "local" | "remote")?.refresh();
      return;
    }
    if (src.paneId === "local") upload(src.entries, dstDir);
    else download(src.entries, dstDir);
  };

  const btn = (label: string, run: () => void, title = label) => (
    <button className="rf-btn" title={title} onClick={run}>{label}</button>
  );
  const busy = items.some((t) => t.state === "queued" || t.state === "running");
  const finished = items.some((t) => t.state !== "queued" && t.state !== "running");

  return (
    <div className="rf-root" ref={root} tabIndex={-1}>
      <div className="rf-toolbar">
        {btn("↑ Upload", () => upload(), "Upload selection from the local pane to the remote folder")}
        {btn("↓ Download", () => download(), "Download selection from the remote pane to the local folder")}
        <span className="rf-tsep" />
        {btn("New Folder", () => act()?.newFolder())}
        {btn("Rename", () => act()?.rename())}
        {btn("Delete", () => act()?.remove())}
        {btn("Chmod", () => act()?.chmod())}
        {btn("Refresh", () => { left.current?.refresh(); right.current?.refresh(); })}
      </div>
      <div className={"rf-panes" + (wide ? " wide" : "")}>
        <Pane ref={left} paneId="local" active={activeId === "local"} onActivate={() => setActive("local")} onDrop={onDrop} />
        <Pane ref={right} paneId="remote" active={activeId === "remote"} onActivate={() => setActive("remote")} onDrop={onDrop} />
      </div>
      <div className="rf-queue">
        <div className="rf-queue-head">
          <span>Transfers{busy ? ` (${items.filter((t) => t.state === "running" || t.state === "queued").length} active)` : ""}</span>
          <span className="grow" />
          {finished && <button className="rf-link" onClick={clearFinishedTransfers}>Clear finished</button>}
        </div>
        <div className="rf-queue-list">
          {items.length === 0 && <div className="rf-queue-empty">Drag files between the panes, or use Upload / Download.</div>}
          {[...items].reverse().map((t) => {
            const pct = t.total > 0 ? Math.min(100, (t.bytes / t.total) * 100) : t.state === "done" ? 100 : 0;
            return (
              <div key={t.id} className={"rf-tr " + t.state}>
                <span className="rf-tr-dir">{t.direction === "upload" ? "↑" : "↓"}</span>
                <span className="rf-tr-name" title={t.error ?? t.name}>{t.name}</span>
                <span className="rf-tr-bar"><i style={{ width: pct + "%" }} /></span>
                <span className="rf-tr-info">
                  {t.state === "error" ? "failed" : t.state === "done" ? humanSize(t.bytes) : t.state === "cancelled" ? "cancelled" : t.state === "queued" ? "queued" : `${humanSize(t.bytes)}${t.total ? ` / ${humanSize(t.total)}` : ""}`}
                </span>
                {(t.state === "running" || t.state === "queued") && (
                  <button className="icon-btn sm" title="Cancel" onClick={() => rf.cancel(t.id)}>✕</button>
                )}
                {t.state === "error" && <button className="rf-link" onClick={() => confirmDialog({ title: "Transfer failed", message: `${t.name}: ${t.error}` })}>details</button>}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
