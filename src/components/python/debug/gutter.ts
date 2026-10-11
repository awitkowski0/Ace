/**
 * Editor gutter for Python: breakpoint dots (right glyph lane), run markers (left glyph lane), toggling by clicking the glyph
 * margin / line numbers, the breakpoint context menu and breakpoints that follow edits.
 */
import type { editor, IRange } from "monaco-editor";
import { activeEditor } from "../../../editor/editorRegistry";
import { projectStore } from "../../../lib/project";
import type { Location } from "../../../lib/ipc";
import { showContextMenu } from "../../shell/contextMenu";
import { watchEditors } from "../glyph";
import { getRunMarkers, isDebugLanguage, type RunMarker } from "../../run/hooks";
import { pyStore } from "../interpreter";
import { bpStore, bpsAt, bpsIn, loadBreakpoints, removeBreakpoint, setBreakpointLines, toggleBreakpoint, updateBreakpoint, type Bp } from "./bps";
import { debugStore } from "./session";

// Monaco enum values (not imported so this module stays free of the monaco runtime)
const GLYPH_LEFT = 1, GLYPH_RIGHT = 3;
const T_GLYPH = 2, T_LINE_NUMBERS = 3;
const STICK_NEVER_GROWS = 1;

/** Location of a model (file:// = local, ssh://host/... = remote). */
export function modelLoc(m: editor.ITextModel): Location {
  return m.uri.scheme === "ssh" ? { host: m.uri.authority, path: m.uri.path } : { host: "local", path: m.uri.path };
}
/** Python files (and files of other debuggable languages, e.g. GDScript) of the project's host. */
export function acceptModel(m: editor.ITextModel): boolean {
  const lang = m.getLanguageId();
  if (lang !== "python" && !isDebugLanguage(lang)) return false;
  const host = projectStore.get().root?.host ?? "local";
  return (m.uri.scheme === "file" || m.uri.scheme === "ssh") && modelLoc(m).host === host;
}

interface View {
  ed: editor.IStandaloneCodeEditor;
  model: editor.ITextModel;
  path: string;
  bp: editor.IEditorDecorationsCollection;
  run: editor.IEditorDecorationsCollection;
  /** breakpoint id per decoration index (same order as the set() call) */
  ids: string[];
  markers: Map<number, RunMarker>;
  render(): void;
  rerunMarkers(): void;
}
const views = new Set<View>();
/** QA only: replaces the run-marker provider for the gutter without touching the Run module's own provider. */
let markerOverride: ((m: { getValue(): string; uri: { path: string } }) => RunMarker[]) | null = null;
export function qaSetRunMarkers(f: typeof markerOverride) {
  markerOverride = f;
  for (const v of views) v.render();
  // re-render the markers of every view
  for (const v of views) v.rerunMarkers();
}

function bpClass(b: Bp, muted: boolean, verified: boolean | undefined): string {
  const kind = b.logMessage?.trim() ? "dbg-bp-log" : b.condition?.trim() || b.hitCount?.trim() ? "dbg-bp-cond" : "dbg-bp-line";
  return `dbg-bp ${kind}${!b.enabled ? " dbg-bp-off" : muted ? " dbg-bp-muted" : verified === false ? " dbg-bp-invalid" : ""}`;
}
function bpTitle(b: Bp): string {
  const bits = ["Line breakpoint"];
  if (b.condition?.trim()) bits.push(`Condition: ${b.condition.trim()}`);
  if (b.logMessage?.trim()) bits.push(`Log: ${b.logMessage.trim()}`);
  if (b.hitCount?.trim()) bits.push(`Pass count: ${b.hitCount.trim()}`);
  if (!b.enabled) bits.push("(disabled)");
  return bits.join("\n");
}

function sessionVerified(id: string): boolean | undefined {
  for (const s of debugStore.get().sessions) { const v = s.state.bpStatus[id]; if (v && s.live) return v.verified; }
  return undefined;
}

export function installGutter(): () => void {
  void loadBreakpoints();
  const off = watchEditors((ed, model) => {
    const path = modelLoc(model).path;
    const v: View = {
      ed, model, path, ids: [], markers: new Map(), rerunMarkers: () => {},
      bp: ed.createDecorationsCollection(), run: ed.createDecorationsCollection(),
      render() {
        const max = model.getLineCount();
        const { list, muted } = bpStore.get();
        const mine = list.filter((b) => b.path === path);
        v.ids = mine.map((b) => b.id);
        v.bp.set(mine.map((b) => {
          const line = Math.min(Math.max(1, b.line), max);
          return {
            range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 },
            options: {
              isWholeLine: true,
              className: b.enabled && !muted ? "dbg-bp-linebg" : undefined,
              glyphMargin: { position: GLYPH_RIGHT },
              zIndex: 10,
              glyphMarginClassName: bpClass(b, muted, sessionVerified(b.id)),
              glyphMarginHoverMessage: { value: bpTitle(b).replace(/\n/g, "  \n") },
              stickiness: STICK_NEVER_GROWS,
            },
          };
        }));
      },
    };
    const renderRun = () => {
      let ms: RunMarker[] = [];
      try { ms = pyStore.get().active ? (markerOverride ?? getRunMarkers)(model) : []; } catch { ms = []; }
      v.markers = new Map(ms.map((m) => [m.line, m]));
      const decos: editor.IModelDeltaDecoration[] = ms.filter((m) => m.line >= 1 && m.line <= model.getLineCount()).map((m) => ({
        range: { startLineNumber: m.line, startColumn: 1, endLineNumber: m.line, endColumn: 1 } as IRange,
        options: { glyphMargin: { position: GLYPH_LEFT }, glyphMarginClassName: `dbg-run dbg-run-${m.kind}`, glyphMarginHoverMessage: { value: m.label }, stickiness: STICK_NEVER_GROWS },
      }));
      // a file with run markers always keeps both lanes (marker | breakpoint), so a marker line can still take a breakpoint click
      if (decos.length) decos.push({ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }, options: { glyphMargin: { position: GLYPH_RIGHT, persistLane: true }, glyphMarginClassName: "dbg-lane-spacer", stickiness: STICK_NEVER_GROWS } });
      v.run.set(decos);
    };
    v.rerunMarkers = renderRun;
    views.add(v);
    v.render();
    renderRun();

    let tRun: ReturnType<typeof setTimeout> | undefined;
    let tSync: ReturnType<typeof setTimeout> | undefined;
    const sub = [
      model.onDidChangeContent(() => {
        clearTimeout(tRun);
        tRun = setTimeout(renderRun, 300);
        clearTimeout(tSync);
        tSync = setTimeout(() => syncLines(v), 350);
      }),
      ed.onMouseDown((e) => onMouseDown(v, e)),
    ];
    const unBp = bpStore.subscribe(() => v.render());
    const unSess = debugStore.subscribe(() => v.render());
    const unPy = pyStore.subscribe(() => { if (!v.markers.size) renderRun(); });
    const dom = ed.getDomNode();
    const onCtx = (ev: MouseEvent) => onContextMenu(v, ev);
    dom?.addEventListener("contextmenu", onCtx, true);
    return () => {
      clearTimeout(tRun); clearTimeout(tSync);
      sub.forEach((s) => s.dispose());
      unBp(); unSess(); unPy();
      dom?.removeEventListener("contextmenu", onCtx, true);
      v.bp.clear(); v.run.clear();
      views.delete(v);
    };
  }, acceptModel);
  return off;
}

/** Decorations moved with the text: write the lines back to the store (merges breakpoints that ended on one line). */
function syncLines(v: View) {
  const ranges = v.bp.getRanges();
  if (ranges.length !== v.ids.length) return;
  const lines = new Map<string, number>();
  ranges.forEach((r, i) => lines.set(v.ids[i], r.startLineNumber));
  setBreakpointLines(v.path, lines);
}

// ------------------------------------------------------------------ mouse
export function openRunMenu(m: RunMarker, x: number, y: number) {
  showContextMenu(x, y, [
    { label: m.label, run: () => m.run() },
    { label: m.label.replace(/^Run/, "Debug"), run: () => m.debug() },
  ]);
}

/** The shared click logic (real mouse events and the QA hook both end here). */
export function gutterClick(v: { ed: editor.IStandaloneCodeEditor; path: string; markers: Map<number, RunMarker> }, line: number, kind: "glyph" | "lineNumber", lane: number | undefined, x: number, y: number) {
  if (kind === "glyph") {
    const m = v.markers.get(line);
    if (m && lane !== GLYPH_RIGHT) { openRunMenu(m, x, y); return "run-menu"; }
  }
  const added = toggleBreakpoint(v.path, line);
  return added ? "added" : "removed";
}

const laneOf = (t: unknown) => (t as { detail?: { glyphMarginLane?: number } }).detail?.glyphMarginLane;

function onMouseDown(v: View, e: editor.IEditorMouseEvent) {
  if (!e.event.leftButton || e.event.shiftKey || e.event.metaKey || e.event.ctrlKey) return;
  const t = e.target;
  const line = t.position?.lineNumber;
  if (!line) return;
  if (t.type === T_GLYPH) gutterClick(v, line, "glyph", laneOf(t), e.event.posx, e.event.posy);
  else if (t.type === T_LINE_NUMBERS) gutterClick(v, line, "lineNumber", undefined, e.event.posx, e.event.posy);
}

function onContextMenu(v: View, ev: MouseEvent) {
  const t = v.ed.getTargetAtClientPoint(ev.clientX, ev.clientY);
  if (!t || t.type !== T_GLYPH || !t.position) return;
  const line = t.position.lineNumber;
  const here = bpsAt(v.path, line);
  if (!here.length) return;
  ev.preventDefault();
  ev.stopPropagation();
  const b = here[0];
  showContextMenu(ev.clientX, ev.clientY, [
    { label: "Edit Breakpoint…", shortcut: "⇧⌘F8", run: () => void import("./dialogs").then((m) => m.openBreakpointsDialog(b.id)) },
    { label: b.enabled ? "Disable Breakpoint" : "Enable Breakpoint", run: () => updateBreakpoint(b.id, { enabled: !b.enabled }) },
    { separator: true, label: "" },
    { label: "Remove Breakpoint", shortcut: "⌘F8", run: () => removeBreakpoint(b.id) },
  ]);
}

// ------------------------------------------------------------------ actions + hooks
/** ToggleLineBreakpoint on the active editor's caret line. */
export function toggleAtCaret(): boolean {
  const ed = activeEditor();
  const m = ed?.getModel();
  const p = ed?.getPosition();
  if (!ed || !m || !p || !acceptModel(m)) return false;
  toggleBreakpoint(modelLoc(m).path, p.lineNumber);
  return true;
}

export function viewFor(path?: string): View | undefined {
  return [...views].find((v) => !path || v.path === path);
}

/** Test hook: what the gutter currently draws, straight from the decoration collections. */
export function gutterInfo() {
  return [...views].map((v) => ({
    path: v.path,
    breakpoints: v.bp.getRanges().map((r) => ({
      line: r.startLineNumber,
      cls: v.model.getLineDecorations(r.startLineNumber).filter((d) => d.options.glyphMarginClassName?.includes("dbg-bp")).map((d) => d.options.glyphMarginClassName).join(" "),
    })),
    runLines: [...v.markers.keys()],
    runClasses: [...v.markers.keys()].map((l) => v.model.getLineDecorations(l).filter((d) => d.options.glyphMarginClassName?.includes("dbg-run")).map((d) => d.options.glyphMarginClassName).join(" ")),
    runMarkers: [...v.markers.values()].map((m) => ({ line: m.line, kind: m.kind, label: m.label })),
    bpInStore: bpsIn(v.path).map((b) => b.line),
  }));
}

/** Test hook: click the gutter at `line` exactly like the mouse handler does (through the editor's real hit-testing). */
export function qaGutterClick(line: number, where: "glyph" | "lineNumber" = "glyph", lane?: "left" | "right", path?: string) {
  const v = viewFor(path) ?? [...views][0];
  if (!v) throw new Error("no python editor");
  const info = v.ed.getLayoutInfo();
  const top = v.ed.getTopForLineNumber(line) - v.ed.getScrollTop();
  const box = v.ed.getDomNode()!.getBoundingClientRect();
  const y = box.top + top + 8;
  const gl = info.glyphMarginLeft, gw = info.glyphMarginWidth;
  const x = box.left + (where === "glyph" ? gl + (lane === "left" ? gw * 0.25 : lane === "right" ? gw * 0.75 : gw / 2) : info.lineNumbersLeft + info.lineNumbersWidth / 2);
  const t = v.ed.getTargetAtClientPoint(x, y);
  if (!t || !t.position) throw new Error(`no target at ${x},${y}`);
  const type = t.type;
  if (where === "glyph" ? type !== T_GLYPH : type !== T_LINE_NUMBERS) throw new Error(`hit-test gave target type ${type} for ${where}`);
  return gutterClick(v, t.position.lineNumber, where, laneOf(t), x, y);
}
