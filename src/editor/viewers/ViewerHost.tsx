import { lazy, Suspense, type ComponentType } from "react";
import type { Doc } from "../store";
import type { DualId, ViewerId } from "./registry";
import type { ViewerProps } from "./ImageViewer";
import { BinaryViewer, TooLargeViewer } from "./Placeholders";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const L = (f: () => Promise<{ default: ComponentType<any> }>) => lazy(f);
const ImageViewer = L(() => import("./ImageViewer"));
const AudioViewer = L(() => import("./AudioViewer"));
const VideoViewer = L(() => import("./VideoViewer"));
const ModelViewer = L(() => import("./ModelViewer"));
const FontViewer = L(() => import("./FontViewer"));
const NbtViewer = L(() => import("./NbtViewer"));
const ArchiveViewer = L(() => import("./ArchiveViewer"));

const VIEWERS: Partial<Record<ViewerId, ComponentType<ViewerProps>>> = {
  image: ImageViewer, audio: AudioViewer, video: VideoViewer, model: ModelViewer, font: FontViewer, nbt: NbtViewer, archive: ArchiveViewer,
};

/** The bytes-only editor for a viewer tab (each editor group mounts its own instance). */
export function ViewerHost({ doc, groupId }: ViewerProps) {
  if (doc.viewer === "binary") return <BinaryViewer doc={doc} />;
  if (doc.viewer === "toolarge") return <TooLargeViewer doc={doc} />;
  const C = doc.viewer ? VIEWERS[doc.viewer] : undefined;
  if (!C) return null;
  return <Suspense fallback={<div className="vw-empty">Loading…</div>}><C key={doc.key + ":" + (doc.rev ?? 0)} doc={doc} groupId={groupId} /></Suspense>;
}

const SvgPreview = L(() => import("./ImageViewer").then((m) => ({ default: m.SvgPreview })));
const MarkdownPreview = L(() => import("./MarkdownPreview"));
const CsvTable = L(() => import("./CsvTable"));
const BbmodelView = L(() => import("./BbmodelView"));
const McmetaPreview = L(() => import("./McmetaPreview"));

export const DUAL_PREVIEWS: Record<DualId, ComponentType<ViewerProps & { text: string; sync: boolean }>> = {
  svg: SvgPreview, markdown: MarkdownPreview, csv: CsvTable, bbmodel: BbmodelView, mcmeta: McmetaPreview,
};

export function DualPreview({ doc, groupId, text, sync }: { doc: Doc; groupId: string; text: string; sync: boolean }) {
  const C = DUAL_PREVIEWS[doc.dual!];
  return <Suspense fallback={<div className="vw-empty">Loading…</div>}><C doc={doc} groupId={groupId} text={text} sync={sync} /></Suspense>;
}
