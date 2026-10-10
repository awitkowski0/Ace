import { useEffect, useMemo, useRef, useState } from "react";
import { PopupShell, type PopupProps } from "../shell/popups";
import { FileIcon } from "../shell/icons";
import { editorStore } from "../../editor/store";
import { useStore } from "../../lib/store";
import { listToolWindows } from "../../toolwindows/registry";
import { layoutStore, showToolWindow } from "../../lib/layout";
import { keysFor } from "../../actions/keymap";
import { formatKeystroke } from "../../actions/keystroke";
import { fuzzy } from "./fuzzy";
import { currentRoot, openAt } from "./nav";
import { Hl, dirOf } from "./ui";

/** Recent Files (⌘E) and Switcher (⌃⇥, release ⌃ to select). Tool windows on the left, files on the right. */
export function makeRecent(switcher: boolean) {
  return function Recent({ onClose }: PopupProps) {
    const { docs, recent } = useStore(editorStore);
    const root = currentRoot();
    const tws = useMemo(() => listToolWindows(), []);
    const [q, setQ] = useState("");
    const [col, setCol] = useState<"files" | "tw">("files");
    const [fsel, setFsel] = useState(0);
    const [tsel, setTsel] = useState(0);
    const box = useRef<HTMLDivElement>(null);

    const files = useMemo(() => {
      const all = recent.map((k) => docs[k]).filter(Boolean).map((d) => {
        const rel = root && d.loc.path.startsWith(root.path + "/") ? d.loc.path.slice(root.path.length + 1) : d.loc.path;
        return { d, rel, f: q ? fuzzy(q, d.name) : null };
      });
      return q ? all.filter((x) => x.f).sort((a, b) => b.f!.score - a.f!.score) : all;
    }, [recent, docs, q, root]);
    const twList = useMemo(() => (q ? tws.filter((t) => fuzzy(q, t.title)) : tws), [tws, q]);

    useEffect(() => { box.current?.focus(); setFsel(Math.min(1, Math.max(0, files.length - 1))); }, []); // eslint-disable-line
    useEffect(() => { setFsel((s) => Math.min(s, Math.max(0, files.length - 1))); }, [files.length]);

    const choose = () => {
      if (col === "files") {
        const x = files[fsel];
        onClose();
        if (x) setTimeout(() => void openAt(x.d.loc), 20);
      } else {
        const t = twList[tsel];
        onClose();
        if (t) setTimeout(() => showToolWindow(t.id), 20);
      }
    };
    const chooseRef = useRef(choose);
    chooseRef.current = choose;

    const move = (d: number) => {
      if (col === "files") setFsel((s) => (files.length ? (s + d + files.length) % files.length : 0));
      else setTsel((s) => (twList.length ? (s + d + twList.length) % twList.length : 0));
    };
    const moveRef = useRef(move);
    moveRef.current = move;

    useEffect(() => {
      if (!switcher) return;
      const up = (e: KeyboardEvent) => { if (e.key === "Control") chooseRef.current(); };
      const down = (e: KeyboardEvent) => {
        if (e.key === "Tab") { e.preventDefault(); e.stopPropagation(); moveRef.current(e.shiftKey ? -1 : 1); }
      };
      window.addEventListener("keyup", up, true);
      window.addEventListener("keydown", down, true);
      return () => { window.removeEventListener("keyup", up, true); window.removeEventListener("keydown", down, true); };
    }, []);

    const onKey = (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown" || (!switcher && e.metaKey && e.key.toLowerCase() === "e")) move(1);
      else if (e.key === "ArrowUp") move(-1);
      else if (e.key === "ArrowLeft" && !q) setCol("tw");
      else if (e.key === "ArrowRight" && !q) setCol("files");
      else if (e.key === "Enter") choose();
      else if (e.key === "Backspace") setQ((s) => s.slice(0, -1));
      else if (!switcher && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) setQ((s) => s + e.key);
      else return;
      e.preventDefault();
    };

    useEffect(() => {
      box.current?.querySelectorAll<HTMLElement>(".selected").forEach((el) => el.scrollIntoView({ block: "nearest" }));
    }, [fsel, tsel, col]);

    const activeTw = Object.values(layoutStore.get().active);
    return (
      <PopupShell onClose={onClose} width={switcher ? 560 : 640}>
        <div className="popup-tabs"><span className="popup-title">{switcher ? "Switcher" : "Recent Files"}</span>{q && <span className="se-q">{q}</span>}</div>
        <div ref={box} tabIndex={0} className="se-recent" onKeyDown={onKey} style={{ outline: "none" }}>
          <div className="se-recent-tw">
            <div className="popup-section">Tool Windows</div>
            {twList.map((t, i) => {
              const k = keysFor(t.actionId ?? `Activate${t.id.replace(/(^|[-_ ])(\w)/g, (_, __, c: string) => c.toUpperCase())}ToolWindow`)[0] ?? (t.shortcut ? t.shortcut : "");
              return (
                <div key={t.id} className={"popup-row se-row" + (col === "tw" && i === tsel ? " selected" : "") + (activeTw.includes(t.id) ? " se-active" : "")}
                  onMouseDown={(e) => { e.preventDefault(); setCol("tw"); setTsel(i); }} onClick={choose}>
                  <span className="se-icon">{t.icon}</span><span className="se-label">{t.title}</span>
                  {k && <span className="se-right">{formatKeystroke(k)}</span>}
                </div>
              );
            })}
          </div>
          <div className="se-recent-files">
            <div className="popup-section">Recent Files</div>
            {files.map(({ d, rel, f }, i) => (
              <div key={d.key} className={"popup-row se-row" + (col === "files" && i === fsel ? " selected" : "")}
                onMouseDown={(e) => { e.preventDefault(); setCol("files"); setFsel(i); }} onClick={choose}>
                <span className="se-icon"><FileIcon /></span>
                <span className="se-label"><Hl text={d.name} indices={f?.indices} />{d.dirty && <span className="se-dirty"> ●</span>}</span>
                <span className="se-sec">{dirOf(rel)}</span>
              </div>
            ))}
            {!files.length && <div className="se-empty">No recent files</div>}
          </div>
        </div>
      </PopupShell>
    );
  };
}
