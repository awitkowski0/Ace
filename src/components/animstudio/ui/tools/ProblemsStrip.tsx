import { useMemo, useState } from "react";
import { findKey, getAnimation, playerDrops, type Problem } from "../../core";
import { effectiveSemantics, SEM_MODES, setSemMode } from "../semantics";
import { useStudio } from "../state";
import { toolsStore, useToolsUi } from "../toolsUi";
import { useStudioSel } from "../timeline/hooks";
import { ensureStyles } from "../timeline/styles";

const RANK = { error: 0, warning: 1, info: 2 } as const;

/** Errors first, then warnings, then info; stable by clip then time. */
export function sortProblems(ps: readonly Problem[]): Problem[] {
  return [...ps].sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.anim.localeCompare(b.anim) || (a.time ?? -1) - (b.time ?? -1));
}
export function countProblems(ps: readonly Problem[]) {
  return { error: ps.filter((p) => p.severity === "error").length, warning: ps.filter((p) => p.severity === "warning").length, info: ps.filter((p) => p.severity === "info").length };
}
const loc = (p: Problem) => [p.anim.replace(/^animation\./, ""), p.bone && (p.channel ? `${p.bone}.${p.channel}` : p.bone), p.time !== undefined && `@${p.time.toFixed(2)}s`].filter(Boolean).join(" · ");

/** Jump to a problem: select its clip / bone / key and move the playhead; apply its quick fix. */
function useProblemActions() {
  const api = useStudio();
  const go = (p: Problem) => {
    const s = api.store.get();
    const a = s.doc ? getAnimation(s.doc, p.anim) : undefined;
    const patch: Partial<typeof s> = { anim: p.anim, playing: false };
    if (p.time !== undefined) patch.time = p.time;
    if (p.bone) patch.bones = [p.bone];
    if (a && p.bone && p.channel && p.time !== undefined) {
      const ref = { bone: p.bone, channel: p.channel, time: p.time };
      patch.keys = findKey(a, ref) ? [ref] : [];
    } else patch.keys = [];
    api.store.set(patch);
  };
  const fix = (p: Problem) => {
    const s = api.store.get();
    if (!s.doc || !p.fix) return;
    try {
      api.commit(p.fix.apply(s.doc), p.fix.title);
    } catch (e) {
      console.error("quick-fix failed", e);
    }
  };
  return { go, fix };
}

/** Small status chip in the timeline header. Hidden entirely when there are no problems; click toggles the list below the header. */
export function ProblemsChip() {
  const api = useStudio();
  ensureStyles();
  const ui = useToolsUi(api);
  const problems = useStudioSel((s) => s.problems);
  const cnt = useMemo(() => countProblems(problems), [problems]);
  if (!problems.length) return null;
  return (
    <button className={"as-pchip" + (ui.problemsOpen ? " on" : "")} data-testid="as-problems-chip" title="Problems (click to show / hide the list)" onClick={() => toolsStore(api).set({ problemsOpen: !ui.problemsOpen })}>
      {cnt.error > 0 && <span className="cnt" data-testid="as-prob-errors"><i className="dot error" />{cnt.error}</span>}
      {cnt.warning > 0 && <span className="cnt" data-testid="as-prob-warnings"><i className="dot warning" />{cnt.warning}</span>}
      {cnt.info > 0 && <span className="cnt"><i className="dot info" />{cnt.info}</span>}
    </button>
  );
}

/** The expanded problem list. Renders nothing when closed or when there are no problems. */
export function ProblemsList() {
  const api = useStudio();
  ensureStyles();
  const ui = useToolsUi(api);
  const problems = useStudioSel((s) => s.problems);
  const anim = useStudioSel((s) => s.anim);
  const [onlyCur, setOnlyCur] = useState(false);
  const list = useMemo(() => sortProblems(onlyCur ? problems.filter((p) => p.anim === anim) : problems), [problems, onlyCur, anim]);
  const { go, fix } = useProblemActions();
  if (!ui.problemsOpen || !problems.length) return null;
  return (
    <div className="as-prob" data-testid="as-problems">
      <div className="bar">
        <span className="as-hint">{problems.length} problem{problems.length === 1 ? "" : "s"}</span>
        <span style={{ flex: 1 }} />
        <label className="as-chk"><input type="checkbox" checked={onlyCur} onChange={(e) => setOnlyCur(e.target.checked)} />This animation only</label>
      </div>
      <div className="lst">
        {list.map((p, i) => (
          <div className="it" key={i + p.code + loc(p)} onClick={() => go(p)} data-code={p.code}>
            <i className={"dot " + p.severity} />
            <span className="msg" title={p.message}>{p.message}</span>
            <span className="loc">{loc(p)}</span>
            {p.fix && <button className="fix" onClick={(e) => { e.stopPropagation(); fix(p); }} data-testid="as-prob-fix">{p.fix.title}</button>}
          </div>
        ))}
        {!list.length && <div className="it as-hint">No problems in this animation.</div>}
      </div>
    </div>
  );
}

/** Which clip semantics the preview samples with (Player = Thematic's armor/player serializer, Geo = GeckoLib). Click cycles Auto / Player / Geo. */
export function SemanticsChip() {
  const api = useStudio();
  ensureStyles();
  const kind = useStudioSel((s) => s.doc?.kind);
  const mode = useStudioSel((s) => s.semMode);
  const path = useStudioSel((s) => s.path);
  const doc = useStudioSel((s) => s.doc);
  const name = useStudioSel((s) => s.anim);
  if (kind !== "animation") return null;
  const sem = effectiveSemantics({ path, semMode: mode });
  const drops = sem === "player" && doc && name ? playerDrops(getAnimation(doc, name) ?? ({ bones: new Map() } as never)) : [];
  const how = sem === "player"
    ? "Player clip rules: the earlier key's easing governs the span leaving it, key times floor to whole ticks, scale is not read, easingArgs are ignored, catmullrom rotation is linear."
    : "Geo clip rules (GeckoLib): a key's easing governs the span arriving at it.";
  const lost = drops.length ? `\nThe game ignores: ${drops.slice(0, 6).map((d) => `${d.bone}.${d.channel} (${d.lost})`).join("; ")}${drops.length > 6 ? ` and ${drops.length - 6} more` : ""}` : "";
  const next = SEM_MODES[(SEM_MODES.indexOf(mode) + 1) % SEM_MODES.length];
  return (
    <button className="as-pchip" data-testid="as-semantics-chip" data-semantics={sem} data-mode={mode} title={`${how}${lost}\nSource: ${mode === "auto" ? "decided by the file path" : "forced by you"}. Click for ${next}.`} onClick={() => setSemMode(api, next)}>
      <span>{sem === "player" ? "Player" : "Geo"}{mode === "auto" ? "" : " (set)"}</span>
      {drops.length > 0 && <span className="cnt"><i className="dot warning" />{drops.length}</span>}
    </button>
  );
}
