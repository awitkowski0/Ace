// Owned by the daemons agent: replace the placeholder below with the real component (keep this file's registrations).
import { registerToolWindow } from "../../toolwindows/registry";
import { CpuIcon } from "../shell/icons";
import { Placeholder } from "../shell/Placeholder";

registerToolWindow({
  id: "processes",
  title: "Processes",
  icon: <CpuIcon />,
  side: "bottom",
  shortcut: "meta shift D",
  actionId: "ActivateProcessesToolWindow",
  order: 14,
  component: () => <Placeholder name="Processes" />,
});

import { registerStatusWidget } from "../../toolwindows/registry";
import { DaemonsStatusWidget } from "./StatusWidget";
registerStatusWidget({ id: "daemons", side: "right", order: 10, component: DaemonsStatusWidget });
