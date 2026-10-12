/** Timeline header indicator: the clip has constraints that only exist in the preview ("Live constraints: game won't see this until baked"). */
import { liveConstraintCount } from "../../core";
import { useStudio } from "../state";
import { useStudioSel } from "../timeline/hooks";
import { ensureConsStyles } from "./ConstraintsPanel";
import { constraintsOf, setCons } from "./store";

export function LiveConstraintsChip() {
  ensureConsStyles();
  const api = useStudio();
  const n = useStudioSel((s) => liveConstraintCount(constraintsOf(s)));
  const live = useStudioSel((s) => s.cons.live);
  if (!n || !live) return null;
  return (
    <button
      className="as-livechip" data-testid="as-livechip"
      title={`${n} constraint${n === 1 ? "" : "s"} drive this clip in the preview only. The game reads keyframes, so it won't see them until you bake (Constraints panel > Bake).`}
      onClick={() => setCons(api, { sel: constraintsOf(api.store.get()).find((c) => c.enabled)?.id ?? null })}
    >
      <i />Live constraints<span className="long">: game won't see this until baked</span>
    </button>
  );
}
