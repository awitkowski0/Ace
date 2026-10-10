import { Fragment, lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { editor } from "monaco-editor";
import Editor from "@monaco-editor/react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { keymapReady, monaco } from "./monacoSetup";
import "./editor.css";
import {
  activateTab, closeAllTabs, closeOthers, closeTab, closeTabsToRight, consumeReveal, editorStore, installModelBridge,
  reloadIfChanged, setActiveGroup, setCursor, setDirtyFromText, splitActive, togglePin, type LayoutNode,
} from "./store";
import { FindBar } from "./FindBar";
import { findStore } from "./find";
import { toggleHideAllWindows } from "./hideAll";
import { getEditor, registerEditor, setActiveEditorGroup, unregisterEditor } from "./editorRegistry";
import { useStore } from "../lib/store";
import { fs, locKey } from "../lib/ipc";
import { showContextMenu } from "../components/shell/contextMenu";
import { CloseIcon, DiffIcon, FileIcon, PinIcon } from "../components/shell/icons";
import { keysFor } from "../actions/keymap";
import { formatKeystroke } from "../actions/keystroke";

const DiffView = lazy(() => import("../components/git/DiffPopup").then((m) => ({ default: m.DiffView })));

const modelUri = (key: string) => {
  const i = key.indexOf(":");
  const host = key.slice(0, i);
  const path = key.slice(i + 1);
  return host === "local" ? monaco.Uri.file(path) : monaco.Uri.from({ scheme: "ssh", authority: host, path });
};
const uriString = (key: string) => modelUri(key).toString();

installModelBridge({
  getText: (key) => monaco.editor.getModel(modelUri(key))?.getValue(),
  setText: (key, text) => monaco.editor.getModel(modelUri(key))?.setValue(text),
  dispose: (key) => monaco.editor.getModel(modelUri(key))?.dispose(),
});

/** IntelliJ default editor settings (JetBrains Mono 13, ligatures off, no wrapping/whitespace, blinking 2px caret). */
const EDITOR_OPTIONS: editor.IStandaloneEditorConstructionOptions = {
  fontFamily: '"JetBrains Mono", Menlo, monospace',
  fontSize: 13,
  lineHeight: 20,
  fontLigatures: false,
  letterSpacing: 0,
  minimap: { enabled: false },
  automaticLayout: true,
  scrollBeyondLastLine: true,
  renderLineHighlight: "line",
  renderWhitespace: "none",
  renderControlCharacters: false,
  wordWrap: "off",
  smoothScrolling: false,
  cursorSmoothCaretAnimation: "off",
  cursorBlinking: "blink",
  cursorStyle: "line",
  cursorWidth: 2,
  multiCursorModifier: "alt",
  padding: { top: 4 },
  guides: { indentation: true, highlightActiveIndentation: true, bracketPairs: false },
  bracketPairColorization: { enabled: false },
  occurrencesHighlight: "singleFile",
  matchBrackets: "always",
  folding: true,
  showFoldingControls: "mouseover",
  stickyScroll: { enabled: true },
  hover: { delay: 500 },
  contextmenu: true,
  accessibilitySupport: "off",
  "semanticHighlighting.enabled": true,
};

/** Put the caret where `reveal` asks once the right model is mounted in this group's editor. */
function applyReveal(groupId: string, ed: editor.IStandaloneCodeEditor | undefined) {
  const st = editorStore.get();
  const r = st.reveal;
  if (!r || !ed || st.activeGroup !== groupId) return;
  const model = ed.getModel();
  if (!model || model.uri.toString() !== uriString(r.key)) return;
  const line = Math.min(Math.max(1, r.line), model.getLineCount());
  const col = Math.min(Math.max(1, r.col), model.getLineMaxColumn(line));
  const start = { lineNumber: line, column: col };
  if (r.select) {
    const end = typeof r.select === "number"
      ? model.getPositionAt(model.getOffsetAt(start) + r.select)
      : { lineNumber: Math.min(r.select.endLine, model.getLineCount()), column: r.select.endCol };
    ed.setSelection({ startLineNumber: line, startColumn: col, endLineNumber: end.lineNumber, endColumn: end.column });
  } else ed.setPosition(start);
  ed.revealPositionInCenterIfOutsideViewport(start);
  ed.focus();
  consumeReveal(r.nonce);
}

function EditorGroupView({ id }: { id: string }) {
  const { groups, docs, activeGroup, reveal } = useStore(editorStore);
  const { open: findOpen } = useStore(findStore);
  const g = groups[id];
  const edRef = useRef<editor.IStandaloneCodeEditor>();
  const tabsRef = useRef<HTMLDivElement>(null);
  const [keysReady, setKeysReady] = useState(false);
  useEffect(() => { keymapReady.then(() => setKeysReady(true)); }, []);
  useEffect(() => () => { unregisterEditor(id); }, [id]);
  const doApply = useCallback(() => applyReveal(id, edRef.current), [id]);
  const activeKey = g?.active ?? null;
  // a reveal request can arrive before or after the model is mounted: try on every relevant change + on model switch
  useEffect(doApply, [doApply, reveal?.nonce, activeKey, keysReady]);
  useEffect(() => {
    tabsRef.current?.querySelector(".tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeKey, g?.tabs.length]);
  if (!g) return null;
  const doc = g.active ? docs[g.active] : undefined;
  const isActiveGroup = activeGroup === id;
  const diffTabs = g.tabs.filter((k) => docs[k]?.kind === "diff");

  const tabMenu = (e: React.MouseEvent, key: string) => {
    const d = docs[key];
    const only = g.tabs.length < 2;
    const idx = g.tabs.indexOf(key);
    showContextMenu(e.clientX, e.clientY, [
      { label: "Close", shortcut: "⌘W", run: () => closeTab(id, key, { force: true }) },
      { label: "Close Others", disabled: only, run: () => closeOthers(id, key) },
      { label: "Close All", run: () => closeAllTabs(id) },
      { label: "Close Tabs to the Right", disabled: idx === g.tabs.length - 1, run: () => closeTabsToRight(id, key) },
      { separator: true, label: "" },
      { label: d?.pinned ? "Unpin Tab" : "Pin Tab", run: () => togglePin(key) },
      { separator: true, label: "" },
      { label: "Split Right", run: () => { activateTab(id, key); splitActive("right"); } },
      { label: "Split Down", run: () => { activateTab(id, key); splitActive("down"); } },
      { separator: true, label: "" },
      { label: "Copy Path", disabled: d?.kind === "diff", run: () => void navigator.clipboard?.writeText(d?.loc.path ?? "") },
    ]);
  };

  return (
    <div className={"editor-group" + (isActiveGroup ? " active" : "")} onMouseDown={() => { setActiveGroup(id); setActiveEditorGroup(id); }}>
      {g.tabs.length > 0 && (
        <div className="tabs" ref={tabsRef}>
          {g.tabs.map((key) => {
            const d = docs[key];
            if (!d) return null;
            return (
              <div
                key={key}
                className={"tab" + (g.active === key ? " active" : "") + (d.pinned ? " pinned" : "") + (d.kind === "diff" ? " diff" : "")}
                title={d.kind === "diff" ? d.diff?.title : d.loc.path}
                onMouseDown={(e) => {
                  if (e.button === 1) { e.preventDefault(); closeTab(id, key); }
                  else if (e.button === 0) activateTab(id, key);
                }}
                onDoubleClick={toggleHideAllWindows}
                onContextMenu={(e) => tabMenu(e, key)}
              >
                <span className="tab-icon">{d.kind === "diff" ? <DiffIcon /> : <FileIcon />}</span>
                <span className="tab-name">{d.name}</span>
                {d.pinned ? (
                  <span className="pin-ico" title="Pinned (click to unpin)" onMouseDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); togglePin(key); }}><PinIcon /></span>
                ) : (
                  <span
                    className={"tab-close" + (d.dirty ? " dirty" : "")}
                    onMouseDown={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (e.altKey) closeOthers(id, key); // ⌥-click close = Close Others
                      else closeTab(id, key);
                    }}
                  >
                    {d.dirty ? <span className="dirty-dot" /> : null}
                    <span className="x"><CloseIcon /></span>
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
      {isActiveGroup && findOpen && doc?.kind !== "diff" && <FindBar groupId={id} />}
      <div className="editor-body">
        {diffTabs.map((key) => (
          <div key={key} style={{ position: "absolute", inset: 0, display: g.active === key ? "block" : "none" }}>
            <Suspense fallback={null}><DiffView spec={docs[key].diff!} tabKey={key} groupId={id} /></Suspense>
          </div>
        ))}
        {doc?.kind === "diff" ? null : doc?.error ? (
          <div className="editor-empty">{doc.error}</div>
        ) : doc && keysReady ? (
          <Editor
            key={id}
            path={uriString(doc.key)}
            defaultValue={doc.initial}
            language={doc.language}
            theme="nord"
            keepCurrentModel
            loading={null}
            onChange={(v) => setDirtyFromText(doc.key, v ?? "")}
            onMount={(ed) => {
              edRef.current = ed;
              registerEditor(id, ed);
              ed.onDidFocusEditorText(() => { setActiveGroup(id); setActiveEditorGroup(id); const p = ed.getPosition(); if (p) setCursor(p.lineNumber, p.column); });
              ed.onDidChangeCursorPosition((e) => editorStore.get().activeGroup === id && setCursor(e.position.lineNumber, e.position.column));
              ed.onDidChangeModel(() => applyReveal(id, ed));
              ed.onDidDispose(() => { if (getEditor(id) === ed) unregisterEditor(id); });
              setActiveEditorGroup(editorStore.get().activeGroup);
              if (editorStore.get().activeGroup === id && !editorStore.get().reveal) ed.focus();
              applyReveal(id, ed);
            }}
            options={EDITOR_OPTIONS}
          />
        ) : !doc ? (
          <EmptyState />
        ) : null}
      </div>
    </div>
  );
}

function EmptyState() {
  const rows: [string, string][] = [
    ["Search Everywhere", "SearchEverywhere"],
    ["Go to File", "GotoFile"],
    ["Recent Files", "RecentFiles"],
    ["Find in Files", "FindInPath"],
    ["Find Action", "GotoAction"],
  ];
  return (
    <div className="editor-empty">
      <table>
        <tbody>
          {rows.map(([t, id]) => (
            <tr key={id}>
              <td className="lbl">{t}</td>
              <td className="key">{keysFor(id)[0] ? formatKeystroke(keysFor(id)[0]) : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Node({ n }: { n: LayoutNode }) {
  if (n.type === "group") return <EditorGroupView id={n.id} />;
  return (
    <PanelGroup direction={n.dir === "row" ? "horizontal" : "vertical"}>
      {n.children.map((c, i) => {
        const id = c.type === "group" ? c.id : `s${i}`;
        return (
          <Fragment key={id}>
            {i > 0 && <PanelResizeHandle className={"resize " + (n.dir === "row" ? "v" : "h")} />}
            <Panel id={id} order={i} minSize={10}>
              <Node n={c} />
            </Panel>
          </Fragment>
        );
      })}
    </PanelGroup>
  );
}

export default function EditorArea() {
  const { layout } = useStore(editorStore);

  // Reload clean open docs on external change.
  useEffect(() => {
    let un: (() => void) | undefined;
    fs.onChanged((e) => {
      const docs = editorStore.get().docs;
      for (const p of e.paths) {
        const key = locKey({ host: "local", path: p });
        if (docs[key]) reloadIfChanged(key);
      }
    }).then((u) => (un = u));
    return () => un?.();
  }, []);

  return <Node n={layout} />;
}
