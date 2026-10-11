import { useEffect, useMemo, useState } from "react";
import { useStore } from "../../../lib/store";
import { onInterpreterChange, usePy } from "../interpreter";
import { clearLog, installedVersion, pkgStore, refresh, requestOp, search, select, setMode, setQuery, stableVersions } from "./store";
import { compareVersions, norm } from "./pip";
import "./packages.css";

export function PackagesWindow() {
  const s = useStore(pkgStore);
  const py = usePy();
  const [version, setVersion] = useState("");

  useEffect(() => {
    void refresh();
    const off = onInterpreterChange(() => void refresh());
    return () => void off();
  }, []);
  useEffect(() => setVersion(""), [s.selected?.name]);

  const shown = useMemo(() => {
    const q = s.query.trim().toLowerCase();
    return q ? s.pkgs.filter((p) => p.name.toLowerCase().includes(q)) : s.pkgs;
  }, [s.pkgs, s.query]);

  const sel = s.selected;
  const inst = sel ? installedVersion(sel.name) : null;
  const latest = s.detail?.version ?? null;
  const upgradable = !!inst && !!latest && compareVersions(latest, inst) > 0;
  const busy = !!s.running;
  const versions = stableVersions(s.detail).slice(0, 200);

  return (
    <div className="pk" data-autofocus tabIndex={0}>
      <div className="pk-top">
        <input
          className="pk-filter"
          data-autofocus
          placeholder={s.mode === "installed" ? "Filter installed packages (Enter searches PyPI)" : "Search PyPI"}
          value={s.query}
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void search(s.query); }}
        />
        <button className={"pk-btn" + (s.mode === "pypi" ? " on" : "")} data-act="mode" title="Search PyPI instead of the installed packages" onClick={() => setMode(s.mode === "pypi" ? "installed" : "pypi")}>PyPI</button>
        <button className="pk-btn" data-act="refresh" title="Reload packages" disabled={s.loading} onClick={() => void refresh()}>⟳</button>
        <span className="pk-interp" title={py.current?.path}>{py.current ? `${py.current.name}${s.tool ? ` · ${s.tool}` : ""}` : "No interpreter"}</span>
      </div>
      <div className="pk-body">
        <div className="pk-list" data-testid="pk-list">
          {s.mode === "installed" ? (
            <>
              <div className="pk-head"><span>Package</span><span>Version</span></div>
              <div className="pk-rows">
                {s.loading && !s.pkgs.length && <div className="pk-empty">Loading packages…</div>}
                {s.error && <div className="pk-empty err">{s.error}</div>}
                {shown.map((p) => (
                  <div key={p.name} className={"pk-row" + (sel?.source === "installed" && norm(sel.name) === norm(p.name) ? " sel" : "")} data-name={p.name} onClick={() => void select(p.name, "installed")}>
                    <span className="n">{p.name}</span>
                    <span className="v">{p.version}</span>
                  </div>
                ))}
                {!s.loading && !s.error && !shown.length && <div className="pk-empty">{s.pkgs.length ? "No matching packages" : "No packages installed"}</div>}
              </div>
            </>
          ) : (
            <>
              <div className="pk-head"><span>PyPI result</span><span>Latest</span></div>
              <div className="pk-rows">
                {s.searching && <div className="pk-empty">Searching PyPI…</div>}
                {s.hits.map((h) => (
                  <div key={h.name} className={"pk-row hit" + (sel?.source === "pypi" && sel.name === h.name ? " sel" : "")} data-name={h.name} onClick={() => void select(h.name, "pypi")}>
                    <span className="n">{h.name}<span className="sum">{h.summary}</span></span>
                    <span className="v">{h.version}</span>
                  </div>
                ))}
                {!s.searching && !s.hits.length && <div className="pk-empty">{s.query.trim() ? "No results (press Enter to search; an exact package name always works)" : "Type a package name and press Enter"}</div>}
              </div>
            </>
          )}
        </div>
        <div className="pk-detail" data-testid="pk-detail">
          {!sel ? (
            <div className="pk-empty">Select a package to see its details</div>
          ) : (
            <>
              <div className="pk-title">{sel.name}</div>
              <div className="pk-kv"><span>Installed</span><b data-k="installed">{inst ?? "not installed"}</b></div>
              <div className="pk-kv"><span>Latest</span><b data-k="latest">{s.detailLoading ? "…" : latest ?? "unknown"}</b></div>
              {s.detail?.summary && <div className="pk-sum">{s.detail.summary}</div>}
              {s.detailError && <div className="pk-empty err">{s.detailError}</div>}
              <div className="pk-actions">
                <select className="pk-select" data-testid="pk-version" value={version} onChange={(e) => setVersion(e.target.value)} disabled={!versions.length}>
                  <option value="">Latest version</option>
                  {versions.map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
                <button className="pk-btn act" data-act="install" disabled={busy} onClick={() => void requestOp("install", sel.name, version || null)}>{inst ? "Install Version" : "Install"}</button>
                <button className="pk-btn act" data-act="upgrade" disabled={busy || !inst || !upgradable} title={upgradable ? `Upgrade to ${latest}` : "Already up to date"} onClick={() => void requestOp("upgrade", sel.name)}>Upgrade</button>
                <button className="pk-btn act danger" data-act="uninstall" disabled={busy || !inst} onClick={() => void requestOp("uninstall", sel.name)}>Uninstall</button>
              </div>
              {versions.length > 0 && (
                <>
                  <div className="pk-sub">Versions</div>
                  <div className="pk-versions">{versions.slice(0, 40).map((v) => <span key={v} className={v === inst ? "cur" : ""} onClick={() => setVersion(v)}>{v}</span>)}</div>
                </>
              )}
            </>
          )}
        </div>
      </div>
      {s.log && (
        <div className="pk-log">
          <div className="pk-loghead"><span>Output</span><div className="grow" /><button className="pk-btn" onClick={clearLog}>Clear</button></div>
          <pre data-testid="pk-log">{s.log}</pre>
        </div>
      )}
      <div className={"pk-status" + (s.status?.error ? " err" : "")} data-testid="pk-status">
        {s.running ? `${s.running}…` : s.status?.text ?? (s.loading ? "Loading…" : `${s.pkgs.length} packages`)}
      </div>
    </div>
  );
}
