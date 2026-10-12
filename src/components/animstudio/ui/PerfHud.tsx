import { usePerf, usePerfOn, type PerfBin } from "./perf";

const ROWS: Array<[PerfBin, string]> = [["store", "store.set"], ["flush", "react+sync"], ["pose", "  pose"], ["render", "three"], ["canvas", "timeline 2D"]];
const SW = 140, SH = 22, SCALE = 50;

/** FPS readout in the viewport corner (View toolbar "FPS" toggles it; the setting persists). Renders nothing, and measures nothing, while off. */
export function PerfHud() {
  if (!usePerfOn()) return null;
  return <Hud />;
}

function Hud() {
  const p = usePerf();
  const ms = (v: number) => v.toFixed(v < 10 ? 2 : 1);
  const pts = p.spark.map((v, i) => `${((i / Math.max(1, p.spark.length - 1)) * SW).toFixed(1)},${(SH - Math.min(SH, (v / SCALE) * SH)).toFixed(1)}`).join(" ");
  const slow = p.fps > 0 && p.fps < 50;
  return (
    <div className="as-perf" data-testid="perf-hud">
      <div className="r"><b className={slow ? "bad" : ""}>{p.fps.toFixed(0)} FPS</b><span>{ms(p.avgMs)} avg / {ms(p.worstMs)} max ms</span></div>
      {ROWS.map(([k, label]) => <div className="r dim" key={k}><span style={{ whiteSpace: "pre" }}>{label}</span><span>{ms(p.bins[k])} ms</span></div>)}
      <div className="r dim"><span>draws/s</span><span>{p.drawsPerSec.toFixed(0)}</span></div>
      <div className="r dim"><span>three</span><span>{p.calls} calls / {p.triangles} tris</span></div>
      <svg width={SW} height={SH} viewBox={`0 0 ${SW} ${SH}`}><polyline points={pts} fill="none" stroke="var(--accent, #88c0d0)" strokeWidth="1" /></svg>
    </div>
  );
}
