/** Per editor group, the controller of the viewer currently mounted (image zoom, audio transport, 3D camera ...). */
import { editorStore } from "../store";

export interface ViewerController {
  zoomIn?(): void;
  zoomOut?(): void;
  actualSize?(): void;
  fit?(): void;
  toggleGrid?(): void;
  playPause?(): void;
  frameAll?(): void;
  /** test hook: free-form state snapshot for the QA harness */
  snapshot?(): unknown;
}
const ctls = new Map<string, ViewerController>();
export function registerController(groupId: string, c: ViewerController) {
  ctls.set(groupId, c);
  return () => { if (ctls.get(groupId) === c) ctls.delete(groupId); };
}
export const activeController = (): ViewerController | undefined => {
  const s = editorStore.get();
  return ctls.get(s.activeGroup);
};
export const controllerFor = (groupId: string) => ctls.get(groupId);
