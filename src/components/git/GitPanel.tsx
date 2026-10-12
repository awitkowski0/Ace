import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../../lib/store";
import { showContextMenu } from "../shell/contextMenu";
import { VirtualList } from "./VirtualList";
import { git, gitStore, refreshAll, type Commit, type CommitFile } from "./api";
import { RefreshIcon, StopIcon } from "./icons";
import { openCommitFileDiff } from "./diff";
import { basename } from "../../lib/ipc";
import type { ToolWindowProps } from "../../toolwindows/registry";

const PAGE = 300;

function fmtDate(t: number) {
  const d = new Date(t * 1000);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleString(undefined, { month: "short", day: "numeric", year: sameYear ? undefined : "numeric", hour: "numeric", minute: "2-digit" });
}

function Refs({ refs }: { refs: string[] }) {
  return (
    <>
      {refs.map((r) => {
        const tag = r.startsWith("tag: ");
        const head = r.startsWith("HEAD -> ");
        const name = tag ? r.slice(5) : head ? r.slice(8) : r;
        const remote = !tag && !head && r.includes("/");
        return <span key={r} className={"gref" + (tag ? " tag" : head ? " head" : remote ? " remote" : "")}>{name}</span>;
      })}
    </>
  );
}

const STATUS_COLOR: Record<string, string> = { A: "var(--nord14)", D: "var(--fg-faint)", M: "var(--nord9)", R: "var(--nord9)", C: "var(--nord9)" };

function Details({ commit }: { commit: Commit }) {
  const root = gitStore.get().root!;
  const [files, setFiles] = useState<CommitFile[]>([]);
  const [body, setBody] = useState("");
  useEffect(() => {
    setFiles([]);
    setBody(commit.subject);
    git.commitFiles(root, commit.hash).then(setFiles).catch(() => {});
    git.body(root, commit.hash).then(setBody).catch(() => {});
  }, [commit.hash, root]);
  return (
    <div className="gdetails">
      <div className="gfiles">
        <div className="gdim gsec">{files.length} file{files.length === 1 ? "" : "s"} changed</div>
        {files.map((f) => (
          <div key={f.path} className="grow-row" onDoubleClick={() => openCommitFileDiff(commit.hash, f)} title="Double-click to show diff">
            <span className="gstat" style={{ color: STATUS_COLOR[f.status] }}>{f.status}</span>
            <span className="gname">{basename(f.path)}</span>
            <span className="gdim">{f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : ""}</span>
          </div>
        ))}
      </div>
      <div className="gmeta">
        <pre className="gbody">{body}</pre>
        <div className="gdim">
          <b>{commit.hash.slice(0, 8)}</b> {commit.author} &lt;{commit.email}&gt; on {fmtDate(commit.time)}
        </div>
        {commit.refs.length > 0 && <div style={{ marginTop: 4 }}><Refs refs={commit.refs} /></div>}
      </div>
    </div>
  );
}

function LogTab() {
  const { root, logVersion, status } = useStore(gitStore);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [all, setAll] = useState(false);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const loading = useRef(false);
  const gen = useRef(0);

  const load = useCallback((reset: boolean) => {
    if (!root || loading.current && !reset) return;
    const my = reset ? ++gen.current : gen.current;
    loading.current = true;
    const skip = reset ? 0 : commits.length;
    git.log(root, skip, PAGE, all, q.trim() || undefined)
      .then((c) => {
        if (my !== gen.current) return;
        setCommits((p) => (reset ? c : [...p, ...c]));
        setDone(c.length < PAGE);
      })
      .catch(() => my === gen.current && setDone(true))
      .finally(() => { if (my === gen.current) loading.current = false; });
  }, [root, all, q, commits.length]);

  // reload on repo changes / filters (search debounced)
  useEffect(() => {
    const t = setTimeout(() => load(true), q ? 250 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, all, q, logVersion]);

  if (status && !status.isRepo) return <div className="git-empty">Not a Git repository</div>;
  const selected = commits.find((c) => c.hash === sel) ?? null;
  return (
    <div className="glog">
      <div className="glog-list">
        <div className="gtoolbar">
          <input className="gsearch" placeholder="Text or hash" value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false} />
          <select className="gselect" value={all ? "all" : "head"} onChange={(e) => setAll(e.target.value === "all")}>
            <option value="head">Current branch</option>
            <option value="all">All branches</option>
          </select>
          <button className="icon-btn sm" title="Refresh" onClick={() => refreshAll()}><RefreshIcon /></button>
        </div>
        <VirtualList
          count={commits.length}
          onNearEnd={() => !done && load(false)}
          render={(i) => {
            const c = commits[i];
            return (
              <div
                className={"grow-row glogrow" + (c.hash === sel ? " selected" : "")}
                onMouseDown={() => setSel(c.hash)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setSel(c.hash);
                  showContextMenu(e.clientX, e.clientY, [
                    { label: "Copy Revision Number", run: () => navigator.clipboard.writeText(c.hash) },
                    { label: "New Branch…", run: () => import("./BranchesPopup").then((m) => m.newBranchFrom(c.hash)) },
                  ]);
                }}
              >
                <span className="gsubject"><Refs refs={c.refs} />{c.subject}</span>
                <span className="gauthor">{c.author}</span>
                <span className="gdate">{fmtDate(c.time)}</span>
              </div>
            );
          }}
        />
        {commits.length === 0 && <div className="git-empty">{done ? "No commits" : "Loading…"}</div>}
      </div>
      {selected && <Details commit={selected} />}
    </div>
  );
}

function ConsoleTab() {
  const { console: lines, job } = useStore(gitStore);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { const e = ref.current; if (e) e.scrollTop = e.scrollHeight; }, [lines.length]);
  return (
    <div className="gconsole-wrap">
      <div className="gtoolbar">
        {job !== null && <button className="icon-btn sm" title="Cancel" onClick={() => git.cancel(job)}><StopIcon /></button>}
        <button className="gbtn" onClick={() => gitStore.set({ console: [] })}>Clear</button>
      </div>
      <div className="gconsole" ref={ref}>
        {lines.map((l, i) => <div key={i} className={"gline " + l.kind}>{l.text}</div>)}
      </div>
    </div>
  );
}

export function GitPanel(_: ToolWindowProps) {
  const [tab, setTab] = useState<"log" | "console">(() => (localStorage.getItem("ace.git.tab") as "log" | "console") || "log");
  const { job } = useStore(gitStore);
  const set = (t: "log" | "console") => { setTab(t); try { localStorage.setItem("ace.git.tab", t); } catch {} };
  // surface the console when a network op starts
  useEffect(() => { if (job !== null) setTab("console"); }, [job]);
  return (
    <div className="gpanel" data-gpanel tabIndex={-1}>
      <div className="gtabs">
        <button className={"gtab" + (tab === "log" ? " active" : "")} onClick={() => set("log")}>Log</button>
        <button className={"gtab" + (tab === "console" ? " active" : "")} onClick={() => set("console")}>Console</button>
      </div>
      {tab === "log" ? <LogTab /> : <ConsoleTab />}
    </div>
  );
}
