/** Python interpreter UI: status-bar widget, switcher popup (anchored above the status bar) and the Add Python Interpreter dialog. */
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../../../lib/store";
import { fs } from "../../../lib/ipc";
import { projectStore } from "../../../lib/project";
import { openPopup, type PopupProps } from "../../shell/popups";
import { DIALOG_ID } from "./ids";
import { setInterpreter, usePy } from "../interpreter";
import { createCondaAndUse, createVenvAndUse, setTerminalActivate, terminalActivateSetting, useExistingInterpreter } from "./ops";
import { defaultVenvDir, groupInterpreters, shortPath } from "./logic";
import type { Interp } from "../api";

let home: string | null = null;
/** shown as "~" in paths; fetched when the popup / dialog first opens */
export const homeReady = fs.home().then((h) => { home = h; }).catch(() => {});

// ------------------------------------------------------------------------------------------ switcher popup
type PRow =
  | { t: "sec"; label: string }
  | { t: "interp"; i: Interp }
  | { t: "sep" }
  | { t: "act"; id: "add" | "settings" | "activate" | "refresh"; label: string; check?: boolean };

export function InterpreterPopup({ onClose, props }: PopupProps) {
  const st = usePy();
  const { on } = useStore(terminalActivateSetting);
  const anchor = (props as { right: number; top: number } | undefined) ?? { right: window.innerWidth - 8, top: window.innerHeight - 24 };
  const rows = useMemo<PRow[]>(() => {
    const out: PRow[] = [];
    for (const g of groupInterpreters(st.interpreters)) {
      out.push({ t: "sec", label: g.label });
      g.items.forEach((i) => out.push({ t: "interp", i }));
    }
    if (!st.interpreters.length) out.push({ t: "sec", label: st.loading ? "Detecting interpreters…" : "No Python interpreters found" });
    out.push({ t: "sep" });
    out.push({ t: "act", id: "add", label: "Add New Interpreter…" });
    out.push({ t: "act", id: "settings", label: "Interpreter Settings…" });
    out.push({ t: "act", id: "activate", label: "Activate virtualenv in new terminals", check: on });
    return out;
  }, [st.interpreters, st.loading, on]);
  const sel = rows.map((r, n) => (r.t === "interp" || r.t === "act" ? n : -1)).filter((n) => n >= 0);
  const [at, setAt] = useState(() => Math.max(0, sel.findIndex((n) => { const r = rows[n]; return r.t === "interp" && r.i.path === st.current?.path; })));
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { box.current?.focus(); }, []);
  useEffect(() => { box.current?.querySelector(".selected")?.scrollIntoView({ block: "nearest" }); }, [at]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), onClose());
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [onClose]);

  const run = (r: PRow) => {
    if (r.t === "interp") { onClose(); void setInterpreter(r.i); }
    else if (r.t === "act") {
      if (r.id === "activate") { setTerminalActivate(!on); return; }
      onClose();
      openPopup(DIALOG_ID, { tab: r.id === "add" ? "venv" : "existing" });
    }
  };
  const key = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setAt((a) => Math.min(sel.length - 1, a + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setAt((a) => Math.max(0, a - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); const r = rows[sel[at]]; if (r) run(r); }
  };
  const selRow = sel[at];
  return (
    <div className="popup-backdrop" style={{ padding: 0, display: "block", background: "transparent" }} onMouseDown={onClose}>
      <div
        ref={box} className="pyi-popup" tabIndex={0} data-testid="py-interp-popup" onKeyDown={key} onMouseDown={(e) => e.stopPropagation()}
        style={{ right: Math.max(8, window.innerWidth - anchor.right), bottom: window.innerHeight - anchor.top + 4, minWidth: 420, maxWidth: "min(720px, 94vw)" }}
      >
        {rows.map((r, n) => {
          if (r.t === "sec") return <div key={n} className="pyi-sec">{r.label}</div>;
          if (r.t === "sep") return <div key={n} className="pyi-sep" />;
          const cls = "pyi-row" + (n === selRow ? " selected" : "");
          if (r.t === "interp") {
            const cur = r.i.path === st.current?.path;
            return (
              <div key={n} className={cls} data-interp={r.i.path} onMouseMove={() => setAt(sel.indexOf(n))} onClick={() => run(r)}>
                <span className="pyi-check">{cur ? "✓" : ""}</span>
                <span>{r.i.name}</span>
                <span className="pyi-path">{shortPath(r.i.path, home)}</span>
              </div>
            );
          }
          return (
            <div key={n} className={cls} data-act={r.id} onMouseMove={() => setAt(sel.indexOf(n))} onClick={() => run(r)}>
              <span className="pyi-check">{r.check ? "✓" : ""}</span>
              <span>{r.label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------ Add Python Interpreter
type Tab = "existing" | "venv" | "conda";

async function browse(dir: boolean, defaultPath?: string): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const r = await open({ directory: dir, multiple: false, defaultPath, title: dir ? "Select Location" : "Select Python Interpreter" });
  return typeof r === "string" ? r : null;
}

export function AddInterpreterDialog({ onClose, props }: PopupProps) {
  const st = usePy();
  const { root } = useStore(projectStore);
  const remote = !!root && root.host !== "local";
  const [tab, setTab] = useState<Tab>(((props as { tab?: Tab } | undefined)?.tab) ?? "existing");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const conda = st.tools.conda;
  const condaEnvs = st.interpreters.filter((i) => i.kind === "conda");

  // existing
  const [exPath, setExPath] = useState(st.current?.path ?? st.interpreters[0]?.path ?? "");
  // venv
  const bases = useMemo(() => {
    const nonEnv = st.interpreters.filter((i) => !i.project && i.kind !== "conda" && !(i.kind === "venv" || i.kind === "poetry" || i.kind === "pipenv"));
    return nonEnv.length ? nonEnv : st.interpreters;
  }, [st.interpreters]);
  const [venvDir, setVenvDir] = useState(() => defaultVenvDir(root?.path ?? "."));
  const [base, setBase] = useState("");
  const [sysSite, setSysSite] = useState(false);
  // default base: the same Python version as the current interpreter if one is offered, else the first
  useEffect(() => {
    if (base || !bases.length) return;
    const minor = (v: string) => v.split(".").slice(0, 2).join(".");
    setBase((bases.find((b) => st.current && minor(b.version) === minor(st.current.version)) ?? bases[0]).path);
  }, [bases, base, st.current]);
  // conda
  const [cMode, setCMode] = useState<"existing" | "new">(condaEnvs.length ? "existing" : "new");
  const [cExisting, setCExisting] = useState(condaEnvs[0]?.path ?? "");
  const projName = root?.path.split("/").filter(Boolean).pop() ?? "env";
  const [cDir, setCDir] = useState(`~/.conda/envs/${projName}`);
  const [cVer, setCVer] = useState("3.12");
  useEffect(() => { if (!cExisting && condaEnvs[0]) setCExisting(condaEnvs[0].path); }, [condaEnvs, cExisting]);
  useEffect(() => { void fs.home().then((h) => setCDir((d) => (d.startsWith("~/") && !remote ? h + d.slice(1) : d))).catch(() => {}); }, [remote]);

  const tool = st.tools.uv ? "uv" : "venv";
  const canOk = !busy && (tab === "existing" ? !!exPath.trim() : tab === "venv" ? !!venvDir.trim() : cMode === "existing" ? !!cExisting : !!conda && !!cDir.trim());

  const ok = async () => {
    if (!canOk) return;
    setErr(null);
    try {
      if (tab === "existing") { setBusy("Checking interpreter…"); await useExistingInterpreter(exPath.trim()); }
      else if (tab === "venv") { setBusy(`Creating virtual environment with ${tool}…`); await createVenvAndUse({ dir: venvDir.trim(), base: base || undefined, systemSite: sysSite }); }
      else if (cMode === "existing") { setBusy("Checking interpreter…"); await useExistingInterpreter(cExisting); }
      else { setBusy("Creating conda environment (this can take a while)…"); await createCondaAndUse({ dir: cDir.trim(), pythonVersion: cVer.trim() || undefined }); }
      onClose();
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
      setBusy(null);
    }
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [onClose, busy]);

  const nav = (id: Tab, label: string, disabled = false) => (
    <div className={"pyd-nav-item" + (tab === id ? " active" : "") + (disabled ? " disabled" : "")} data-tab={id} onClick={() => !busy && !disabled && (setTab(id), setErr(null))}>{label}</div>
  );
  const interpOptions = (list: Interp[]) => list.map((i) => <option key={i.path} value={i.path}>{i.name}  {shortPath(i.path, home)}</option>);

  return (
    <div className="dialog-backdrop" onMouseDown={() => !busy && onClose()}>
      <div className="dialog pyd" data-testid="py-add-dialog" onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.target as HTMLElement).tagName !== "BUTTON" && (e.target as HTMLElement).tagName !== "SELECT") { e.preventDefault(); void ok(); } }}>
        <div className="dialog-title">Add Python Interpreter</div>
        <div className="pyd-body">
          <div className="pyd-nav">
            {nav("existing", "Existing")}
            {nav("venv", "Virtualenv")}
            {nav("conda", "Conda", !conda && !condaEnvs.length)}
          </div>
          <div className="pyd-pane">
            {tab === "existing" && (<>
              <div className="pyd-field"><label>Discovered:</label>
                <div className="row"><select data-testid="ex-select" value={st.interpreters.some((i) => i.path === exPath) ? exPath : ""} onChange={(e) => e.target.value && setExPath(e.target.value)}>
                  <option value="">{st.interpreters.length ? "Select…" : "No interpreters discovered"}</option>{interpOptions(st.interpreters)}
                </select></div></div>
              <div className="pyd-field"><label>Interpreter:</label>
                <div className="row"><input type="text" data-testid="ex-path" value={exPath} spellCheck={false} placeholder="/path/to/bin/python" autoFocus onChange={(e) => setExPath(e.target.value)} />
                  {!remote && <button onClick={async () => { const p = await browse(false, exPath || undefined); if (p) setExPath(p); }}>Browse…</button>}</div></div>
              <div className="pyd-note">{remote ? `The path is on ${root?.host}.` : "Type a path or pick one from the list. The interpreter is run once to read its version."}</div>
            </>)}
            {tab === "venv" && (<>
              <div className="pyd-field"><label>Location:</label>
                <div className="row"><input type="text" data-testid="venv-dir" value={venvDir} spellCheck={false} autoFocus onChange={(e) => setVenvDir(e.target.value)} />
                  {!remote && <button onClick={async () => { const p = await browse(true, venvDir); if (p) setVenvDir(p); }}>Browse…</button>}</div></div>
              <div className="pyd-field"><label>Base interpreter:</label>
                <div className="row"><select data-testid="venv-base" value={base} onChange={(e) => setBase(e.target.value)}>{interpOptions(bases)}</select></div></div>
              <div className="pyd-field"><label>Tool:</label><div className="pyd-note" data-testid="venv-tool">{tool === "uv" ? "uv (virtualenv with pip)" : "venv"}</div></div>
              <label className="pyd-check"><input type="checkbox" data-testid="venv-site" checked={sysSite} onChange={(e) => setSysSite(e.target.checked)} /> Inherit global site-packages</label>
            </>)}
            {tab === "conda" && (<>
              {!conda && <div className="pyd-note">conda was not found on {remote ? root?.host : "this machine"}; only discovered environments can be used.</div>}
              <label className="pyd-check"><input type="radio" checked={cMode === "existing"} disabled={!condaEnvs.length} onChange={() => setCMode("existing")} /> Use existing environment</label>
              <div className="pyd-field"><label>Environment:</label>
                <div className="row"><select data-testid="conda-existing" disabled={cMode !== "existing"} value={cExisting} onChange={(e) => setCExisting(e.target.value)}>{interpOptions(condaEnvs)}</select></div></div>
              <label className="pyd-check"><input type="radio" checked={cMode === "new"} disabled={!conda} onChange={() => setCMode("new")} /> Create new environment</label>
              <div className="pyd-field"><label>Location:</label>
                <div className="row"><input type="text" data-testid="conda-dir" disabled={cMode !== "new"} value={cDir} spellCheck={false} onChange={(e) => setCDir(e.target.value)} /></div></div>
              <div className="pyd-field"><label>Python version:</label>
                <div className="row"><input type="text" data-testid="conda-ver" disabled={cMode !== "new"} value={cVer} spellCheck={false} onChange={(e) => setCVer(e.target.value)} /></div></div>
            </>)}
            <div style={{ flex: 1 }} />
            {busy && <div className="pyd-busy" data-testid="py-add-busy"><span className="pyi-spin" />{busy}</div>}
            {err && <div className="pyd-err" data-testid="py-add-error">{err}</div>}
          </div>
        </div>
        <div className="dialog-buttons">
          <button data-testid="py-add-cancel" disabled={!!busy} onClick={onClose}>Cancel</button>
          <button className="primary" data-testid="py-add-ok" disabled={!canOk} onClick={() => void ok()}>OK</button>
        </div>
      </div>
    </div>
  );
}

