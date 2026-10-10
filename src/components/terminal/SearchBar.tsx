import { useEffect, useRef } from "react";
import type { Pane } from "./pane";

/** Ghostty-style ⌘F bar. Esc is handled by register.tsx (it must beat the global Esc action). */
export function SearchBar({ pane }: { pane: Pane }) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const s = pane.search;
  return (
    <div className="term-search" onMouseDown={(e) => e.stopPropagation()}>
      <input
        ref={input}
        value={s.query}
        placeholder="Find"
        spellCheck={false}
        onChange={(e) => pane.setSearch(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); e.shiftKey ? pane.searchPrev() : pane.searchNext(); }
        }}
      />
      <span className="term-search-count">{!s.query ? "" : s.count ? `${s.index + 1}/${s.count}` : "No results"}</span>
      <button className={s.caseSensitive ? "on" : ""} title="Match Case" onClick={() => pane.setSearch(s.query, { caseSensitive: !s.caseSensitive })}>Aa</button>
      <button className={s.regex ? "on" : ""} title="Regex" onClick={() => pane.setSearch(s.query, { regex: !s.regex })}>.*</button>
      <button title="Previous (⇧↩)" onClick={() => pane.searchPrev()}>↑</button>
      <button title="Next (↩)" onClick={() => pane.searchNext()}>↓</button>
      <button title="Close (Esc)" onClick={() => pane.closeSearch()}>×</button>
    </div>
  );
}
