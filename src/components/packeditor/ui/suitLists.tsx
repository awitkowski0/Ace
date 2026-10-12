/**
 * The lists a suit carries, as the Suit Designer edits them: its abilities (with an "Add ability" picker over every ability the
 * project has), its stats and scales (a min/max table with a range bar), and the chips for the values a suit can take. Each
 * action reports one text transform through `edit`, so it is one undo step.
 */
import { Fragment, useState } from "react";
import { defaultKeybind, filterAbilities, type AbilityEntry, type Catalog } from "../core/catalog";
import type { AttributeRow, StatRow, SuitAbility } from "../core/suit";
import { listAdd, listMove, listRemove, listSet } from "../core/suit";
import "./suitLists.css";

export type Edit = (fn: (cur: string) => string, live?: boolean) => void;

// ---------------------------------------------------------------- abilities

export function AbilityList({ abilities, catalog, selected, edit, onSelect }: {
  abilities: SuitAbility[];
  /** null until the project's files are read: nothing is flagged as missing yet */
  catalog: Catalog | null;
  /** the selected ability's index, or null */
  selected: number | null;
  edit: Edit;
  /** a row was clicked (index), or the selection moved with a row (after a move or a removal); null: none */
  onSelect: (index: number | null) => void;
}) {
  const known = new Map((catalog?.abilities ?? []).map((a) => [a.id, a]));
  const keybinds = catalog?.keybinds ?? [];
  const onSuit = new Set(abilities.map((a) => a.id));
  const add = (id: string) => {
    const kb = defaultKeybind(catalog ?? emptyCatalog(), id);
    edit((cur) => listAdd(cur, "abilities", { identifier: id, keybind: kb }));
  };
  // the selection follows the row it was on
  const move = (i: number, to: number) => {
    edit((cur) => listMove(cur, "abilities", i, to));
    if (selected === null) return;
    onSelect(selected === i ? to : selected > i && selected <= to ? selected - 1 : selected < i && selected >= to ? selected + 1 : selected);
  };
  const remove = (i: number) => {
    edit((cur) => listRemove(cur, "abilities", i));
    if (selected === null || selected === i) onSelect(null);
    else if (selected > i) onSelect(selected - 1);
  };
  return (
    <div className="pe-lst" data-testid="pe-ab-list">
      {abilities.length === 0 && <div className="pe-note">This suit has no abilities yet.</div>}
      {abilities.map((a, i) => {
        const entry = known.get(a.id);
        const missing = catalog !== null && !entry;
        const options = a.keybind && !keybinds.includes(a.keybind) ? [a.keybind, ...keybinds] : keybinds;
        return (
          <div key={`${i}:${a.id}`} className={"pe-lrow" + (selected === i ? " sel" : "") + (a.remove ? " dim" : "")} data-testid="pe-ab-row" data-ab={i} onClick={() => onSelect(i)}>
            <div className="pe-lrow-main">
              <div className="pe-lrow-id">
                <span className="mono">{a.id}</span>
                {missing && <span className="pe-warn" title="No ability script with this id in the project">not in project</span>}
                {a.remove && <span className="pe-tag">removes parent's</span>}
              </div>
              <div className="pe-lrow-sub">{[entry?.folder, entry?.description].filter(Boolean).join(" · ") || (missing ? "" : " ")}</div>
            </div>
            <select className="pe-in sel pe-lrow-kb" data-testid="pe-ab-kb" value={a.keybind ?? ""} title="Keybind"
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => edit((cur) => listSet(cur, "abilities", i, "keybind", e.target.value || undefined))}>
              {a.keybind === undefined && <option value="">(none)</option>}
              {options.map((k) => <option key={k} value={k}>{k.replace("key.thematic.", "")}</option>)}
            </select>
            <div className="pe-lrow-btns" onClick={(e) => e.stopPropagation()}>
              <button className="pe-ib" title="Move up" aria-label="Move up" data-testid="pe-ab-up" disabled={i === 0} onClick={() => move(i, i - 1)}>▴</button>
              <button className="pe-ib" title="Move down" aria-label="Move down" data-testid="pe-ab-down" disabled={i === abilities.length - 1} onClick={() => move(i, i + 1)}>▾</button>
              <button className="pe-ib danger" title="Remove from suit" aria-label="Remove" data-testid="pe-ab-remove" onClick={() => remove(i)}>×</button>
            </div>
          </div>
        );
      })}
      <AbilityPicker catalog={catalog} taken={onSuit} onPick={add} />
    </div>
  );
}

function emptyCatalog(): Catalog {
  return { ns: "thematic", abilities: [], abilityKeybinds: {}, keybinds: [], keybindCount: {}, stats: {}, attributeIds: {}, fightingTypes: [], flightTypes: [], jetGroups: [], tags: [], types: [], flightProfiles: [], suits: [] };
}

/** "Add ability…": a search over every ability id of the project; an id that isn't there can still be added, flagged. */
export function AbilityPicker({ catalog, taken, onPick }: { catalog: Catalog | null; taken: Set<string>; onPick: (id: string) => void }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const all: AbilityEntry[] = catalog?.abilities ?? [];
  const typed = q.trim();
  const results = filterAbilities(all, typed);
  const exact = all.some((a) => a.id === typed);
  const pick = (id: string) => { onPick(id); setQ(""); };
  return (
    <div className="pe-picker" data-testid="pe-ab-picker">
      <input className="pe-in pe-picker-in" data-testid="pe-ab-add" placeholder="Add ability…" value={q}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onKeyDown={(e) => {
          if (e.key === "Escape") { setQ(""); (e.target as HTMLInputElement).blur(); }
          else if (e.key === "Enter") {
            const first = results.find((a) => !taken.has(a.id));
            if (first) pick(first.id);
            else if (typed && !exact && !taken.has(typed)) pick(typed);
          }
        }} />
      {open && (
        <div className="pe-pick-list" data-testid="pe-ab-results" onMouseDown={(e) => e.preventDefault()}>
          {results.map((a) => (
            <button key={a.id} className="pe-pick-row" data-id={a.id} disabled={taken.has(a.id)} onClick={() => pick(a.id)}>
              <span className="mono pe-pick-id">{a.id}</span>
              <span className="pe-pick-folder">{a.folder || "abilities"}</span>
              {a.description && <span className="pe-pick-desc">{a.description}</span>}
              {taken.has(a.id) && <span className="pe-pick-on">on this suit</span>}
            </button>
          ))}
          {typed && !exact && !taken.has(typed) && (
            <button className="pe-pick-row warn" data-testid="pe-ab-add-typed" onClick={() => pick(typed)}>
              <span className="mono pe-pick-id">{typed}</span>
              <span className="pe-pick-desc">Add anyway: no ability script with this id in the project</span>
            </button>
          )}
          {results.length === 0 && !typed && <div className="pe-note">No abilities in this project.</div>}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- stats

const NUM_RANGE = 100;

/** A number in a table cell: committed on Enter or blur, Escape reverts. */
function Cell({ value, onCommit, step = 1, testId, title, className }: { value: number | undefined; onCommit: (v: number) => void; step?: number; testId?: string; title?: string; className?: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft !== null && draft.trim() !== "" && Number.isFinite(Number(draft)) && Number(draft) !== value) onCommit(Number(draft));
    setDraft(null);
  };
  return (
    <input className={"pe-in num pe-cell " + (className ?? "")} data-testid={testId} title={title}
      value={draft ?? (value === undefined ? "" : String(value))}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        else if (e.key === "Escape") { setDraft(null); (e.target as HTMLInputElement).blur(); }
        else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          const base = value ?? 0;
          const k = (e.key === "ArrowUp" ? 1 : -1) * step * (e.shiftKey ? 10 : 1);
          onCommit(Math.round((base + k) * 1000) / 1000);
        }
      }} />
  );
}

export function StatTable({ rows, catalog, edit, title = "Stats" }: { rows: StatRow[]; catalog: Catalog | null; edit: Edit; title?: string }) {
  const scale = Math.max(NUM_RANGE, ...rows.map((r) => r.maximum ?? 0));
  const present = new Set(rows.map((r) => r.identifier));
  const offer = Object.keys(catalog?.stats ?? {}).filter((s) => !present.has(s));
  return (
    <div className="pe-lst" data-testid="pe-stat-table">
      <div className="pe-tbl-head" aria-hidden><span>{title}</span><span className="r">min</span><span className="r">max</span><span /></div>
      {rows.length === 0 && <div className="pe-note">No stats set on this suit.</div>}
      {rows.map((r) => {
        const bad = r.minimum !== undefined && r.maximum !== undefined && r.minimum > r.maximum;
        const lo = Math.max(0, Math.min(100, ((r.minimum ?? 0) / scale) * 100));
        const hi = Math.max(lo, Math.min(100, ((r.maximum ?? 0) / scale) * 100));
        return (
          <div key={`${r.index}:${r.identifier}`} className={"pe-srow" + (bad ? " bad" : "")} data-testid="pe-stat-row" data-stat={r.index}>
            <div className="pe-srow-id">
              <div className="mono pe-srow-name" title={r.identifier}>{r.identifier.replace(/^thematic:/, "")}</div>
              <div className="pe-range" title={bad ? "Minimum is above maximum" : `${r.minimum ?? "-"} to ${r.maximum ?? "-"} of ${scale}`}>
                <span className="pe-range-fill" style={{ left: `${lo}%`, width: `${Math.max(0.5, hi - lo)}%` }} />
              </div>
            </div>
            <Cell value={r.minimum} testId="pe-stat-min" title="Minimum" onCommit={(v) => edit((cur) => listSet(cur, "stats", r.index, "minimum", v))} />
            <Cell value={r.maximum} testId="pe-stat-max" title="Maximum" onCommit={(v) => edit((cur) => listSet(cur, "stats", r.index, "maximum", v))} />
            <button className="pe-ib danger" title="Remove stat" aria-label="Remove stat" data-testid="pe-stat-remove" onClick={() => edit((cur) => listRemove(cur, "stats", r.index))}>×</button>
          </div>
        );
      })}
      <select className="pe-in sel pe-add-sel" data-testid="pe-stat-add" value="" onChange={(e) => {
        const id = e.target.value;
        if (id) edit((cur) => listAdd(cur, "stats", { identifier: id, minimum: 0, maximum: 100 }));
      }}>
        <option value="">Add stat…</option>
        {offer.map((s) => <option key={s} value={s}>{s.replace(/^thematic:/, "")}</option>)}
      </select>
      {rows.some((r) => r.minimum !== undefined && r.maximum !== undefined && r.minimum > r.maximum) && (
        <div className="pe-note warn">A stat with its minimum above its maximum is marked red.</div>
      )}
    </div>
  );
}

export function AttributeTable({ rows, catalog, edit }: { rows: AttributeRow[]; catalog: Catalog | null; edit: Edit }) {
  const present = new Set(rows.map((r) => r.identifier));
  const offer = Object.keys(catalog?.attributeIds ?? {}).filter((s) => !present.has(s));
  return (
    <div className="pe-lst" data-testid="pe-attr-table">
      {rows.length === 0 && <div className="pe-note">No scales. Pehkui sizes and multipliers go here.</div>}
      {rows.map((r) => (
        <div key={`${r.index}:${r.identifier}`} className="pe-srow attr" data-testid="pe-attr-row" data-attr={r.index}>
          <div className="pe-srow-id"><div className="mono pe-srow-name" title={r.identifier}>{r.identifier}</div></div>
          <Cell value={r.effect} step={0.05} testId="pe-attr-effect" title="Effect" onCommit={(v) => edit((cur) => listSet(cur, "attributes", r.index, "effect", v))} />
          <span />
          <button className="pe-ib danger" title="Remove" aria-label="Remove attribute" data-testid="pe-attr-remove" onClick={() => edit((cur) => listRemove(cur, "attributes", r.index))}>×</button>
        </div>
      ))}
      <select className="pe-in sel pe-add-sel" data-testid="pe-attr-add" value="" onChange={(e) => {
        const id = e.target.value;
        if (id) edit((cur) => listAdd(cur, "attributes", { identifier: id, effect: 1 }));
      }}>
        <option value="">Add scale…</option>
        {offer.map((s) => <option key={s} value={s}>{s}</option>)}
      </select>
    </div>
  );
}

// ---------------------------------------------------------------- chips

/** Pick any of `options` (the values seen in the project, plus the ones this suit has); a chip is on when the suit has it. */
export function ChipSelect({ label, options, value, onChange, testId, doc }: { label: string; options: string[]; value: string[]; onChange: (next: string[]) => void; testId?: string; doc?: string }) {
  const all = [...new Set([...options, ...value])];
  return (
    <div className="pe-row" data-testid={testId}>
      <div className="pe-row-l" title={doc}>{label}</div>
      <div className="pe-row-r pe-chips">
        {all.length === 0 && <span className="pe-note">none yet</span>}
        {all.map((o) => {
          const on = value.includes(o);
          return (
            <button key={o} className={"pe-chip" + (on ? " on" : "")} aria-pressed={on} onClick={() => onChange(on ? value.filter((x) => x !== o) : [...value, o])}>{o}</button>
          );
        })}
      </div>
    </div>
  );
}

/** Keys the designer doesn't edit: shown as they are in the file, read-only. */
export function ReadOnlyFields({ fields }: { fields: Array<[string, unknown]> }) {
  if (fields.length === 0) return null;
  return (
    <div className="pe-kv pe-ro" data-testid="pe-readonly">
      {fields.map(([k, v]) => {
        const text = JSON.stringify(v);
        return (
          <Fragment key={k}>
            <span title="Read-only here: edit the file to change it">{k}</span>
            <b className="mono" title={text}>{text.length > 60 ? text.slice(0, 57) + "…" : text}</b>
          </Fragment>
        );
      })}
    </div>
  );
}
