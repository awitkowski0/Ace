import { useStore } from "../../lib/store";
import { basename } from "../../lib/ipc";
import { gitStore } from "../git/api";
import { classifyAsset } from "./assets";
import { saveFlow } from "./SaveDialog";

const word = (k: string) => (k === "added" || k === "untracked" ? "new" : k === "deleted" ? "removed" : k === "renamed" ? "renamed" : "changed");

/** The Changes tool window in Asset Dev: your asset changes, code changes greyed out, one Save to Git button. */
export function AssetChanges() {
  const { status } = useStore(gitStore);
  const ch = status?.changes ?? [];
  const assets = ch.filter((c) => classifyAsset(c.path));
  const code = ch.filter((c) => !classifyAsset(c.path));
  return (
    <div className="ap-changes" data-testid="asset-changes" data-autofocus tabIndex={0}>
      <div className="ap-changes-top">
        <button className="primary" disabled={!assets.length} onClick={() => void saveFlow()}>Save to Git…</button>
        <span className="dim">{assets.length ? `${assets.length} asset change${assets.length === 1 ? "" : "s"}` : "Nothing to save"}</span>
      </div>
      <div className="ap-changes-list">
        {assets.map((c) => <div key={c.path} className="tree-row ap-crow" style={{ position: "static" }}><span className="tree-name">{classifyAsset(c.path)!.name}</span><span className="tree-hint">{word(c.kind)}</span></div>)}
        {code.map((c) => <div key={c.path} className="tree-row ap-crow code" title="Code isn't saved from Asset Dev" style={{ position: "static" }}><span className="tree-name">{basename(c.path)}</span><span className="tree-hint">not included</span></div>)}
      </div>
    </div>
  );
}
