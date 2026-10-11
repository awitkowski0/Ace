/** Tiny colour helpers (hex only) + WCAG contrast. Pure: used by the theme builder and its contrast test. */
export const hex6 = (h: string) => h.replace(/^#/, "").slice(0, 6).toLowerCase();
const rgb = (h: string): [number, number, number] => {
  const x = hex6(h);
  return [parseInt(x.slice(0, 2), 16), parseInt(x.slice(2, 4), 16), parseInt(x.slice(4, 6), 16)];
};
const toHex = (c: number[]) => "#" + c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("");

export function luminance(h: string): number {
  const f = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  const [r, g, b] = rgb(h);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
/** WCAG 2.x contrast ratio, 1..21 */
export function contrast(a: string, b: string): number {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
/** mix `a` toward `b` by t (0..1) */
export function mix(a: string, b: string, t: number): string {
  const x = rgb(a), y = rgb(b);
  return toHex(x.map((v, i) => v + (y[i] - v) * t));
}
export const withAlpha = (h: string, a: number) => "#" + hex6(h) + Math.round(a * 255).toString(16).padStart(2, "0");
