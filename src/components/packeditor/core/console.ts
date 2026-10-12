/**
 * An ability's command console (ConsoleLayout.java, built in the ability script with `component.console(...)`) and its
 * radial wheel (`component.wheel(...)`): pages, desktop windows placed as fractions of the screen, the widgets in each
 * window, and the theme. Read from the script with the source span of every value, so the layout editor can move a window or
 * recolour the theme and write exactly that back.
 */
import { applyEdits, callsOn, fnArg, objArg, plain, scanCalls, setProp, strArg, type JsCall, type JsObj } from "./jsdsl";

export const WIDGET_KINDS = ["button", "toggle", "choice", "units", "readout", "map", "draw", "mode", "programRunner"] as const;
export type WidgetKind = (typeof WIDGET_KINDS)[number];

export const THEME_KEYS = ["background", "surface", "surfaceAlt", "border", "borderActive", "text", "textMuted", "accent", "ok", "warn", "danger"] as const;
/** UiTokens.of: the colours a console actually draws with, filling in every token the script leaves out. */
export function themeTokens(t: Record<string, unknown>) {
  const hex = (v: unknown): number | null => (typeof v === "string" && /^#?[0-9a-fA-F]{6}$/.test(v) ? parseInt(v.replace("#", ""), 16) : null);
  const mix = (a: number, b: number, u: number) => {
    const c = (sh: number) => Math.round(((a >> sh) & 255) * (1 - u) + ((b >> sh) & 255) * u);
    return (c(16) << 16) | (c(8) << 8) | c(0);
  };
  const rgb = (k: string, stock: number) => hex(t[k]) ?? stock;
  const background = rgb("background", 0x0e1117);
  const primaryIn = hex(t.primary);
  const tinted = primaryIn !== null;
  const accent = rgb("accent", 0x58a6ff);
  const primary = tinted ? primaryIn! : mix(background, accent, 0.5);
  const surface = hex(t.surface) ?? (tinted ? mix(background, primary, 0.1) : mix(background, 0xffffff, 0.045));
  const surfaceAlt = hex(t.surfaceAlt) ?? (tinted ? mix(surface, primary, 0.3) : mix(surface, 0xffffff, 0.06));
  const border = hex(t.border) ?? (tinted ? mix(background, primary, 0.55) : mix(surfaceAlt, 0xffffff, 0.1));
  const text = rgb("text", 0xd6dbe4);
  const css = (v: number) => "#" + v.toString(16).padStart(6, "0");
  const opacity = Math.max(0.2, Math.min(1, typeof t.opacity === "number" ? t.opacity : 0.85));
  return {
    background: css(background), surface: css(surface), surfaceAlt: css(surfaceAlt), border: css(border),
    borderActive: css(rgb("borderActive", accent)), text: css(text), textMuted: css(hex(t.textMuted) ?? mix(text, surface, 0.5)),
    accent: css(accent), ok: css(rgb("ok", 0x4fd17e)), warn: css(rgb("warn", 0xe6a93a)), danger: css(rgb("danger", 0xe5484d)), primary: css(primary), opacity,
  };
}

export interface ConsoleWidget { id: string; kind: string; props: Record<string, unknown> }
export interface ConsolePage { id: string; props: Record<string, unknown> }
export interface ConsoleWindow {
  id: string;
  /** the page it belongs to; undefined = on every page */
  page?: string;
  props: Record<string, unknown>;
  rect: { x: number; y: number; w: number; h: number };
  widgets: ConsoleWidget[];
}
export interface WheelEntry { id: string; props: Record<string, unknown>; dynamic: boolean }
export interface ConsoleModel {
  props: Record<string, unknown>;
  theme: Record<string, unknown>;
  pages: ConsolePage[];
  windows: ConsoleWindow[];
  wheel?: { props: Record<string, unknown>; entries: WheelEntry[] };
}

interface Found {
  calls: JsCall[];
  console?: JsCall;
  theme?: JsCall;
  pages: Array<{ call: JsCall; windows: JsCall[] }>;
  loose: JsCall[];
  wheel?: JsCall;
}

function find(src: string): Found {
  const calls = scanCalls(src);
  const con = calls.find((c) => c.method === "console" && c.recv);
  const wheel = calls.find((c) => c.method === "wheel" && c.recv);
  const out: Found = { calls, console: con, pages: [], loose: [], wheel };
  if (!con) return out;
  const inner = callsOn(calls, fnArg(con));
  out.theme = inner.find((c) => c.method === "theme");
  for (const p of inner.filter((c) => c.method === "page")) out.pages.push({ call: p, windows: callsOn(calls, fnArg(p)).filter((c) => c.method === "window") });
  out.loose = inner.filter((c) => c.method === "window");
  return out;
}

const props = (c: JsCall | undefined): Record<string, unknown> => ((c && plain(objArg(c))) ?? {}) as Record<string, unknown>;
const n = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);

function windowOf(f: Found, c: JsCall, page?: string): ConsoleWindow {
  const p = props(c);
  return {
    id: strArg(c) ?? "",
    page,
    props: p,
    rect: { x: n(p.x, 0.1), y: n(p.y, 0.1), w: n(p.w, 0.3), h: n(p.h, 0.4) },
    widgets: callsOn(f.calls, fnArg(c)).filter((w) => (WIDGET_KINDS as readonly string[]).includes(w.method)).map((w) => ({ id: strArg(w) ?? "", kind: w.method, props: props(w) })),
  };
}

export function readConsole(src: string): ConsoleModel | null {
  const f = find(src);
  if (!f.console && !f.wheel) return null;
  const model: ConsoleModel = {
    props: props(f.console),
    theme: props(f.theme),
    pages: f.pages.map(({ call }) => ({ id: strArg(call) ?? "", props: props(call) })),
    windows: [...f.pages.flatMap(({ call, windows }) => windows.map((w) => windowOf(f, w, strArg(call)))), ...f.loose.map((w) => windowOf(f, w))],
  };
  if (f.wheel) {
    const entries = callsOn(f.calls, fnArg(f.wheel)).filter((c) => c.method === "entry");
    model.wheel = {
      props: props(f.wheel),
      entries: entries.map((e) => ({ id: strArg(e) ?? (e.args[0]?.t === "other" ? e.args[0].raw : "?"), props: props(e), dynamic: strArg(e) === undefined })),
    };
  }
  return model;
}

/** Where an edit lands: a window, a widget in a window, the theme, the console itself, a page, the wheel or one of its entries. */
export type ConsoleTarget =
  | { t: "window"; id: string }
  | { t: "widget"; window: string; id: string }
  | { t: "theme" }
  | { t: "console" }
  | { t: "page"; id: string }
  | { t: "wheel" }
  | { t: "entry"; id: string };

function targetObj(f: Found, t: ConsoleTarget): { obj?: JsObj; call?: JsCall } {
  const allWindows = [...f.pages.flatMap((p) => p.windows), ...f.loose];
  switch (t.t) {
    case "window": { const c = allWindows.find((w) => strArg(w) === t.id); return { obj: c && objArg(c), call: c }; }
    case "widget": {
      const w = allWindows.find((x) => strArg(x) === t.window);
      const c = w && callsOn(f.calls, fnArg(w)).find((x) => strArg(x) === t.id);
      return { obj: c && objArg(c), call: c };
    }
    case "theme": return { obj: f.theme && objArg(f.theme), call: f.theme };
    case "console": return { obj: f.console && objArg(f.console), call: f.console };
    case "page": { const c = f.pages.find((p) => strArg(p.call) === t.id)?.call; return { obj: c && objArg(c), call: c }; }
    case "wheel": return { obj: f.wheel && objArg(f.wheel), call: f.wheel };
    case "entry": {
      const c = f.wheel && callsOn(f.calls, fnArg(f.wheel)).find((x) => strArg(x) === t.id);
      return { obj: c && objArg(c), call: c };
    }
  }
}

/** Set several keys of one target in one edit pass (a window drag writes x and y together). */
export function setConsoleProps(src: string, t: ConsoleTarget, values: Record<string, unknown>): string {
  let out = src;
  for (const [k, v] of Object.entries(values)) {
    const f = find(out);
    const { obj, call } = targetObj(f, t);
    if (obj) out = applyEdits(out, [setProp(out, obj, k, v)]);
    else if (call && t.t === "theme" && v !== undefined) continue;
    else if (!call && t.t === "theme" && f.console && v !== undefined) {
      // no con.theme(...) yet: add one at the top of the console body
      const fn = fnArg(f.console);
      if (!fn) continue;
      const param = fn.params[0] ?? "con";
      const indent = out.slice(0, fn.body.s).match(/\n([ \t]*)[^\n]*$/)?.[1] ?? "";
      const at = fn.body.s + 1;
      out = out.slice(0, at) + `\n${indent}    ${param}.theme({ ${k}: ${JSON.stringify(v)} });` + out.slice(at);
    }
  }
  return out;
}

/** Window rect clamped to the screen, rounded to 0.005 (what the authored files use). */
export function clampRect(r: { x: number; y: number; w: number; h: number }) {
  const q = (v: number) => Math.round(v * 200) / 200;
  const w = Math.min(1, Math.max(0.05, r.w));
  const h = Math.min(1, Math.max(0.05, r.h));
  return { x: q(Math.min(1 - w, Math.max(0, r.x))), y: q(Math.min(1 - h, Math.max(0, r.y))), w: q(w), h: q(h) };
}
