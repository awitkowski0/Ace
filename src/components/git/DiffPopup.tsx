import { useEffect, useRef, useState } from "react";
import type { editor } from "monaco-editor";
import { PopupShell, type PopupProps } from "../shell/popups";
import { languageFor } from "../../editor/languages";
import { openFile } from "../../editor/store";
import type { DiffSpec } from "./diff";

/**
 * Side-by-side Monaco diff. v1 renders in a large popup (read-only) because the editor store only knows
 * file-backed tabs; to make it a real tab, EditorArea needs a `doc.diff` branch that mounts this
 * <DiffView/> (it is self-contained).
 */
export function DiffView({ spec, onClose }: { spec: DiffSpec; onClose?: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const ed = useRef<editor.IStandaloneDiffEditor | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    const models: editor.ITextModel[] = [];
    (async () => {
      try {
        const [{ monaco }, l, r] = await Promise.all([import("../../editor/monacoSetup"), spec.left(), spec.right()]);
        if (disposed || !host.current) return;
        const lang = languageFor(spec.name);
        const d = monaco.editor.createDiffEditor(host.current, {
          renderSideBySide: true, readOnly: true, originalEditable: false, automaticLayout: true, theme: "nord",
          fontFamily: '"JetBrains Mono", Menlo, monospace', fontSize: 13, lineHeight: 20, minimap: { enabled: false },
          scrollBeyondLastLine: false, ignoreTrimWhitespace: false, renderOverviewRuler: true,
        });
        const o = monaco.editor.createModel(l, lang), m = monaco.editor.createModel(r, lang);
        models.push(o, m);
        d.setModel({ original: o, modified: m });
        ed.current = d;
        d.onDidUpdateDiff(() => { if (!disposed && d.getLineChanges()?.length) d.goToDiff("next"); });
        d.getModifiedEditor().focus();
      } catch (e) {
        setErr(String(e));
      }
    })();
    return () => {
      disposed = true;
      ed.current?.dispose();
      ed.current = null;
      models.forEach((m) => m.dispose());
    };
  }, [spec]);

  const go = (dir: "next" | "previous") => ed.current?.goToDiff(dir);
  return (
    <div className="gitdiff" onKeyDown={(e) => {
      if (e.key === "F7") { e.preventDefault(); go(e.shiftKey ? "previous" : "next"); }
    }}>
      <div className="gitdiff-bar">
        <span className="gitdiff-title">{spec.title}</span>
        <div className="grow" />
        <button className="gitbtn" onClick={() => go("previous")} title="Previous Difference (⇧F7)">↑</button>
        <button className="gitbtn" onClick={() => go("next")} title="Next Difference (F7)">↓</button>
        {spec.openLoc && (
          <button className="gitbtn" onClick={() => { openFile(spec.openLoc!); onClose?.(); }}>Open in Editor</button>
        )}
      </div>
      <div className="gitdiff-labels"><span>{spec.leftLabel}</span><span>{spec.rightLabel}</span></div>
      {err ? <div className="git-empty">{err}</div> : <div className="gitdiff-host" ref={host} />}
    </div>
  );
}

export function DiffPopup({ onClose, props }: PopupProps) {
  const spec = props as DiffSpec;
  return (
    <PopupShell onClose={onClose} width={Math.min(1500, window.innerWidth - 60)} height={Math.round(window.innerHeight * 0.74)}>
      <DiffView spec={spec} onClose={onClose} />
    </PopupShell>
  );
}
