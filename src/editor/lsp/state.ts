/** Shared LSP UI state (no monaco imports so it can load eagerly). */
import { createStore } from "../../lib/store";
import type { LspLocation, Rng } from "./client";

/** A quick fix attached to a diagnostic (ruff `fix`): applied as plain text edits. */
export interface DiagFix { title: string; edits: { range: Rng; newText: string }[] }
export interface Diag {
  uri: string;
  range: Rng;
  severity: 1 | 2 | 3 | 4;
  message: string;
  source?: string;
  code?: string | number;
  /** LSP DiagnosticTag values: 1 = unnecessary (faded), 2 = deprecated */
  tags?: number[];
  /** which producer owns it ("lsp" | "ruff"): each has its own marker owner and is replaced independently */
  owner?: string;
  fix?: DiagFix;
}
export const diagStore = createStore<{ byUri: Record<string, Diag[]>; rev: number }>({ byUri: {}, rev: 0 });

/** Per-producer diagnostics (the LSP server and ruff must not clobber each other); `diagStore.byUri` is their merge. */
export const DIAG_OWNERS = ["lsp", "ruff"] as const;
const bySource = new Map<string, Map<string, Diag[]>>();
export const getSourceDiags = (owner: string, path: string): Diag[] => bySource.get(owner)?.get(path) ?? [];

/** ruff reports what the type checker already reports (undefined names, syntax errors): hide the duplicate. */
function duplicateOfLsp(d: Diag, lsp: Diag[]): boolean {
  const line = d.range.start.line;
  return lsp.some((l) => l.range.start.line === line && l.severity === 1 && ((d.code === "F821" && l.code === "reportUndefinedVariable") || !d.code));
}
export function mergeDiags(lsp: Diag[], ruff: Diag[]): Diag[] {
  return ruff.length ? [...lsp, ...ruff.filter((d) => !duplicateOfLsp(d, lsp))] : lsp;
}

/** Replace the diagnostics `owner` has for the given paths (an empty list clears the path). */
export function setSourceDiags(owner: string, batch: Record<string, Diag[]>) {
  let m = bySource.get(owner);
  if (!m) bySource.set(owner, (m = new Map()));
  for (const [p, ds] of Object.entries(batch)) { if (ds.length) m.set(p, ds); else m.delete(p); }
  diagStore.set((s) => {
    const byUri = { ...s.byUri };
    for (const p of Object.keys(batch)) {
      const merged = mergeDiags(getSourceDiags("lsp", p), getSourceDiags("ruff", p));
      if (merged.length) byUri[p] = merged; else delete byUri[p];
    }
    return { byUri, rev: s.rev + 1 };
  });
}

export type ServerState = "idle" | "starting" | "ready" | "waiting" | "unavailable" | "error";
export interface ServerStatus { state: ServerState; hint?: string; progress?: string; /** clickable remedy shown in the status bar / Problems window (e.g. "Install basedpyright") */ action?: () => void; actionLabel?: string }
export const statusStore = createStore<{ servers: Record<string, ServerStatus>; note?: string }>({ servers: {} });
export const setServerStatus = (id: string, s: ServerStatus) =>
  statusStore.set((st) => ({ servers: { ...st.servers, [id]: s } }));

/** Headless Godot is SIGSTOPped by the backend while idle (src-tauri/src/lsp/mod.rs, "GodotPause"). */
export const godotPaused = createStore<{ paused: boolean }>({ paused: false });

export interface UsageItem { loc: LspLocation; line: string }
export const usagesStore = createStore<{ title: string; items: UsageItem[]; busy: boolean }>({ title: "", items: [], busy: false });

export const uriToPath = (uri: string) => {
  try { return decodeURIComponent(new URL(uri).pathname); } catch { return uri.replace(/^file:\/\//, ""); }
};
export const pathToUri = (path: string) =>
  "file://" + path.split("/").map((s) => encodeURIComponent(s).replace(/%40/g, "@")).join("/");

const AUTO_KEY = "atelier.lsp.autoGodot";
const readAuto = () => { try { return localStorage.getItem(AUTO_KEY) !== "0"; } catch { return true; } };
/** "Auto-start headless Godot" toggle (default on). */
export const lspSettings = createStore<{ autoGodot: boolean }>({ autoGodot: readAuto() });
export const setAutoGodot = (v: boolean) => {
  lspSettings.set({ autoGodot: v });
  try { localStorage.setItem(AUTO_KEY, v ? "1" : "0"); } catch { /* ignore */ }
};
