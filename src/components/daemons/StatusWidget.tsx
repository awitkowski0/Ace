import { CpuIcon } from "../shell/icons";
import { toggleToolWindow } from "../../lib/layout";

/** Placeholder: daemons agent shows total daemon count + RSS here (click opens the Processes window). */
export function DaemonsStatusWidget() {
  return (
    <span className="sb-item" title="Processes & Daemons" onClick={() => toggleToolWindow("processes")}>
      <CpuIcon />
      <span>—</span>
    </span>
  );
}
