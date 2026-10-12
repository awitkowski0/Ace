import { useEffect, useState } from "react";
import { fs, type Location } from "../../lib/ipc";
import { extOf, type AssetType } from "./assets";

const P = { fill: "none", stroke: "currentColor", strokeWidth: 1.2, strokeLinecap: "round", strokeLinejoin: "round" } as const;
/** Kind icons for asset types (cube, play, picture, speaker, text, person, sparks, gear, braces) */
export function AssetIcon({ type, size = 16 }: { type: AssetType; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...P} className={"ap-ico ap-" + type}>
      {type === "model" && <path d="M8 1.8l5.5 3v6.4L8 14.2l-5.5-3V4.8zM2.7 5l5.3 3 5.3-3M8 8v6" />}
      {type === "animation" && <><circle cx="8" cy="8" r="6" /><path d="M6.6 5.4l4 2.6-4 2.6z" /></>}
      {type === "texture" && <><rect x="2" y="2.5" width="12" height="11" rx="1.5" /><path d="M2.5 11l3.2-3.2 2.3 2.3 2-2 3.5 3.4M10.5 5.6v.1" /></>}
      {type === "sound" && <path d="M2.5 6v4h2.7L9 13V3L5.2 6zM11.2 5.6a3.6 3.6 0 0 1 0 4.8" />}
      {type === "lang" && <path d="M2.5 4h11M2.5 8h11M2.5 12h7" />}
      {type === "pose" && <><circle cx="8" cy="3.5" r="1.6" /><path d="M8 5.5v4M4.5 7l3.5-1 3.5 1M8 9.5l-2.5 4M8 9.5l2.5 4" /></>}
      {type === "particle" && <path d="M8 2v3M8 11v3M2 8h3M11 8h3M4 4l2 2M10 10l2 2M12 4l-2 2M6 10l-2 2" />}
      {type === "controller" && <><circle cx="8" cy="8" r="2.2" /><path d="M8 2v2M8 12v2M2 8h2M12 8h2M3.8 3.8l1.4 1.4M10.8 10.8l1.4 1.4M12.2 3.8l-1.4 1.4M5.2 10.8l-1.4 1.4" /></>}
      {type === "suit" && <path d="M5 2.5h6l2 3-2 1.2V13.5H5V6.7L3 5.5zM6.5 2.5c.4 1.2 2.6 1.2 3 0" />}
      {type === "hud" && <><rect x="1.8" y="3" width="12.4" height="9" rx="1.2" /><path d="M4 10h3M10 5.5h2" /></>}
      {type === "flight" && <path d="M8 2v6M5.5 8h5l-1.2 5.5h-2.6zM8 13.5v1" />}
      {type === "guide" && <path d="M8 4c-1.8-1.2-3.8-1.4-5.5-1v9.5c1.7-.4 3.7-.2 5.5 1 1.8-1.2 3.8-1.4 5.5-1V3c-1.7-.4-3.7-.2-5.5 1zM8 4v9.5" />}
      {type === "data" && <path d="M5 3.5C3.5 4 3.5 5.5 3.5 7S3 8 2.5 8c.5 0 1 .5 1 1s0 3 1.5 3.5M11 3.5c1.5.5 1.5 2 1.5 3.5s.5 1 1 1c-.5 0-1 .5-1 1s0 3-1.5 3.5" />}
      {type === "other" && <path d="M3.5 1.5h5l4 4v8.5a.5.5 0 0 1-.5.5h-8.5a.5.5 0 0 1-.5-.5v-12a.5.5 0 0 1 .5-.5zM8.5 1.5v4h4" />}
    </svg>
  );
}

const cache = new Map<string, string | null>();
const MAX_THUMB = 400_000;
/** A texture's own pixels (nearest-neighbour, 16px) or a kind icon for everything else. Only mounted rows load, so big lists stay cheap. */
export function Thumb({ loc, type, size = 16 }: { loc: Location; type: AssetType; size?: number }) {
  const key = loc.host + ":" + loc.path;
  const isPng = type === "texture" && extOf(loc.path) === "png";
  const [url, setUrl] = useState<string | null | undefined>(() => (isPng ? cache.get(key) : null));
  useEffect(() => {
    if (!isPng || cache.has(key)) { if (isPng) setUrl(cache.get(key)); return; }
    let live = true;
    fs.probe(loc).then((p) => (p.size > MAX_THUMB ? null : fs.readBytes(loc))).then((buf) => {
      const u = buf ? URL.createObjectURL(new Blob([buf], { type: "image/png" })) : null;
      if (cache.size > 400) { for (const k of [...cache.keys()].slice(0, 100)) { const v = cache.get(k); if (v) URL.revokeObjectURL(v); cache.delete(k); } }
      cache.set(key, u);
      if (live) setUrl(u);
    }).catch(() => { cache.set(key, null); });
    return () => { live = false; };
  }, [key, isPng]); // eslint-disable-line react-hooks/exhaustive-deps
  if (url) return <img className="ap-thumb" src={url} width={size} height={size} alt="" draggable={false} />;
  return <AssetIcon type={type} size={size} />;
}
