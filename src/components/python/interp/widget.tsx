/** Python interpreter status-bar widget (eager and tiny; the popup and the dialog are lazy: ui.tsx). */
import "./interp.css";
import { openPopup } from "../../shell/popups";
import { usePy } from "../interpreter";
import { POPUP_ID } from "./ids";
import { widgetText } from "./logic";

export function InterpreterWidget() {
  const st = usePy();
  if (!st.active) return null;
  const text = widgetText(st);
  const none = !st.current && !st.loading;
  return (
    <span
      className={"sb-item sb-pyinterp" + (none ? " warn" : "")} data-testid="py-interp-widget"
      title={st.current ? `${st.current.name}\n${st.current.path}` : "Python interpreter"}
      onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); openPopup(POPUP_ID, { right: r.right, top: r.top }); }}
    >
      {st.loading && !st.current && <span className="pyi-spin" />}
      {text}
    </span>
  );
}

