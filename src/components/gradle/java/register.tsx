// Hot swap entry (docs/GRADLE.md "Debug & hot swap"): launcher for Gradle Debug runs, the Compile and Reload File actions,
// Debug window buttons, hot swap on save. Everything is idle until a Gradle Debug run exists.
import { useSyncExternalStore } from "react";
import { registerAction } from "../../../actions/registry";
import { keysFor } from "../../../actions/keymap";
import { formatKeystroke } from "../../../actions/keystroke";
import { editorStore } from "../../../editor/store";
import { enableDebugLanguage, setJavaDebugLauncher } from "../../run/hooks";
import { installEditorDebug } from "../../python/debug/register";
import type { DebugSession } from "../../python/debug/session";
import { activeJavaFile, reloadJavaFile } from "./actions";
import { launchJavaDebug, liveJavaSession, setJavaExtras } from "./session";
import { hotswapOnSave, setHotswapOnSave, subscribeHotswapCfg } from "./settings";
import "./qa";
import { gradleStore } from "../model";
import { refreshJbrs } from "./jbr";

setJavaDebugLauncher(launchJavaDebug);

const hint = (id: string) => { const k = keysFor(id)[0]; return k ? ` (${formatKeystroke(k)})` : ""; };

registerAction({
  id: "Compile", title: "Compile and Reload File", intellijId: "Compile",
  isEnabled: () => !!activeJavaFile() && !!liveJavaSession(),
  run: () => void reloadJavaFile(),
});
registerAction({
  id: "Hotswap", title: "Reload Changed Classes",
  isEnabled: () => !!activeJavaFile() && !!liveJavaSession(),
  run: () => void reloadJavaFile(),
});
registerAction({
  id: "Hotswap.ToggleOnSave", title: "Toggle Hot Swap on Save",
  isEnabled: () => !!liveJavaSession(),
  run: () => void setHotswapOnSave(!hotswapOnSave()),
});

// ---- hot swap on save: a USER save (saved text changes, `initial` does not: external reloads change both)
const prev = new Map<string, { saved: string; initial: string }>();
editorStore.subscribe(() => {
  const docs = editorStore.get().docs;
  for (const [k, d] of Object.entries(docs)) {
    const p = prev.get(k);
    prev.set(k, { saved: d.saved, initial: d.initial });
    if (!p || d.dirty || d.kind === "diff" || d.viewer || p.saved === d.saved || p.initial !== d.initial) continue;
    if (!hotswapOnSave() || d.loc.host !== "local" || !d.loc.path.endsWith(".java") || !liveJavaSession()) continue;
    void reloadJavaFile(d.loc.path, { quiet: true });
  }
  for (const k of [...prev.keys()]) if (!docs[k]) prev.delete(k);
});

// ---- Debug window buttons of a Java session
const Svg = ({ children }: { children: React.ReactNode }) => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">{children}</svg>
);
function Extras(_: { session: DebugSession }) {
  const on = useSyncExternalStore(subscribeHotswapCfg, hotswapOnSave);
  return (
    <>
      <div className="dbg-sep" />
      <button className="dbg-btn" data-hotswap="reload" title={`Compile and Reload File${hint("Compile")}`} onMouseDown={(e) => e.preventDefault()} onClick={() => void reloadJavaFile()}>
        <Svg><path d="M13 8a5 5 0 1 1-1.6-3.7" /><path d="M13 2.5v3h-3" /><path d="M6 8.5l1.5 1.5L10.5 6.5" /></Svg>
      </button>
      <button className={"dbg-btn" + (on ? " on" : "")} data-hotswap="onsave" title={`Hot swap on save: ${on ? "on" : "off"} (.ace/config.json)`} onMouseDown={(e) => e.preventDefault()} onClick={() => void setHotswapOnSave(!on)}>
        <Svg><path d="M3 2.5h8l2 2v9H3z" /><path d="M5.5 2.5v3.5h4V2.5" /><path d="M8 8.5v3M6.5 10L8 11.5 9.5 10" /></Svg>
      </button>
    </>
  );
}
setJavaExtras(Extras);

// look for JetBrains Runtimes once the project is known to be a Gradle project (the run configuration dialog shows what was found)
gradleStore.subscribe(() => {
  if (!gradleStore.get().detected) return;
  void refreshJbrs();
  // Java files get the breakpoint gutter / execution line of the Debug window (the Python editor integration, shared)
  enableDebugLanguage("java");
  installEditorDebug(true);
});
