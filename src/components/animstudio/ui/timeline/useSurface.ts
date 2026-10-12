import { useEffect, useRef } from "react";
import { perfTime } from "../perf";

/** draws scheduled but not yet run (QA: a hidden webview never fires rAF, `flushSurfaces` runs them now) */
const pending = new Set<() => void>();
export function flushSurfaces(): number {
  const list = [...pending];
  list.forEach((f) => f());
  return list.length;
}

/** rAF-coalesced canvas redraw scheduler with a ResizeObserver. `draw` is read through a ref so it may close over fresh values. */
export function useSurface(draw: () => void, deps: unknown[] = []) {
  const drawRef = useRef(draw);
  drawRef.current = draw;
  const raf = useRef(0);
  const fallback = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const schedule = useRef(() => {
    if (raf.current) return;
    // a hidden / occluded webview (background window, QA harness) never fires rAF: a timer draws instead so size and fit stay correct
    const run = () => {
      pending.delete(run);
      if (!raf.current) return;
      cancelAnimationFrame(raf.current);
      clearTimeout(fallback.current);
      raf.current = 0;
      perfTime("canvas", () => drawRef.current());
    };
    raf.current = requestAnimationFrame(run);
    pending.add(run);
    fallback.current = setTimeout(run, 120);
  }).current;
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ro = new ResizeObserver(() => schedule());
    ro.observe(c);
    schedule();
    return () => { ro.disconnect(); if (raf.current) cancelAnimationFrame(raf.current); raf.current = 0; clearTimeout(fallback.current); };
  }, [schedule]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => schedule(), deps);
  return { canvasRef, schedule };
}
