import { hideToolWindow } from "../../lib/layout";
import type { ToolWindowDef } from "../../toolwindows/registry";
import type { Location } from "../../lib/ipc";
import { DotsIcon, MinusIcon } from "./icons";
import { showContextMenu } from "./contextMenu";
import { getToolWindow } from "../../toolwindows/registry";
import { liveGroup, selectGroupTab } from "./toolGroups";

export function ToolWindowFrame({ tw, root }: { tw: ToolWindowDef; root: Location }) {
  const C = tw.component;
  const H = tw.headerActions;
  const group = liveGroup(tw.id);
  return (
    <div className="toolwindow" data-toolwindow={tw.id} tabIndex={-1}>
      <div className="tw-header">
        {group.length > 1 ? (
          <div className="tw-tabs">
            {group.map((m) => (
              <span key={m} className={"tw-tab" + (m === tw.id ? " active" : "")} onMouseDown={() => m !== tw.id && selectGroupTab(m)}>{getToolWindow(m)?.title}</span>
            ))}
          </div>
        ) : (
          <span className="tw-title">{tw.title}</span>
        )}
        <div className="grow" />
        {H && <H root={root} />}
        <button
          className="icon-btn sm"
          title="Options"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            showContextMenu(r.left, r.bottom + 2, [{ label: "Hide", shortcut: "⇧⎋", run: () => hideToolWindow(tw.id) }]);
          }}
        ><DotsIcon /></button>
        <button className="icon-btn sm" title="Hide" onClick={() => hideToolWindow(tw.id)}><MinusIcon /></button>
      </div>
      <div className="tw-body"><C root={root} /></div>
    </div>
  );
}
