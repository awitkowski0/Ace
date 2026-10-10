import { registerToolWindow } from "../../toolwindows/registry";
import { registerAction } from "../../actions/registry";
import { TerminalIcon } from "../shell/icons";
import { TerminalPanel, newTerminalTab } from "./TerminalPanel";
import { closeSession, getSession, termStore } from "./sessions";
import { pty } from "./api";
import "@xterm/xterm/css/xterm.css";

registerToolWindow({
  id: "terminal",
  title: "Terminal",
  icon: <TerminalIcon />,
  side: "bottom",
  shortcut: "alt F12",
  actionId: "ActivateTerminalToolWindow",
  order: 10,
  component: TerminalPanel,
});

const inTerminal = () => !!document.activeElement?.closest(".term-host");
const activeSession = () => {
  const a = termStore.get().active;
  return a ? getSession(a) : undefined;
};

registerAction({ id: "Terminal.NewTab", context: { toolWindow: "terminal" }, title: "New Terminal Tab", defaultKeys: ["meta T"], isEnabled: inTerminal, run: () => { newTerminalTab(); } });
registerAction({ id: "Terminal.Clear", context: { toolWindow: "terminal" }, title: "Clear Terminal", defaultKeys: ["meta K"], isEnabled: inTerminal, run: () => activeSession()?.term.clear() });
registerAction({ id: "Terminal.CloseTab", context: { toolWindow: "terminal" }, title: "Close Terminal Tab", defaultKeys: ["meta W"], isEnabled: inTerminal, run: () => { const a = termStore.get().active; if (a) closeSession(a); } });

// Registered at import time, i.e. before the global dispatcher, so these win while the terminal has focus:
//  - Esc goes to the shell (IntelliJ), not "focus editor"; Shift+Esc still reaches HideActiveWindow.
//  - ⌘C copies the xterm selection, ⌘V is left to the native paste event (xterm handles it), ⌘T/⌘K/⌘W act on the terminal.
window.addEventListener(
  "keydown",
  (e) => {
    if (!inTerminal() || e.isComposing) return;
    const s = activeSession();
    if (!s) return;
    const mods = e.metaKey || e.ctrlKey || e.altKey || e.shiftKey;
    if (e.key === "Escape" && !mods) {
      e.preventDefault();
      e.stopPropagation();
      void pty.write(s.id, "\x1b").catch(() => {});
    } else if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      if (e.code === "KeyC") {
        e.preventDefault();
        e.stopPropagation();
        const sel = s.term.getSelection();
        if (sel) void navigator.clipboard.writeText(sel).catch(() => {});
      } else if (e.code === "KeyT" || e.code === "KeyK" || e.code === "KeyW") {
        e.preventDefault();
        e.stopPropagation();
        if (e.code === "KeyT") newTerminalTab();
        else if (e.code === "KeyK") s.term.clear();
        else closeSession(s.id);
      } else if (e.code === "KeyV") {
        e.stopPropagation(); // native paste event -> xterm
      }
    }
  },
  true,
);
