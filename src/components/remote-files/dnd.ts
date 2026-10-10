/** Pointer-based drag between panes (HTML5 DnD is unreliable inside the Tauri webview). */
import type { RichEntry } from "./api";

export interface DragPayload {
  paneId: string;
  entries: RichEntry[];
}
export interface DropTarget {
  paneId: string;
  /** directory row under the pointer, or null = pane's current directory */
  dir: string | null;
}

export function beginDrag(e: React.MouseEvent, payload: DragPayload, onDrop: (t: DropTarget) => void) {
  if (e.button !== 0) return;
  const sx = e.clientX, sy = e.clientY;
  let ghost: HTMLDivElement | null = null;
  let hl: Element[] = [];
  const clear = () => { hl.forEach((x) => x.classList.remove("rf-drop")); hl = []; };
  const find = (x: number, y: number): DropTarget | null => {
    const el = document.elementFromPoint(x, y);
    const pane = el?.closest("[data-rf-pane]");
    if (!pane) return null;
    const row = el!.closest("[data-rf-dir]");
    const dir = row?.getAttribute("data-rf-dir") ?? null;
    clear();
    if (dir && !payload.entries.some((p) => p.path === dir)) { row!.classList.add("rf-drop"); hl = [row!]; }
    else { pane.classList.add("rf-drop"); hl = [pane]; }
    return { paneId: pane.getAttribute("data-rf-pane")!, dir: dir && !payload.entries.some((p) => p.path === dir) ? dir : null };
  };
  const move = (ev: MouseEvent) => {
    if (!ghost) {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
      ghost = document.createElement("div");
      ghost.className = "rf-ghost";
      ghost.textContent = payload.entries.length === 1 ? payload.entries[0].name : `${payload.entries.length} items`;
      document.body.appendChild(ghost);
    }
    ghost.style.left = ev.clientX + 12 + "px";
    ghost.style.top = ev.clientY + 12 + "px";
    find(ev.clientX, ev.clientY);
  };
  const up = (ev: MouseEvent) => {
    window.removeEventListener("mousemove", move, true);
    window.removeEventListener("mouseup", up, true);
    const dragged = !!ghost;
    ghost?.remove();
    clear();
    if (dragged) {
      const t = find(ev.clientX, ev.clientY);
      clear();
      if (t) onDrop(t);
    }
  };
  window.addEventListener("mousemove", move, true);
  window.addEventListener("mouseup", up, true);
}
