/** Canvas drawing + hit-test geometry of the "all keys selected" badge on dope-sheet row labels (see rowSelection.ts). */
import type { Palette } from "./draw";
import { LABEL_W } from "./layout";
import { selBadgeText, selBadgeWidth, type RowSel } from "./rowSelection";

export const BADGE_RIGHT = LABEL_W - 6;
/** badges drawn in the last frame, keyed "bone" or "bone:channel" (QA reads this: the canvas has no DOM) */
export const drawnBadges = new Map<string, string>();

/** x range [x0, x1) of the badge for `s` (undefined when there is none) */
export function badgeSpan(s: RowSel): { x0: number; x1: number; text: string } | undefined {
  const text = selBadgeText(s);
  if (!text) return undefined;
  return { x0: BADGE_RIGHT - selBadgeWidth(text), x1: BADGE_RIGHT, text };
}

/** Filled accent pill = every key of the row is selected; outlined dim pill = some of them. Returns the left edge it used. */
export function drawSelBadge(ctx: CanvasRenderingContext2D, P: Palette, s: RowSel, cy: number, small = false): number {
  const sp = badgeSpan(s);
  if (!sp) return BADGE_RIGHT;
  const h = small ? 12 : 14, w = sp.x1 - sp.x0, y = Math.round(cy - h / 2);
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(sp.x0 + 0.5, y + 0.5, w - 1, h - 1, h / 2);
  if (s.state === "all") {
    ctx.fillStyle = P.accentBg;
    ctx.fill();
    ctx.fillStyle = "#fff";
  } else {
    ctx.strokeStyle = P.faint;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = P.dim;
  }
  ctx.font = `${small ? 9 : 10}px ${P.font}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(sp.text, sp.x0 + w / 2, cy + 0.5);
  ctx.restore();
  return sp.x0;
}
