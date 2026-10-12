/**
 * Bridge from the keymap to the viewport half's imperative API (`StudioHandle.viewport.current`, ui/viewport/api.ts).
 * Calls go through here by METHOD NAME so a method the viewport side has not published yet is a logged, counted stub
 * (never a crash). `missingViewportMethods()` lists what the keymap needs but the viewport API lacks.
 *
 * Methods the keymap calls (all optional):
 *   (camera/display toggles go through ./viewport/api.ts directly) · cameraYaw(): radians (atan2(fx, fz) of the camera
 *   forward vector, scene space; used by arrow nudges) · togglePixelGrid() ·
 *   screenshot() · setTool(name) (vertex_snap | stretch) · cancelDrag(): boolean · isDragging(): boolean
 */
import type { StudioHandle } from "../studios";

const missing = new Set<string>();
export const missingViewportMethods = (): string[] => [...missing].sort();

export function vpCall<T = unknown>(h: StudioHandle | null, method: string, ...args: unknown[]): { ok: boolean; value?: T } {
  const api = h?.viewport.current as unknown as Record<string, ((...a: unknown[]) => unknown) | undefined> | null | undefined;
  const fn = api?.[method];
  if (typeof fn !== "function") {
    if (!missing.has(method)) { missing.add(method); console.debug(`[animstudio] viewport API stub: ${method}() is not published yet`); }
    return { ok: false };
  }
  return { ok: true, value: fn.apply(api, args) as T };
}

