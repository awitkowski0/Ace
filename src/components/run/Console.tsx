import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { openAt } from "./openAt";
import { projectStore } from "../../lib/project";
import type { Location } from "../../lib/ipc";
import { findLinks, resolveLink, type RawLink } from "./links";
import type { Line, Span } from "./outbuf";
import { subscribeOut, type Session } from "./sessions";

export const LINE_H = 17;
type Resolved = Map<string, Location | null>;

/** Link resolution shared by the console and the test detail pane: resolves candidate paths lazily (cached) and re-renders when ready. */
export function useLinkResolver(host: string, cwd: string) {
  const [resolved, setResolved] = useState<Resolved>(() => new Map());
  const pending = useRef(new Set<string>());
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const root = projectStore.get().root?.path ?? cwd;
  const ask = useCallback((raws: string[]) => {
    const todo = raws.filter((r) => !pending.current.has(r));
    if (!todo.length) return;
    todo.forEach((r) => pending.current.add(r));
    void Promise.all(todo.map((r) => resolveLink(r, host, cwd, root).then((loc) => [r, loc] as const))).then((rs) => {
      if (!alive.current) return;
      setResolved((m) => { const n = new Map(m); rs.forEach(([r, l]) => n.set(r, l)); return n; });
    });
  }, [host, cwd, root]);
  // a different cwd / host invalidates earlier answers
  useEffect(() => { pending.current.clear(); setResolved(new Map()); }, [host, cwd]);
  return { resolved, ask };
}

export function openLink(loc: Location, line: number, col: number) {
  void openAt(loc, line, col);
}

/** Split `spans` at link boundaries; spans inside a resolved link get `link` info. */
function cut(spans: Span[], links: (RawLink & { loc: Location })[]): { span: Span; link?: RawLink & { loc: Location } }[] {
  if (!links.length) return spans.map((span) => ({ span }));
  const out: { span: Span; link?: RawLink & { loc: Location } }[] = [];
  let pos = 0;
  for (const sp of spans) {
    let from = 0;
    const end = pos + sp.t.length;
    for (const l of links) {
      if (l.end <= pos || l.start >= end) continue;
      const a = Math.max(l.start, pos) - pos;
      const b = Math.min(l.end, end) - pos;
      if (a > from) out.push({ span: { ...sp, t: sp.t.slice(from, a) } });
      out.push({ span: { ...sp, t: sp.t.slice(a, b) }, link: l });
      from = b;
    }
    if (from < sp.t.length) out.push({ span: from ? { ...sp, t: sp.t.slice(from) } : sp });
    pos = end;
  }
  return out;
}

const spanStyle = (s: Span): React.CSSProperties | undefined =>
  s.fg || s.bg || s.b || s.d || s.i || s.u
    ? { color: s.fg, background: s.bg, fontWeight: s.b ? 600 : undefined, opacity: s.d ? 0.7 : undefined, fontStyle: s.i ? "italic" : undefined, textDecoration: s.u ? "underline" : undefined }
    : undefined;

const LineView = memo(function LineView({ line, idx, resolved, wrapH }: { line: Line; idx: number; ver?: string; resolved: Resolved; wrapH?: number }) {
  const text = line.spans.map((s) => s.t).join("");
  const links = useMemo(() => {
    const out: (RawLink & { loc: Location })[] = [];
    for (const l of findLinks(text)) {
      const loc = resolved.get(l.path);
      if (loc) out.push({ ...l, loc });
    }
    return out;
  }, [text, resolved]);
  const parts = cut(line.spans, links);
  return (
    <div className="run-line" data-i={idx} style={wrapH ? { minHeight: wrapH } : undefined}>
      {parts.length === 0 ? "​" : parts.map((p, i) => {
        const cls = p.span.k ? `k-${p.span.k}` : undefined;
        return p.link ? (
          <a key={i} className={"run-link " + (cls ?? "")} style={spanStyle(p.span)} data-path={p.link.loc.path} data-host={p.link.loc.host} data-line={p.link.line} data-col={p.link.col}>{p.span.t}</a>
        ) : (
          <span key={i} className={cls} style={spanStyle(p.span)}>{p.span.t}</span>
        );
      })}
    </div>
  );
});

let charW = 0;
function measureCharW(host: HTMLElement) {
  if (charW) return charW;
  const m = document.createElement("span");
  m.className = "run-line";
  m.style.cssText = "position:absolute;visibility:hidden;white-space:pre";
  m.textContent = "0".repeat(50);
  host.appendChild(m);
  charW = m.getBoundingClientRect().width / 50 || 7.2;
  m.remove();
  return charW;
}

function clickLink(e: React.MouseEvent) {
  const a = (e.target as HTMLElement).closest<HTMLElement>(".run-link");
  if (!a) return;
  e.preventDefault();
  openLink({ host: a.dataset.host ?? "local", path: a.dataset.path! }, +(a.dataset.line ?? 1), +(a.dataset.col ?? 1));
}

/** Virtualised console. Only the visible lines are in the DOM, so a process printing millions of lines cannot freeze the UI. */
export function Console({ session, wrap, follow, onFollow }: { session: Session; wrap: boolean; follow: boolean; onFollow: (f: boolean) => void }) {
  useSyncExternalStore(subscribeOut(session), () => session.out);
  const ref = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, h: 400, w: 600 });
  const { resolved, ask } = useLinkResolver(session.host, session.cwd);
  const lines = session.buf.lines;
  const n = lines.length;
  // line heights: constant, or (soft wrap) derived from the line length and the monospace column count
  const cols = wrap ? Math.max(8, Math.floor((view.w - 20) / (ref.current ? measureCharW(ref.current) : 7.2))) : 0;
  const heights = useMemo(() => {
    if (!wrap) return null;
    const hs = new Float64Array(n + 1);
    let acc = 0;
    for (let i = 0; i < n; i++) { hs[i] = acc; acc += LINE_H * Math.max(1, Math.ceil(lines[i].len / cols)); }
    hs[n] = acc;
    return hs;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wrap, cols, n, session.out]);
  const total = heights ? heights[n] : n * LINE_H;
  const offsetOf = (i: number) => (heights ? heights[i] : i * LINE_H);
  const find = (y: number) => {
    if (!heights) return Math.max(0, Math.min(n - 1, Math.floor(y / LINE_H)));
    let lo = 0, hi = n - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (heights[mid] <= y) lo = mid; else hi = mid - 1; }
    return lo;
  };
  const first = Math.max(0, find(view.top) - 5);
  const last = Math.min(n, find(view.top + view.h) + 8);

  // ask for the candidate links of the visible lines
  useEffect(() => {
    const raws = new Set<string>();
    for (let i = first; i < last; i++) {
      const l = lines[i];
      if (!l || !l.len) continue;
      const t = l.spans.length === 1 ? l.spans[0].t : l.spans.map((s) => s.t).join("");
      for (const k of findLinks(t)) raws.add(k.path);
    }
    if (raws.size) ask([...raws]);
  }, [first, last, session.out, lines, ask]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (follow) el.scrollTop = el.scrollHeight;
  }, [follow, total, session.out]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setView((v) => ({ ...v, h: el.clientHeight, w: el.clientWidth })));
    ro.observe(el);
    setView((v) => ({ ...v, h: el.clientHeight, w: el.clientWidth }));
    return () => ro.disconnect();
  }, []);

  const onScroll = () => {
    const el = ref.current!;
    setView((v) => (Math.abs(v.top - el.scrollTop) < 1 ? v : { ...v, top: el.scrollTop }));
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 4;
    if (atBottom !== follow) onFollow(atBottom);
  };

  const rows = [];
  for (let i = first; i < last; i++) rows.push(<LineView key={i + session.buf.dropped} idx={i + session.buf.dropped} ver={lines[i].len + ":" + lines[i].spans.length} line={lines[i]} resolved={resolved} wrapH={heights ? Math.max(1, Math.ceil(lines[i].len / cols)) * LINE_H : undefined} />);
  return (
    <div ref={ref} className={"run-console" + (wrap ? " wrap" : "")} data-autofocus tabIndex={0} onScroll={onScroll} onClick={clickLink} data-session={session.id}>
      <div style={{ height: total, position: "relative", minWidth: "100%" }}>
        <div style={{ position: "absolute", top: offsetOf(first), left: 0, right: wrap ? 0 : undefined }}>{rows}</div>
      </div>
    </div>
  );
}

/** Plain text with clickable file links (test output / failure traceback). */
export function LinkedText({ text, host, cwd }: { text: string; host: string; cwd: string }) {
  const { resolved, ask } = useLinkResolver(host, cwd);
  const lines = useMemo(() => text.split("\n").slice(0, 3000), [text]);
  useEffect(() => {
    const raws = new Set<string>();
    for (const l of lines) for (const k of findLinks(l)) raws.add(k.path);
    if (raws.size) ask([...raws]);
  }, [lines, ask]);
  const mk = useMemo(() => lines.map((t): Line => ({ spans: [{ t }], len: t.length })), [lines]);
  return (
    <div className="run-text" onClick={clickLink}>
      {mk.map((l, i) => <LineView key={i} idx={i} line={l} resolved={resolved} />)}
    </div>
  );
}
