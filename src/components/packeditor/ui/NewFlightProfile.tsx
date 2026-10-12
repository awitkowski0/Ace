/** Choosing a flight profile (a searchable select) and making a new one (an inline form: id + parent; no dialogs). */
import { useState } from "react";
import { flightIdProblem } from "../core/flight";
import { createFlightProfile } from "./flightData";

const LONG = 12; // a list longer than this gets a search box

/** A select of profile ids that grows a filter box once the list is long. The current value always stays listed. */
export function ProfileSelect({ value, options, onChange, allowEmpty, testId, className }: {
  value: string | undefined; options: readonly string[]; onChange: (v: string | undefined) => void; allowEmpty?: string; testId?: string; className?: string;
}) {
  const [q, setQ] = useState("");
  const f = q.trim().toLowerCase();
  const shown = options.filter((o) => !f || o.toLowerCase().includes(f) || o === value);
  const known = value === undefined || options.includes(value);
  return (
    <span className="pe-psel">
      {options.length > LONG && <input className="pe-in pe-psel-q" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} data-testid={testId ? testId + "-filter" : undefined} />}
      <select className={"pe-in sel " + (className ?? "")} value={value ?? ""} onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)} data-testid={testId}>
        {allowEmpty !== undefined && <option value="">{allowEmpty}</option>}
        {!known && <option value={value}>{value}</option>}
        {shown.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </span>
  );
}

/**
 * "New flight profile…": a button that opens an inline form. `path` is a file of the pack the profile goes in (the suit, or the
 * profile being edited), `profiles` the ids already in the project, `parent` the default parent. `onCreated` gets the new id
 * and file once it is on disk.
 */
export function NewFlightProfile({ host, path, ns, profiles, parent, label = "New flight profile…", testId, onCreated }: {
  host: string; path: string; ns: string; profiles: readonly string[]; parent: string; label?: string; testId: string; onCreated: (id: string, file: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [id, setId] = useState("");
  const [par, setPar] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!open) return <button className="pe-btn" onClick={() => { setId(""); setPar(null); setErr(null); setOpen(true); }} data-testid={testId}>{label}</button>;
  const parentId = par ?? parent;
  const problem = id ? flightIdProblem(id, profiles) : null;
  const create = async () => {
    const bad = flightIdProblem(id, profiles);
    if (bad) return setErr(bad);
    setBusy(true);
    try {
      const file = await createFlightProfile(host, path, id, parentId);
      setOpen(false);
      onCreated(`${ns}:${id}`, file);
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="pe-newfp" data-testid={testId + "-form"}>
      <label>Id <input className="pe-in mono" autoFocus placeholder="my_flight" value={id} data-testid="pe-newfp-id"
        onChange={(e) => { setId(e.target.value); setErr(null); }}
        onKeyDown={(e) => { if (e.key === "Enter") void create(); else if (e.key === "Escape") setOpen(false); }} /></label>
      <label>Parent <ProfileSelect value={parentId} options={profiles} onChange={(v) => setPar(v ?? null)} testId="pe-newfp-parent" /></label>
      <button className="pe-btn" disabled={busy || !id || !!problem} onClick={() => void create()} data-testid="pe-newfp-create">Create</button>
      <button className="pe-btn" onClick={() => setOpen(false)} data-testid="pe-newfp-cancel">Cancel</button>
      {(err ?? problem) && <div className="pe-note warn" data-testid="pe-newfp-error">{err ?? problem}</div>}
    </div>
  );
}
