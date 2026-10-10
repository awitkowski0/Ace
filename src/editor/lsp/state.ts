/** Shared LSP UI state (no monaco imports so it can load eagerly). */
import { createStore } from "../../lib/store";
import type { LspLocation, Rng } from "./client";

export interface Diag {
  uri: string;
  range: Rng;
  severity: 1 | 2 | 3 | 4;
  message: string;
  source?: string;
  code?: string | number;
}
export const diagStore = createStore<{ byUri: Record<string, Diag[]>; rev: number }>({ byUri: {}, rev: 0 });

export type ServerState = "idle" | "starting" | "ready" | "waiting" | "unavailable" | "error";
export interface ServerStatus { state: ServerState; hint?: string; progress?: string }
export const statusStore = createStore<{ servers: Record<string, ServerStatus>; note?: string }>({ servers: {} });
export const setServerStatus = (id: string, s: ServerStatus) =>
  statusStore.set((st) => ({ servers: { ...st.servers, [id]: s } }));

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
