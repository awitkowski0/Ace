import { registerToolWindow, type ToolWindowProps } from "../../toolwindows/registry";
import { registerAction } from "../../actions/registry";
import { showToolWindow } from "../../lib/layout";
import { invoke } from "../../lib/ipc";
import { TerminalIcon } from "../shell/icons";
import { openPopup, registerPopup } from "../shell/popups";
import { showContextMenu } from "../shell/contextMenu";
import { TerminalPanel } from "./TerminalPanel";
import { TerminalSettings, ThemePicker } from "./TerminalSettings";
import { closeSurface, closeTab, activeTab, equalizeSplits, focusedPane, gotoSplit, gotoTab, moveTab, newTabInherit, renameTabPrompt, resizeSplit, selectTab, splitPane, targetPane, toggleQuick, toggleZoom, undoClose, termStore, quickStore } from "./sessions";
import { getSettings, loadGhosttyConfig, updateSettings } from "./settings";
import "@xterm/xterm/css/xterm.css";

let secureOn = false;
const toggleSecure = async () => { secureOn = await invoke<boolean>("secure_keyboard_entry", { enable: !secureOn }); return secureOn; };

const ToolbarActions = (_: ToolWindowProps) => {
  return (
    <button
      className="icon-btn sm"
      title="Terminal options"
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        showContextMenu(r.left, r.bottom + 2, [
          { label: "Terminal Settings…", shortcut: "⌘,", run: () => openPopup("TerminalSettings") },
          { label: "Select Theme…", run: () => openPopup("TerminalThemes") },
          { label: "Quick Terminal", run: toggleQuick },
          { label: "Reload Ghostty Config", shortcut: "⇧⌘,", run: () => void loadGhosttyConfig() },
          { label: (secureOn ? "✓ " : "") + "Secure Keyboard Entry", run: () => void toggleSecure() },
        ]);
      }}
    >⚙</button>
  );
};

registerToolWindow({
  id: "terminal",
  title: "Terminal",
  icon: <TerminalIcon />,
  side: "bottom",
  shortcut: "alt F12",
  actionId: "ActivateTerminalToolWindow",
  order: 10,
  component: TerminalPanel,
  headerActions: ToolbarActions,
});
registerPopup("TerminalThemes", ThemePicker);
registerPopup("TerminalSettings", TerminalSettings);
void loadGhosttyConfig();

// ---------------------------------------------------------------------------------------------------------------------
// Actions. Context {toolWindow:"terminal"}: Ghostty's keys apply only while a terminal (or the quick terminal) has focus,
// beating editor/global IntelliJ keys there (⌘D, ⌘T, ⌘W, ⌘F, ⌘K, ⌘[ ...) and leaving every other IntelliJ key alone.
// ---------------------------------------------------------------------------------------------------------------------
const ctx = { toolWindow: "terminal" } as const;
/** Run on the terminal; when invoked from outside (Find Action) make sure the tool window is showing first. */
const term = (f: () => unknown) => () => {
  if (!document.querySelector('.toolwindow[data-toolwindow="terminal"]') && !quickStore.get().open) showToolWindow("terminal");
  return void f();
};
function act(id: string, title: string, keys: string[], run: () => unknown, o: { global?: boolean; enabled?: () => boolean } = {}) {
  registerAction({ id: `Terminal.${id}`, title: `Terminal: ${title}`, defaultKeys: keys, context: o.global ? "global" : ctx, run: term(run), isEnabled: o.enabled });
}
const P = () => targetPane();
const hasSel = () => !!P()?.term.hasSelection();

// tabs
act("NewTab", "New Tab", ["meta T"], () => newTabInherit());
act("CloseSurface", "Close Split / Tab", ["meta W"], () => closeSurface());
act("CloseTab", "Close Tab", ["meta alt W"], () => { const t = activeTab(); return t && closeTab(t.id); });
act("NextTab", "Next Tab", ["meta shift CLOSE_BRACKET"], () => selectTab(1));
act("PrevTab", "Previous Tab", ["meta shift OPEN_BRACKET"], () => selectTab(-1));
act("MoveTabRight", "Move Tab Right", ["meta alt shift RIGHT"], () => moveTab(1));
act("MoveTabLeft", "Move Tab Left", ["meta alt shift LEFT"], () => moveTab(-1));
act("RenameTab", "Rename Tab", [], () => { const t = activeTab(); return t && renameTabPrompt(t.id); });
act("UndoClose", "Reopen Closed Tab / Split", ["meta shift T"], () => undoClose());
for (let i = 1; i <= 8; i++) act(`GotoTab${i}`, `Go to Tab ${i}`, [], () => gotoTab(i)); // ⌘1-9 stay IntelliJ tool-window keys
act("LastTab", "Go to Last Tab", [], () => gotoTab(-1));

// splits
act("SplitRight", "Split Right", ["meta D"], () => splitPane("row"));
act("SplitDown", "Split Down", ["meta shift D"], () => splitPane("col"));
act("PrevSplit", "Focus Previous Split", ["meta OPEN_BRACKET"], () => gotoSplit("previous"));
act("NextSplit", "Focus Next Split", ["meta CLOSE_BRACKET"], () => gotoSplit("next"));
act("FocusLeft", "Focus Split Left", ["meta alt LEFT"], () => gotoSplit("left"));
act("FocusRight", "Focus Split Right", ["meta alt RIGHT"], () => gotoSplit("right"));
act("FocusUp", "Focus Split Up", ["meta alt UP"], () => gotoSplit("up"));
act("FocusDown", "Focus Split Down", ["meta alt DOWN"], () => gotoSplit("down"));
act("EqualizeSplits", "Equalize Splits", ["meta control EQUALS"], () => equalizeSplits());
act("ResizeLeft", "Resize Split Left", ["meta control LEFT"], () => resizeSplit("left"));
act("ResizeRight", "Resize Split Right", ["meta control RIGHT"], () => resizeSplit("right"));
act("ResizeUp", "Resize Split Up", ["meta control UP"], () => resizeSplit("up"));
act("ResizeDown", "Resize Split Down", ["meta control DOWN"], () => resizeSplit("down"));
act("ToggleZoom", "Toggle Split Zoom", ["meta shift ENTER"], () => toggleZoom());

// search
act("Find", "Find in Scrollback", ["meta F"], () => { const p = P(); if (p) { p.search.open ? (p.openSearch(), document.querySelector<HTMLInputElement>(".term-search input")?.select()) : p.openSearch(); } });
act("FindNext", "Find Next", ["meta G"], () => P()?.searchNext());
act("FindPrevious", "Find Previous", ["meta shift G"], () => P()?.searchPrev());

// screen / clipboard
act("Clear", "Clear Screen", ["meta K"], () => P()?.term.clear());
act("Reset", "Reset Terminal", [], () => P()?.term.reset());
act("Copy", "Copy", ["meta C"], () => P()?.copySelection(), { enabled: hasSel });
act("Paste", "Paste", ["meta V"], () => P()?.pasteFromClipboard());
act("SelectAll", "Select All", ["meta A"], () => P()?.term.selectAll());
act("SelectLastOutput", "Select Last Command Output", [], () => P()?.selectLastOutput());
act("CopyLastOutput", "Copy Last Command Output", [], () => { const p = P(); if (p?.selectLastOutput()) p.copySelection(); });
act("PrevPrompt", "Jump to Previous Prompt", ["meta UP", "meta shift UP"], () => P()?.jumpToPrompt(-1));
act("NextPrompt", "Jump to Next Prompt", ["meta DOWN", "meta shift DOWN"], () => P()?.jumpToPrompt(1));
act("ScrollTop", "Scroll to Top", ["meta HOME"], () => P()?.term.scrollToTop());
act("ScrollBottom", "Scroll to Bottom", ["meta END"], () => P()?.term.scrollToBottom());
act("ScrollPageUp", "Scroll Page Up", ["meta PAGE_UP"], () => P()?.term.scrollPages(-1));
act("ScrollPageDown", "Scroll Page Down", ["meta PAGE_DOWN"], () => P()?.term.scrollPages(1));

// font size (per terminal)
const zoom = (d: number) => { const p = P(); if (p) p.setFontSize(p.fontSize + d); };
act("FontIncrease", "Increase Font Size", ["meta EQUALS", "meta shift EQUALS"], () => zoom(1));
act("FontDecrease", "Decrease Font Size", ["meta MINUS"], () => zoom(-1));
act("FontReset", "Reset Font Size", ["meta 0"], () => P()?.setFontSize(null));

// config / misc
act("Settings", "Settings…", ["meta COMMA"], () => openPopup("TerminalSettings"), { global: false });
act("SelectTheme", "Select Theme…", [], () => openPopup("TerminalThemes"), { global: true });
act("ReloadConfig", "Reload Ghostty Config", ["meta shift COMMA"], () => loadGhosttyConfig());
act("CommandPalette", "Command Palette (Find Action)", ["meta shift P"], () => openPopup("GotoAction"));
act("ToggleQuick", "Toggle Quick Terminal", [], () => toggleQuick(), { global: true });
act("SecureKeyboardEntry", "Toggle Secure Keyboard Entry", [], () => toggleSecure(), { global: true });
act("ToggleCopyOnSelect", "Toggle Copy on Select", [], () => updateSettings({ copyOnSelect: !getSettings().copyOnSelect }), { global: true });

// Registered at import time, i.e. before the global dispatcher, so these win while the terminal has focus:
//  - Esc goes to the shell (IntelliJ), not "focus editor"; in the find bar it closes the bar. Shift+Esc still reaches HideActiveWindow.
window.addEventListener(
  "keydown",
  (e) => {
    if (e.isComposing || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.key !== "Escape") return;
    const t = e.target as Element | null;
    if (t?.closest?.(".term-search")) {
      const p = targetPane() ?? focusedPane();
      if (p?.search.open) { e.preventDefault(); e.stopPropagation(); p.closeSearch(); }
      return;
    }
    if (!t?.closest?.(".term-host")) return;
    const p = targetPane();
    if (!p) return;
    e.preventDefault();
    e.stopPropagation();
    p.sendText("\x1b");
  },
  true,
);
void termStore;
