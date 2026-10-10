import { useStore, useRegistry } from "../../lib/store";
import { editorStore } from "../../editor/store";
import { projectStore } from "../../lib/project";
import { shellStore } from "../../lib/shell";
import { statusWidgets } from "../../toolwindows/registry";
import { BranchIcon, ChevronRight } from "./icons";

export function StatusBar() {
  const { groups, activeGroup, docs, cursor } = useStore(editorStore);
  const { root } = useStore(projectStore);
  const { branch } = useStore(shellStore);
  const widgets = useRegistry(statusWidgets);
  const doc = docs[groups[activeGroup]?.active ?? ""];
  const rel = doc && root && doc.loc.path.startsWith(root.path) ? doc.loc.path.slice(root.path.length + 1) : doc?.loc.path;
  const crumbs = rel ? rel.split("/") : [];
  const by = (side: "left" | "right") => widgets.filter((w) => w.side === side).sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
  return (
    <div className="statusbar">
      <div className="crumbs">
        {crumbs.map((c, i) => (
          <span key={i} className="crumb">{i > 0 && <ChevronRight />}{c}</span>
        ))}
      </div>
      {by("left").map((w) => <w.component key={w.id} />)}
      <div className="grow" />
      {by("right").map((w) => <w.component key={w.id} />)}
      {doc && (
        <>
          <span className="sb-item">{cursor.line}:{cursor.col}</span>
          <span className="sb-item">LF</span>
          <span className="sb-item">UTF-8</span>
          <span className="sb-item">4 spaces</span>
        </>
      )}
      <span className="sb-item"><BranchIcon />{branch ?? "—"}</span>
    </div>
  );
}
