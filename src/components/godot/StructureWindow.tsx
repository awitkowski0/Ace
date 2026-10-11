/** Structure tool window (⌘7): the node tree of a .tscn (read-only), else the language server's symbols of the active file. */
import { useEffect, useState } from "react";
import { useStore } from "../../lib/store";
import { editorStore, activeDocKey } from "../../editor/store";
import { activeEditor } from "../../editor/editorRegistry";
import { lsp } from "../../editor/lsp/api";
import { registerSymbolProvider, type PlainSymbol } from "../../editor/lsp/state";
import type { ToolWindowProps } from "../../toolwindows/registry";
import { openAt } from "../run/openAt";
import { nodeDetail, parseScene } from "./outline";

export const sceneSymbols = (text: string): PlainSymbol[] =>
  parseScene(text).map((n) => ({ name: n.name, kind: n.instance ? 7 : 5, detail: nodeDetail(n), line: n.line, col: 1, depth: n.depth }));

registerSymbolProvider((path, text) => (path.endsWith(".tscn") ? sceneSymbols(text) : null));

function currentText(): { path: string; host: string; text: string } | null {
  const k = activeDocKey();
  const doc = k ? editorStore.get().docs[k] : undefined;
  if (!doc || doc.kind === "diff" || doc.error) return null;
  const m = activeEditor()?.getModel();
  const live = m && m.uri.path === doc.loc.path ? m.getValue() : doc.saved;
  return { path: doc.loc.path, host: doc.loc.host, text: live };
}

export interface StructRow { name: string; detail?: string; line: number; col: number; depth: number }
export let lastStructure: StructRow[] = [];

async function rowsFor(): Promise<StructRow[]> {
  const cur = currentText();
  if (!cur) return [];
  if (cur.path.endsWith(".tscn")) return sceneSymbols(cur.text);
  const r = await lsp.symbols().catch(() => null);
  return r ?? [];
}

export function StructureWindow(_: ToolWindowProps) {
  useStore(editorStore);
  const [rows, setRows] = useState<StructRow[]>([]);
  const [path, setPath] = useState("");
  const [sel, setSel] = useState(-1);
  const key = activeDocKey();
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      const cur = currentText();
      void rowsFor().then((r) => { if (alive) { lastStructure = r; setRows(r); setPath(cur?.path ?? ""); setSel(-1); } });
    };
    refresh();
    // live: re-read a few hundred ms after the model changes (typing in a .tscn)
    const m = activeEditor()?.getModel();
    const sub = m?.onDidChangeContent(() => { clearTimeout(timer); timer = setTimeout(refresh, 400); });
    return () => { alive = false; clearTimeout(timer); sub?.dispose(); };
  }, [key]);
  const go = (r: StructRow) => { const cur = currentText(); if (cur) void openAt({ host: cur.host, path: cur.path }, r.line, r.col); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(rows.length - 1, s + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
    else if (e.key === "Enter" && rows[sel]) go(rows[sel]);
  };
  return (
    <div className="gd-struct" tabIndex={0} data-autofocus onKeyDown={onKey} data-testid="structure-window" data-path={path}>
      {rows.length === 0 && <div className="gd-empty">{path ? "No structure available" : "No file open"}</div>}
      {rows.map((r, i) => (
        <div key={i} className={"gd-row" + (i === sel ? " selected" : "")} data-testid="structure-row" data-line={r.line} style={{ paddingLeft: 8 + r.depth * 14 }} onMouseDown={() => setSel(i)} onClick={() => go(r)}>
          <span className="gd-label">{r.name}</span>
          {r.detail && <span className="gd-hint">{r.detail}</span>}
        </div>
      ))}
    </div>
  );
}
