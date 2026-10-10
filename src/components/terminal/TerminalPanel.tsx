import { useEffect, useRef, useSyncExternalStore } from "react";
import type { ToolWindowProps } from "../../toolwindows/registry";
import { useStore } from "../../lib/store";
import { invoke } from "../../lib/ipc";
import { CloseIcon, ChevronDown } from "../shell/icons";
import { showContextMenu } from "../shell/contextMenu";
import { promptDialog } from "../shell/dialogs";
import { attach, closeSession, createSession, getSession, renameSession, setActive, termStore } from "./sessions";
import "./terminal.css";

let lastRoot: { host: string; path: string } = { host: "local", path: "~" };
export const newTerminalTab = (host?: string) =>
  createSession({ host: host ?? lastRoot.host, cwd: host && host !== lastRoot.host ? "~" : lastRoot.path });

export function TerminalPanel({ root }: ToolWindowProps) {
  lastRoot = root;
  const { tabs, active } = useStore(termStore);
  useSyncExternalStore(termStore.subscribe, () => termStore.get().version);
  const body = useRef<HTMLDivElement>(null);

  // Start with one tab the first time the window opens.
  useEffect(() => {
    if (termStore.get().tabs.length === 0) createSession({ host: root.host, cwd: root.path });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Mount the active session's element; keep the others detached (alive, off-DOM).
  useEffect(() => {
    const b = body.current;
    if (!b) return;
    const s = active ? getSession(active) : undefined;
    b.replaceChildren();
    if (!s) return;
    b.appendChild(s.el);
    for (const id of termStore.get().tabs) {
      const t = getSession(id);
      t?.term.textarea?.removeAttribute("data-autofocus");
    }
    const refit = () => {
      if (b.clientWidth > 0 && b.clientHeight > 0) {
        try { s.fit.fit(); } catch {}
      }
    };
    void attach(s).then(() => {
      s.term.textarea?.setAttribute("data-autofocus", "");
      if (b.contains(document.activeElement) || document.activeElement === document.body || b.closest("[data-toolwindow]")?.contains(document.activeElement)) s.term.focus();
    });
    const ro = new ResizeObserver(refit);
    ro.observe(b);
    return () => ro.disconnect();
  }, [active]);

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

  const rename = async (id: string) => {
    const s = getSession(id);
    if (!s) return;
    const v = await promptDialog({ title: "Rename Tab", initial: s.title });
    if (v) renameSession(id, v);
    setTimeout(() => getSession(id)?.term.focus(), 20);
  };

  return (
    <div className="term-panel">
      <div className="term-tabs">
        {tabs.map((id) => {
          const s = getSession(id);
          if (!s) return null;
          return (
            <div
              key={id}
              className={"term-tab" + (id === active ? " active" : "")}
              onMouseDown={(e) => {
                if (e.button === 1) { e.preventDefault(); closeSession(id); }
                else if (e.button === 0) setActive(id);
              }}
              onDoubleClick={() => rename(id)}
              onContextMenu={(e) => {
                e.preventDefault();
                showContextMenu(e.clientX, e.clientY, [
                  { label: "Rename Tab", run: () => rename(id) },
                  { label: "Close Tab", shortcut: "⌘W", run: () => closeSession(id) },
                ]);
              }}
            >
              {s.host !== "local" && <span className="term-badge">{s.host}</span>}
              <span className="term-title">{s.title}</span>
              {s.exited && <span className="term-exited">(exited)</span>}
              <button className="term-x" title="Close" onMouseDown={(e) => e.stopPropagation()} onClick={() => closeSession(id)}><CloseIcon size={10} /></button>
            </div>
          );
        })}
        <button className="term-add" title="New Session" onClick={() => newTerminalTab()}>+</button>
        <button className="term-add" title="Select session type" onClick={hostMenu}><ChevronDown /></button>
      </div>
      <div className="term-body" ref={body} />
    </div>
  );
}
