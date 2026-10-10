import { useEffect, useLayoutEffect, useRef, type PointerEvent as RPointerEvent } from "react";
import type { ToolWindowProps } from "../../toolwindows/registry";
import { useStore } from "../../lib/store";
import { invoke } from "../../lib/ipc";
import { CloseIcon, ChevronDown } from "../shell/icons";
import { showContextMenu } from "../shell/contextMenu";
import { Pane } from "./pane";
import { SearchBar } from "./SearchBar";
import { equalizeSplits, closeTab, createSession, getPane, moveTab, newTabInherit, renameTabPrompt, setActive, setLastRoot, setSplitRatio, tabHasBell, tabTitle, takeWantFocus, termStore, undoClose, type Tab } from "./sessions";
import { layoutRects, layoutSplits, leaves, type Rect } from "./splitTree";
import "./terminal.css";

export const newTerminalTab = (host?: string) => (host ? createSession({ host, cwd: host === "local" ? "~" : "~" }) : void newTabInherit());

const pct = (n: number) => `${n * 100}%`;
const FULL: Rect = { x: 0, y: 0, w: 1, h: 1 };

/** Mount a pane's element into a slot, open/spawn it, keep it sized. Also used by the quick terminal. */
export function usePaneMount(pane: Pane | null, slot: React.RefObject<HTMLDivElement | null>, deps: unknown[] = []) {
  useLayoutEffect(() => {
    const el = slot.current;
    if (!el || !pane) return;
    el.appendChild(pane.el);
    pane.setVisible(true);
    void pane.attach();
    if (takeWantFocus(pane.id)) pane.focus();
    const ro = new ResizeObserver(() => pane.refit());
    ro.observe(el);
    return () => {
      ro.disconnect();
      setTimeout(() => { if (!pane.el.isConnected && !pane.disposed) pane.setVisible(false); }, 100);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane, ...deps]);
}

function PaneView({ pane, rect, focused, multi }: { pane: Pane; rect: Rect; focused: boolean; multi: boolean }) {
  const mount = useRef<HTMLDivElement>(null);
  usePaneMount(pane, mount);
  useEffect(() => {
    const ta = pane.term.textarea;
    if (!ta) return;
    if (focused) ta.setAttribute("data-autofocus", ""); else ta.removeAttribute("data-autofocus");
  });
  return (
    <div
      className={"term-slot" + (focused && multi ? " focused" : "") + (multi && !focused ? " dim" : "")}
      style={{ left: pct(rect.x), top: pct(rect.y), width: pct(rect.w), height: pct(rect.h) }}
      data-pane={pane.id}
    >
      <div className="term-mount" ref={mount} />
      {pane.search.open && <SearchBar pane={pane} />}
    </div>
  );
}

function Divider({ tab, id, dir, rect, ratio }: { tab: Tab; id: string; dir: "row" | "col"; rect: Rect; ratio: number }) {
  const row = dir === "row";
  const drag = (e: RPointerEvent<HTMLDivElement>) => {
    const host = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
    const move = (ev: PointerEvent) => {
      const r = row
        ? (ev.clientX - host.left - rect.x * host.width) / (rect.w * host.width)
        : (ev.clientY - host.top - rect.y * host.height) / (rect.h * host.height);
      setSplitRatio(tab.id, id, r);
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const style = row
    ? { left: pct(rect.x + rect.w * ratio), top: pct(rect.y), height: pct(rect.h) }
    : { top: pct(rect.y + rect.h * ratio), left: pct(rect.x), width: pct(rect.w) };
  return <div className={"term-divider " + dir} style={style} data-split={id} onPointerDown={drag} onDoubleClick={equalizeSplits} />;
}
function SplitArea({ tab }: { tab: Tab }) {
  const all = leaves(tab.root);
  const rects = layoutRects(tab.root);
  const visible = tab.zoom && all.includes(tab.zoom) ? [tab.zoom] : all;
  const zoomed = visible.length === 1 && all.length > 1;
  return (
    <div className="term-splits" data-tab={tab.id} data-zoomed={zoomed ? "1" : undefined}>
      {visible.map((id) => {
        const p = getPane(id);
        return p ? <PaneView key={id} pane={p} rect={zoomed ? FULL : rects.get(id) ?? FULL} focused={tab.focus === id} multi={all.length > 1} /> : null;
      })}
      {!zoomed && layoutSplits(tab.root).map((s) => <Divider key={s.id} tab={tab} id={s.id} dir={s.dir} rect={s.rect} ratio={s.ratio} />)}
      {zoomed && <div className="term-zoom-badge" title="Zoomed split (⇧⌘↩ to restore)">zoomed</div>}
    </div>
  );
}

export function TerminalPanel({ root }: ToolWindowProps) {
  setLastRoot(root);
  const { tabs, active } = useStore(termStore);
  const tab = tabs.find((t) => t.id === active);

  // Start with one tab the first time the window opens.
  useEffect(() => {
    if (termStore.get().tabs.length === 0) createSession({ host: root.host, cwd: root.path });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const hostMenu = async (e: React.MouseEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    let hosts: string[] = [];
    try { hosts = await invoke<string[]>("remote_hosts"); } catch {}
    showContextMenu(r.left, r.bottom + 2, [
      { label: "New Local Session", run: () => newTerminalTab("local") },
      { label: "", separator: true },
      ...(hosts.length
        ? hosts.map((h) => ({ label: `New SSH Session: ${h}`, run: () => createSession({ host: h, cwd: "~" }) }))
        : [{ label: "No SSH hosts in ~/.ssh/config", disabled: true }]),
    ]);
  };

  return (
    <div className="term-panel">
      <div className="term-tabs">
        {tabs.map((t) => {
          const p = getPane(t.focus);
          const bell = t.id !== active && tabHasBell(t);
          const host = p?.host ?? "local";
          return (
            <div
              key={t.id}
              className={"term-tab" + (t.id === active ? " active" : "")}
              data-tab-id={t.id}
              onMouseDown={(e) => {
                if (e.button === 1) { e.preventDefault(); void closeTab(t.id); }
                else if (e.button === 0) setActive(t.id);
              }}
              onDoubleClick={() => void renameTabPrompt(t.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                showContextMenu(e.clientX, e.clientY, [
                  { label: "Rename Tab", run: () => void renameTabPrompt(t.id) },
                  { label: "Move Tab Left", run: () => moveTab(-1, t.id) },
                  { label: "Move Tab Right", run: () => moveTab(1, t.id) },
                  { label: "", separator: true },
                  { label: "Close Tab", shortcut: "⌥⌘W", run: () => void closeTab(t.id) },
                  { label: "Reopen Closed Tab", shortcut: "⇧⌘T", run: () => void undoClose() },
                ]);
              }}
            >
              {host !== "local" && <span className="term-badge">{host}</span>}
              {bell && <span className="term-bell" title="Bell" />}
              <span className="term-title">{tabTitle(t)}</span>
              {p?.exited && <span className="term-exited">(exited)</span>}
              {leaves(t.root).length > 1 && <span className="term-count">{leaves(t.root).length}</span>}
              <button className="term-x" title="Close" onMouseDown={(e) => e.stopPropagation()} onClick={() => void closeTab(t.id)}><CloseIcon size={10} /></button>
            </div>
          );
        })}
        <button className="term-add" title="New Tab (⌘T)" onClick={() => newTerminalTab()}>+</button>
        <button className="term-add" title="Select session type" onClick={hostMenu}><ChevronDown /></button>
      </div>
      <div className="term-body">{tab && <SplitArea key={tab.id} tab={tab} />}</div>
    </div>
  );
}
