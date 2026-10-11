import "./shell.css";
import { useStore } from "../../lib/store";
import { layoutStore } from "../../lib/layout";
import { activeMemberOf, clickGroup, isGroupedFollower } from "./toolGroups";
import { listToolWindows, subscribeToolWindows, toolBadges, type Side } from "../../toolwindows/registry";
import { liveGroup } from "./toolGroups";
import { useSyncExternalStore } from "react";
import { keysFor } from "../../actions/keymap";
import { formatKeystroke } from "../../actions/keystroke";

const useTW = () => useSyncExternalStore(subscribeToolWindows, listToolWindows);

function Btn({ id }: { id: string }) {
  const tws = useTW();
  const { active } = useStore(layoutStore);
  const tw = tws.find((t) => t.id === id)!;
  const on = active[tw.side] === id || (!!activeMemberOf(id) && activeMemberOf(id) === active[tw.side]);
  const actionId = tw.actionId ?? `Activate${tw.id.replace(/(^|[-_ ])(\w)/g, (_, __, c: string) => c.toUpperCase())}ToolWindow`;
  const k = keysFor(actionId)[0];
  const { map } = useStore(toolBadges);
  const badge = liveGroup(id).map((m) => map[m]).find(Boolean);
  return (
    <button className={"stripe-btn" + (on ? " on" : "")} title={tw.title + (k ? `  ${formatKeystroke(k)}` : "")} onClick={() => clickGroup(id)}>
      {tw.icon}
      {badge && <span className={"stripe-badge " + (badge.kind ?? "")} title={badge.title} data-badge={id}>{badge.text}</span>}
    </button>
  );
}

/** Left stripe: left tool windows on top, bottom tool windows at the bottom (IntelliJ New UI). Right stripe: right tool windows. */
export function Stripe({ which }: { which: "left" | "right" }) {
  const tws = useTW();
  const pick = (s: Side) => tws.filter((t) => t.side === s && !isGroupedFollower(t.id));
  return (
    <div className={"stripe " + which}>
      <div className="stripe-group">{pick(which).map((t) => <Btn key={t.id} id={t.id} />)}</div>
      <div className="grow" />
      {which === "left" && <div className="stripe-group">{pick("bottom").map((t) => <Btn key={t.id} id={t.id} />)}</div>}
    </div>
  );
}
