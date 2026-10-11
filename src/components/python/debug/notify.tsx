/** IntelliJ-style balloon notifications (bottom-right, above the status bar). Self-mounting: no host component in App.tsx. */
import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { createStore, useStore } from "../../../lib/store";
import "./debug.css";

export interface BalloonAction { label: string; run(): void }
export interface Balloon { id: number; kind: "info" | "warn" | "error"; title: string; text?: string; actions: BalloonAction[] }
const store = createStore<{ items: Balloon[] }>({ items: [] });
let seq = 1;
let mounted = false;

function Host() {
  const { items } = useStore(store);
  return (
    <div className="dbg-balloons">
      {items.map((b) => <BalloonView key={b.id} b={b} />)}
    </div>
  );
}
function BalloonView({ b }: { b: Balloon }) {
  useEffect(() => {
    if (b.kind === "error" || b.actions.length) return;
    const t = setTimeout(() => dismiss(b.id), 7000);
    return () => clearTimeout(t);
  }, [b]);
  return (
    <div className={`dbg-balloon ${b.kind}`} data-balloon={b.title}>
      <div className="dbg-balloon-title">{b.title}<button className="dbg-balloon-x" onClick={() => dismiss(b.id)} title="Close">×</button></div>
      {b.text && <div className="dbg-balloon-text">{b.text}</div>}
      {b.actions.length > 0 && (
        <div className="dbg-balloon-actions">
          {b.actions.map((a) => <button key={a.label} className="dbg-balloon-link" onClick={() => { dismiss(b.id); a.run(); }}>{a.label}</button>)}
        </div>
      )}
    </div>
  );
}

export function dismiss(id: number) { store.set((s) => ({ items: s.items.filter((b) => b.id !== id) })); }
export function showBalloon(b: Omit<Balloon, "id" | "actions"> & { actions?: BalloonAction[] }): number {
  if (!mounted) {
    mounted = true;
    const el = document.createElement("div");
    document.body.appendChild(el);
    createRoot(el).render(<Host />);
  }
  const id = seq++;
  store.set((s) => ({ items: [...s.items.filter((x) => x.title !== b.title), { actions: [], ...b, id }].slice(-4) }));
  return id;
}
/** Visible balloons (test hook). */
export const balloons = () => store.get().items;
