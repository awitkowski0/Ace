/** Blockbench .bbmodel parsing + geometry description (pure; three.js side lives in BbmodelView). */
export type Face = "north" | "south" | "east" | "west" | "up" | "down";
export const FACES: Face[] = ["north", "south", "east", "west", "up", "down"];
type V3 = [number, number, number];

export interface BbCube {
  uuid?: string; name: string; from: V3; to: V3; origin: V3; rotation: V3; inflate: number;
  faces: Partial<Record<Face, { uv: [number, number, number, number]; texture: number | null; rotation?: number }>>;
}
export interface BbGroup { name: string; origin: V3; rotation: V3; children: (BbGroup | string)[] }
export interface BbTexture { name: string; source: string; uvW: number; uvH: number }
export interface BbModel { cubes: Map<string, BbCube>; order: string[]; root: (BbGroup | string)[]; textures: BbTexture[]; res: [number, number]; skipped: number }

const v3 = (a: any, d: V3 = [0, 0, 0]): V3 => (Array.isArray(a) && a.length >= 3 ? [+a[0] || 0, +a[1] || 0, +a[2] || 0] : d);

/** Standard Minecraft "box UV" layout from uv_offset. */
export function boxUv(off: [number, number], size: V3): Record<Face, [number, number, number, number]> {
  const [u, v] = off, [dx, dy, dz] = size;
  return {
    east: [u, v + dz, u + dz, v + dz + dy],
    north: [u + dz, v + dz, u + dz + dx, v + dz + dy],
    west: [u + dz + dx, v + dz, u + 2 * dz + dx, v + dz + dy],
    south: [u + 2 * dz + dx, v + dz, u + 2 * dz + 2 * dx, v + dz + dy],
    up: [u + dz, v, u + dz + dx, v + dz],
    down: [u + dz + dx, v, u + dz + 2 * dx, v + dz],
  };
}

export function parseBbmodel(text: string): BbModel {
  const j = JSON.parse(text);
  const res: [number, number] = [j.resolution?.width ?? 16, j.resolution?.height ?? 16];
  const cubes = new Map<string, BbCube>();
  const order: string[] = [];
  let skipped = 0;
  (j.elements ?? []).forEach((e: any, i: number) => {
    if (e.type && e.type !== "cube") { skipped++; return; }
    const from = v3(e.from), to = v3(e.to);
    const id = e.uuid ?? `#${i}`;
    const faces: BbCube["faces"] = {};
    const size: V3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
    const bx = e.box_uv ? boxUv([e.uv_offset?.[0] ?? 0, e.uv_offset?.[1] ?? 0], size) : null;
    for (const f of FACES) {
      const src = e.faces?.[f];
      if (e.box_uv && bx) faces[f] = { uv: bx[f], texture: src?.texture ?? 0 };
      else if (src && src.uv) faces[f] = { uv: src.uv, texture: src.texture ?? null, rotation: src.rotation };
    }
    cubes.set(id, { uuid: e.uuid, name: e.name ?? "cube", from, to, origin: v3(e.origin, from), rotation: v3(e.rotation), inflate: +e.inflate || 0, faces });
    order.push(id);
  });
  const conv = (n: any): BbGroup | string | null => {
    if (typeof n === "string") return cubes.has(n) ? n : null;
    if (!n || typeof n !== "object") return null;
    return { name: n.name ?? "group", origin: v3(n.origin), rotation: v3(n.rotation), children: (n.children ?? []).map(conv).filter((x: unknown): x is BbGroup | string => !!x) };
  };
  const root = Array.isArray(j.outliner) && j.outliner.length ? j.outliner.map(conv).filter((x: unknown): x is BbGroup | string => !!x) : order.slice();
  const textures: BbTexture[] = (j.textures ?? []).map((t: any) => ({ name: t.name ?? "texture", source: t.source ?? "", uvW: t.uv_width ?? res[0], uvH: t.uv_height ?? res[1] }));
  return { cubes, order, root, textures, res, skipped };
}
