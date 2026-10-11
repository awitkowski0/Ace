/** "Activate virtualenv" in new local terminal tabs: tells the terminal module which `<venv>/bin/activate` to source. */
import { setTerminalActivator } from "../../terminal/api";
import { projectStore } from "../../../lib/project";
import { pyStore } from "../interpreter";
import { activateScript, insideProject } from "./logic";
import { terminalActivateSetting } from "./ops";

export const activationFor = (cwd: string): string | null => {
  if (!terminalActivateSetting.get().on) return null;
  const r = projectStore.get().root;
  const st = pyStore.get();
  if (!r || r.host !== "local" || !st.active || !insideProject(cwd, r.path)) return null;
  return activateScript(st.current);
};

export function installTerminalActivation() {
  setTerminalActivator(async ({ cwd }) => {
    // a terminal restored at startup can beat interpreter discovery: wait (bounded) for it
    if (pyStore.get().loading) {
      await new Promise<void>((res) => {
        const t = setTimeout(done, 4000);
        const off = pyStore.subscribe(() => { if (!pyStore.get().loading) done(); });
        function done() { clearTimeout(t); off(); res(); }
      });
    }
    return activationFor(cwd);
  });
}
