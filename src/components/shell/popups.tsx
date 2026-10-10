/**
 * Popup registry. A module registers a popup component under an id and opens it from an action:
 *   registerPopup("GotoFile", GotoFilePopup);  ...  openPopup("GotoFile");
 * Re-registering an id replaces the placeholder. Use <PopupShell> for IntelliJ-style chrome.
 */
import { useEffect, type ComponentType, type ReactNode } from "react";
import { createStore, useStore } from "../../lib/store";
import { focusEditor } from "../../editor/editorRegistry";

export interface PopupProps {
  onClose: () => void;
  props?: unknown;
}
const components = new Map<string, ComponentType<PopupProps>>();
const popupStore = createStore<{ id: string | null; props?: unknown }>({ id: null });

export const registerPopup = (id: string, c: ComponentType<PopupProps>) => components.set(id, c);
export const openPopup = (id: string, props?: unknown) => popupStore.set({ id, props });
export const closePopup = () => {
  if (popupStore.get().id) {
    popupStore.set({ id: null, props: undefined });
    setTimeout(focusEditor, 0);
  }
};
export const isPopupOpen = () => popupStore.get().id !== null;

export function PopupHost() {
  const { id, props } = useStore(popupStore);
  if (!id) return null;
  const C = components.get(id);
  if (!C) return null;
  return <C key={id} onClose={closePopup} props={props} />;
}

/** Centered-top floating popup frame. Esc / outside click close. */
export function PopupShell({ children, onClose, width = 700, height }: { children: ReactNode; onClose: () => void; width?: number; height?: number }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), onClose());
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [onClose]);
  return (
    <div className="popup-backdrop" onMouseDown={onClose}>
      <div className="popup" style={{ width, height }} onMouseDown={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}
