import { useStore } from "../../lib/store";
import { layoutStore, toggleToolWindow } from "../../lib/layout";
import { listToolWindows, subscribeToolWindows, type Side } from "../../toolwindows/registry";
import { useSyncExternalStore } from "react";
import { keysFor } from "../../actions/keymap";
import { formatKeystroke } from "../../actions/keystroke";

const useTW = () => useSyncExternalStore(subscribeToolWindows, listToolWindows);

function Btn({ id }: { id: string }) {
  const tws = useTW();
  const { active } = useStore(layoutStore);
  const tw = tws.find((t) => t.id === id)!;
  const on = active[tw.side] === id;
  const actionId = tw.actionId ?? `Activate${tw.id.replace(/(^|[-_ ])(\w)/g, (_, __, c: string) => c.toUpperCase())}ToolWindow`;
  const k = keysFor(actionId)[0];
  return (
    <button className={"stripe-btn" + (on ? " on" : "")} title={tw.title + (k ? `  ${formatKeystroke(k)}` : "")} onClick={() => toggleToolWindow(id)}>
      {tw.icon}
    </button>
  );
}

/** Left stripe: left tool windows on top, bottom tool windows at the bottom (IntelliJ New UI). Right stripe: right tool windows. */
export function Stripe({ which }: { which: "left" | "right" }) {
  const tws = useTW();
  const pick = (s: Side) => tws.filter((t) => t.side === s);
  return (
    <div className={"stripe " + which}>
      <div className="stripe-group">{pick(which).map((t) => <Btn key={t.id} id={t.id} />)}</div>
      <div className="grow" />
      {which === "left" && <div className="stripe-group">{pick("bottom").map((t) => <Btn key={t.id} id={t.id} />)}</div>}
    </div>
  );
}
