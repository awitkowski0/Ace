import { isWithin, relativeTo } from "../../lib/paths";
import { isMod } from "../../lib/platform";
import { isAbsPath } from "./util";
import { useEffect, useMemo, useRef, useState } from "react";
import { open as pickPath } from "@tauri-apps/plugin-dialog";
import type { PopupProps } from "../shell/popups";
import { showContextMenu } from "../shell/contextMenu";
import { projectStore } from "../../lib/project";
import { usePy } from "../python/interpreter";
import { newId } from "../python/api";
import { availableTypes, ctxFor, getConfigType, newConfig, replaceConfigs, runStore, listConfigTypes, uniqueName } from "./configs";
import { CopyIcon, MinusSmall, PlusIcon } from "./icons";
import type { FieldDef, RunConfig } from "./types";

export interface EditDialogProps { selectId?: string; addType?: string }

const clone = (c: RunConfig): RunConfig => JSON.parse(JSON.stringify(c));
const same = (a: RunConfig, b: RunConfig) => JSON.stringify(a) === JSON.stringify(b);

export function EditDialog({ onClose, props }: PopupProps) {
  const p = (props ?? {}) as EditDialogProps;
  const original = useMemo(() => runStore.get().configs.map(clone), []);
  const [draft, setDraft] = useState<RunConfig[]>(() => {
    const d = original.map(clone);
    const ctx = ctxFor();
    if (p.addType && ctx && getConfigType(p.addType)) d.push(newConfig(p.addType, ctx));
    return d;
  });
  const [sel, setSel] = useState<string | null>(() => (p.addType ? null : p.selectId ?? runStore.get().selectedId ?? original[0]?.id ?? null));
  const [err, setErr] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const nameRef = useRef<HTMLInputElement>(null);
  const dlg = useRef<HTMLDivElement>(null);
  const cur = draft.find((c) => c.id === (sel ?? draft[draft.length - 1]?.id)) ?? null;
  useEffect(() => { if (p.addType && draft.length) setSel(draft[draft.length - 1].id); /* eslint-disable-next-line */ }, []);
  useEffect(() => { dlg.current?.focus(); }, []);
  useEffect(() => { setTimeout(() => nameRef.current?.select(), 30); }, [cur?.id]);

  const set = (patch: Partial<RunConfig>) => cur && setDraft((d) => d.map((c) => (c.id === cur.id ? { ...c, ...patch } : c)));
  const add = (typeId: string) => {
    const ctx = ctxFor();
    if (!ctx) return;
    const c = newConfig(typeId, ctx);
    c.name = uniqueName(c.name, draft);
    setDraft((d) => [...d, c]);
    setSel(c.id);
    setErr(null);
  };
  const remove = () => {
    if (!cur) return;
    const i = draft.findIndex((c) => c.id === cur.id);
    const rest = draft.filter((c) => c.id !== cur.id);
    setDraft(rest);
    setSel(rest[Math.min(i, rest.length - 1)]?.id ?? null);
  };
  const copy = () => {
    if (!cur) return;
    const c = { ...clone(cur), id: newId("cfg"), name: uniqueName(cur.name, draft), temporary: false };
    setDraft((d) => [...d, c]);
    setSel(c.id);
  };

  const validate = (): boolean => {
    for (const c of draft) {
      const t = getConfigType(c.type);
      const e = (!c.name.trim() ? "Name is not specified" : null) ?? t?.validate?.(c) ?? null;
      if (e) { setSel(c.id); setErr(`${c.name || "Configuration"}: ${e}`); return false; }
    }
    setErr(null);
    return true;
  };
  const apply = (): boolean => {
    if (!validate()) return false;
    const byId = new Map(original.map((c) => [c.id, c]));
    const out: RunConfig[] = [];
    for (const c of draft) {
      const o = byId.get(c.id);
      const edited = !o || !same(o, c);
      const r = { ...c, name: uniqueName(c.name.trim(), out, c.id), temporary: edited ? false : c.temporary };
      if (!r.temporary) delete (r as { temporary?: boolean }).temporary;
      out.push(r);
    }
    const selected = cur && out.some((c) => c.id === cur.id) ? cur.id : out[0]?.id ?? null;
    replaceConfigs(out, selected);
    original.splice(0, original.length, ...out.map(clone));
    return true;
  };
  const ok = () => { if (apply()) onClose(); };

  const types = listConfigTypes().filter((t) => draft.some((c) => c.type === t.id));
  const dirty = JSON.stringify(draft) !== JSON.stringify(original);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.stopPropagation(); onClose(); }
    else if (e.key === "Enter" && (isMod(e) || (e.target as HTMLElement).tagName === "INPUT" && (e.target as HTMLInputElement).type !== "checkbox")) { e.preventDefault(); ok(); }
  };

  return (
    <div className="dialog-backdrop" data-testid="edit-configs">
      <div className="rc-dialog" ref={dlg} tabIndex={-1} onKeyDown={onKey} onMouseDown={(e) => e.stopPropagation()}>
        <div className="rc-title">Run/Debug Configurations</div>
        <div className="rc-body">
          <div className="rc-left">
            <div className="rc-lbar">
              <button className="icon-btn sm" title="Add New Configuration" data-act="add" onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                showContextMenu(r.left, r.bottom + 2, [{ label: "Add New Configuration", disabled: true }, ...availableTypes().map((t) => ({ label: t.label, run: () => add(t.id) }))]);
              }}><PlusIcon /></button>
              <button className="icon-btn sm" title="Remove Configuration" data-act="remove" disabled={!cur} onClick={remove}><MinusSmall /></button>
              <button className="icon-btn sm" title="Copy Configuration" data-act="copy" disabled={!cur} onClick={copy}><CopyIcon /></button>
            </div>
            <div className="rc-tree" data-testid="rc-tree">
              {types.length === 0 && <div className="run-empty">No configurations.<br />Click + to add one.</div>}
              {types.map((t) => (
                <div key={t.id}>
                  <div className="rc-group" onClick={() => setCollapsed((s) => { const n = new Set(s); n.has(t.id) ? n.delete(t.id) : n.add(t.id); return n; })}>
                    <span className="gchev">{collapsed.has(t.id) ? "▸" : "▾"}</span><span className="gicon">{t.icon}</span><span>{t.label}</span>
                  </div>
                  {!collapsed.has(t.id) && draft.filter((c) => c.type === t.id).map((c) => (
                    <div key={c.id} className={"rc-item" + (c.id === cur?.id ? " selected" : "")} data-cfg={c.id} onClick={() => { setSel(c.id); setErr(null); }}>
                      <span className="gicon">{t.icon}</span>
                      <span className={original.find((o) => o.id === c.id)?.temporary && same(original.find((o) => o.id === c.id)!, c) ? "temp" : undefined}>{c.name || "(unnamed)"}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
          <div className="rc-right">
            {cur ? <Form key={cur.id} cfg={cur} set={set} nameRef={nameRef} /> : <div className="run-empty">Select a configuration, or add a new one with +.</div>}
          </div>
        </div>
        <div className="rc-foot">
          <span className="rc-err" data-testid="rc-error">{err ?? ""}</span>
          <span className="grow" />
          <button onClick={onClose} data-act="cancel">Cancel</button>
          <button onClick={() => void apply()} disabled={!dirty} data-act="apply">Apply</button>
          <button className="primary" onClick={ok} data-act="ok">OK</button>
        </div>
      </div>
    </div>
  );
}

function Form({ cfg, set, nameRef }: { cfg: RunConfig; set: (p: Partial<RunConfig>) => void; nameRef: React.RefObject<HTMLInputElement> }) {
  const t = getConfigType(cfg.type);
  if (!t) return <div className="run-empty">Unknown configuration type '{cfg.type}'.</div>;
  return (
    <div className="rc-form">
      <label className="rc-row"><span className="rc-label">Name:</span><input ref={nameRef} className="dialog-input" data-field="name" value={cfg.name} spellCheck={false} onChange={(e) => set({ name: e.target.value })} /></label>
      <div className="rc-type">{t.icon}<span>{t.label}</span></div>
      {t.fields.filter((f) => !f.visible || f.visible(cfg)).map((f) => <Field key={f.key} f={f} cfg={cfg} set={set} />)}
    </div>
  );
}

function Field({ f, cfg, set }: { f: FieldDef; cfg: RunConfig; set: (p: Partial<RunConfig>) => void }) {
  const v = cfg[f.key];
  const remote = projectStore.get().root?.host !== "local";
  const hintText = typeof f.hint === "function" ? f.hint() : f.hint;
  const hint = hintText ? <div className="rc-hint">{hintText}</div> : null;
  if (f.kind === "checkbox") {
    return <div className="rc-row"><span className="rc-label" /><div className="rc-input"><label className="rc-check"><input type="checkbox" data-field={f.key} checked={!!v} onChange={(e) => set({ [f.key]: e.target.checked })} /> {f.label}</label>{hint}</div></div>;
  }
  let input: React.ReactNode;
  if (f.kind === "text") input = <input className="dialog-input" data-field={f.key} value={String(v ?? "")} placeholder={f.placeholder} spellCheck={false} onChange={(e) => set({ [f.key]: e.target.value })} />;
  else if (f.kind === "path") {
    input = (
      <div className="rc-path">
        <input className="dialog-input" data-field={f.key} value={String(v ?? "")} placeholder={f.placeholder} spellCheck={false} onChange={(e) => set({ [f.key]: e.target.value })} />
        {!remote && <button className="gbtn" title="Browse" data-browse={f.key} onClick={async () => {
          const root = projectStore.get().root?.path;
          const cur = String(v ?? "");
          const r = await pickPath({ directory: !!f.dir, multiple: false, defaultPath: isAbsPath(cur) ? cur : root });
          if (typeof r === "string") set({ [f.key]: isWithin(root!, r) && f.key !== "interpreter" ? relativeTo(root!, r) : r });
        }}>…</button>}
      </div>
    );
  } else if (f.kind === "textarea") input = <textarea className="rc-textarea" data-field={f.key} rows={f.rows ?? 3} value={String(v ?? "")} spellCheck={false} placeholder={f.placeholder} onChange={(e) => set({ [f.key]: e.target.value })} />;
  else if (f.kind === "select") input = (
    <select className="rc-select" data-field={f.key} value={String(v ?? "")} onChange={(e) => set({ [f.key]: e.target.value })}>
      {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
  else if (f.kind === "interpreter") input = <InterpreterSelect field={f.key} value={String(v ?? "")} onChange={(x) => set({ [f.key]: x })} />;
  else if (f.kind === "env") input = <EnvEditor field={f.key} rows={Array.isArray(v) ? (v as [string, string][]) : []} onChange={(rows) => set({ [f.key]: rows })} />;
  return <div className="rc-row top"><span className="rc-label">{f.label}:</span><div className="rc-input">{input}{hint}</div></div>;
}

function InterpreterSelect({ value, onChange, field }: { value: string; onChange: (v: string) => void; field: string }) {
  const py = usePy();
  const known = py.interpreters.some((i) => i.path === value);
  return (
    <select className="rc-select" data-field={field} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{py.current ? `Project Default (${py.current.name})` : "Project Default (none)"}</option>
      {value && !known && <option value={value}>{value}</option>}
      {py.interpreters.map((i) => <option key={i.path} value={i.path}>{i.name} — {i.path}</option>)}
    </select>
  );
}

function EnvEditor({ rows, onChange, field }: { rows: [string, string][]; onChange: (r: [string, string][]) => void; field: string }) {
  const upd = (i: number, k: 0 | 1, val: string) => onChange(rows.map((r, j) => (j === i ? (k === 0 ? [val, r[1]] : [r[0], val]) : r) as [string, string]));
  return (
    <div className="rc-env" data-field={field}>
      {rows.map((r, i) => (
        <div className="rc-env-row" key={i}>
          <input className="dialog-input" placeholder="NAME" data-env-key={i} value={r[0]} spellCheck={false} onChange={(e) => upd(i, 0, e.target.value)} />
          <span>=</span>
          <input className="dialog-input" placeholder="value" data-env-val={i} value={r[1]} spellCheck={false} onChange={(e) => upd(i, 1, e.target.value)} />
          <button className="icon-btn sm" title="Remove" onClick={() => onChange(rows.filter((_, j) => j !== i))}><MinusSmall /></button>
        </div>
      ))}
      <button className="gbtn" data-env-add={field} onClick={() => onChange([...rows, ["", ""]])}>+ Add variable</button>
    </div>
  );
}
