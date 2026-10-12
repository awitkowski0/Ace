/**
 * Left sidebar. Blockbench Edit mode: UV editor on top, Textures below. Animate / Pose: Animations list with the selected keyframe's
 * inspector below it. Each mode keeps its own split (autoSaveId per mode).
 */
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { Section } from "./widgets";
import { KeyframeInspector } from "./timeline/KeyframeInspector";
import { AnimationsPanel } from "./timeline/AnimationsPanel";
import { UvPanel } from "./uv/UvEditor";
import { TexturesPanel } from "./uv/TexturesPanel";
import type { RigModel } from "./model";
import { ConstraintsPanel } from "./constraints/ConstraintsPanel"; // == constraints hook ==

export function LeftColumn({ mode = "animate", rig = null }: { mode?: string; rig?: RigModel | null }) {
  return (
    <PanelGroup direction="vertical" autoSaveId={`animstudio.l.${mode}`}>
      <Panel id="anims" order={1} defaultSize={40} minSize={20} className="as-panel"><div className="as-lcol"><AnimationsPanel /></div></Panel>
      <PanelResizeHandle className="as-handle h" />
      {/* == constraints hook == limb links */}
      <Panel id="constraints" order={2} defaultSize={32} minSize={8} className="as-panel"><div className="as-lcol scroll" data-testid="as-constraints-col"><ConstraintsPanel rig={rig} /></div></Panel>
      <PanelResizeHandle className="as-handle h" />
      <Panel id="keyframe" order={3} defaultSize={28} minSize={10} className="as-panel">
        <div className="as-lcol scroll" data-testid="as-keyframe"><Section title="Keyframe"><KeyframeInspector /></Section></div>
      </Panel>
    </PanelGroup>
  );
}

/** Edit mode: UV editor (top) + Textures (bottom). */
export function EditLeft({ rig, host }: { rig: RigModel | null; host: string }) {
  return (
    <PanelGroup direction="vertical" autoSaveId="animstudio.l.edit">
      <Panel id="uv" order={1} defaultSize={64} minSize={25} className="as-panel"><div className="as-lcol scroll" data-testid="as-uv"><UvPanel rig={rig} host={host} /></div></Panel>
      <PanelResizeHandle className="as-handle h" />
      <Panel id="textures" order={2} defaultSize={36} minSize={10} className="as-panel"><div className="as-lcol scroll" data-testid="as-textures-col"><TexturesPanel host={host} /></div></Panel>
    </PanelGroup>
  );
}
