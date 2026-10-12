import { formatShortcut } from "../../lib/platform";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { editor as MonacoEditor } from "monaco-editor";
import { PopupShell, type PopupProps } from "../shell/popups";
import { confirmDialog } from "../shell/dialogs";
import { showToolWindow } from "../../lib/layout";
import { editorStore, reloadIfChanged } from "../../editor/store";
import { languageFor } from "../../editor/languages";
import { basename, fs, locKey, type Location } from "../../lib/ipc";
import { searchReplace, searchText, type TextMatch, type TextOpts, type TextSearchHandle } from "./api";
import { absLoc, currentRoot, openAt } from "./nav";
import { RangeHl, VList, dirOf } from "./ui";
import { findStore } from "./findStore";
import { FileIcon } from "../shell/icons";

const PreviewEditor = lazy(async () => {
  await import("../../editor/monacoSetup");
  const m = await import("@monaco-editor/react");
  return { default: m.default };
});

const LS = "ace.findInPath";
const loadPrefs = () => {
  try { return JSON.parse(localStorage.getItem(LS) ?? "{}"); } catch { return {}; }
};

export function makeFindPopup(replaceMode: boolean) {
  return function FindPopup({ onClose, props }: PopupProps) {
    const prefs = useMemo(loadPrefs, []);
    const init = (props as { query?: string; scope?: string } | undefined) ?? {};
    const root = currentRoot();
    const sel0 = window.getSelection()?.toString() ?? "";
    const [q, setQ] = useState(init.query ?? (sel0 && !sel0.includes("\n") ? sel0 : "") ?? "");
    const [rep, setRep] = useState("");
    const [cs, setCs] = useState<boolean>(prefs.cs ?? false);
    const [words, setWords] = useState<boolean>(prefs.words ?? false);
    const [regex, setRegex] = useState<boolean>(prefs.regex ?? false);
    const [mask, setMask] = useState<string>(prefs.mask ?? "");
    const [scopeDir, setScopeDir] = useState<string>(init.scope ?? "");
    const [matches, setMatches] = useState<TextMatch[]>([]);
    const [done, setDone] = useState(true);
    const [info, setInfo] = useState<{ truncated: boolean; elapsedMs: number; error: string | null }>({ truncated: false, elapsedMs: 0, error: null });
    const [sel, setSel] = useState(0);
    const [excluded, setExcluded] = useState<Set<string>>(new Set());
    const [size, setSize] = useState<{ w: number; h: number }>(prefs.size ?? { w: 900, h: 640 });
    const input = useRef<HTMLInputElement>(null);
    const handle = useRef<TextSearchHandle | null>(null);
    const acc = useRef<TextMatch[]>([]);
    const raf = useRef(0);
    const selKey = useRef<string | null>(null);

    useEffect(() => { input.current?.focus(); input.current?.select(); return () => { handle.current?.cancel(); cancelAnimationFrame(raf.current); }; }, []);
    useEffect(() => {
      try { localStorage.setItem(LS, JSON.stringify({ cs, words, regex, mask, size })); } catch {}
    }, [cs, words, regex, mask, size]);

    const opts: TextOpts = useMemo(() => ({ query: q, caseSensitive: cs, words, regex, mask, scope: scopeDir.trim() || null, maxResults: 5000 }), [q, cs, words, regex, mask, scopeDir]);

    useEffect(() => {
      handle.current?.cancel();
      acc.current = [];
      if (!root || !q) { setMatches([]); setDone(true); setInfo({ truncated: false, elapsedMs: 0, error: null }); return; }
      setDone(false);
      setSel(0);
      setExcluded(new Set());
      selKey.current = null;
      const timer = setTimeout(() => {
        let pending = false;
        const h = searchText(root, opts, (ms, fin, inf) => {
          acc.current.push(...ms);
          if (fin) {
            const sorted = [...acc.current].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : a.line - b.line));
            acc.current = sorted;
            cancelAnimationFrame(raf.current);
            setMatches(sorted);
            setDone(true);
            setInfo({ truncated: inf.truncated, elapsedMs: inf.elapsedMs, error: inf.error });
            if (selKey.current) {
              const i = sorted.findIndex((m) => `${m.path}:${m.line}` === selKey.current);
              if (i >= 0) setSel(i);
            }
          } else if (!pending) {
            pending = true;
            raf.current = requestAnimationFrame(() => { pending = false; setMatches(acc.current.slice()); });
          }
        });
        handle.current = h;
      }, 60);
      return () => { clearTimeout(timer); handle.current?.cancel(); };
    }, [opts, root?.path, root?.host]); // eslint-disable-line

    const cur = matches[sel];
    useEffect(() => { selKey.current = cur ? `${cur.path}:${cur.line}` : null; }, [cur]);

    // ---- preview
    const [pv, setPv] = useState<{ path: string; text: string } | null>(null);
    const ed = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
    const dec = useRef<MonacoEditor.IEditorDecorationsCollection | null>(null);
    const cache = useRef(new Map<string, string>());
    useEffect(() => {
      if (!cur || !root) { setPv(null); return; }
      const hit = cache.current.get(cur.path);
      if (hit !== undefined) { setPv({ path: cur.path, text: hit }); return; }
      let dead = false;
      const t = setTimeout(() => {
        fs.readFile(absLoc(root, cur.path)).then((text) => {
          if (dead) return;
          if (cache.current.size > 20) cache.current.clear();
          cache.current.set(cur.path, text);
          setPv({ path: cur.path, text });
        }).catch(() => !dead && setPv({ path: cur.path, text: "(cannot read file)" }));
      }, 30);
      return () => { dead = true; clearTimeout(t); };
    }, [cur?.path, root?.path]); // eslint-disable-line
    const decorate = useCallback(() => {
      const e = ed.current;
      const model = e?.getModel();
      if (!e || !model || !cur || !pv || pv.path !== cur.path) return;
      const ln = Math.min(cur.line, model.getLineCount());
      const lead = model.getLineContent(ln).length - model.getLineContent(ln).trimStart().length;
      const ranges = cur.ranges.map(([s, en]) => ({
        range: { startLineNumber: ln, startColumn: s + lead + 1, endLineNumber: ln, endColumn: en + lead + 1 },
        options: { inlineClassName: "se-prev-mark", className: "se-prev-line", isWholeLine: false },
      }));
      dec.current?.clear();
      dec.current = e.createDecorationsCollection(ranges);
      e.revealLineInCenter(ln);
    }, [cur, pv]);
    useEffect(decorate, [decorate]);

    // ---- actions
    const openSel = (m: TextMatch | undefined) => { if (!m || !root) return; onClose(); setTimeout(() => void openAt(absLoc(root, m.path), m.line, m.col), 20); };
    const pin = () => {
      if (!root) return;
      findStore.set({ root, opts, matches, done, truncated: info.truncated, elapsedMs: info.elapsedMs, title: q });
      onClose();
      setTimeout(() => showToolWindow("find"), 20);
    };
    const doReplace = async () => {
      if (!root) return;
      const files = [...new Set(matches.map((m) => m.path))].filter((p) => !excluded.has(p));
      const count = matches.filter((m) => !excluded.has(m.path)).length;
      if (!files.length) return;
      const ok = await confirmDialog({
        title: "Replace in Files",
        message: `Replace ${count} occurrence${count === 1 ? "" : "s"} of "${q}" with "${rep}" in ${files.length} file${files.length === 1 ? "" : "s"}?`,
        okLabel: "Replace",
      });
      if (!ok) return;
      try {
        const r = await searchReplace(root, opts, rep, files);
        for (const f of files) void reloadIfChanged(locKey(absLoc(root, f)));
        if (r.errors.length) console.warn("replace errors", r.errors);
        onClose();
      } catch (e) {
        await confirmDialog({ title: "Replace failed", message: String(e), okLabel: "OK" });
      }
    };

    const onKey = (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(matches.length - 1, s + 1)); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
      else if (e.key === "PageDown") { e.preventDefault(); setSel((s) => Math.min(matches.length - 1, s + 12)); }
      else if (e.key === "PageUp") { e.preventDefault(); setSel((s) => Math.max(0, s - 12)); }
      else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); pin(); }
      else if (e.key === "Enter" && replaceMode && e.altKey) { e.preventDefault(); void doReplace(); }
      else if (e.key === "Enter") { e.preventDefault(); openSel(cur); }
      else if (e.key === "Delete" && replaceMode && cur) {
        setExcluded((s) => { const n = new Set(s); n.has(cur.path) ? n.delete(cur.path) : n.add(cur.path); return n; });
      } else if (e.altKey && e.code === "KeyC") { e.preventDefault(); setCs((v) => !v); }
      else if (e.altKey && e.code === "KeyW") { e.preventDefault(); setWords((v) => !v); }
      else if (e.altKey && e.code === "KeyX") { e.preventDefault(); setRegex((v) => !v); }
    };

    const startResize = (e: React.MouseEvent) => {
      e.preventDefault();
      const sx = e.clientX, sy = e.clientY, { w, h } = size;
      const mv = (ev: MouseEvent) => setSize({ w: Math.max(560, w + (ev.clientX - sx) * 2), h: Math.max(380, h + (ev.clientY - sy)) });
      const up = () => { window.removeEventListener("mousemove", mv); window.removeEventListener("mouseup", up); };
      window.addEventListener("mousemove", mv);
      window.addEventListener("mouseup", up);
    };

    const nFiles = useMemo(() => new Set(matches.map((m) => m.path)).size, [matches]);
    const Toggle = ({ on, set, label, title }: { on: boolean; set: (v: boolean) => void; label: string; title: string }) => (
      <button className={"se-toggle" + (on ? " on" : "")} title={title} onMouseDown={(e) => { e.preventDefault(); set(!on); input.current?.focus(); }}>{label}</button>
    );
    const language = cur ? languageFor(basename(cur.path)) : "plaintext";
    const title = replaceMode ? "Replace in Files" : "Find in Files";

    return (
      <PopupShell onClose={onClose} width={size.w} height={size.h}>
        <div className="popup-tabs"><span className="popup-title">{title}</span></div>
        <div className="se-fip-fields">
          <div className="se-inputrow">
            <input ref={input} className="se-input" spellCheck={false} placeholder="Search text" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} />
            <Toggle on={cs} set={setCs} label="Cc" title={`Match Case (${formatShortcut("⌥C")})`} />
            <Toggle on={words} set={setWords} label="W" title={`Words (${formatShortcut("⌥W")})`} />
            <Toggle on={regex} set={setRegex} label=".*" title={`Regex (${formatShortcut("⌥X")})`} />
          </div>
          {replaceMode && (
            <div className="se-inputrow">
              <input className="se-input" spellCheck={false} placeholder="Replace with" value={rep} onChange={(e) => setRep(e.target.value)} onKeyDown={onKey} />
            </div>
          )}
          <div className="se-inputrow se-small">
            <span className="se-lbl">File mask</span>
            <input className="se-input se-mask" spellCheck={false} placeholder="*.gd, *.tscn" value={mask} onChange={(e) => setMask(e.target.value)} onKeyDown={onKey} />
            <span className="se-lbl">Scope</span>
            <input className="se-input se-mask" spellCheck={false} placeholder={root ? `Project (${basename(root.path)}) — or directory path` : "Project"} value={scopeDir} onChange={(e) => setScopeDir(e.target.value)} onKeyDown={onKey} />
          </div>
        </div>
        <div className="se-fip-body">
          <div className="se-fip-results">
            <VList
              items={matches}
              height="100%"
              sel={sel}
              render={(m, i) => (
                <div className={"popup-row se-row" + (i === sel ? " selected" : "")} onMouseDown={() => setSel(i)} onDoubleClick={() => openSel(m)}>
                  {replaceMode && <input type="checkbox" className="se-chk" checked={!excluded.has(m.path)} onChange={() => setExcluded((s) => { const n = new Set(s); n.has(m.path) ? n.delete(m.path) : n.add(m.path); return n; })} onMouseDown={(e) => e.stopPropagation()} />}
                  <span className="se-label se-code"><RangeHl text={m.text} ranges={m.ranges} replacement={replaceMode && !excluded.has(m.path) && !regex ? rep : undefined} /></span>
                  <span className="se-sec"><FileIcon />{basename(m.path)}:{m.line}</span>
                </div>
              )}
            />
            {!matches.length && <div className="se-empty">{!q ? "Type to search" : !done ? "Searching…" : info.error ? info.error : "No matches"}</div>}
          </div>
          <div className="se-fip-preview">
            {cur && <div className="se-prev-head"><span>{basename(cur.path)}</span><span className="dim">{dirOf(cur.rel)}</span></div>}
            <div className="se-prev-ed">
              {cur && pv && (
                <Suspense fallback={null}>
                  <PreviewEditor
                    theme="nord"
                    language={language}
                    value={pv.text}
                    onMount={(e) => { ed.current = e; decorate(); }}
                    options={{ readOnly: true, minimap: { enabled: false }, lineNumbers: "on", scrollBeyondLastLine: false, folding: false, fontSize: 12, renderLineHighlight: "none", domReadOnly: true, contextmenu: false, scrollbar: { verticalScrollbarSize: 8 } }}
                  />
                </Suspense>
              )}
            </div>
          </div>
        </div>
        <div className="se-footer">
          <span>
            {done ? "" : "Searching… "}
            {matches.length}{info.truncated ? "+" : ""} match{matches.length === 1 ? "" : "es"} in {nFiles} file{nFiles === 1 ? "" : "s"}
            {done && info.elapsedMs ? ` · ${info.elapsedMs.toFixed(0)} ms` : ""}
          </span>
          <span className="se-actions">
            <a className="se-link" onMouseDown={(e) => { e.preventDefault(); pin(); }}>Open in Find Window ⌘↵</a>
            {replaceMode && <button className="se-btn" disabled={!matches.length} onClick={() => void doReplace()}>Replace All</button>}
          </span>
        </div>
        <div className="se-resize" onMouseDown={startResize} />
      </PopupShell>
    );
  };
}
export type { Location };
