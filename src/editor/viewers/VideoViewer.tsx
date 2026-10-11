import { registerController } from "./controllers";
import { useEffect, useRef } from "react";
import { mimeOf, useBlobUrl, useBytes } from "./io";
import { extOf, formatSize } from "./registry";
import { Message } from "./Placeholders";
import type { ViewerProps } from "./ImageViewer";

export default function VideoViewer({ doc, groupId }: ViewerProps) {
  const { data, error } = useBytes(doc, true, 400 * 1024 * 1024);
  const url = useBlobUrl(data, mimeOf(extOf(doc.name)));
  const v = useRef<HTMLVideoElement>(null);
  useEffect(() => registerController(groupId, {
    playPause: () => { const e = v.current; if (e) e.paused ? void e.play() : e.pause(); },
    snapshot: () => ({ kind: "video", duration: v.current?.duration, w: v.current?.videoWidth, h: v.current?.videoHeight, paused: v.current?.paused, error: v.current?.error?.message ?? null }),
  }), [groupId]);
  if (error) return <Message title="Cannot play video" detail={error} />;
  return (
    <div className="vv" data-viewer="video">
      <video ref={v} src={url} controls preload="metadata" />
      <div className="iv-status"><span>{doc.name}</span><span>{formatSize(data?.byteLength ?? 0)}</span></div>
    </div>
  );
}
