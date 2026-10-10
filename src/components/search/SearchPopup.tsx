import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PopupShell, type PopupProps } from "../shell/popups";
import { FileIcon, SearchIcon } from "../shell/icons";
import { editorStore } from "../../editor/store";
import { useStore } from "../../lib/store";
import { listActions, runAction } from "../../actions/registry";
import { keysFor } from "../../actions/keymap";
import { formatKeystroke } from "../../actions/keystroke";
import { basename } from "../../lib/ipc";
import { searchFiles, searchSymbols, searchText, searchIndex, type TextMatch, type TextSearchHandle } from "./api";
import { fuzzy } from "./fuzzy";
import { absLoc, currentRoot, openAt, recentPaths } from "./nav";
import { Hl, KindBadge, RangeHl, dirOf } from "./ui";
import { openPopup } from "../shell/popups";

export const TABS = ["All", "Classes", "Files", "Symbols", "Actions", "Text"] as const;
type Tab = (typeof TABS)[number];

interface Item {
  key: string;
  section: string;
  icon: ReactNode;
  label: ReactNode;
  secondary?: ReactNode;
  right?: string;
  run: () => void;
}

const SECTION_LIMIT_ALL: Record<string, number> = { Classes: 5, Files: 8, Symbols: 6, Actions: 5 };

export function makeSearchPopup(initialTab: Tab, title: string) {
  return function SearchPopup({ onClose }: PopupProps) {
    const [tab, setTab] = useState<Tab>(initialTab);
    const [q, setQ] = useState("");
    const [sel, setSel] = useState(0);
    const [res, setRes] = useState<Record<string, Item[]>>({});
    const [status, setStatus] = useState("");
    const input = useRef<HTMLInputElement>(null);
    const list = useRef<HTMLDivElement>(null);
    const seq = useRef(0);
    const textH = useRef<TextSearchHandle | null>(null);
    const { docs, recent } = useStore(editorStore);
    const root = currentRoot();

    useEffect(() => { input.current?.focus(); if (root) searchIndex(root).catch(() => {}); return () => textH.current?.cancel(); }, []); // eslint-disable-line

    const go = useCallback((fn: () => void) => { onClose(); setTimeout(fn, 20); }, [onClose]);

    const recentItems = useMemo<Item[]>(() => {
      if (!root) return [];
      return recent.map((k) => docs[k]).filter(Boolean).slice(0, 30).map((d) => ({
        key: "r:" + d.key, section: "Recent Files", icon: <FileIcon />,
        label: d.name, secondary: d.loc.path.startsWith(root.path) ? dirOf(d.loc.path.slice(root.path.length + 1)) : dirOf(d.loc.path),
        run: () => go(() => void openAt(d.loc)),
      }));
    }, [recent, docs, root, go]);

    const actionItems = useCallback((query: string, max: number): Item[] => {
      const all = listActions().filter((a) => !a.isEnabled || a.isEnabled());
      const scored = query
        ? all.map((a) => ({ a, f: fuzzy(query, a.title) })).filter((x) => x.f).sort((x, y) => y.f!.score - x.f!.score)
        : all.map((a) => ({ a, f: null as null | { indices: number[] } })).sort((x, y) => x.a.title.localeCompare(y.a.title));
      return scored.slice(0, max).map(({ a, f }) => {
        const k = keysFor(a.id)[0];
        return {
          key: "a:" + a.id, section: "Actions", icon: <span className="se-ico-act">⌘</span>,
          label: <Hl text={a.title} indices={f?.indices} />, right: k ? formatKeystroke(k) : undefined,
          run: () => go(() => runAction(a.id)),
        };
      });
    }, [go]);

    // ---- query -> results
    useEffect(() => {
      const my = ++seq.current;
      textH.current?.cancel();
      textH.current = null;
      setSel(0);
      const r = root;
      const query = q.trim();
      const active = (fn: () => void) => { if (seq.current === my) fn(); };
      const set = (section: string, items: Item[]) => active(() => setRes((p) => ({ ...p, [section]: items })));
      const reset: Record<string, Item[]> = {};
      if (!query) {
        setRes(reset);
        setStatus("");
        if (tab === "Actions" || tab === "All") set("Actions", actionItems("", tab === "All" ? 0 : 60));
        return;
      }
      setRes(reset);
      const wantFiles = tab === "All" || tab === "Files";
      const wantSyms = tab === "All" || tab === "Symbols";
      const wantClasses = tab === "All" || tab === "Classes";
      const wantActions = tab === "All" || tab === "Actions";
      const wantText = tab === "Text";
      const lim = (n: number, section: string) => (tab === "All" ? SECTION_LIMIT_ALL[section] ?? n : n);
      if (wantActions) set("Actions", actionItems(query, lim(60, "Actions")));
      if (!r) return;
      const t0 = performance.now();
      if (wantFiles) {
        searchFiles(r, query, tab === "All" ? 30 : 120, recentPaths()).then((fr) => {
          const items = fr.hits.slice(0, lim(120, "Files")).map<Item>((h) => ({
            key: "f:" + h.path, section: "Files", icon: <FileIcon />,
            label: <Hl text={h.name} indices={h.indices} offset={h.nameStart} />,
            secondary: <Hl text={dirOf(h.rel)} indices={h.nameStart > 0 && h.indices.some((i) => i < h.nameStart) ? h.indices : undefined} />,
            run: () => go(() => void openAt(absLoc(r, h.path), fr.line, fr.col)),
          }));
          set("Files", items);
          active(() => setStatus(`${fr.total} files · ${(performance.now() - t0).toFixed(0)} ms`));
        }).catch(() => {});
      }
      if (wantClasses || wantSyms) {
        const kinds: ("classes" | "all")[] = [];
        if (wantClasses) kinds.push("classes");
        if (wantSyms && tab !== "All" ) kinds.push("all");
        if (tab === "All") kinds.push("all");
        const timer = setTimeout(() => {
          for (const kind of kinds) {
            const section = kind === "classes" ? "Classes" : "Symbols";
            searchSymbols(r, query, kind, tab === "All" ? 12 : 120).then((sr) => {
              set(section, sr.hits.slice(0, lim(120, section)).map<Item>((h) => ({
                key: `${kind}:${h.path}:${h.line}:${h.name}`, section, icon: <KindBadge kind={h.kind} />,
                label: <Hl text={h.name} indices={h.indices} />, secondary: `${basename(h.path)}:${h.line}`,
                run: () => go(() => void openAt(absLoc(r, h.path), h.line)),
              })));
            }).catch(() => {});
          }
        }, 15);
        return () => clearTimeout(timer);
      }
      if (wantText) {
        const acc: TextMatch[] = [];
        let last = 0;
        const push = (done: boolean) => active(() => {
          set("Text", acc.slice(0, 200).map<Item>((m, i) => ({
            key: `t:${m.path}:${m.line}:${i}`, section: "Text", icon: <SearchIcon />,
            label: <RangeHl text={m.text} ranges={m.ranges} />, secondary: `${basename(m.path)}:${m.line}`,
            run: () => go(() => void openAt(absLoc(r, m.path), m.line, m.col)),
          })));
          if (done) setStatus(`${acc.length}${acc.length >= 200 ? "+" : ""} matches · ${(performance.now() - t0).toFixed(0)} ms`);
        });
        const timer = setTimeout(() => {
          if (seq.current !== my) return;
          textH.current = searchText(r, { query, caseSensitive: false, words: false, regex: false, mask: "", maxResults: 200 }, (ms, done) => {
            acc.push(...ms);
            const now = performance.now();
            if (done || now - last > 80) { last = now; push(done); }
            if (acc.length >= 200) textH.current?.cancel();
          });
        }, 120);
        return () => clearTimeout(timer);
      }
    }, [q, tab, root?.path, root?.host]); // eslint-disable-line

    // Flatten sections in IntelliJ order
    const order = tab === "All" ? ["Classes", "Files", "Symbols", "Actions"] : [tab === "Text" ? "Text" : tab];
    const flat: Item[] = useMemo(() => {
      const out: Item[] = [];
      for (const s of order) out.push(...(res[s] ?? []));
      if (!q.trim() && (tab === "All" || tab === "Files" || tab === "Classes" || tab === "Symbols")) return recentItems;
      return out;
    }, [res, tab, q, recentItems]); // eslint-disable-line

    useEffect(() => { setSel((s) => Math.min(s, Math.max(0, flat.length - 1))); }, [flat.length]);
    useEffect(() => {
      list.current?.querySelector<HTMLElement>(".popup-row.selected")?.scrollIntoView({ block: "nearest" });
    }, [sel, flat]);

    const cycle = (d: number) => setTab(TABS[(TABS.indexOf(tab) + d + TABS.length) % TABS.length]);
    const onKey = (e: React.KeyboardEvent) => {
      if (e.key === "Tab") { e.preventDefault(); cycle(e.shiftKey ? -1 : 1); }
      else if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(flat.length - 1, s + 1)); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
      else if (e.key === "PageDown") { e.preventDefault(); setSel((s) => Math.min(flat.length - 1, s + 10)); }
      else if (e.key === "PageUp") { e.preventDefault(); setSel((s) => Math.max(0, s - 10)); }
      else if (e.key === "Enter") { e.preventDefault(); flat[sel]?.run(); }
    };

    let lastSection = "";
    const sectionNames = new Set(flat.map((f) => f.section));
    return (
      <PopupShell onClose={onClose} width={700}>
        <div className="popup-tabs">
          <span className="popup-title">{title}</span>
          {TABS.map((t) => (
            <span key={t} className={"popup-tab" + (t === tab ? " active" : "")} onMouseDown={(e) => { e.preventDefault(); setTab(t); input.current?.focus(); }}>{t}</span>
          ))}
        </div>
        <div className="se-inputrow">
          <SearchIcon />
          <input
            ref={input}
            className="se-input"
            spellCheck={false}
            placeholder={tab === "Actions" ? "Type an action name" : tab === "Text" ? "Type text to find" : "Type / to see commands"}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
          />
        </div>
        <div className="popup-list se-list" ref={list} style={{ maxHeight: 400, minHeight: 60 }}>
          {flat.map((it, i) => {
            const head = it.section !== lastSection && (sectionNames.size > 1 || !q.trim()) ? it.section : null;
            lastSection = it.section;
            return (
              <div key={it.key + i}>
                {head && <div className="popup-section">{head}</div>}
                <div className={"popup-row se-row" + (i === sel ? " selected" : "")} onMouseMove={() => i !== sel && setSel(i)} onClick={it.run}>
                  <span className="se-icon">{it.icon}</span>
                  <span className="se-label">{it.label}</span>
                  {it.secondary != null && <span className="se-sec">{it.secondary}</span>}
                  {it.right && <span className="se-right">{it.right}</span>}
                </div>
              </div>
            );
          })}
          {!flat.length && q.trim() && <div className="se-empty">Nothing found</div>}
        </div>
        <div className="se-footer">
          <span>{status}</span>
          <span>{tab === "Text" || tab === "All" ? "" : ""}⇥ switch tab · ↵ open{" "}
            {tab === "Text" && <a className="se-link" onMouseDown={(e) => { e.preventDefault(); onClose(); setTimeout(() => openPopup("FindInPath", { query: q }), 20); }}>Open in Find Window</a>}
          </span>
        </div>
      </PopupShell>
    );
  };
}
