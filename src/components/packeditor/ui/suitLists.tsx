/**
 * The lists a suit carries, as the Suit Designer edits them: its abilities (with an "Add ability" picker over every ability the
 * project has), its stats and scales (a min/max table with a range bar), and the chips for the values a suit can take. Each
 * action reports one text transform through `edit`, so it is one undo step.
 */
import { Fragment, useState } from "react";
import { defaultKeybind, filterAbilities, type AbilityEntry, type Catalog } from "../core/catalog";
import { abilityNameProblem, defaultFolder, newAbilityId, normalizeAbilityName, normalizeFolder } from "../core/newAbility";
import { packRoot } from "../core/kinds";
import { openFile } from "../../../editor/store";
import { createAbility, awaitingLang } from "./newAbilityData";
import type { AttributeRow, StatRow, SuitAbility } from "../core/suit";
import { listAdd, listMove, listRemove, listSet } from "../core/suit";
import "./suitLists.css";

export type Edit = (fn: (cur: string) => string, live?: boolean) => void;

// ---------------------------------------------------------------- abilities

export function AbilityList({ abilities, catalog, selected, edit, onSelect, create }: {
  abilities: SuitAbility[];
  /** null until the project's files are read: nothing is flagged as missing yet */
  catalog: Catalog | null;
  /** the selected ability's index, or null */
  selected: number | null;
  edit: Edit;
  /** a row was clicked (index), or the selection moved with a row (after a move or a removal); null: none */
  onSelect: (index: number | null) => void;
  /** where a new ability would be made; without it the picker doesn't offer to create one */
  create?: Omit<CreateCtx, "copyId" | "onCreated"> & { refresh: () => void };
}) {
  const known = new Map((catalog?.abilities ?? []).map((a) => [a.id, a]));
  const keybinds = catalog?.keybinds ?? [];
  const onSuit = new Set(abilities.map((a) => a.id));
  const add = (id: string) => {
    const kb = defaultKeybind(catalog ?? emptyCatalog(), id);
    edit((cur) => listAdd(cur, "abilities", { identifier: id, keybind: kb }));
  };
  // a new ability: it goes on the suit (one undo step) with the keybind of the one it copies, and opens in its own tab
  const created = create && ((made: { id: string; path: string; title: string; sourceId: string | null }) => {
    const kb = abilities.find((a) => a.id === made.sourceId)?.keybind ?? defaultKeybind(catalog ?? emptyCatalog(), made.id);
    edit((cur) => listAdd(cur, "abilities", { identifier: made.id, keybind: kb }));
    awaitingLang.set(made.path, { id: made.id, title: made.title, root: packRoot(made.path)!.root });
    create.refresh();
    void openFile({ host: create.host, path: made.path });
  });
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
      <AbilityPicker catalog={catalog} taken={onSuit} onPick={add} create={create && created ? { ...create, copyId: selected !== null ? abilities[selected]?.id : undefined, onCreated: created } : undefined} />
    </div>
  );
}

function emptyCatalog(): Catalog {
  return { ns: "thematic", abilities: [], abilityKeybinds: {}, keybinds: [], keybindCount: {}, stats: {}, attributeIds: {}, fightingTypes: [], flightTypes: [], jetGroups: [], tags: [], types: [], flightProfiles: [], suits: [] };
}

/** What the "Add ability" picker needs to make a new ability in the suit's pack. */
export interface CreateCtx {
  host: string;
  /** the suit file: the new ability goes in its pack */
  path: string;
  ns: string;
  /** the suit's file name without extension (a folder of that name is the default one) */
  suitId: string;
  /** the id of the suit's selected ability, the default thing to copy */
  copyId?: string;
  /** the new ability is on disk (path, id, title) and the catalog should be read again */
  onCreated: (made: { id: string; path: string; title: string; sourceId: string | null }) => void;
}

type PickItem = { kind: "create"; name: string; id: string } | { kind: "ability"; entry: AbilityEntry } | { kind: "typed"; id: string };

/**
 * "Add ability…": a search over every ability id of the project. A name that isn't an id yet offers "Create ability" first (Enter
 * takes it); an id that isn't there can still be added anyway, flagged.
 */
export function AbilityPicker({ catalog, taken, onPick, create }: { catalog: Catalog | null; taken: Set<string>; onPick: (id: string) => void; create?: CreateCtx }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const [making, setMaking] = useState<string | null>(null); // the normalised name being created
  const all: AbilityEntry[] = catalog?.abilities ?? [];
  const typed = q.trim();
  const name = create ? normalizeAbilityName(typed, create.ns) : "";
  const newId = create ? newAbilityId(create.ns, name) : "";
  let results = filterAbilities(all, typed);
  if (results.length === 0 && name && name !== typed) results = filterAbilities(all, name);
  const exact = all.some((a) => a.id === typed);
  const problem = create && catalog && name && !exact ? abilityNameProblem(name, create.ns, all.map((a) => a.id)) : null;
  const canCreate = !!create && !!catalog && !!typed && !exact && !!name && !problem;
  const anyway = !!typed && !exact && !taken.has(typed);
  const items: PickItem[] = [
    ...(canCreate ? [{ kind: "create" as const, name, id: newId }] : []),
    ...results.map((entry) => ({ kind: "ability" as const, entry })),
    ...(anyway ? [{ kind: "typed" as const, id: typed }] : []),
  ];
  const pick = (id: string) => { onPick(id); setQ(""); };
  const run = (it: PickItem | undefined) => {
    if (!it) return;
    if (it.kind === "create") { setMaking(it.name); setOpen(false); }
    else if (it.kind === "ability") { if (!taken.has(it.entry.id)) pick(it.entry.id); }
    else pick(it.id);
  };
  if (making && create && catalog) {
    return <NewAbilityStep ctx={create} catalog={catalog} name={making} onCancel={() => { setMaking(null); }} onCreated={(m) => { setMaking(null); setQ(""); create.onCreated(m); }} />;
  }
  const active = Math.min(hi, Math.max(0, items.length - 1));
  return (
    <div className="pe-picker" data-testid="pe-ab-picker">
      <input className="pe-in pe-picker-in" data-testid="pe-ab-add" placeholder="Add ability…" value={q}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onChange={(e) => { setQ(e.target.value); setOpen(true); setHi(0); }}
        onKeyDown={(e) => {
          if (e.key === "Escape") { setQ(""); (e.target as HTMLInputElement).blur(); }
          else if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setHi(Math.max(0, Math.min(items.length - 1, active + (e.key === "ArrowDown" ? 1 : -1)))); }
          else if (e.key === "Enter") {
            // the highlighted row, but never an ability already on the suit
            run(items[active]?.kind === "ability" && taken.has((items[active] as { entry: AbilityEntry }).entry.id) ? items.find((it) => it.kind !== "ability" || !taken.has(it.entry.id)) : items[active]);
          }
        }} />
      {open && (
        <div className="pe-pick-list" data-testid="pe-ab-results" onMouseDown={(e) => e.preventDefault()}>
          {items.map((it, i) => {
            const cls = (i === active ? " active" : "");
            if (it.kind === "create") return (
              <button key="create" className={"pe-pick-row create" + cls} data-testid="pe-ab-create" data-id={it.id} onClick={() => run(it)}>
                <span className="pe-pick-id">Create ability ‘{typed}’…</span>
                <span className="mono pe-pick-folder">{it.id}</span>
                <span className="pe-pick-desc">A new ability id{it.name !== typed ? `, written ${it.id}` : ""}; you pick which ability to copy next</span>
              </button>
            );
            if (it.kind === "typed") return (
              <button key="typed" className={"pe-pick-row warn" + cls} data-testid="pe-ab-add-typed" onClick={() => run(it)}>
                <span className="mono pe-pick-id">{it.id}</span>
                <span className="pe-pick-desc">Add anyway: no ability script with this id in the project</span>
              </button>
            );
            const a = it.entry;
            return (
              <button key={a.id} className={"pe-pick-row" + cls} data-id={a.id} disabled={taken.has(a.id)} onClick={() => run(it)}>
                <span className="mono pe-pick-id">{a.id}</span>
                <span className="pe-pick-folder">{a.folder || "abilities"}</span>
                {a.description && <span className="pe-pick-desc">{a.description}</span>}
                {taken.has(a.id) && <span className="pe-pick-on">on this suit</span>}
              </button>
            );
          })}
          {problem && typed && <div className="pe-note warn" data-testid="pe-ab-create-problem">{problem}</div>}
          {items.length === 0 && !typed && <div className="pe-note">No abilities in this project.</div>}
        </div>
      )}
    </div>
  );
}

/** The inline step after "Create ability": what to copy, which folder, then Enter / Create. Esc cancels. */
function NewAbilityStep({ ctx, catalog, name, onCancel, onCreated }: {
  ctx: CreateCtx; catalog: Catalog; name: string; onCancel: () => void; onCreated: (m: { id: string; path: string; title: string; sourceId: string | null }) => void;
}) {
  const id = newAbilityId(ctx.ns, name);
  const all = catalog.abilities;
  const start = ctx.copyId && all.some((a) => a.id === ctx.copyId) ? ctx.copyId : undefined;
  const [src, setSrc] = useState<string | "blank" | undefined>(start); // undefined: nothing chosen yet
  const [q, setQ] = useState("");
  const [folder, setFolder] = useState<string | null>(null); // null: follows the choice
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const entry = src && src !== "blank" ? all.find((a) => a.id === src) : undefined;
  const folders = [...new Set(all.filter((a) => a.ns === ctx.ns).map((a) => a.folder).filter(Boolean))].sort();
  const folderValue = folder ?? defaultFolder(entry?.folder, ctx.suitId, folders);
  const clean = normalizeFolder(folderValue);
  const ext = entry?.path.endsWith(".json") ? "json" : "js";
  const shown = filterAbilities(all, q);
  const ready = src !== undefined && !busy;
  const go = async () => {
    if (!ready) { if (src === undefined) setErr("Pick an ability to copy, or Blank."); return; }
    setBusy(true);
    setErr(null);
    try {
      const made = await createAbility(ctx.host, ctx.path, name, clean, entry?.path ?? null);
      onCreated({ id, path: made.path, title: made.title, sourceId: entry?.id ?? null });
    } catch (e) {
      setErr(String((e as Error).message ?? e));
      setBusy(false);
    }
  };
  return (
    <div className="pe-newab" data-testid="pe-newab" onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onCancel(); } }}>
      <div className="pe-newab-h">New ability <b className="mono" data-testid="pe-newab-id">{id}</b></div>
      <div className="pe-newab-l">Copy from</div>
      <input className="pe-in" autoFocus placeholder="Search abilities…" value={q} data-testid="pe-newab-q"
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          const top = q.trim() ? shown[0] : undefined;
          if (top && top.id !== src) setSrc(top.id); else void go();
        }} />
      <div className="pe-newab-list" data-testid="pe-newab-list">
        <button className={"pe-pick-row" + (src === "blank" ? " sel" : "")} data-testid="pe-newab-blank" onClick={() => setSrc("blank")}>
          <span className="pe-pick-id">Blank</span>
          <span className="pe-pick-desc">A minimal script: a cooldown and a press that plays a sound</span>
        </button>
        {shown.map((a) => (
          <button key={a.id} className={"pe-pick-row" + (src === a.id ? " sel" : "")} data-id={a.id} onClick={() => setSrc(a.id)}>
            <span className="mono pe-pick-id">{a.id}</span>
            <span className="pe-pick-folder">{a.folder || "abilities"}</span>
            {a.description && <span className="pe-pick-desc">{a.description}</span>}
          </button>
        ))}
        {shown.length === 0 && <div className="pe-note">No ability matches.</div>}
      </div>
      <label className="pe-newab-f">Folder
        <input className="pe-in mono" list="pe-newab-folders" placeholder="(top level)" value={folderValue} data-testid="pe-newab-folder"
          onChange={(e) => setFolder(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void go(); }} />
        <datalist id="pe-newab-folders">{folders.map((f) => <option key={f} value={f} />)}</datalist>
      </label>
      <div className="pe-note mono" data-testid="pe-newab-target">data/{ctx.ns}/abilities/{clean ? clean + "/" : ""}{name}.{ext}</div>
      <div className="pe-btns">
        <button className="pe-btn" disabled={!ready} onClick={() => void go()} data-testid="pe-newab-create">Create</button>
        <button className="pe-btn" onClick={onCancel} data-testid="pe-newab-cancel">Cancel</button>
      </div>
      {err && <div className="pe-note warn" data-testid="pe-newab-error">{err}</div>}
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
