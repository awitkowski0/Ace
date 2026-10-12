/**
 * The ability view's Timing tab: the press -> phases -> cooldown timeline (centre) and, in the inspector, the ability's
 * ability_defaults row (cooldown, duration, range, damage, amplifier), its tuned keys and each phase's length, every number
 * editable at the place it is written (see core/timing.ts for what each one means and where it is read from).
 */
import { STAT_DOC, STAT_COLS, type LastsFrom, type PhaseInfo, type StatCol, type StatRow, type Step, type Timeline, type TimingCtx, type TuneRow } from "../core/timing";
import { NumberField, Row, Section } from "./widgets";

const base = (p: string) => p.replace(/\\/g, "/").split("/").pop() ?? p;
const stemOf = (p: string) => base(p).replace(/\.csv$/, "");
const fmt = (n: number) => String(Math.round(n * 1000) / 1000);
const sec = (n: number | null) => (n === null ? "?" : `${fmt(n)} s`);

// ---------------------------------------------------------------- the timeline

const FROM_TEXT: Record<LastsFrom, string> = {
  literal: "written in the script", "duration column": "the duration column", tuning: "a tuning row", "shared tuning": "a shared (all) tuning row",
  "suit option": "the suit's option", otherwise: "the tuned() fallback", unset: "no value set", expression: "an expression", "no lasts": "no lasts()",
};

export function TimelineView({ tl, sel, select }: { tl: Timeline; sel: string | null; select: (id: string) => void }) {
  // widths follow the seconds, but no step is thinner than a readable chip; an unknown length is a hatched chip
  const known = tl.steps.filter((s) => s.seconds !== null && s.kind !== "press" && s.kind !== "ready");
  const total = known.reduce((a, s) => a + (s.seconds ?? 0), 0) || 1;
  const w = (s: Step) => (s.kind === "press" || s.kind === "ready" ? 0 : s.seconds === null ? 12 : Math.max(8, (s.seconds / total) * 100));
  const shown = tl.steps.filter((s) => s.kind !== "press");
  const sum = shown.reduce((a, s) => a + w(s), 0) || 1;
  return (
    <div className="pe-stage pe-tl-stage">
      <div className="pe-tl" data-testid="pe-timeline">
        <div className="pe-tl-h">
          <span className="pe-tl-press" data-step="press">press</span>
          <span className="pe-tl-total" data-testid="pe-timeline-total">{tl.total === null ? "total not fixed" : `press to ready again: ${fmt(tl.total)} s`}</span>
        </div>
        <div className="pe-tl-bar">
          {shown.map((s) => (
            <div key={s.kind + s.name} className={"pe-tl-seg " + s.kind + (s.seconds === null ? " open" : "") + (sel === `phase:${s.name}` ? " sel" : "")}
              style={{ flex: `${(w(s) / sum) * 100} 0 0` }} data-step={s.name} data-kind={s.kind} data-seconds={s.seconds === null ? "" : String(s.seconds)} data-start={s.start === null ? "" : String(s.start)}
              onClick={() => s.kind === "phase" && select(`phase:${s.name}`)} title={s.lasts ? `${s.name}: ${FROM_TEXT[s.lasts.from]}` : s.name}>
              <span className="pe-tl-n">{s.name}</span>
              <span className="pe-tl-s">{sec(s.seconds)}</span>
              <span className="pe-tl-t">{s.start === null ? "" : `t=${fmt(s.start)}`}</span>
            </div>
          ))}
        </div>
        {tl.notes.map((n, i) => <div key={i} className="pe-note">{n}</div>)}
        {tl.orphans.length > 0 && <div className="pe-note" data-testid="pe-timeline-orphans">Not reached from the press: {tl.orphans.map((p) => p.name).join(", ")}.</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the inspector

export interface TimingEdits {
  setStat: (row: StatRow, col: StatCol, value: number) => void;
  setTune: (row: TuneRow, value: number) => void;
  setLiteral: (phase: string, value: number) => void;
  addRow: () => void;
}
export interface TimingStatus { via: "buffer" | "disk"; name: string; undo?: () => void }

export function TimingInspector({ name, ctx, stats, timeline, previewId, target, edits, status, sel }: {
  name: string;
  ctx: TimingCtx;
  /** every defaults row found for the ability (the first is the one used) */
  stats: StatRow[];
  timeline: Timeline;
  previewId: string;
  /** the csv "Add timing row" writes to */
  target: string;
  edits: TimingEdits;
  status: TimingStatus | null;
  sel: string | null;
}) {
  const row = stats[0];
  const own = ctx.tune.filter((r) => r.own);
  const shared = ctx.tune.filter((r) => !r.own);
  const phases = timeline.steps.filter((s) => s.kind === "phase");
  const num = (c: StatCol) => (row ? parseNumOrUndef(row.values[c]) : undefined);
  return (
    <>
      <Section title={row ? `Timing row · ${base(row.path)}:${row.line + 1}` : "Timing row"}>
        {!row && (
          <>
            <div className="pe-note" data-testid="pe-timing-norow">
              No row for <span className="mono">{name}</span> in any ability_defaults csv. Without one it gets a default for how its key works (a press: 20 s cooldown, 6 s duration, 8 radius, 6 damage).
            </div>
            <div className="pe-btns"><button className="pe-btn" data-testid="pe-timing-add" onClick={edits.addRow}>Add timing row</button></div>
            <div className="pe-note mono">to {base(target)}</div>
          </>
        )}
        {row && STAT_COLS.filter((c) => c !== "disabled").map((c) => (
          <NumberField key={c} label={c === "range" ? "range (radius)" : c} value={num(c)} step={c === "amplifier" ? 1 : 0.1} doc={STAT_DOC[c] + (c === "cooldown" || c === "duration" ? " Seconds." : "")}
            testId={`pe-timing-${c}`} onChange={(v, l) => { if (!l) edits.setStat(row, c, v); }} onClear={() => edits.setStat(row, c, -1)} placeholder={-1} />
        ))}
        {row && <div className="pe-note">A blank cell or -1 is "not set": the ability's own default applies.{row.values.disabled === "TRUE" && <b> This row turns the ability off.</b>}</div>}
        {stats.length > 1 && <div className="pe-note warn" data-testid="pe-timing-dup">{stats.length} rows name this ability ({stats.map((s) => base(s.path)).join(", ")}); the first is shown and edited.</div>}
      </Section>
      <Section title="Tuned keys">
        {own.length === 0 && shared.length === 0 && <div className="pe-note">No <span className="mono">ability,key,value</span> rows for this ability.</div>}
        {own.map((r) => <TuneField key={r.path + r.line} r={r} previewId={previewId} setTune={edits.setTune} />)}
        {shared.map((r) => <TuneField key={r.path + r.line} r={r} previewId={previewId} setTune={edits.setTune} />)}
        <div className="pe-note">Read by <span className="mono">tuned("key")</span>. The file name only organises the rows (the shipped ones are one file per suit); the lookup is by ability name, and the ability's own row beats an <span className="mono">all</span> one.</div>
      </Section>
      <Section title="Phases">
        {phases.length === 0 && <div className="pe-note">This script declares no phases.</div>}
        {phases.map((s) => <PhaseField key={s.name} s={s} sel={sel === `phase:${s.name}`} ctx={ctx} edits={edits} />)}
      </Section>
      {status && (
        <div className="pe-note" data-testid="pe-timing-status" data-via={status.via}>
          {status.via === "buffer"
            ? <>Edited the open tab {status.name} (unsaved; undo it there with Cmd/Ctrl+Z).</>
            : <>Written to {status.name} on disk (not in the editor's undo history).{status.undo && <> <button className="pe-link" data-testid="pe-timing-undo" onClick={status.undo}>Undo</button></>}</>}
        </div>
      )}
    </>
  );
}

const parseNumOrUndef = (s: string | undefined) => (s === undefined || s.trim() === "" || !Number.isFinite(Number(s)) ? undefined : Number(s));

function TuneField({ r, previewId, setTune }: { r: TuneRow; previewId: string; setTune: (row: TuneRow, value: number) => void }) {
  const stem = stemOf(r.path);
  const mine = previewId !== "" && stem === previewId;
  return (
    <div className="pe-bf" data-testid={`pe-tune-${r.own ? "" : "all-"}${r.key}`}>
      <div className="pe-bf-w">
        <NumberField label={r.own ? r.key : `all · ${r.key}`} value={r.num ?? undefined} step={0.05} doc={`${r.owner},${r.key} in ${base(r.path)}:${r.line + 1}`} onChange={(v, l) => { if (!l) setTune(r, v); }} />
      </div>
      <span className={"pe-layer " + (mine ? "visual" : "default")} title={mine ? "The tuning file named after the preview suit" : "The tuning file this row is in"}>{stem}</span>
    </div>
  );
}

function PhaseField({ s, sel, ctx, edits }: { s: Step; sel: boolean; ctx: TimingCtx; edits: TimingEdits }) {
  const p = s.phase as PhaseInfo;
  const l = s.lasts!;
  const how = p.lasts.kind === "tuned" ? `tuned("${p.lasts.key}"${p.lasts.times !== undefined ? `, ${p.lasts.times}` : ""})` : p.lasts.kind === "duration" ? 'lasts("duration")' : p.lasts.kind === "literal" ? `lasts(${p.lasts.value})` : p.lasts.kind === "other" ? p.lasts.raw : "no lasts()";
  const edit = l.edit;
  const write = (v: number) => {
    if (!edit) return;
    if (edit.kind === "literal") edits.setLiteral(p.name, v);
    else if (edit.kind === "stat") { if (ctx.stat) edits.setStat(ctx.stat, edit.col, v / l.times); }
    else edits.setTune(edit.row, v / l.times);
  };
  return (
    <div className={"pe-phase" + (sel ? " sel" : "")} data-testid={`pe-phase-${p.name}`}>
      {edit && l.seconds !== null
        ? <NumberField label={p.name} value={l.seconds} step={0.1} doc={`line ${p.line}: ${how} - ${FROM_TEXT[l.from]}`} testId={`pe-phase-${p.name}-secs`} onChange={(v, live) => { if (!live) write(v); }} />
        : <Row label={p.name} doc={`line ${p.line}`}><span className="pe-ro">{l.seconds === null ? "not fixed" : sec(l.seconds)}</span></Row>}
      <div className="pe-note mono">{how} · {FROM_TEXT[l.from]}</div>
    </div>
  );
}
