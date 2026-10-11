/** Lazy variables tree (Variables panel, Watches, Evaluate dialog). Children load on expand; big containers are paged. */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useStore } from "../../../lib/store";
import { showContextMenu } from "../../shell/contextMenu";
import { ChevronDown, ChevronRight } from "../../shell/icons";
import { addWatch } from "./bps";
import { isGroupVar, PAGE, rangeLabel, shortValue, subRanges, type VarRange } from "./pure";
import { DebugSession, type Var } from "./session";

interface Expander { has(path: string): boolean; toggle(path: string): void }
const ExpandCtx = createContext<Expander>({ has: () => false, toggle: () => {} });
const SessionCtx = createContext<DebugSession | null>(null);

/** Expansion state that survives stops (paths are name-based, references are not). */
export function useExpander(): Expander {
  const [set, setSet] = useState<Set<string>>(() => new Set());
  const toggle = useCallback((p: string) => setSet((s) => { const n = new Set(s); if (n.has(p)) n.delete(p); else n.add(p); return n; }), []);
  return useMemo(() => ({ has: (p) => set.has(p), toggle }), [set, toggle]);
}
export function VarProvider({ s, ex, children }: { s: DebugSession; ex: Expander; children: ReactNode }) {
  return <SessionCtx.Provider value={s}><ExpandCtx.Provider value={ex}>{children}</ExpandCtx.Provider></SessionCtx.Provider>;
}

const Chev = ({ open, show }: { open: boolean; show: boolean }) => <span className="chev">{show ? (open ? <ChevronDown /> : <ChevronRight />) : null}</span>;

function icon(v: Var, parentIsScope: boolean): { c: string; t: string } {
  if (isGroupVar(v.name, v.value)) return { c: "g", t: "" };
  if (v.type === "function" || v.type === "method" || v.type === "builtin_function_or_method") return { c: "f", t: "f" };
  return { c: parentIsScope ? "" : "f", t: parentIsScope ? "v" : "f" };
}

/** One variable row (+ its children when expanded). */
export function VarNode({ v, depth, path, parentRef, scope }: { v: Var; depth: number; path: string; parentRef: number; scope: boolean }) {
  const s = useContext(SessionCtx)!;
  const ex = useContext(ExpandCtx);
  const open = ex.has(path) && v.ref > 0;
  const group = isGroupVar(v.name, v.value);
  const ic = icon(v, scope);
  return (
    <>
      <div
        className="dbg-row dbg-var"
        style={{ paddingLeft: 8 + depth * 14 }}
        title={v.value.length > 200 ? shortValue(v.value, 1200) : undefined}
        onDoubleClick={() => v.ref > 0 && ex.toggle(path)}
        onContextMenu={(e) => {
          e.preventDefault();
          showContextMenu(e.clientX, e.clientY, [
            { label: "Copy Value", run: () => void navigator.clipboard?.writeText(v.value).catch(() => {}) },
            { label: "Set Value…", disabled: !parentRef || !s.live, run: () => void setValue(s, parentRef, v) },
            { label: "Add to Watches", run: () => { addWatch(v.evalName ?? v.name); void s.refreshWatches(); } },
          ]);
        }}
      >
        <span onClick={() => v.ref > 0 && ex.toggle(path)}><Chev open={open} show={v.ref > 0} /></span>
        <span className={`ic ${ic.c}`}>{ic.t}</span>
        <span className={"nm" + (group ? " grp" : "")}>{v.name}</span>
        {!group && <span className="eq">=</span>}
        {!group && v.type && <span className="ty">{`{${v.type}}`}</span>}
        {!group && <span className="va">{shortValue(v.value)}</span>}
      </div>
      {open && <Children v={v} depth={depth + 1} path={path} />}
    </>
  );
}

async function setValue(s: DebugSession, parentRef: number, v: Var) {
  const { promptDialog } = await import("../../shell/dialogs");
  const val = await promptDialog({ title: `Set Value: ${v.name}`, initial: v.value, okLabel: "Set" });
  if (val == null) return;
  const err = await s.setVariable(parentRef, v.name, val);
  if (err) s.print("err", `Set Value failed: ${err}\n`);
}

function Msg({ depth, text, err }: { depth: number; text: string; err?: boolean }) {
  return <div className="dbg-row dbg-var" style={{ paddingLeft: 8 + depth * 14 + 16 }}><span className={"va" + (err ? " err" : "")} style={{ color: err ? undefined : "var(--fg-dim)" }}>{text}</span></div>;
}

function Children({ v, depth, path }: { v: Var; depth: number; path: string }) {
  const s = useContext(SessionCtx)!;
  const st = useStore(s.store);
  const big = (v.indexed ?? 0) > PAGE;
  const range = big ? { filter: "named" as const } : undefined;
  const slot = st.vars[DebugSession.slotKey(v.ref, range)];
  useEffect(() => { void s.ensureVars(v.ref, range); }, [s, v.ref, big, slot === undefined]);
  if (!slot || slot === "loading") return <Msg depth={depth} text="Loading…" />;
  if (!Array.isArray(slot)) return <Msg depth={depth} text={slot.error} err />;
  return (
    <>
      {slot.map((c) => <VarNode key={c.name} v={c} depth={depth} path={`${path}/${c.name}`} parentRef={v.ref} scope={false} />)}
      {big && subRanges(0, v.indexed!).map((r) => <RangeNode key={r.start} v={v} r={r} depth={depth} path={`${path}/${rangeLabel(r)}`} />)}
    </>
  );
}

function RangeNode({ v, r, depth, path }: { v: Var; r: VarRange; depth: number; path: string }) {
  const s = useContext(SessionCtx)!;
  const ex = useContext(ExpandCtx);
  const st = useStore(s.store);
  const open = ex.has(path);
  const leaf = r.len <= PAGE;
  const rg = { filter: "indexed" as const, start: r.start, count: r.len };
  useEffect(() => { if (open && leaf) void s.ensureVars(v.ref, rg); }, [open, leaf, s, v.ref, r.start, r.len, st.vars[DebugSession.slotKey(v.ref, rg)] === undefined]);
  const slot = st.vars[DebugSession.slotKey(v.ref, rg)];
  return (
    <>
      <div className="dbg-row dbg-var" style={{ paddingLeft: 8 + depth * 14 }} onClick={() => ex.toggle(path)}>
        <Chev open={open} show />
        <span className="ic g" />
        <span className="nm">{rangeLabel(r)}</span>
      </div>
      {open && !leaf && subRanges(r.start, r.len).map((c) => <RangeNode key={c.start} v={v} r={c} depth={depth + 1} path={`${path}/${rangeLabel(c)}`} />)}
      {open && leaf && (!slot || slot === "loading" ? <Msg depth={depth + 1} text="Loading…" /> : !Array.isArray(slot) ? <Msg depth={depth + 1} text={slot.error} err /> :
        slot.map((c) => <VarNode key={c.name} v={c} depth={depth + 1} path={`${path}/${c.name}`} parentRef={v.ref} scope={false} />))}
    </>
  );
}

/** A frame scope: Locals is shown flat; others ("Globals") as a collapsed node. */
export function ScopeNode({ name, vref, flat }: { name: string; vref: number; flat: boolean }) {
  const s = useContext(SessionCtx)!;
  const ex = useContext(ExpandCtx);
  const st = useStore(s.store);
  const path = `scope:${name}`;
  const open = flat || ex.has(path);
  useEffect(() => { if (open) void s.ensureVars(vref); }, [open, s, vref, st.vars[String(vref)] === undefined]);
  const slot = st.vars[String(vref)];
  return (
    <>
      {!flat && (
        <div className="dbg-row dbg-var" onClick={() => ex.toggle(path)}>
          <Chev open={open} show />
          <span className="ic g" />
          <span className="nm grp">{name}</span>
        </div>
      )}
      {open && (!slot || slot === "loading" ? <Msg depth={flat ? 0 : 1} text="Loading…" /> : !Array.isArray(slot) ? <Msg depth={flat ? 0 : 1} text={slot.error} err /> :
        slot.map((c) => <VarNode key={c.name} v={c} depth={flat ? 0 : 1} path={`${path}/${c.name}`} parentRef={vref} scope />))}
    </>
  );
}

/** Root row for an evaluation result / watch (`name = {type} value`). */
export function ResultNode({ name, value, type, vref, error, path }: { name: string; value?: string; type?: string; vref?: number; error?: string; path: string }) {
  if (error) {
    return (
      <div className="dbg-row dbg-var" title={error}>
        <span className="chev" /><span className="ic e">!</span><span className="nm">{name}</span><span className="eq">=</span><span className="va err">{shortValue(error)}</span>
      </div>
    );
  }
  return <VarNode v={{ name, value: value ?? "", type, ref: vref ?? 0, evalName: name }} depth={0} path={path} parentRef={0} scope={false} />;
}
