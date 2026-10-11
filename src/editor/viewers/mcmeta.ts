/** Minecraft `.png.mcmeta` animation: parse + frame schedule (1 tick = 50 ms). */
export interface McFrame { index: number; ticks: number }
export interface McAnimation { frametime: number; interpolate: boolean; width?: number; height?: number; frames?: McFrame[] }

export function parseMcmeta(text: string): McAnimation | null {
  let j: any;
  try { j = JSON.parse(text); } catch { return null; }
  const a = j?.animation;
  if (!a || typeof a !== "object") return null;
  const frametime = Math.max(1, Number(a.frametime) || 1);
  const frames: McFrame[] | undefined = Array.isArray(a.frames)
    ? a.frames.map((f: any) => (typeof f === "number" ? { index: f, ticks: frametime } : { index: Number(f.index) || 0, ticks: Math.max(1, Number(f.time) || frametime) }))
    : undefined;
  return { frametime, interpolate: !!a.interpolate, width: a.width, height: a.height, frames };
}

/** Frame size + count for a sheet; Minecraft stacks frames vertically (square frames unless width/height given). */
export function sheetLayout(a: McAnimation, w: number, h: number) {
  const fw = a.width ?? w;
  const fh = a.height ?? (a.width ? a.width : w);
  const cols = Math.max(1, Math.floor(w / fw));
  const total = Math.max(1, cols * Math.floor(h / fh));
  return { fw, fh, cols, total };
}

export function schedule(a: McAnimation, total: number): McFrame[] {
  return a.frames?.length ? a.frames : Array.from({ length: total }, (_, i) => ({ index: i, ticks: a.frametime }));
}
