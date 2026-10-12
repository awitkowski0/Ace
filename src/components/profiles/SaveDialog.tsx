import { useEffect, useMemo, useRef, useState } from "react";
import { joinPath, basename } from "../../lib/ipc";
import { useStore } from "../../lib/store";
import { projectStore } from "../../lib/project";
import { gitStore, refreshNow, type Change } from "../git/api";
import { openExternal } from "../../lib/external";
import { PopupShell, openPopup, type PopupProps } from "../shell/popups";
import { classifyAsset, suggestMessage } from "./assets";
import { ghAvailable, saveToGit, type SaveResult } from "./gitops";
import { ensureLatest } from "./updates";
import { Thumb } from "./Thumb";
import { showBalloon, hideBalloon, toast } from "./notice";

const WORD: Record<string, string> = { added: "new", untracked: "new", deleted: "removed", renamed: "renamed", conflict: "clashes" };
const word = (k: string) => WORD[k] ?? "changed";

let pending: ((committed: boolean) => void) | null = null;

/** "Save to Git": nudge when behind, then open the dialog. Resolves true when something was saved. */
export async function saveFlow(): Promise<boolean> {
  await refreshNow();
  const st = gitStore.get().status;
  if (!st?.isRepo) { toast("This folder isn't under Git, so there's nowhere to save to.", "warn"); return false; }
  if (!st.changes.some((c) => classifyAsset(c.path))) { toast("Nothing to save — no asset changes.", "info"); return false; }
  if (!(await ensureLatest("save"))) return false;
  return new Promise<boolean>((resolve) => { pending?.(false); pending = resolve; openPopup("AssetSave"); });
}

export function SavePopup({ onClose }: PopupProps) {
  const { status } = useStore(gitStore);
  const { root } = useStore(projectStore);
  const changes = status?.changes ?? [];
  const assets = useMemo(() => changes.filter((c) => classifyAsset(c.path)), [changes]);
  const code = useMemo(() => changes.filter((c) => !classifyAsset(c.path)), [changes]);
  const [off, setOff] = useState<Set<string>>(() => new Set());
  const chosen = assets.filter((c) => !off.has(c.path));
  const suggested = useMemo(() => suggestMessage(chosen), [chosen.map((c) => c.path + c.kind).join("|")]); // eslint-disable-line react-hooks/exhaustive-deps
  const [msg, setMsg] = useState(suggested);
  const [touched, setTouched] = useState(false);
  const [push, setPush] = useState(true);
  const [pr, setPr] = useState(false);
  const [gh, setGh] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (!touched) setMsg(suggested); }, [suggested, touched]);
  useEffect(() => { void ghAvailable().then(setGh); area.current?.focus(); area.current?.select(); }, []);
  const main = status?.branch === "main" || status?.branch === "master";

  const close = (committed: boolean) => { const p = pending; pending = null; onClose(); p?.(committed); };
  const submit = async () => {
    if (busy || !msg.trim() || !chosen.length) return;
    setBusy(true);
    setErr(null);
    const r: SaveResult = await saveToGit({ message: msg.trim(), changes: chosen as Change[], push, pr: pr && push && gh });
    setBusy(false);
    if (!r.ok) return setErr(r.message);
    toast(r.message, r.pushed || !push ? "ok" : "warn", 6000);
    if (r.prUrl) showBalloon({ id: "profiles.pr", text: "Your review request is ready.", actions: [{ label: "Open it", primary: true, run: () => { hideBalloon("profiles.pr"); void openExternal(r.prUrl!); } }, { label: "Close", run: () => hideBalloon("profiles.pr") }] });
    close(true);
  };

  return (
    <PopupShell onClose={() => close(false)} width={640}>
      <div className="popup-tabs"><span className="popup-title">Save to Git</span></div>
      <div className="ap-save" data-testid="asset-save">
        <div className="ap-save-list">
          {assets.map((c) => {
            const info = classifyAsset(c.path)!;
            return (
              <label key={c.path} className="ap-save-row" data-path={c.path}>
                <input type="checkbox" checked={!off.has(c.path)} onChange={() => setOff((s) => { const n = new Set(s); if (n.has(c.path)) n.delete(c.path); else n.add(c.path); return n; })} />
                {root && <Thumb loc={{ host: root.host, path: joinPath(root.path, c.path) }} type={info.type} />}
                <span className="ap-save-name">{info.name}</span>
                <span className={"ap-save-st " + c.kind}>{word(c.kind)}</span>
                <span className="ap-save-path">{c.path.includes("/") ? c.path.slice(0, c.path.lastIndexOf("/")) : ""}</span>
              </label>
            );
          })}
          {code.map((c) => (
            <div key={c.path} className="ap-save-row code" data-path={c.path} data-excluded="1" title="Code files aren't saved from Asset Dev">
              <input type="checkbox" disabled checked={false} readOnly />
              <span className="ap-save-name">{basename(c.path)}</span>
              <span className="ap-save-st">not included</span>
              <span className="ap-save-path">{c.path.includes("/") ? c.path.slice(0, c.path.lastIndexOf("/")) : ""}</span>
            </div>
          ))}
        </div>
        {code.length > 0 && <div className="ap-warn" data-testid="asset-save-warn">{code.length} code file{code.length === 1 ? " was" : "s were"} changed too. {code.length === 1 ? "It stays" : "They stay"} on your computer and {code.length === 1 ? "isn't" : "aren't"} part of this save.</div>}
        <div className="ap-field-label">Describe what you changed</div>
        <textarea ref={area} data-testid="asset-save-msg" className="ap-msg" rows={2} value={msg} spellCheck={false}
          onChange={(e) => { setMsg(e.target.value); setTouched(true); }}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit(); } }} />
        <label className="ap-check"><input type="checkbox" data-testid="asset-save-push" checked={push} onChange={(e) => setPush(e.target.checked)} /> Share with my team now{status?.branch ? ` (${status.branch})` : ""}</label>
        {gh && !main && <label className="ap-check"><input type="checkbox" data-testid="asset-save-pr" checked={pr && push} disabled={!push} onChange={(e) => setPr(e.target.checked)} /> Ask for a review (opens a pull request)</label>}
        {err && <div className="ap-err" data-testid="asset-save-err">{err}</div>}
        <div className="ap-buttons">
          <button onClick={() => close(false)}>Cancel</button>
          <button className="primary" data-testid="asset-save-ok" disabled={busy || !msg.trim() || !chosen.length} onClick={() => void submit()}>{busy ? "Saving…" : "Save"}</button>
        </div>
      </div>
    </PopupShell>
  );
}
