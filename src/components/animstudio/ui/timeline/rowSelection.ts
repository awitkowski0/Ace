/**
 * "Do I have every keyframe of this bone selected?" (pure, unit-tested in rowSelection.test.ts).
 * The dope sheet shows a calm badge on the row label ("all 9" filled, "3/9" outlined), the Outliner marks the bone in Animate mode,
 * and clicking the badge toggles select-all / select-none for that row.
 */
import type { Animation, ChannelName, KeyRef } from "../../core";
import { hasKey, keyEq, mergeSel, rowKeys, type Row } from "./layout";

export type RowLike = Pick<Row, "kind" | "bone" | "channel">;
export interface RowSel {
  state: "none" | "partial" | "all";
  selected: number;
  total: number;
}

/** Selection state of a bone row (every channel) or a channel row. A row without keys is "none". */
export function rowSelectionState(sel: readonly KeyRef[], anim: Animation | undefined, row: RowLike): RowSel {
  if (!anim) return { state: "none", selected: 0, total: 0 };
  const refs = rowKeys(anim, { ...row, y: 0, h: 0 });
  let selected = 0;
  for (const r of refs) if (hasKey(sel, r)) selected++;
  return { state: !refs.length || selected === 0 ? "none" : selected === refs.length ? "all" : "partial", selected, total: refs.length };
}
export const boneSelectionState = (sel: readonly KeyRef[], anim: Animation | undefined, bone: string): RowSel =>
  rowSelectionState(sel, anim, { kind: "bone", bone });
export const channelSelectionState = (sel: readonly KeyRef[], anim: Animation | undefined, bone: string, channel: ChannelName): RowSel =>
  rowSelectionState(sel, anim, { kind: "channel", bone, channel });

/** Badge text: "" when nothing is selected, "all 9" when every key is, "3/9" otherwise. */
export function selBadgeText(s: RowSel): string {
  if (s.state === "none") return "";
  return s.state === "all" ? `all ${s.total}` : `${s.selected}/${s.total}`;
}
/** Approximate badge width in px for the 10px label font (so drawing and hit-testing agree without measuring). */
export const selBadgeWidth = (text: string) => Math.round(text.length * 5.4 + 9);

/** Clicking the badge: everything selected -> deselect the row's keys, otherwise select all of them (other rows' keys are kept). */
export function toggleRowKeys(sel: readonly KeyRef[], anim: Animation, row: RowLike): KeyRef[] {
  const refs = rowKeys(anim, { ...row, y: 0, h: 0 });
  if (!refs.length) return [...sel];
  return refs.every((r) => hasKey(sel, r)) ? sel.filter((s) => !refs.some((r) => keyEq(r, s))) : mergeSel(sel, refs);
}

export function selBadgeTip(row: RowLike, s: RowSel): string {
  const what = row.kind === "bone" ? `keyframes of ${row.bone}` : `${row.channel} keyframes of ${row.bone}`;
  if (s.state === "all") return `All ${s.total} ${what} are selected. Click to deselect them.`;
  if (s.state === "partial") return `${s.selected} of ${s.total} ${what} are selected. Click to select all of them.`;
  return "";
}
