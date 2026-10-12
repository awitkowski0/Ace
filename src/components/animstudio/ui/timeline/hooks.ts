/** Selector hooks so panels do not re-render on every playback frame. */
import { useRef, useSyncExternalStore } from "react";
import { getAnimation, type Animation } from "../../core";
import { useStudio, type StudioState } from "../state";

/** Subscribe to a derived value; re-renders only when `eq(prev, next)` is false (default Object.is). */
export function useStudioSel<T>(sel: (s: StudioState) => T, eq: (a: T, b: T) => boolean = Object.is): T {
  const { store } = useStudio();
  const last = useRef<{ v: T } | null>(null);
  const get = () => {
    const v = sel(store.get());
    if (last.current && eq(last.current.v, v)) return last.current.v;
    last.current = { v };
    return v;
  };
  return useSyncExternalStore(store.subscribe, get);
}

/** The currently selected Animation (or undefined). */
export function useCurrentAnim(): Animation | undefined {
  return useStudioSel((s) => (s.doc && s.anim ? getAnimation(s.doc, s.anim) : undefined));
}

/** setPointerCapture that tolerates pointers the browser doesn't know (synthetic QA events). */
export function capture(el: Element, id: number): void {
  try { el.setPointerCapture(id); } catch { /* not an active pointer */ }
}
