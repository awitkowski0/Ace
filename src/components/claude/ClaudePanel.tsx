import { useEffect, useMemo, useRef, useState } from "react";
import { invoke, basename } from "../../lib/ipc";
import { useStore } from "../../lib/store";
import type { ToolWindowProps } from "../../toolwindows/registry";
import { ChevronDown, ChevronRight, SparkIcon } from "../shell/icons";
import { showContextMenu } from "../shell/contextMenu";
import { promptDialog } from "../shell/dialogs";
import { openFile } from "../../editor/store";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { claudeApi, claudeStore, launch, openSessionProject, refreshHost, relTime, runningIds, unknownRunning, type SessionInfo } from "./api";
import "./claude.css";

const HOST_KEY = "atelier.claude.host";
const readHost = () => {
  try {
    return localStorage.getItem(HOST_KEY) || "local";
  } catch {
    return "local";
  }
};

interface Group {
  key: string;
  host: string;
  cwd: string;
  items: SessionInfo[];
}

export function ClaudePanel({ root }: ToolWindowProps) {
  const [host, setHost] = useState(readHost);
  const [hosts, setHosts] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [, tick] = useState(0);
  const { hosts: data } = useStore(claudeStore);

  useEffect(() => {
    invoke<string[]>("remote_hosts").then(setHosts).catch(() => {});
  }, []);
  const choose = (h: string) => {
    setHost(h);
    try {
      localStorage.setItem(HOST_KEY, h);
    } catch {}
  };
  const active = useMemo(() => (host === "all" ? ["local", ...hosts.filter((h) => h === "mc")] : [host]), [host, hosts]);
  const activeKey = active.join(",");

  // Refresh: local via watcher, remote every 30s, only while mounted (= visible) and the window is visible.
  useEffect(() => {
    const doRefresh = () => {
      if (!document.hidden) active.forEach((h) => void refreshHost(h));
    };
    doRefresh();
    const hasRemote = active.some((h) => h !== "local");
    const iv = window.setInterval(() => {
      doRefresh();
      tick((n) => n + 1);
    }, hasRemote ? 30_000 : 60_000);
    let un: (() => void) | undefined;
    if (active.includes("local")) {
      claudeApi.watch().catch(() => {});
      claudeApi.onChanged(() => active.includes("local") && !document.hidden && void refreshHost("local")).then((u) => (un = u));
    }
    return () => {
      clearInterval(iv);
      un?.();
      claudeApi.unwatch().catch(() => {});
    };
  }, [activeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const loading = active.some((h) => data[h]?.loading);
  const errors = active.map((h) => (data[h]?.error ? `${h}: ${data[h]!.error}` : null)).filter(Boolean) as string[];
  const running = useMemo(() => new Set(active.flatMap((h) => [...runningIds(data[h])].map((id) => `${h}:${id}`))), [data, activeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const unknown = useMemo(() => {
    const m = new Map<string, number>();
    for (const h of active) for (const [cwd, n] of unknownRunning(data[h])) m.set(`${h}:${cwd}`, n);
    return m;
  }, [data, activeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const groups = useMemo(() => {
    const ql = q.trim().toLowerCase();
    const map = new Map<string, Group>();
    for (const h of active) {
      for (const s of data[h]?.sessions ?? []) {
        if (ql && !(s.title.toLowerCase().includes(ql) || s.cwd.toLowerCase().includes(ql) || (s.branch ?? "").toLowerCase().includes(ql) || s.id.startsWith(ql))) continue;
        const key = `${s.host}:${s.cwd}`;
        let g = map.get(key);
        if (!g) map.set(key, (g = { key, host: s.host, cwd: s.cwd, items: [] }));
        g.items.push(s);
      }
    }
    const cur = `${root.host}:${root.path}`;
    return [...map.values()].sort((a, b) => (a.key === cur ? -1 : b.key === cur ? 1 : b.items[0].modified - a.items[0].modified));
  }, [data, q, activeKey, root]); // eslint-disable-line react-hooks/exhaustive-deps

  const curKey = `${root.host}:${root.path}`;
  const isOpen = (g: Group) => (q ? true : open[g.key] ?? g.key === curKey);
  const flat = groups.flatMap((g) => (isOpen(g) ? g.items : []));
  const selected = flat.find((s) => `${s.host}:${s.id}` === sel) ?? null;

  const pickDir = async (h: string): Promise<string | null> => {
    if (h === "local") {
      const d = await openDialog({ directory: true, multiple: false, title: "New Claude session in…" });
      return typeof d === "string" ? d : null;
    }
    return promptDialog({ title: `Directory on ${h}`, initial: root.host === h ? root.path : "~", okLabel: "Start" });
  };
  const newIn = async (h: string) => {
    const d = await pickDir(h);
    if (d) launch.newSession(h, d);
  };
  const newHere = () => {
    const h = host === "all" ? root.host : host;
    if (root.host === h) launch.newSession(h, root.path);
    else void newIn(h);
  };
  const continueLast = () => {
    const h = host === "all" ? root.host : host;
    if (root.host === h) launch.continueLast(h, root.path);
    else if (selected) launch.continueLast(selected.host, selected.cwd);
  };

  const menu = (e: React.MouseEvent, s: SessionInfo) => {
    e.preventDefault();
    setSel(`${s.host}:${s.id}`);
    showContextMenu(e.clientX, e.clientY, [
      { label: "Resume", run: () => launch.resume(s) },
      { label: "Continue Last in Project", run: () => launch.continueLast(s.host, s.cwd) },
      { label: "Fork Session", run: () => launch.fork(s) },
      { label: "New Session in Project", run: () => launch.newSession(s.host, s.cwd) },
      { label: "", separator: true },
      { label: "Open Project", run: () => void openSessionProject(s) },
      { label: s.host === "local" ? "Reveal JSONL in Finder" : "Open JSONL in Editor", run: () => (s.host === "local" ? claudeApi.reveal(s.file) : void openFile({ host: s.host, path: s.file })) },
      { label: "Copy Session ID", run: () => void navigator.clipboard.writeText(s.id) },
    ]);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === "INPUT" && e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const i = flat.findIndex((s) => `${s.host}:${s.id}` === sel);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = flat[Math.max(0, Math.min(flat.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
      if (n) setSel(`${n.host}:${n.id}`);
    } else if (e.key === "Enter" && selected) launch.resume(selected);
  };

  const others = hosts.filter((h) => h !== "mc");
  const seg = (id: string, label: string) => (
    <button className={host === id ? "on" : ""} onClick={() => choose(id)}>{label}</button>
  );

  return (
    <div className="claude-panel" tabIndex={0} onKeyDown={onKey} data-autofocus>
      <div className="claude-bar">
        <div className="claude-seg">
          {seg("local", "Local")}
          {hosts.includes("mc") && seg("mc", "mc")}
          {seg("all", "All")}
        </div>
        {others.length > 0 && (
          <select value={others.includes(host) ? host : ""} onChange={(e) => e.target.value && choose(e.target.value)}>
            <option value="">Other…</option>
            {others.map((h) => <option key={h} value={h}>{h}</option>)}
          </select>
        )}
        <div style={{ flex: 1 }} />
        <button className="icon-btn sm" title="New Session (in project root)" onClick={newHere}><SparkIcon /></button>
        <button className="icon-btn sm" title="New Session in Directory…" onClick={() => void newIn(host === "all" ? root.host : host)}>…</button>
        <button className="icon-btn sm" title="Continue Last (claude -c)" onClick={continueLast}>↻</button>
        <button className="icon-btn sm" title="Refresh" onClick={() => active.forEach((h) => void refreshHost(h))}>{loading ? "…" : "⟳"}</button>
      </div>
      <input className="claude-search" placeholder="Filter sessions" value={q} onChange={(e) => setQ(e.target.value)} />
      {errors.map((er) => <div key={er} className="claude-err">{er}</div>)}
      <div className="claude-list">
        {groups.length === 0 && <div className="claude-empty">{loading ? "Loading sessions…" : "No sessions"}</div>}
        {groups.map((g) => (
          <div key={g.key}>
            <div className="claude-group" onClick={() => setOpen((o) => ({ ...o, [g.key]: !isOpen(g) }))}
              onContextMenu={(e) => { e.preventDefault(); showContextMenu(e.clientX, e.clientY, [
                { label: "New Session Here", run: () => launch.newSession(g.host, g.cwd) },
                { label: "Continue Last", run: () => launch.continueLast(g.host, g.cwd) },
                { label: "Open Project", run: () => void openSessionProject(g.items[0]) },
              ]); }}>
              {isOpen(g) ? <ChevronDown /> : <ChevronRight />}
              <span>{basename(g.cwd) || g.cwd}</span>
              {host === "all" && g.host !== "local" && <span className="claude-badge host">{g.host}</span>}
              {(unknown.get(g.key) ?? 0) > 0 && (
                <span className="claude-badge" title="A claude process is running here but its session cannot be identified (no --resume and no recent writes)">
                  running (session unknown){(unknown.get(g.key) ?? 0) > 1 ? ` ×${unknown.get(g.key)}` : ""}
                </span>
              )}
              <span className="path">{g.cwd}</span>
              <span className="count">{g.items.length}</span>
            </div>
            {isOpen(g) && g.items.map((s) => {
              const k = `${s.host}:${s.id}`;
              return (
                <div key={k} className={"claude-row" + (sel === k ? " sel" : "")} title={`${s.title}\n${s.id}`}
                  onClick={() => setSel(k)} onDoubleClick={() => launch.resume(s)} onContextMenu={(e) => menu(e, s)}>
                  <div className="t">
                    {running.has(k) && <span className="claude-badge">running</span>}
                    <span className="txt">{s.title}</span>
                  </div>
                  <div className="m">
                    <span>{relTime(s.modified)}</span>
                    <span>{s.approx ? "~" : ""}{s.messages} msgs</span>
                    {s.branch && <span>{s.branch}</span>}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
