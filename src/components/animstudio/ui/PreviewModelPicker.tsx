/** Preview-model picker of an animation file: choose a geo, see where the active model came from, pin it as the project default. */
const base = (p: string) => p.slice(p.lastIndexOf("/") + 1).replace(/\.(geo|animation)\.json$/, "");

/** Where the active preview model comes from (resolution order: file > sibling > project > spiderman > player). */
export type ModelSource = "file" | "sibling" | "project" | "spiderman" | "player";
const SOURCE_LABEL: Record<ModelSource, string> = {
  file: "chosen for this file", sibling: "same-name model", project: "project default", spiderman: "spiderman (auto)", player: "built-in player rig",
};

export interface PreviewModelPickerProps {
  /** candidate geo paths (store.siblings.geos) */
  geos: string[];
  /** active geo path (null = built-in player rig) */
  value: string | null;
  onPick(path: string | null): void;
  /** project default geo path (null = none) */
  projectDefault: string | null;
  onSetProjectDefault(path: string | null): void;
  /** where `value` came from; shown as a hint */
  modelSource?: ModelSource;
}

export function PreviewModelPicker({ geos, value, onPick, projectDefault, onSetProjectDefault, modelSource }: PreviewModelPickerProps) {
  const isDefault = !!value && value === projectDefault;
  const options = value && !geos.includes(value) ? [value, ...geos] : geos;
  return (
    <span className="as-pick" data-testid="preview-model-picker" title={modelSource ? `Preview model: ${SOURCE_LABEL[modelSource]}` : "Model the animation is previewed on"}>
      <span>Preview model</span>
      <select data-id="preview-model" value={value ?? ""} onChange={(e) => onPick(e.target.value || null)}>
        <option value="">Player (built-in)</option>
        {options.map((g) => <option key={g} value={g}>{base(g)}</option>)}
      </select>
      {modelSource && <span className="as-note" data-testid="preview-model-source" style={{ padding: 0 }}>{SOURCE_LABEL[modelSource]}</span>}
      <label className="as-check" title="Use this model for every animation file of this project (stored in Ace app data, not in the repo)">
        <input data-id="preview-model-default" type="checkbox" checked={isDefault} disabled={!value} onChange={(e) => onSetProjectDefault(e.target.checked ? value : null)} />
        <span>Default for project</span>
      </label>
    </span>
  );
}
