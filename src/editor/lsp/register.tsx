// Owned by the LSP agent. Currently registers the Problems tool window placeholder (diagnostics list goes here).
import { registerToolWindow } from "../../toolwindows/registry";
import { ProblemsIcon } from "../../components/shell/icons";
import { Placeholder } from "../../components/shell/Placeholder";

registerToolWindow({
  id: "problems",
  title: "Problems",
  icon: <ProblemsIcon />,
  side: "bottom",
  shortcut: "meta 6",
  actionId: "ActivateProblemsViewToolWindow",
  order: 11,
  component: () => <Placeholder name="Problems" />,
});
