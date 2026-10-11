/** Debugger operations shared by the actions, the Debug window buttons and the QA hooks (so a test drives the same code a key does). */
import { activeEditor } from "../../../editor/editorRegistry";
import { showContextMenu } from "../../shell/contextMenu";
import { showToolWindow } from "../../../lib/layout";
import { addWatch, bpStore, setMuted } from "./bps";
import { acceptModel, modelLoc } from "./gutter";
import { closeSession, rerunSession, stopAllSessions } from "./launch";
import { activeSession, debugStore, liveSessions, pausedSession, type DebugSession } from "./session";

export const isPaused = () => !!pausedSession();
export const hasLive = () => liveSessions().length > 0;

/** The session an operation applies to: the paused one, else the active one. */
const target = () => pausedSession() ?? activeSession();

export const ops = {
  resume: () => pausedSession()?.resume(),
  pause: () => { const s = activeSession(); return s && s.status === "running" ? s.pause() : liveSessions().find((x) => x.status === "running")?.pause(); },
  stepOver: () => pausedSession()?.stepOver(),
  stepInto: () => pausedSession()?.stepInto(),
  // debugpy has no per-step "ignore justMyCode": Force Step Into is a plain step into
  forceStepInto: () => pausedSession()?.stepInto(),
  stepOut: () => pausedSession()?.stepOut(),
  async smartStepInto() {
    const s = pausedSession();
    if (!s) return;
    const ts = await s.stepInTargets();
    if (ts.length <= 1) return s.stepInto(ts[0]?.id);
    const box = activeEditor()?.getDomNode()?.getBoundingClientRect();
    showContextMenu((box?.left ?? 200) + 120, (box?.top ?? 120) + 80, ts.map((t) => ({ label: t.label, run: () => void s.stepInto(t.id) })));
  },
  runToCursor(force = false) {
    const s = pausedSession();
    const ed = activeEditor();
    const m = ed?.getModel();
    const p = ed?.getPosition();
    if (!s || !m || !p || !acceptModel(m)) return;
    return s.runToCursor(modelLoc(m).path, p.lineNumber, force);
  },
  showExecutionPoint() { const s = pausedSession(); if (s) s.showFrame(s.frame); },
  stop: () => { const s = activeSession(); return s && s.live ? s.stop() : stopAllSessions(); },
  async rerun(s: DebugSession | null = activeSession()) { if (s) await rerunSession(s); },
  closeSession,
  toggleMute: () => setMuted(!bpStore.get().muted),
  viewBreakpoints: () => void import("./dialogs").then((m) => m.openBreakpointsDialog()),
  evaluateExpression() {
    if (!isPaused()) return;
    const ed = activeEditor();
    const m = ed?.getModel();
    const sel = ed && m ? m.getValueInRange(ed.getSelection()!) : "";
    void import("./dialogs").then((d) => d.openEvaluateDialog(sel.includes("\n") ? "" : sel.trim()));
  },
  addToWatch() {
    const ed = activeEditor();
    const m = ed?.getModel();
    let text = ed && m ? m.getValueInRange(ed.getSelection()!).trim() : "";
    if (!text && ed && m) {
      const p = ed.getPosition();
      const w = p && m.getWordAtPosition(p);
      text = w?.word ?? "";
    }
    if (!text) return;
    addWatch(text);
    showToolWindow("debug");
    void pausedSession()?.refreshWatches();
  },
  select(id: string) { debugStore.set({ activeId: id }); },
};
