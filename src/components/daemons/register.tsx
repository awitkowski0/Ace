import { registerToolWindow } from "../../toolwindows/registry";
import { CpuIcon } from "../shell/icons";
import { DaemonsWindow } from "./DaemonsWindow";

registerToolWindow({
  id: "processes",
  title: "Processes",
  icon: <CpuIcon />,
  side: "bottom",
  shortcut: "meta shift D",
  actionId: "ActivateProcessesToolWindow",
  order: 14,
  component: () => <DaemonsWindow />,
});

import { registerStatusWidget } from "../../toolwindows/registry";
import { DaemonsStatusWidget } from "./StatusWidget";
registerStatusWidget({ id: "daemons", side: "right", order: 10, component: DaemonsStatusWidget });
