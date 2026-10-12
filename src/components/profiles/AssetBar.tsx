import { useState } from "react";
import { useStore } from "../../lib/store";
import { gitStore } from "../git/api";
import { classifyAsset } from "./assets";
import { getLatest } from "./gitops";
import { openBranches } from "./BranchPicker";
import { saveFlow } from "./SaveDialog";
import { updatesStore, behindCount } from "./updates";
import { gameStore, runGame, stopGame, chooseRunTask, discoverRun, GAME_TEXT } from "./rungame";
import { showContextMenu } from "../shell/contextMenu";
import { ChevronDown, BranchIcon } from "../shell/icons";

const S = { fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round" } as const;
const Down = () => <svg width="16" height="16" viewBox="0 0 16 16" {...S}><path d="M8 2.5v8M4.5 7.5L8 11l3.5-3.5M3 13.5h10" /></svg>;
const Save = () => <svg width="16" height="16" viewBox="0 0 16 16" {...S}><path d="M3 2.5h8l2 2v9H3zM5.5 2.5v3.5h4V2.5M5.5 13.5V9.5h5v4" /></svg>;
const Play = () => <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M4.5 2.8l9 5.2-9 5.2z" /></svg>;
const Stop = () => <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><rect x="3.5" y="3.5" width="9" height="9" rx="1.2" /></svg>;

/** Run Game version menu: every Gradle client task the project offers, the one in use ticked; "Automatic" follows the branch. */
async function openRunMenu(e: React.MouseEvent<HTMLElement>) {
  const r = e.currentTarget.getBoundingClientRect();
  const d = await discoverRun();
  const picked = d.source === "chosen";
  showContextMenu(r.left, r.bottom + 2, [
    { label: `${picked ? "    " : "✓  "}Automatic: ${d.name ?? d.task}${picked ? "" : " (matches my branch)"}`, run: () => void chooseRunTask(null) },
    { separator: true, label: "" },
    ...d.options.map((o) => ({ label: `${picked && o.task === d.task ? "✓  " : "    "}${o.name}`, run: () => void chooseRunTask(o.task) })),
  ]);
}

/** Asset Dev toolbar (docs/PROFILES.md): Get latest, Branch, Save to Git, Run Game and the status chip. */
export function AssetBar() {
  const { status } = useStore(gitStore);
  const { checking } = useStore(updatesStore);
  const game = useStore(gameStore);
  const behind = behindCount();
  const [busy, setBusy] = useState(false);
  const unsaved = (status?.changes ?? []).filter((c) => classifyAsset(c.path)).length;
  const running = game.state === "building" || game.state === "running";
  const get = async () => { if (busy) return; setBusy(true); try { await getLatest(); } finally { setBusy(false); } };
  return (
    <div className="asset-bar" data-testid="asset-bar">
      <button className="ab-btn" data-act="get-latest" disabled={busy} title="Get the newest version from your team" onClick={() => void get()}>
        <Down /><span>{busy ? "Getting…" : "Get latest"}</span>
        {behind > 0 && <span className="ab-badge" data-testid="get-latest-badge" title={`${behind} newer update${behind === 1 ? "" : "s"} available`}>{behind}</span>}
        {checking && behind === 0 && <span className="ab-spin" />}
      </button>
      <button className="ab-btn" data-act="branch" title="Switch or start a branch" onClick={openBranches}>
        <BranchIcon /><span className="ab-branch">{status?.branch ?? (status?.isRepo ? "No branch" : "No Git")}</span><ChevronDown />
      </button>
      <button className="ab-btn" data-act="save" title="Save your asset changes to Git" disabled={!status?.isRepo} onClick={() => void saveFlow()}>
        <Save /><span>Save to Git</span>
      </button>
      {running ? (
        <button className="ab-btn run stop" data-act="stop" title="Stop the game" onClick={stopGame}><Stop /><span>Stop</span></button>
      ) : (
        <>
          <button className="ab-btn run" data-act="run" title="Start the game with your latest assets" onClick={() => void runGame()}><Play /><span>Run Game</span></button>
          <button className="ab-caret" data-act="run-pick" title="Choose which version of the game to run" onClick={(e) => void openRunMenu(e)}><ChevronDown /></button>
        </>
      )}
      <div className="ab-chip" data-testid="asset-chip" title="Where you are">
        <span className="ab-chip-branch" data-chip="branch">{status?.branch ?? "–"}</span>
        {(status?.ahead ?? 0) > 0 && <span data-chip="ahead" title="Saved here, not shared yet">{"↑"}{status!.ahead}</span>}
        {(status?.behind ?? 0) > 0 && <span data-chip="behind" title="Newer updates from your team">{"↓"}{status!.behind}</span>}
        {unsaved > 0 && <span className="ab-unsaved" data-chip="unsaved">{unsaved} unsaved asset{unsaved === 1 ? "" : "s"}</span>}
        {game.state !== "idle" && <span className={"ab-game " + game.state} data-chip="game">{GAME_TEXT[game.state]}</span>}
      </div>
    </div>
  );
}
