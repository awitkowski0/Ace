/**
 * The pack editor (docs/PACKEDITOR.md): the designer half of a pack file's tab. Laid out like a scene editor - the file's
 * structure on the left, the thing itself in the middle (a 3D suit, a screen, a book page), the selected part's properties on
 * the right - over the same text the code pane shows. Every change is an ordinary edit of that text (undoable, visible in
 * the diff), and every change made to the text by any other means shows up here at once.
 */
import { lazy, Suspense, useCallback, useEffect, useRef, type ReactNode } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import type { ViewerProps } from "../../../editor/viewers/ImageViewer";
import { isMod } from "../../../lib/platform";
import { packKind, type PackKind } from "../core/kinds";
import { useTextApi, type TextApi } from "./textApi";
import "./pack.css";

const SuitView = lazy(() => import("./SuitView"));
const AbilityView = lazy(() => import("./AbilityView"));
const HudView = lazy(() => import("./HudView"));
const FlightView = lazy(() => import("./FlightView"));
const GuideView = lazy(() => import("./GuideView"));

export interface ViewProps {
  docKey: string;
  host: string;
  path: string;
  name: string;
  /** live text of the file */
  text: string;
  api: TextApi;
  /** apply a text transform; `live` keeps one undo step open across a drag */
  edit: (fn: (cur: string) => string, live?: boolean) => void;
}

const VIEWS: Record<PackKind, React.ComponentType<ViewProps>> = { suit: SuitView, ability: AbilityView, hud: HudView, flight: FlightView, guide: GuideView };

export default function PackView({ doc, text }: ViewerProps & { text: string; sync: boolean }) {
  const kind = packKind(doc.loc.path);
  const api = useTextApi(doc.key, text);
  const live = useRef(false);
  const edit = useCallback((fn: (cur: string) => string, isLive = false) => {
    if (isLive && !live.current) { api.begin(); live.current = true; }
    api.commit(fn);
    if (!isLive && live.current) { api.end(); live.current = false; }
  }, [api]);
  useEffect(() => () => { if (live.current) api.end(); }, [api]);
  const root = useRef<HTMLDivElement>(null);
  if (!kind) return <div className="vw-empty">Not a pack file</div>;
  const V = VIEWS[kind];
  return (
    <div className="pe-root" ref={root} tabIndex={-1} data-testid="pack-editor" data-kind={kind}
      onKeyDown={(e) => {
        const t = e.target as HTMLElement;
        if (t.closest("input, textarea, select, [contenteditable]")) return;
        if (isMod(e) && e.key.toLowerCase() === "z") { e.preventDefault(); e.stopPropagation(); if (e.shiftKey) api.redo(); else api.undo(); }
      }}>
      <Suspense fallback={<div className="vw-empty">Loading…</div>}>
        <V key={doc.key} docKey={doc.key} host={doc.loc.host} path={doc.loc.path} name={doc.name} text={text} api={api} edit={edit} />
      </Suspense>
    </div>
  );
}

/** Three docks: structure | view | inspector. */
export function Docks({ id, tree, view, inspector, bar }: { id: string; tree: ReactNode; view: ReactNode; inspector: ReactNode; bar?: ReactNode }) {
  return (
    <>
      {bar && <div className="pe-bar">{bar}</div>}
      <PanelGroup direction="horizontal" autoSaveId={`packeditor.${id}`} className="pe-docks">
        <Panel id="tree" order={1} defaultSize={22} minSize={14} maxSize={40} className="pe-dock">
          <div className="pe-dock-h">Scene</div>
          <div className="pe-dock-b">{tree}</div>
        </Panel>
        <PanelResizeHandle className="pe-handle" />
        <Panel id="view" order={2} minSize={30} className="pe-dock pe-center">{view}</Panel>
        <PanelResizeHandle className="pe-handle" />
        <Panel id="insp" order={3} defaultSize={30} minSize={20} maxSize={45} className="pe-dock">
          <div className="pe-dock-h">Inspector</div>
          <div className="pe-dock-b pe-insp" data-testid="pe-inspector">{inspector}</div>
        </Panel>
      </PanelGroup>
    </>
  );
}

export function ParseError({ error }: { error: unknown }) {
  return <div className="pe-perr">The file doesn't parse right now ({String((error as Error)?.message ?? error)}). The designer picks up again once it does.</div>;
}
