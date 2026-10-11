/** Ranged zip/jar reader: only the central directory and requested entries are read (works for big jars and over ssh). */
export interface ZipEntry { name: string; size: number; csize: number; method: number; offset: number; dir: boolean }
export type ReadRange = (offset: number, len: number) => Promise<Uint8Array>;

export async function listZip(size: number, read: ReadRange): Promise<ZipEntry[]> {
  const tailLen = Math.min(size, 65557);
  const tail = await read(size - tailLen, tailLen);
  const dv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let e = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (dv.getUint32(i, true) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error("Not a zip file (no end-of-central-directory record)");
  const total = dv.getUint16(e + 10, true), cdSize = dv.getUint32(e + 12, true), cdOff = dv.getUint32(e + 16, true);
  if (cdOff === 0xffffffff || total === 0xffff) throw new Error("Zip64 archives are not supported");
  const cd = await read(cdOff, cdSize);
  const cv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
  const out: ZipEntry[] = [];
  const dec = new TextDecoder();
  let p = 0;
  for (let i = 0; i < total && p + 46 <= cd.length; i++) {
    if (cv.getUint32(p, true) !== 0x02014b50) break;
    const method = cv.getUint16(p + 10, true), csize = cv.getUint32(p + 20, true), usize = cv.getUint32(p + 24, true);
    const nl = cv.getUint16(p + 28, true), el = cv.getUint16(p + 30, true), cl = cv.getUint16(p + 32, true), off = cv.getUint32(p + 42, true);
    const name = dec.decode(cd.subarray(p + 46, p + 46 + nl));
    out.push({ name, size: usize, csize, method, offset: off, dir: name.endsWith("/") });
    p += 46 + nl + el + cl;
  }
  return out;
}

export async function readEntry(en: ZipEntry, read: ReadRange): Promise<Uint8Array> {
  const lh = await read(en.offset, 30);
  const dv = new DataView(lh.buffer, lh.byteOffset, lh.byteLength);
  if (dv.getUint32(0, true) !== 0x04034b50) throw new Error("bad local header");
  const start = en.offset + 30 + dv.getUint16(26, true) + dv.getUint16(28, true);
  const raw = await read(start, en.csize);
  if (en.method === 0) return raw;
  if (en.method !== 8) throw new Error(`unsupported compression method ${en.method}`);
  const ds = new DecompressionStream("deflate-raw");
  return new Uint8Array(await new Response(new Blob([raw as BlobPart]).stream().pipeThrough(ds)).arrayBuffer());
}
