import { useEffect, useMemo, useRef, useState } from "react";
import { PopupShell, type PopupProps } from "../shell/popups";
import { fuzzy } from "../search/fuzzy";
import { useStore } from "../../lib/store";
import { gradleStore } from "./model";
import { allTasks } from "./tree";
import { runTask } from "./ops";

/** Execute Gradle Task: fuzzy-match the tasks of the current build; Enter runs, anything typed can also be run as a command line. */
export function ExecuteGradlePopup({ onClose }: PopupProps) {
  const { model } = useStore(gradleStore);
  const [q, setQ] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const tasks = useMemo(() => allTasks(model), [model]);
  const hits = useMemo(() => {
    const s = q.trim();
    if (!s) return tasks.slice(0, 60).map((t) => ({ t, score: 0 }));
    const word = s.split(/\s+/)[0];
    return tasks.map((t) => {
      const a = fuzzy(word, t.path), b = fuzzy(word, t.name);
      const score = Math.max(a?.score ?? -1e9, (b?.score ?? -1e9) + 3);
      return { t, score };
    }).filter((x) => x.score > -1e8).sort((a, b) => b.score - a.score || (a.t.path < b.t.path ? -1 : 1)).slice(0, 60);
  }, [tasks, q]);
  const free = q.trim();
  const total = hits.length + (free ? 1 : 0);
  const [hi, setHi] = useState(0);
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => setHi(0), [q]);
  const choose = (i: number) => {
    onClose();
    if (i < hits.length) {
      const rest = free.split(/\s+/).slice(1).join(" "); // "run --info" -> args after the task word
      void runTask(hits[i].t.path, rest);
    } else if (free) void runTask(free);
  };
  return (
    <PopupShell onClose={onClose} width={620}>
      <div className="popup-tabs"><span className="popup-title">Execute Gradle Task</span></div>
      <input ref={input} className="popup-input" data-testid="gradle-exec-input" value={q} placeholder="Task name, e.g. build, :app:run --info" spellCheck={false}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => (total ? (h + 1) % total : 0)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => (total ? (h - 1 + total) % total : 0)); }
          else if (e.key === "Enter") { e.preventDefault(); if (total) choose(hi); }
        }} />
      <div className="popup-list" data-testid="gradle-exec-list" style={{ maxHeight: 360, overflow: "auto" }}>
        {hits.map(({ t }, i) => (
          <div key={t.path} className={"popup-row" + (i === hi ? " selected" : "")} data-task={t.path} title={t.description ?? undefined} onMouseEnter={() => setHi(i)} onClick={() => choose(i)}>
            <span className="gj-pop-row"><span>{t.path}</span><span className="dim">{t.group ?? "other"}</span></span>
            <span className="grow" />
          </div>
        ))}
        {free && (
          <div className={"popup-row" + (hi === hits.length ? " selected" : "")} data-act="free" onMouseEnter={() => setHi(hits.length)} onClick={() => choose(hits.length)}>
            <span>Run <b>gradle {free}</b></span>
          </div>
        )}
        {!total && <div className="gj-empty">{model ? "No tasks" : "Gradle projects are not loaded yet"}</div>}
      </div>
    </PopupShell>
  );
}
