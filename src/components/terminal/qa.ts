/** Test hooks for scripts/qa/terminal.mjs (only loaded by the automation harness). */
import { qaHooks } from "./notify";
import { getSettings, updateSettings, resetSettings } from "./settings";
import { activeTab, allPanes, getPane, quickStore, termStore, tabTitle, targetPane, undoDepth } from "./sessions";
import { findPaths } from "./links";
import { showToolWindow } from "../../lib/layout";
import { closePopup } from "../shell/popups";
import { hideContextMenu } from "../shell/contextMenu";
import { layoutRects, leaves } from "./splitTree";

const paneInfo = (id: string, focus: string) => {
  const p = getPane(id) ?? allPanes().find((x) => x.id === id)!;
  const b = p.term.buffer.active;
  return {
    id, host: p.host, cwd: p.cwd, cwdFromShell: p.cwdFromShell, title: p.title, exited: p.exited, running: p.running, lastExit: p.lastExit,
    focused: focus === id, fontSize: p.fontSize, cols: p.term.cols, rows: p.term.rows, bell: p.bell, gl: p.glActive, images: p.imagesLoaded,
    blocks: p.blocks.length, promptLines: p.blocks.map((b) => b.prompt.line), outLines: p.blocks.map((b) => b.out?.line ?? -1), searchOpen: p.search.open, searchCount: p.search.count, hasSelection: p.term.hasSelection(), selection: p.term.getSelection().slice(0, 200),
    viewportY: b.viewportY, baseY: b.baseY, sync: p.term.modes.synchronizedOutputMode, bracketed: p.term.modes.bracketedPasteMode,
    domFocused: p.el.contains(document.activeElement), connected: p.el.isConnected,
  };
};

export const termQa = {
  /** Test baseline between checks: no popup/menu, terminal tool window visible with the focused pane focused (state is kept). */
  settle() {
    closePopup();
    hideContextMenu();
    if (!document.querySelector('.toolwindow[data-toolwindow="terminal"]')) showToolWindow("terminal");
    setTimeout(() => targetPane()?.focus() ?? (activeTab() && getPane(activeTab()!.focus)?.focus()), 60);
  },
  state() {
    const { tabs, active } = termStore.get();
    return {
      active,
      tabs: tabs.map((t) => ({
        id: t.id, title: tabTitle(t), custom: t.custom ?? null, focus: t.focus, zoom: t.zoom,
        panes: leaves(t.root).map((id) => paneInfo(id, t.focus)),
        rects: Object.fromEntries([...layoutRects(t.root)].map(([k, r]) => [k, r])),
      })),
      quick: { open: quickStore.get().open, pane: quickStore.get().pane ? paneInfo(quickStore.get().pane!.id, "") : null },
      undo: undoDepth(),
      target: targetPane()?.id ?? null,
      activeTab: activeTab()?.id ?? null,
    };
  },
  pane: (id: string) => getPane(id) ?? allPanes().find((p) => p.id === id),
  inject: (id: string, data: string) => termQa.pane(id)!.inject(data),
  write: (id: string, data: string) => termQa.pane(id)!.term.write(data),
  sendText: (id: string, data: string) => termQa.pane(id)!.sendText(data),
  record: (id: string) => { const p = termQa.pane(id)!; p.writes = []; },
  writes: (id: string) => termQa.pane(id)!.writes ?? [],
  /** Visible text of the whole buffer (scrollback included) */
  text: (id: string) => {
    const b = termQa.pane(id)!.term.buffer.active;
    const out: string[] = [];
    for (let i = 0; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? "");
    return out.join("\n");
  },
  hooks: qaHooks,
  settings: getSettings,
  updateSettings,
  resetSettings,
  findPaths,
  /** Ask the pane's link providers for the links on buffer line y (1-based) */
  async links(id: string, y: number) {
    const p = termQa.pane(id)!;
    const providers = (p.term as any)._core?._linkProviderService?.linkProviders ?? [];
    const out: Array<{ text: string; activate: (e: any, text: string) => void }> = [];
    for (const lp of providers) {
      await new Promise<void>((res) => lp.provideLinks(y, (ls: any[] | undefined) => { (ls ?? []).forEach((l) => out.push(l)); res(); }));
    }
    return out;
  },
  async activateLink(id: string, y: number, text: string) {
    const l = (await termQa.links(id, y)).find((x) => x.text.includes(text));
    if (!l) return false;
    l.activate({ metaKey: true } as MouseEvent, l.text);
    return true;
  },
};
