/** Canvas drawing helpers shared by the dope sheet and the graph editor. */
import type { ChannelName, Keyframe } from "../../core";

export interface Palette {
  bg: string; bgChrome: string; bgHover: string; bgSel: string; border: string; borderStrong: string;
  fg: string; dim: string; faint: string; accent: string; accentBg: string;
  red: string; yellow: string; green: string; cyan: string; blue: string; purple: string; orange: string;
  font: string; mono: string;
}
let cache: { p: Palette; at: number } | null = null;
export function palette(): Palette {
  const now = performance.now();
  if (cache && now - cache.at < 1500) return cache.p;
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string, d: string) => cs.getPropertyValue(n).trim() || d;
  const p: Palette = {
    bg: v("--bg-editor", "#2e3440"), bgChrome: v("--bg-chrome", "#2b303b"), bgHover: v("--bg-hover", "#3b4252"), bgSel: v("--bg-selected", "#434c5e"),
    border: v("--border", "#3b4252"), borderStrong: v("--border-strong", "#232831"),
    fg: v("--fg", "#d8dee9"), dim: v("--fg-dim", "#8b95a8"), faint: v("--fg-faint", "#616e88"), accent: v("--accent", "#88c0d0"), accentBg: v("--accent-bg", "#5e81ac"),
    red: v("--nord11", "#bf616a"), yellow: v("--nord13", "#ebcb8b"), green: v("--nord14", "#a3be8c"), cyan: v("--nord8", "#88c0d0"),
    blue: v("--nord9", "#81a1c1"), purple: v("--nord15", "#b48ead"), orange: v("--nord12", "#d08770"),
    font: v("--font-ui", "Inter, system-ui, sans-serif"), mono: v("--font-mono", "Menlo, monospace"),
  };
  cache = { p, at: now };
  return p;
}

export const channelColor = (p: Palette, ch: ChannelName | undefined): string =>
  ch === "rotation" ? p.orange : ch === "position" ? p.green : ch === "scale" ? p.purple : p.blue;
export const AXIS_NAMES = ["X", "Y", "Z"] as const;
export const axisColor = (p: Palette, a: number): string => (a === 0 ? p.red : a === 1 ? p.green : p.blue);
export const channelLabel = (ch: ChannelName) => ch[0].toUpperCase() + ch.slice(1);

export type KeyShape = "diamond" | "square" | "circle" | "round";
export interface KeyStyle { shape: KeyShape; color: string; split: boolean }
/** Diamond style by easing/lerp: linear = diamond, step = square, catmullrom = circle, ease* = rounded (back/elastic/bounce tinted). */
export function keyStyle(p: Palette, k: Pick<Keyframe, "easing" | "lerp" | "pre">): KeyStyle {
  const e = (k.lerp ?? k.easing ?? "").toLowerCase();
  const split = !!k.pre;
  if (e === "catmullrom") return { shape: "circle", color: p.purple, split };
  if (e === "step") return { shape: "square", color: p.yellow, split };
  if (/back|elastic|bounce/.test(e)) return { shape: "round", color: p.orange, split };
  if (e.startsWith("ease")) return { shape: "round", color: p.green, split };
  return { shape: "diamond", color: p.cyan, split };
}

export function keyPath(ctx: CanvasRenderingContext2D, shape: KeyShape, x: number, y: number, r: number): void {
  ctx.beginPath();
  if (shape === "square") { ctx.rect(x - r * 0.75, y - r * 0.75, r * 1.5, r * 1.5); return; }
  if (shape === "circle") { ctx.arc(x, y, r * 0.85, 0, Math.PI * 2); return; }
  if (shape === "round") {
    const s = r * 0.62;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.PI / 4);
    const c = 2.2;
    ctx.moveTo(-s + c, -s);
    ctx.arcTo(s, -s, s, s, c); ctx.arcTo(s, s, -s, s, c); ctx.arcTo(-s, s, -s, -s, c); ctx.arcTo(-s, -s, s, -s, c);
    ctx.closePath();
    ctx.restore();
    return;
  }
  ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath();
}

export interface KeyDraw { x: number; y: number; style: KeyStyle; selected?: boolean; hover?: boolean; dim?: boolean; ghost?: boolean; r?: number }
export function drawKey(ctx: CanvasRenderingContext2D, p: Palette, k: KeyDraw): void {
  const r = k.r ?? 5.5;
  ctx.save();
  if (k.dim) ctx.globalAlpha = 0.35;
  keyPath(ctx, k.style.shape, k.x, k.y, r);
  if (k.ghost) {
    ctx.globalAlpha = 0.8;
    ctx.setLineDash([2, 2]);
    ctx.strokeStyle = p.accent;
    ctx.lineWidth = 1.2;
    ctx.fillStyle = "rgba(136,192,208,.25)";
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    return;
  }
  ctx.fillStyle = k.selected ? "#ffffff" : k.style.color;
  ctx.fill();
  ctx.lineWidth = k.selected ? 1.4 : 0.8;
  ctx.strokeStyle = k.selected ? p.accentBg : "rgba(20,24,32,.45)";
  ctx.stroke();
  if (k.style.split) {
    // pre/post split: dark left half
    ctx.save();
    keyPath(ctx, k.style.shape, k.x, k.y, r);
    ctx.clip();
    ctx.fillStyle = "rgba(35,40,49,.55)";
    ctx.fillRect(k.x - r, k.y - r, r, r * 2);
    ctx.restore();
  }
  if (k.hover && !k.selected) {
    keyPath(ctx, k.style.shape, k.x, k.y, r + 1.5);
    ctx.strokeStyle = p.accent;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  ctx.restore();
}

/** Size a canvas to its element (HiDPI) and return a 2d context scaled to CSS pixels. */
export function fitCanvas(c: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; w: number; h: number } | null {
  const w = c.clientWidth;
  const h = c.clientHeight;
  if (w < 2 || h < 2) return null;
  const dpr = window.devicePixelRatio || 1;
  const bw = Math.round(w * dpr);
  const bh = Math.round(h * dpr);
  if (c.width !== bw || c.height !== bh) { c.width = bw; c.height = bh; }
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

export function triangle(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, down = true): void {
  ctx.beginPath();
  if (down) { ctx.moveTo(x - w / 2, y); ctx.lineTo(x + w / 2, y); ctx.lineTo(x, y + h); }
  else { ctx.moveTo(x - w / 2, y + h); ctx.lineTo(x + w / 2, y + h); ctx.lineTo(x, y); }
  ctx.closePath();
}
