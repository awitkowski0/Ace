import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { matchAll, matchName, SS_IDLE, setSpeedSearchLive, stepSpeedSearch, type Range, type SSState } from "../../lib/speedSearch";

/**
 * IntelliJ speed search for trees / lists (docs/CONVENTIONS.md "Speed search"). Core logic lives in `lib/speedSearch.ts`.
 *
 *   const ss = useSpeedSearch({ rows, text: (r) => r.name, selected: index, select: (i) => moveTo(i), activate: (i) => open(rows[i]) });
 *   <div className="ss-host" {...ss.hostProps}>
 *     <div className="tree" tabIndex={0} onKeyDown={(e) => { if (ss.onKeyDown(e)) return; ...your keys... }}>
 *       ... <span className="tree-name">{ss.highlight(i, r.name)}</span>
 *     </div>
 *     {ss.popup}
 *   </div>
 *
 * `select(i)` must select the row AND scroll it into view. Only rows in `rows` (the visible/expanded model) are searched.
 */
export interface SpeedSearchOpts<R> {
  rows: readonly R[];
  text: (row: R) => string;
  /** index of the selected row (-1 none) */
  selected: number;
  select: (index: number) => void;
  activate: (index: number) => void;
}

const EMPTY: Map<number, Range[]> = new Map();

export function useSpeedSearch<R>(o: SpeedSearchOpts<R>) {
  const [state, setState] = useState<SSState>(SS_IDLE);
  const stateRef = useRef(state);
  stateRef.current = state;
  const optsRef = useRef(o);
  optsRef.current = o;
  const selRef = useRef(o.selected);
  selRef.current = o.selected;

  // Per-rows cache: lowercase-insensitive texts + the match map of the last query. A longer query that extends the previous
  // one can only match a subset, so it is computed over the previous matches only (incremental typing on 17k rows).
  const cache = useRef<{ rows: readonly R[] | null; texts: string[]; q: string; map: Map<number, Range[]> }>({ rows: null, texts: [], q: "", map: EMPTY });
  const compute = useCallback((q: string): Map<number, Range[]> => {
    const { rows, text } = optsRef.current;
    const c = cache.current;
    if (c.rows !== rows) { c.rows = rows; c.texts = rows.map(text); c.q = ""; c.map = EMPTY; }
    if (c.q === q) return c.map;
    const narrow = c.q && q.startsWith(c.q);
    c.map = matchAll(q, c.texts, narrow ? c.map.keys() : undefined);
    c.q = q;
    return c.map;
  }, []);

  const map = useMemo(() => (state.active ? compute(state.query) : EMPTY), [state.active, state.query, o.rows, compute]);

  useEffect(() => {
    if (!state.active) return;
    setSpeedSearchLive(true);
    return () => setSpeedSearchLive(false);
  }, [state.active]);

  const close = useCallback(() => { if (stateRef.current.active) { stateRef.current = SS_IDLE; setState(SS_IDLE); } }, []);

  const onKeyDown = useCallback((e: KeyboardEvent): boolean => {
    if (e.nativeEvent.isComposing) return false;
    const r = stepSpeedSearch(stateRef.current, e, {
      sel: selRef.current,
      matchesFor: (q) => [...compute(q).keys()],
    });
    stateRef.current = r.state;
    setState(r.state);
    if (r.select != null) { selRef.current = r.select; optsRef.current.select(r.select); }
    if (r.activate && selRef.current >= 0) optsRef.current.activate(selRef.current);
    if (r.handled) { e.preventDefault(); e.stopPropagation(); }
    return r.handled;
  }, [compute]);

  const noMatch = state.active && map.size === 0;
  const popup: ReactNode = state.active ? (
    <div className={"ss-popup" + (noMatch ? " nomatch" : "")} data-testid="speed-search" data-query={state.query} data-matches={map.size}>
      <span className="ss-label">Search for:</span>
      <span className="ss-query">{state.query}</span>
    </div>
  ) : null;

  return {
    active: state.active,
    query: state.query,
    matches: map,
    onKeyDown,
    close,
    /** spread on the `.ss-host` wrapper: closes on click and when focus leaves the tree */
    hostProps: {
      onMouseDownCapture: close,
      onBlur: (e: React.FocusEvent) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) close(); },
    },
    popup,
    /** the row label with matched fragments wrapped in `.ss-hit` */
    highlight: (index: number, label: string): ReactNode => (state.active ? <Highlight text={label} ranges={map.get(index)} /> : label),
  };
}

export const Highlight = memo(function Highlight({ text, ranges }: { text: string; ranges?: Range[] }) {
  if (!ranges?.length) return <>{text}</>;
  const out: ReactNode[] = [];
  let at = 0;
  ranges.forEach(([a, b], k) => {
    if (a > at) out.push(text.slice(at, a));
    out.push(<mark key={k} className="ss-hit">{text.slice(a, b)}</mark>);
    at = b;
  });
  if (at < text.length) out.push(text.slice(at));
  return <>{out}</>;
});

/** Scroll row `index` (fixed `rowH`) into view inside scroll container `el`, minimally (like a tree's scrollRectToVisible). */
export function scrollRowIntoView(el: HTMLElement | null, index: number, rowH = 24) {
  if (!el) return;
  const top = index * rowH;
  if (top < el.scrollTop) el.scrollTop = top;
  else if (top + rowH > el.scrollTop + el.clientHeight) el.scrollTop = top + rowH - el.clientHeight;
}

export { matchName };
