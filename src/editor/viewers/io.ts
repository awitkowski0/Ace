import { dirname, fs, joinPath, type Location } from "../../lib/ipc";
import { useEffect, useState } from "react";
import { createStore, useStore } from "../../lib/store";
import type { Doc } from "../store";
import type { DualMode } from "./registry";

/** Load a file's bytes (reloads when the doc's `rev` changes, i.e. on external modification). */
export const MAX_PREVIEW = 160 * 1024 * 1024;
export function useBytes(doc: Pick<Doc, "key" | "loc" | "rev">, enabled = true, max = MAX_PREVIEW) {
  const [st, setSt] = useState<{ data?: ArrayBuffer; error?: string; loading: boolean }>({ loading: true });
  useEffect(() => {
    if (!enabled) return;
    let dead = false;
    setSt((s) => ({ data: s.data, loading: true }));
    fs.readBytes(doc.loc, 0, max + 1).then(
      (data) => !dead && (data.byteLength > max ? setSt({ error: `File is larger than ${Math.round(max / 1048576)} MB: too large to preview`, loading: false }) : setSt({ data, loading: false })),
      (e) => !dead && setSt({ error: String(e), loading: false }),
    );
    return () => { dead = true; };
  }, [doc.key, doc.rev, enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  return st;
}

/** Object URL for bytes, revoked on change/unmount. */
export function useBlobUrl(data: ArrayBuffer | undefined, type: string) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!data) return setUrl(undefined);
    const u = URL.createObjectURL(new Blob([data], { type }));
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [data, type]);
  return url;
}

export const siblingOf = (loc: Location, name: string): Location => ({
  host: loc.host,
  path: joinPath(dirname(loc.path), name),
});

export const mimeOf = (ext: string): string =>
  ({
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", ico: "image/x-icon",
    svg: "image/svg+xml", avif: "image/avif", icns: "image/x-icns", mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
    m4v: "video/mp4", ogv: "video/ogg", wav: "audio/wav", mp3: "audio/mpeg", ogg: "audio/ogg", flac: "audio/flac", ttf: "font/ttf",
    otf: "font/otf", woff: "font/woff", woff2: "font/woff2", glb: "model/gltf-binary",
  })[ext] ?? "application/octet-stream";

// ---- per-tab view preferences (kept for the session; viewers remount when the tab is re-activated) ----
export interface ViewPrefs {
  mode?: DualMode;
  bg?: "checker" | "light" | "dark" | "none";
  grid?: boolean;
  zoom?: number | "fit";
  animated?: boolean;
  wire?: boolean;
}
const prefs = createStore<{ map: Record<string, ViewPrefs> }>({ map: {} });
export const getPrefs = (key: string): ViewPrefs => prefs.get().map[key] ?? {};
export const setPrefs = (key: string, p: ViewPrefs) => prefs.set((s) => ({ map: { ...s.map, [key]: { ...s.map[key], ...p } } }));
export const usePrefs = (key: string): ViewPrefs => useStore(prefs).map[key] ?? {};
export const dropPrefs = (key: string) => prefs.set((s) => { const { [key]: _, ...map } = s.map; return { map }; });
