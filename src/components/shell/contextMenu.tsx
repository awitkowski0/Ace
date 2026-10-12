import { formatShortcut } from "../../lib/platform";
import { useEffect } from "react";
import { createStore, useStore } from "../../lib/store";

export interface MenuItem {
  label: string;
  shortcut?: string;
  run?: () => void;
  separator?: boolean;
  disabled?: boolean;
}
const menuStore = createStore<{ menu: { x: number; y: number; items: MenuItem[] } | null }>({ menu: null });
export const showContextMenu = (x: number, y: number, items: MenuItem[]) => menuStore.set({ menu: { x, y, items } });
export const hideContextMenu = () => menuStore.set({ menu: null });

export function ContextMenuHost() {
  const { menu } = useStore(menuStore);
  useEffect(() => {
    if (!menu) return;
    const h = (e: KeyboardEvent) => e.key === "Escape" && hideContextMenu();
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [menu]);
  if (!menu) return null;
  const x = Math.min(menu.x, window.innerWidth - 240);
  const y = Math.min(menu.y, window.innerHeight - menu.items.length * 26 - 12);
  return (
    <div className="menu-backdrop" onMouseDown={hideContextMenu} onContextMenu={(e) => { e.preventDefault(); hideContextMenu(); }}>
      <div className="menu" style={{ left: x, top: y }} onMouseDown={(e) => e.stopPropagation()}>
        {menu.items.map((it, i) =>
          it.separator ? (
            <div key={i} className="menu-sep" />
          ) : (
            <div
              key={i}
              className={"menu-item" + (it.disabled ? " disabled" : "")}
              onClick={() => {
                if (it.disabled) return;
                hideContextMenu();
                it.run?.();
              }}
            >
              <span>{it.label}</span>
              {it.shortcut && <span className="menu-shortcut">{formatShortcut(it.shortcut)}</span>}
            </div>
          ),
        )}
      </div>
    </div>
  );
}
