/** UI state of the limb-link (constraint) feature, kept in `StudioState.cons` (docs/ANIMSTUDIO.md "Limb links"). */
import type { ConstraintMap, Drive, PointRef } from "../../core";

export interface PickState {
  kind: "link" | "pin";
  /** which point the next viewport click sets */
  stage: "a" | "b";
  /** first point of a link, once picked */
  a?: PointRef;
  drive: Drive;
}
export interface ConsUi {
  /** .animation.json / .geo.json: constraints per animation name (Ace app data). .bbmodel: not used, the doc is the source. */
  byAnim: ConstraintMap;
  loaded: boolean;
  /** evaluate constraints in the viewport (preview only; nothing is written to the clip) */
  live: boolean;
  /** gizmo edits also key the constrained bones (otherwise only the bone you dragged is keyed) */
  keyConstrained: boolean;
  /** contact dots in the viewport */
  showPoints: boolean;
  pick: PickState | null;
  sel: string | null;
}
export const initialCons = (): ConsUi => ({ byAnim: {}, loaded: false, live: true, keyConstrained: false, showPoints: true, pick: null, sel: null });
