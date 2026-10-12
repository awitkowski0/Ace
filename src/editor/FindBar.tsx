import { formatShortcut, isMod } from "../lib/platform";
import { useEffect, useRef } from "react";
import { useStore } from "../lib/store";
import { SearchIcon, CloseIcon } from "../components/shell/icons";
import { closeFind, findNext, findStore, refreshFind, replaceAll, replaceCurrent } from "./find";
import { getEditor } from "./editorRegistry";

/** IntelliJ-style find / replace strip shown above the editor of the active group. */
export function FindBar({ groupId }: { groupId: string }) {
  const f = useStore(findStore);
  const q = useRef<HTMLInputElement>(null);
  const ed = () => getEditor(groupId);

  useEffect(() => {
    if (!f.open) return;
    q.current?.focus();
    q.current?.select();
  }, [f.open, f.focusNonce]);

  // live updates: query/options, edits and selection changes while the bar is open
  useEffect(() => {
    const e = ed();
    if (!e) return;
    refreshFind(e);
    let t: number | undefined;
    const later = () => { clearTimeout(t); t = window.setTimeout(() => refreshFind(e), 120); };
    const a = e.onDidChangeModelContent(later);
    const b = e.onDidChangeCursorSelection(() => refreshFind(e));
    return () => { clearTimeout(t); a.dispose(); b.dispose(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f.query, f.matchCase, f.wholeWord, f.regex, groupId]);

  const toggle = (k: "matchCase" | "wholeWord" | "regex") => findStore.set((s) => ({ [k]: !s[k] }) as Partial<typeof s>);
  const count = !f.query ? "" : f.invalid ? "Bad regex" : f.total === 0 ? "No results" : f.index ? `${f.index}/${f.total}` : `${f.total} results`;

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeFind(); }
    else if (e.key === "Enter") {
      e.preventDefault();
      if ((e.target as HTMLElement).dataset.role === "replace") replaceCurrent(ed());
      else findNext(e.shiftKey ? -1 : 1, ed(), true);
    } else if (e.altKey && isMod(e) && e.code === "KeyC") { e.preventDefault(); toggle("matchCase"); }
    else if (e.altKey && isMod(e) && e.code === "KeyW") { e.preventDefault(); toggle("wholeWord"); }
    else if (e.altKey && isMod(e) && e.code === "KeyR") { e.preventDefault(); toggle("regex"); }
  };

  return (
    <div className="findbar" onKeyDown={onKey}>
      <div className="find-row">
        <div className={"find-field" + (f.invalid || (f.query && f.total === 0) ? " bad" : "")}>
          <span className="find-ico"><SearchIcon /></span>
          <input
            ref={q}
            value={f.query}
            spellCheck={false}
            placeholder="Search"
            onChange={(e) => findStore.set({ query: e.target.value })}
          />
          <button className={"find-opt" + (f.matchCase ? " on" : "")} title={`Match Case (${formatShortcut("⌥⌘C")})`} onClick={() => toggle("matchCase")}>Cc</button>
          <button className={"find-opt" + (f.wholeWord ? " on" : "")} title={`Words (${formatShortcut("⌥⌘W")})`} onClick={() => toggle("wholeWord")}>W</button>
          <button className={"find-opt" + (f.regex ? " on" : "")} title={`Regex (${formatShortcut("⌥⌘R")})`} onClick={() => toggle("regex")}>.*</button>
        </div>
        <span className="find-count">{count}</span>
        <button className="icon-btn sm" title={`Previous Occurrence (${formatShortcut("⇧⌘G")})`} onClick={() => findNext(-1, ed(), true)}>↑</button>
        <button className="icon-btn sm" title={`Next Occurrence (${formatShortcut("⌘G")})`} onClick={() => findNext(1, ed(), true)}>↓</button>
        <button className={"find-opt wide" + (f.replace ? " on" : "")} title={`Toggle Replace (${formatShortcut("⌘R")})`} onClick={() => findStore.set((s) => ({ replace: !s.replace }))}>Replace</button>
        <div className="grow" />
        <button className="icon-btn sm" title="Close (Esc)" onClick={closeFind}><CloseIcon /></button>
      </div>
      {f.replace && (
        <div className="find-row">
          <div className="find-field">
            <span className="find-ico">↳</span>
            <input data-role="replace" value={f.replaceText} spellCheck={false} placeholder="Replace" onChange={(e) => findStore.set({ replaceText: e.target.value })} />
          </div>
          <button className="find-btn" onClick={() => replaceCurrent(ed())}>Replace</button>
          <button className="find-btn" onClick={() => replaceAll(ed())}>Replace all</button>
        </div>
      )}
    </div>
  );
}
