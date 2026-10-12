import { homeShorten } from "../../lib/paths";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { onWindowActive, windowActive } from "../../lib/activity";
import { invoke } from "../../lib/ipc";
import { confirmDialog, promptDialog } from "../shell/dialogs";
import { showContextMenu } from "../shell/contextMenu";
import { openTerminal } from "../terminal/api";
import { daemonsApi, fmtBytes, fmtUptime, getExtraRoots, setExtraRoots, type CleanEvent, type CleanItem, type ProcRow } from "./api";
import "./daemons.css";

type SortKey = "pid" | "kind" | "version" | "rss" | "cpu" | "uptimeSecs" | "busy" | "cwd";
const COLS: { key: SortKey; title: string; w: string; num?: boolean }[] = [
  { key: "pid", title: "PID", w: "70px", num: true },
  { key: "kind", title: "Kind", w: "170px" },
  { key: "version", title: "Version", w: "80px" },
  { key: "rss", title: "RSS", w: "80px", num: true },
  { key: "cpu", title: "CPU", w: "60px", num: true },
  { key: "uptimeSecs", title: "Uptime", w: "80px", num: true },
  { key: "busy", title: "State", w: "60px" },
  { key: "cwd", title: "Project dir", w: "auto" },
];
const KIND_ORDER: Record<string, number> = { gradle: 0, kotlin: 1, java: 2, lsp: 3, claude: 4, atelier: 5, minecraft: 6 };

const errMsg = (e: unknown) => (typeof e === "string" ? e : (e as Error)?.message ?? String(e));
const short = (p: string | null) => (p ? homeShorten(p) : "");

export function DaemonsWindow() {
  const [hosts, setHosts] = useState<string[]>(["local"]);
  const [host, setHost] = useState("local");
  const [tab, setTab] = useState<"procs" | "clean">("procs");
  useEffect(() => {
    invoke<string[]>("remote_hosts").then((h) => setHosts(["local", ...h])).catch(() => {});
  }, []);
  return (
    <div className="dm" tabIndex={0} data-autofocus>
      <div className="dm-bar">
        <button className={"dm-btn" + (tab === "procs" ? " on" : "")} onClick={() => setTab("procs")}>Processes</button>
        <button className={"dm-btn" + (tab === "clean" ? " on" : "")} onClick={() => setTab("clean")}>Cleanup</button>
        <span className="sep" />
        <select className="dm-btn" value={host} onChange={(e) => setHost(e.target.value)} style={{ background: "var(--bg-input)", border: 0 }}>
          {hosts.map((h) => <option key={h} value={h}>{h}</option>)}
        </select>
        <div className="grow" />
      </div>
      {tab === "procs" ? <ProcessesTab host={host} /> : <CleanupTab host={host} />}
    </div>
  );
}

function ProcessesTab({ host }: { host: string }) {
  const [rows, setRows] = useState<ProcRow[]>([]);
  const [status, setStatus] = useState("");
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "kind", dir: 1 });
  const [working, setWorking] = useState(false);
  const inflight = useRef(false);

  const refresh = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    try {
      const r = await daemonsApi.list(host);
      setRows(r.rows);
      setStatus(`${r.rows.length} processes · ${r.elapsedMs} ms`);
    } catch (e) {
      setStatus(errMsg(e));
    } finally {
      inflight.current = false;
    }
  }, [host]);

  useEffect(() => {
    setRows([]);
    setSel(new Set());
    refresh();
    const t = setInterval(() => windowActive() && refresh(), 5000);
    const off = onWindowActive(refresh);
    return () => { clearInterval(t); off(); };
  }, [refresh]);

  const sorted = useMemo(() => {
    const v = (r: ProcRow): string | number => {
      if (sort.key === "kind") return KIND_ORDER[r.kind] ?? 9;
      if (sort.key === "busy") return r.busy === null ? -1 : r.busy ? 1 : 0;
      return (r[sort.key] ?? "") as string | number;
    };
    return [...rows].sort((a, b) => {
      const x = v(a), y = v(b);
      const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
      return (c || a.pid - b.pid) * sort.dir;
    });
  }, [rows, sort]);

  const selected = rows.filter((r) => sel.has(r.pid));
  const gradle = rows.filter((r) => r.kind === "gradle");
  const idle = gradle.filter((r) => r.busy === false);

  const run = async (label: string, f: () => Promise<unknown>) => {
    setWorking(true);
    setStatus(label + "…");
    try {
      const r = await f();
      setStatus(`${label}: ${typeof r === "string" ? r : "done"}`);
    } catch (e) {
      setStatus(`${label} failed: ${errMsg(e)}`);
    }
    setWorking(false);
    refresh();
  };
  /** Minecraft servers need the PID typed. Resolves to the confirmed PID or null. */
  const typePid = async (r: ProcRow, verb: string): Promise<number | null> => {
    const v = await promptDialog({ title: `${verb} "${r.label}" on ${r.host}? Type its PID (${r.pid}) to confirm`, initial: "", okLabel: verb });
    return v !== null && v.trim() === String(r.pid) ? r.pid : null;
  };
  const stop = (rs: ProcRow[]) => {
    // Minecraft servers are never part of a multi-selection; a single selected server asks for its PID.
    const guarded = rs.filter((r) => r.guarded);
    const plain = rs.filter((r) => !r.guarded);
    return run("Stop", async () => {
      const seen = new Set<string>();
      for (const r of plain) {
        const k = r.kind === "gradle" && r.version ? `g${r.version}` : `p${r.pid}`;
        if (seen.has(k)) continue;
        seen.add(k);
        await daemonsApi.stop(r);
      }
      if (guarded.length === 1 && rs.length === 1) {
        const pid = await typePid(guarded[0], "Stop");
        if (pid === null) return "cancelled";
        await daemonsApi.stop(guarded[0], pid);
      } else if (guarded.length) return `skipped ${guarded.length} Minecraft server(s) (select one alone and type its PID)`;
    });
  };
  const kill = async (rs: ProcRow[]) => {
    if (!rs.length) return;
    const guarded = rs.filter((r) => r.guarded);
    const plain = rs.filter((r) => !r.guarded);
    if (guarded.length && rs.length > 1) {
      setStatus(`Minecraft servers are excluded from multi-kill; select ${guarded.length > 1 ? "one" : "it"} alone and type the PID`);
      if (!plain.length) return;
    }
    if (guarded.length === 1 && rs.length === 1) {
      const pid = await typePid(guarded[0], "Kill");
      if (pid !== null) run("Kill", () => daemonsApi.kill(guarded[0], pid));
      return;
    }
    const ok = await confirmDialog({
      title: "Kill process" + (plain.length > 1 ? "es" : ""),
      message: "Send SIGKILL to:\n" + plain.map((r) => `${r.pid}  ${r.label}${r.version ? " " + r.version : ""}  ${short(r.cwd)}`).join("\n"),
      okLabel: "Kill",
    });
    if (ok) run("Kill", async () => { for (const r of plain) await daemonsApi.kill(r); });
  };
  const stopIdle = () => run("Stop idle Gradle", async () => { await daemonsApi.terminate(host, idle.filter((r) => !r.guarded).map((r) => r.pid)); return `${idle.length} stopped`; });
  const stopAll = async () => {
    const ok = await confirmDialog({
      title: "Stop all Gradle on " + host,
      message: `Stops ${gradle.length} Gradle daemon(s), including busy ones (running builds will fail).`,
      okLabel: "Stop all",
    });
    if (ok) run("Stop all Gradle", () => daemonsApi.stopAllGradle(host, gradle));
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Delete" && selected.length) { e.preventDefault(); stop(selected); }
    if (e.key === "a" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); setSel(new Set(rows.filter((r) => !r.guarded).map((r) => r.pid))); }
  };
  const ctx = (e: React.MouseEvent, r: ProcRow) => {
    e.preventDefault();
    const target = sel.has(r.pid) ? selected : [r];
    if (!sel.has(r.pid)) setSel(new Set([r.pid]));
    showContextMenu(e.clientX, e.clientY, [
      { label: "Stop", run: () => stop(target) },
      { label: "Kill (SIGKILL)…", run: () => kill(target) },
      { label: "", separator: true },
      { label: "Copy PID", run: () => navigator.clipboard.writeText(String(r.pid)) },
      { label: "Copy command line", run: () => navigator.clipboard.writeText(r.cmd) },
      { label: "Copy project dir", disabled: !r.cwd, run: () => r.cwd && navigator.clipboard.writeText(r.cwd) },
      { label: "Open terminal in project dir", disabled: !r.cwd, run: () => r.cwd && openTerminal({ host: r.host, cwd: r.cwd }) },
    ]);
  };
  const click = (e: React.MouseEvent, r: ProcRow) => {
    setSel((s) => {
      if (e.metaKey || e.ctrlKey) { const n = new Set(s); n.has(r.pid) ? n.delete(r.pid) : n.add(r.pid); return n; }
      return new Set([r.pid]);
    });
  };

  return (
    <>
      <div className="dm-bar" onKeyDown={onKey}>
        <button className="dm-btn" disabled={working} onClick={refresh}>Refresh</button>
        <span className="sep" />
        <button className="dm-btn" disabled={working || !selected.length} onClick={() => stop(selected)}>Stop</button>
        <button className="dm-btn danger" disabled={working || !selected.length} onClick={() => kill(selected)}>Kill</button>
        <span className="sep" />
        <button className="dm-btn" disabled={working || !idle.length} onClick={stopIdle}>Stop idle Gradle ({idle.length})</button>
        <button className="dm-btn" disabled={working || !gradle.length} onClick={stopAll}>Stop all Gradle ({gradle.length})</button>
        <span className="dm-status">{status}</span>
      </div>
      <div className="dm-table" tabIndex={0} onKeyDown={onKey}>
        <table>
          <colgroup>{COLS.map((c) => <col key={c.key} style={{ width: c.w }} />)}</colgroup>
          <thead>
            <tr>
              {COLS.map((c) => (
                <th key={c.key} className={c.num ? "num" : ""} onClick={() => setSort((s) => ({ key: c.key, dir: s.key === c.key ? (-s.dir as 1 | -1) : 1 }))}>
                  {c.title}{sort.key === c.key ? (sort.dir === 1 ? " ▲" : " ▼") : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.pid} className={sel.has(r.pid) ? "sel" : ""} onClick={(e) => click(e, r)} onContextMenu={(e) => ctx(e, r)} title={r.cmd}>
                <td className="num">{r.pid}</td>
                <td><span className={"dm-tag " + r.kind}>{r.kind === "minecraft" ? "mc" : r.kind}</span> {r.label}</td>
                <td>{r.version ?? ""}</td>
                <td className="num">{fmtBytes(r.rss)}</td>
                <td className="num">{r.cpu.toFixed(1)}%</td>
                <td className="num">{fmtUptime(r.uptimeSecs)}</td>
                <td className={r.busy ? "dm-busy" : "dm-idle"}>{r.busy === null ? "" : r.busy ? "busy" : "idle"}</td>
                <td className="mono" title={r.cwd ?? ""}>{short(r.cwd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <div className="dm-empty">No matching processes on {host}.</div>}
      </div>
    </>
  );
}

function CleanupTab({ host }: { host: string }) {
  const [items, setItems] = useState<CleanItem[]>([]);
  const [sizes, setSizes] = useState<Record<string, number>>({});
  const [progress, setProgress] = useState<[number, number] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [status, setStatus] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const scanId = useRef("");

  const scan = useCallback(() => {
    const id = `${host}-${Date.now()}`;
    scanId.current = id;
    setItems([]); setSizes({}); setProgress(null); setPicked(new Set()); setScanning(true); setStatus("");
    daemonsApi.cleanupScan(host, id).catch((e) => { setStatus(errMsg(e)); setScanning(false); });
  }, [host]);

  useEffect(() => {
    let un: (() => void) | undefined;
    let dead = false;
    daemonsApi.onCleanup((e: CleanEvent) => {
      if (e.host !== host || e.scan !== scanId.current) return;
      if (e.items) setItems(e.items);
      if (e.id != null && e.bytes != null) setSizes((s) => ({ ...s, [e.id!]: e.bytes! }));
      if (e.progress) setProgress(e.progress);
      if (e.done) { setScanning(false); if (e.error) setStatus(e.error); }
    }).then((u) => (dead ? u() : (un = u)));
    scan();
    return () => { dead = true; un?.(); daemonsApi.cleanupCancel(host).catch(() => {}); };
  }, [host, scan]);

  const editRoots = async () => {
    const cur = getExtraRoots(host).join(", ");
    const v = await promptDialog({ title: `Extra scan roots on ${host} (comma separated; empty = $HOME + /opt/mc if present)`, initial: cur, okLabel: "Save" });
    if (v === null) return;
    setExtraRoots(host, v.split(",").map((x) => x.trim()).filter(Boolean));
    scan();
  };
  const group = (g: string) => items.filter((i) => i.group === g).sort((a, b) => (sizes[b.id] ?? -1) - (sizes[a.id] ?? -1));
  const sum = (xs: CleanItem[]) => xs.reduce((n, i) => n + (sizes[i.id] ?? 0), 0);
  const chosen = items.filter((i) => picked.has(i.id) && i.cleanable);
  const cleanables = (g: string) => group(g).filter((i) => i.cleanable);

  const clean = async (xs: CleanItem[]) => {
    if (!xs.length) return;
    const ok = await confirmDialog({
      title: `Clean ${xs.length} item(s) on ${host}`,
      message:
        "These directories will be moved to the Trash (" + (host === "local" ? "~/.Trash" : "~/.local/share/Trash") +
        "; empty the Trash to reclaim space):\n\n" +
        xs.map((i) => `${i.path}  (${sizes[i.id] != null ? fmtBytes(sizes[i.id]) : "?"})`).join("\n") +
        `\n\nTotal: ${fmtBytes(sum(xs))}`,
      okLabel: "Move to Trash",
    });
    if (!ok) return;
    try {
      const r = await daemonsApi.cleanupRun(host, xs.map((i) => i.path));
      setStatus(`Moved ${r.moved.length} to Trash` + (r.skipped.length ? `, skipped ${r.skipped.length}: ${r.skipped[0][1]}` : ""));
    } catch (e) {
      setStatus(errMsg(e));
    }
    scan();
  };
  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const Section = ({ g, title }: { g: string; title: string }) => {
    const xs = group(g);
    return (
      <>
        <tr><td colSpan={4} className="dm-group">{title} · {fmtBytes(sum(xs))}
          <button className="dm-btn" style={{ marginLeft: 8 }} disabled={!cleanables(g).length} onClick={() => clean(cleanables(g))}>Clean all cleanable ({cleanables(g).length})</button>
        </td></tr>
        {xs.map((i) => (
          <tr key={i.id} className={picked.has(i.id) ? "sel" : ""} onClick={() => i.cleanable && toggle(i.id)} title={i.path}>
            <td><input type="checkbox" disabled={!i.cleanable} checked={picked.has(i.id)} onChange={() => toggle(i.id)} /></td>
            <td>{i.label}</td>
            <td className="num">{sizes[i.id] != null ? fmtBytes(sizes[i.id]) : scanning ? "…" : ""}</td>
            <td className={i.cleanable ? "" : "dm-idle"}>{i.cleanable ? "cleanable" : i.note ?? "in use"}</td>
          </tr>
        ))}
      </>
    );
  };

  return (
    <>
      <div className="dm-bar">
        <button className="dm-btn" disabled={scanning} onClick={scan}>Rescan</button>
        <button className="dm-btn" disabled={!chosen.length} onClick={() => clean(chosen)}>Clean selected ({chosen.length})</button>
        <button className="dm-btn" title="Extra directories searched for gradle wrappers (protects their distributions). Default: $HOME plus /opt/mc when present." onClick={editRoots}>Scan roots…</button>
        <span className="dm-status">{scanning ? `Scanning${progress ? ` ${progress[0]}/${progress[1]}` : ""}…` : status || `~/.gradle on ${host}: ${fmtBytes(sum(items))}`}</span>
      </div>
      {scanning && <div className="dm-prog" style={{ width: progress ? `${(progress[0] / Math.max(1, progress[1])) * 100}%` : "10%" }} />}
      <div className="dm-table">
        <table>
          <colgroup><col style={{ width: "28px" }} /><col /><col style={{ width: "90px" }} /><col style={{ width: "230px" }} /></colgroup>
          <tbody>
            {Section({ g: "daemon", title: "Daemon logs & registry (~/.gradle/daemon)" })}
            {Section({ g: "caches", title: "Caches (~/.gradle/caches)" })}
            {Section({ g: "wrapper", title: "Wrapper distributions (~/.gradle/wrapper/dists)" })}
          </tbody>
        </table>
        {!items.length && !scanning && <div className="dm-empty">Nothing found.</div>}
      </div>
    </>
  );
}
