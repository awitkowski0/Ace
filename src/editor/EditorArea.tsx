import { Fragment, useEffect } from "react";
import Editor from "@monaco-editor/react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { monaco } from "./monacoSetup";
import {
  activateTab, closeTab, editorStore, installModelBridge, reloadIfChanged, setActiveGroup,
  setCursor, setDirtyFromText, splitActive, type LayoutNode,
} from "./store";
import { registerEditor, setActiveEditorGroup, unregisterEditor } from "./editorRegistry";
import { useStore } from "../lib/store";
import { fs, locKey } from "../lib/ipc";
import { showContextMenu } from "../components/shell/contextMenu";
import { CloseIcon, FileIcon } from "../components/shell/icons";
import { keysFor } from "../actions/keymap";
import { formatKeystroke } from "../actions/keystroke";

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

function EditorGroupView({ id }: { id: string }) {
  const { groups, docs, activeGroup } = useStore(editorStore);
  const g = groups[id];
  useEffect(() => () => { unregisterEditor(id); }, [id]);
  if (!g) return null;
  const doc = g.active ? docs[g.active] : undefined;
  const isActiveGroup = activeGroup === id;

  return (
    <div className={"editor-group" + (isActiveGroup ? " active" : "")} onMouseDown={() => { setActiveGroup(id); setActiveEditorGroup(id); }}>
      {g.tabs.length > 0 && (
        <div className="tabs" onDoubleClick={() => {}}>
          {g.tabs.map((key) => {
            const d = docs[key];
            if (!d) return null;
            return (
              <div
                key={key}
                className={"tab" + (g.active === key ? " active" : "")}
                title={d.loc.path}
                onMouseDown={(e) => {
                  if (e.button === 1) { e.preventDefault(); closeTab(id, key); }
                  else if (e.button === 0) activateTab(id, key);
                }}
                onContextMenu={(e) =>
                  showContextMenu(e.clientX, e.clientY, [
                    { label: "Close", run: () => closeTab(id, key) },
                    { label: "Close Others", run: () => g.tabs.filter((t) => t !== key).forEach((t) => closeTab(id, t)) },
                    { separator: true, label: "" },
                    { label: "Split Right", run: () => { activateTab(id, key); splitActive("right"); } },
                    { label: "Split Down", run: () => { activateTab(id, key); splitActive("down"); } },
                  ])
                }
              >
                <span className="tab-icon"><FileIcon /></span>
                <span className="tab-name">{d.name}</span>
                <span
                  className={"tab-close" + (d.dirty ? " dirty" : "")}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => { e.stopPropagation(); closeTab(id, key); }}
                >
                  {d.dirty ? <span className="dirty-dot" /> : null}
                  <span className="x"><CloseIcon /></span>
                </span>
              </div>
            );
          })}
        </div>
      )}
      <div className="editor-body">
        {doc?.error ? (
          <div className="editor-empty">{doc.error}</div>
        ) : doc ? (
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
              registerEditor(id, ed);
              ed.onDidFocusEditorText(() => { setActiveGroup(id); setActiveEditorGroup(id); const p = ed.getPosition(); if (p) setCursor(p.lineNumber, p.column); });
              ed.onDidChangeCursorPosition((e) => editorStore.get().activeGroup === id && setCursor(e.position.lineNumber, e.position.column));
              setActiveEditorGroup(editorStore.get().activeGroup);
              if (editorStore.get().activeGroup === id) ed.focus();
            }}
            options={{
              fontFamily: '"JetBrains Mono", Menlo, monospace',
              fontSize: 13,
              lineHeight: 20,
              fontLigatures: true,
              minimap: { enabled: false },
              automaticLayout: true,
              scrollBeyondLastLine: true,
              renderLineHighlight: "all",
              smoothScrolling: false,
              cursorSmoothCaretAnimation: "off",
              multiCursorModifier: "alt",
              padding: { top: 4 },
              guides: { indentation: true },
              contextmenu: true,
              "semanticHighlighting.enabled": true,
            }}
          />
        ) : (
          <EmptyState />
        )}
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
