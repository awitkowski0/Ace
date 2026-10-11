/** Minimal NBT reader (Java big-endian, Bedrock little-endian fallback) with gzip/zlib support. Pure besides DecompressionStream. */
export interface NbtNode { name: string; type: number; value?: string; children?: NbtNode[]; count?: number }
export const TAG = ["End", "Byte", "Short", "Int", "Long", "Float", "Double", "Byte[]", "String", "List", "Compound", "Int[]", "Long[]"];

export async function inflate(b: Uint8Array): Promise<Uint8Array> {
  const fmt = b[0] === 0x1f && b[1] === 0x8b ? "gzip" : b[0] === 0x78 ? "deflate" : null;
  if (!fmt) return b;
  const ds = new DecompressionStream(fmt);
  const out = new Response(new Blob([b as BlobPart]).stream().pipeThrough(ds));
  return new Uint8Array(await out.arrayBuffer());
}

class R {
  dv: DataView; p = 0;
  constructor(public b: Uint8Array, public le: boolean) { this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength); }
  u8() { return this.b[this.p++]; }
  i8() { return this.dv.getInt8(this.p++); }
  i16() { const v = this.dv.getInt16(this.p, this.le); this.p += 2; return v; }
  u16() { const v = this.dv.getUint16(this.p, this.le); this.p += 2; return v; }
  i32() { const v = this.dv.getInt32(this.p, this.le); this.p += 4; return v; }
  i64() { const v = this.dv.getBigInt64(this.p, this.le); this.p += 8; return v; }
  f32() { const v = this.dv.getFloat32(this.p, this.le); this.p += 4; return v; }
  f64() { const v = this.dv.getFloat64(this.p, this.le); this.p += 8; return v; }
  str() { const n = this.u16(); if (this.p + n > this.b.length) throw new Error("truncated"); const s = new TextDecoder().decode(this.b.subarray(this.p, this.p + n)); this.p += n; return s; }
}
const MAX_CHILDREN = 20000;

function payload(r: R, type: number, name: string, depth: number): NbtNode {
  if (depth > 64) throw new Error("too deep");
  switch (type) {
    case 1: return { name, type, value: String(r.i8()) };
    case 2: return { name, type, value: String(r.i16()) };
    case 3: return { name, type, value: String(r.i32()) };
    case 4: return { name, type, value: String(r.i64()) };
    case 5: return { name, type, value: String(+r.f32().toPrecision(8)) };
    case 6: return { name, type, value: String(r.f64()) };
    case 8: return { name, type, value: JSON.stringify(r.str()) };
    case 7: { const n = r.i32(); if (n < 0 || r.p + n > r.b.length) throw new Error("bad array"); const a = Array.from(r.b.subarray(r.p, r.p + Math.min(n, 64))); r.p += n; return { name, type, count: n, value: `[${a.join(", ")}${n > 64 ? ", …" : ""}]` }; }
    case 11: case 12: {
      const n = r.i32(); if (n < 0 || r.p + n * (type === 11 ? 4 : 8) > r.b.length) throw new Error("bad array");
      const a: string[] = [];
      for (let i = 0; i < n; i++) { const v = type === 11 ? r.i32() : r.i64(); if (i < 64) a.push(String(v)); }
      return { name, type, count: n, value: `[${a.join(", ")}${n > 64 ? ", …" : ""}]` };
    }
    case 9: {
      const t = r.u8(), n = r.i32();
      if (n < 0 || (t === 0 && n > 0)) throw new Error("bad list");
      const children: NbtNode[] = [];
      for (let i = 0; i < n; i++) { const c = payload(r, t, String(i), depth + 1); if (i < MAX_CHILDREN) children.push(c); }
      return { name, type, count: n, children };
    }
    case 10: {
      const children: NbtNode[] = [];
      for (;;) {
        const t = r.u8();
        if (t === 0) break;
        if (t > 12) throw new Error("bad tag " + t);
        const nm = r.str();
        const c = payload(r, t, nm, depth + 1);
        if (children.length < MAX_CHILDREN) children.push(c);
      }
      return { name, type, count: children.length, children };
    }
    default: throw new Error("bad tag " + type);
  }
}

export async function parseNbt(raw: Uint8Array): Promise<{ root: NbtNode; endian: "big" | "little"; compressed: boolean }> {
  const data = await inflate(raw);
  const compressed = data !== raw;
  let err: unknown;
  for (const le of [false, true]) {
    try {
      const r = new R(data, le);
      // Bedrock .mcstructure/level.dat has an 8-byte header sometimes; try plain first
      const t = r.u8();
      if (t !== 10 && t !== 9) throw new Error("not NBT");
      const name = r.str();
      return { root: payload(r, t, name, 0), endian: le ? "little" : "big", compressed };
    } catch (e) { err = e; }
  }
  throw new Error(`Not a valid NBT file (${(err as Error).message})`);
}

/** SNBT-ish one-line preview for a leaf/collection. */
export const summary = (n: NbtNode) => (n.children ? `${TAG[n.type]} · ${n.count} ${n.type === 9 ? "entries" : "tags"}` : n.value ?? "");
