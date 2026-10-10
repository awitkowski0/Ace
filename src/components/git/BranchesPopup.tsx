import { useEffect, useMemo, useRef, useState } from "react";
import { PopupShell, openPopup, type PopupProps } from "../shell/popups";
import { promptDialog, confirmDialog } from "../shell/dialogs";
import { showContextMenu } from "../shell/contextMenu";
import { BranchIcon } from "../shell/icons";
import { checkout, exec, fetchAll, git, gitStore, pushCurrent, updateProject, type Branches } from "./api";
import { keysFor } from "../../actions/keymap";
import { formatKeystroke } from "../../actions/keystroke";

type Item =
  | { t: "section"; label: string }
  | { t: "action"; label: string; hint?: string; run: () => void }
  | { t: "branch"; name: string; remote: boolean; current: boolean; sub?: string };

export async function newBranchFrom(start?: string) {
  const name = await promptDialog({ title: start ? `New Branch from ${start.slice(0, 12)}` : "New Branch", okLabel: "Create" });
  if (name?.trim()) await checkout(name.trim(), { create: true, startPoint: start });
}

const hint = (id: string) => { const k = keysFor(id)[0]; return k ? formatKeystroke(k) : undefined; };

export function BranchesPopup({ onClose }: PopupProps) {
  const [br, setBr] = useState<Branches | null>(null);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const root = gitStore.get().root;
  const status = gitStore.get().status;
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => { if (root) git.branches(root).then(setBr).catch(() => setBr({ local: [], remote: [] })); }, [root]);

  const items = useMemo<Item[]>(() => {
    const f = q.trim().toLowerCase();
    const match = (n: string) => !f || n.toLowerCase().includes(f);
    const out: Item[] = [];
    const run = (fn: () => unknown) => () => { onClose(); fn(); };
    const acts: Item[] = [
      { t: "action", label: "New Branch…", run: run(() => newBranchFrom()) },
      { t: "action", label: "Fetch", run: run(fetchAll) },
      { t: "action", label: "Update Project", hint: hint("Vcs.UpdateProject"), run: run(updateProject) },
      { t: "action", label: "Push…", hint: hint("Vcs.Push"), run: run(pushCurrent) },
    ];
    out.push(...acts.filter((a) => a.t === "action" && match(a.label)));
    const local = (br?.local ?? []).filter((b) => match(b.name));
    const remote = (br?.remote ?? []).filter((b) => match(b.name));
    if (local.length) {
      out.push({ t: "section", label: "Local" });
      for (const b of local) out.push({ t: "branch", name: b.name, remote: false, current: b.current, sub: b.upstream ?? undefined });
    }
    if (remote.length) {
      out.push({ t: "section", label: "Remote" });
      for (const b of remote) out.push({ t: "branch", name: b.name, remote: true, current: false });
    }
    return out;
  }, [br, q, onClose]);

  const selectable = items.map((it, i) => (it.t === "section" ? -1 : i)).filter((i) => i >= 0);
  const cur = selectable[Math.min(sel, selectable.length - 1)] ?? -1;

  const pick = (it: Item) => {
    if (it.t === "action") return it.run();
    if (it.t !== "branch" || it.current) return;
    onClose();
    if (!it.remote) return void checkout(it.name);
    const short = it.name.slice(it.name.indexOf("/") + 1);
    if (br?.local.some((b) => b.name === short)) checkout(short);
    else checkout(it.name, { track: true });
  };
  const ctx = (e: React.MouseEvent, it: Item) => {
    e.preventDefault();
    if (it.t !== "branch" || !root) return;
    showContextMenu(e.clientX, e.clientY, [
      { label: "Checkout", disabled: it.current, run: () => pick(it) },
      { label: `New Branch from '${it.name}'…`, run: () => { onClose(); newBranchFrom(it.name); } },
      { separator: true, label: "" },
      {
        label: "Delete", disabled: it.current || it.remote,
        run: async () => {
          onClose();
          if (await confirmDialog({ title: "Delete Branch", message: `Delete branch ${it.name}?`, okLabel: "Delete" }))
            await exec(`branch -d ${it.name}`, () => git.deleteBranch(root, it.name, false)).then(async (r) => {
              if (r === undefined && (await confirmDialog({ title: "Delete Branch", message: `${it.name} is not fully merged. Force delete?`, okLabel: "Force Delete" })))
                await exec(`branch -D ${it.name}`, () => git.deleteBranch(root, it.name, true));
            });
        },
      },
    ]);
  };

  useEffect(() => { list.current?.querySelector(".popup-row.selected")?.scrollIntoView({ block: "nearest" }); }, [cur]);

  return (
    <PopupShell onClose={onClose} width={440} height={Math.min(520, window.innerHeight - 140)}>
      <div className="popup-tabs"><span className="popup-title">{status?.branch ?? "Branches"}</span>
        {status && status.upstream && <span className="gdim">{status.upstream}{status.ahead ? ` ↑${status.ahead}` : ""}{status.behind ? ` ↓${status.behind}` : ""}</span>}
      </div>
      <input
        className="popup-input"
        autoFocus
        placeholder="Search branches and actions"
        value={q}
        spellCheck={false}
        onChange={(e) => { setQ(e.target.value); setSel(0); }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(selectable.length - 1, s + 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
          else if (e.key === "Enter" && cur >= 0) pick(items[cur]);
        }}
      />
      <div className="popup-list" ref={list}>
        {items.map((it, i) =>
          it.t === "section" ? <div key={"s" + it.label} className="popup-section">{it.label}</div> : (
            <div key={i} className={"popup-row" + (i === cur ? " selected" : "")} onMouseMove={() => setSel(selectable.indexOf(i))} onClick={() => pick(it)} onContextMenu={(e) => ctx(e, it)}>
              {it.t === "branch" ? (
                <>
                  <span className="gicon" style={{ color: it.current ? "var(--nord14)" : undefined }}><BranchIcon /></span>
                  <span style={{ fontWeight: it.current ? 600 : 400 }}>{it.name}</span>
                  {it.sub && <span className="gdim">{it.sub}</span>}
                </>
              ) : (
                <>
                  <span>{it.label}</span><div className="grow" /><span className="gdim">{it.hint}</span>
                </>
              )}
            </div>
          ),
        )}
        {br === null && <div className="git-empty">Loading…</div>}
      </div>
    </PopupShell>
  );
}

export const openBranches = () => openPopup("GitBranches");
