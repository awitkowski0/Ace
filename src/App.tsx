import { Fragment, lazy, Suspense, useEffect, useSyncExternalStore } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { useStore } from "./lib/store";
import { initProject, openProject, openRemoteProject, pickAndOpenFolder, projectKey, projectName, projectStore } from "./lib/project";
import { layoutStore } from "./lib/layout";
import { getToolWindow, listToolWindows, subscribeToolWindows } from "./toolwindows/registry";
import { Toolbar } from "./components/shell/Toolbar";
import { StatusBar } from "./components/shell/StatusBar";
import { Stripe } from "./components/shell/Stripe";
import { ToolWindowFrame } from "./components/shell/ToolWindowFrame";
import { DialogHost } from "./components/shell/dialogs";
import { ContextMenuHost } from "./components/shell/contextMenu";
import { PopupHost } from "./components/shell/popups";

const EditorArea = lazy(() => import("./editor/EditorArea"));

function Welcome() {
  const { recent } = useStore(projectStore);
  return (
    <div className="welcome">
      <h1>Atelier</h1>
      <button className="primary" onClick={pickAndOpenFolder}>Open Folder…</button>
      <button onClick={openRemoteProject}>Open Remote Project…</button>
      {recent.length > 0 && <div className="welcome-recent">
        <div className="popup-section">Recent projects</div>
        {recent.map((l) => (
          <div key={l.host + l.path} className="popup-row" onClick={() => openProject(l)}>{projectName(l)}<span className="dim">{l.host}:{l.path}</span></div>
        ))}
      </div>}
    </div>
  );
}

export default function App() {
  const { root, ready } = useStore(projectStore);
  const { active } = useStore(layoutStore);
  useSyncExternalStore(subscribeToolWindows, listToolWindows);
  useEffect(() => { initProject(); }, []);

  const left = active.left ? getToolWindow(active.left) : undefined;
  const right = active.right ? getToolWindow(active.right) : undefined;
  const bottom = active.bottom ? getToolWindow(active.bottom) : undefined;
  const pk = root ? projectKey(root) : "none";

  return (
    <div className="app">
      <Toolbar />
      <div className="body">
        <Stripe which="left" />
        <div className="main">
          {!root ? (
            ready ? <Welcome /> : null
          ) : (
            <PanelGroup direction="horizontal" autoSaveId={`atelier:${pk}:h`} key={pk}>
              {left && (
                <Fragment>
                  <Panel id="left" order={1} defaultSize={20} minSize={10} maxSize={50}><ToolWindowFrame tw={left} root={root} /></Panel>
                  <PanelResizeHandle className="resize v" />
                </Fragment>
              )}
              <Panel id="center" order={2} minSize={20}>
                <PanelGroup direction="vertical" autoSaveId={`atelier:${pk}:v`}>
                  <Panel id="editor" order={1} minSize={15}>
                    <Suspense fallback={null}><EditorArea /></Suspense>
                  </Panel>
                  {bottom && (
                    <Fragment>
                      <PanelResizeHandle className="resize h" />
                      <Panel id="bottom" order={2} defaultSize={30} minSize={10} maxSize={80}><ToolWindowFrame tw={bottom} root={root} /></Panel>
                    </Fragment>
                  )}
                </PanelGroup>
              </Panel>
              {right && (
                <Fragment>
                  <PanelResizeHandle className="resize v" />
                  <Panel id="right" order={3} defaultSize={20} minSize={10} maxSize={50}><ToolWindowFrame tw={right} root={root} /></Panel>
                </Fragment>
              )}
            </PanelGroup>
          )}
        </div>
        <Stripe which="right" />
      </div>
      <StatusBar />
      <PopupHost />
      <DialogHost />
      <ContextMenuHost />
    </div>
  );
}
