/** Cheap header sniffing for the image status line (format, colour depth) + a TGA decoder (browsers can't show .tga). */
export interface ImageMeta { format: string; depth?: string }

const PNG_COLOR: Record<number, string> = { 0: "Grayscale", 2: "RGB", 3: "Indexed", 4: "Grayscale+Alpha", 6: "RGBA" };

export function sniffImage(b: Uint8Array, ext: string): ImageMeta {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length > 26 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    const bits = b[24], ct = b[25];
    const ch = ct === 0 ? 1 : ct === 2 ? 3 : ct === 3 ? 1 : ct === 4 ? 2 : 4;
    return { format: "PNG", depth: `${ct === 3 ? bits : bits * ch}-bit ${PNG_COLOR[ct] ?? "?"}${ct === 3 ? ` (${bits}-bit palette)` : ""}` };
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    // walk markers to SOF0/SOF2: precision + components
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        const prec = b[i + 4], comps = b[i + 9];
        return { format: m === 0xc2 ? "JPEG (progressive)" : "JPEG", depth: `${prec * comps}-bit ${comps === 1 ? "Grayscale" : comps === 4 ? "CMYK" : "YCbCr"}` };
      }
      i += 2 + dv.getUint16(i + 2);
    }
    return { format: "JPEG" };
  }
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    const frames = countGifFrames(b);
    return { format: "GIF", depth: `8-bit indexed${frames > 1 ? `, ${frames} frames` : ""}` };
  }
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[8] === 0x57) return { format: "WebP" };
  if (b[0] === 0x42 && b[1] === 0x4d && b.length > 30) return { format: "BMP", depth: `${dv.getUint16(28, true)}-bit` };
  if (ext === "ico" || ext === "cur") return { format: ext.toUpperCase() };
  if (ext === "tga") return { format: "TGA", depth: b.length > 17 ? `${b[16]}-bit` : undefined };
  return { format: ext.toUpperCase() };
}

function countGifFrames(b: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < b.length - 3 && n < 5000; i++) if (b[i] === 0x21 && b[i + 1] === 0xf9 && b[i + 2] === 0x04) n++;
  return n;
}

/** Decode uncompressed / RLE truecolour & grey TGA to RGBA. */
export function decodeTga(b: Uint8Array): { w: number; h: number; rgba: Uint8ClampedArray } | null {
  if (b.length < 18) return null;
  const idLen = b[0], cmType = b[1], type = b[2];
  const cmLen = b[5] | (b[6] << 8), cmBits = b[7];
  const w = b[12] | (b[13] << 8), h = b[14] | (b[15] << 8), bpp = b[16], desc = b[17];
  if (!w || !h || ![1, 2, 3, 9, 10, 11].includes(type) || ![8, 15, 16, 24, 32].includes(bpp)) return null;
  let p = 18 + idLen;
  let palette: Uint8Array | null = null;
  if (cmType === 1) {
    const eb = Math.ceil(cmBits / 8);
    palette = b.subarray(p, p + cmLen * eb);
    p += cmLen * eb;
  }
  const px = Math.ceil(bpp / 8);
  const out = new Uint8ClampedArray(w * h * 4);
  const rle = type >= 9;
  const put = (i: number, src: number) => {
    let r = 0, g = 0, bl = 0, a = 255;
    if (type === 1 || type === 9) {
      const idx = b[src];
      const eb = Math.ceil(cmBits / 8);
      const o = idx * eb;
      if (palette) { bl = palette[o]; g = palette[o + 1]; r = palette[o + 2]; if (eb === 4) a = palette[o + 3]; }
    } else if (type === 3 || type === 11) {
      r = g = bl = b[src]; if (bpp === 16) a = b[src + 1];
    } else if (bpp >= 24) { bl = b[src]; g = b[src + 1]; r = b[src + 2]; if (bpp === 32) a = b[src + 3]; }
    else { const v = b[src] | (b[src + 1] << 8); r = ((v >> 10) & 31) << 3; g = ((v >> 5) & 31) << 3; bl = (v & 31) << 3; }
    out[i] = r; out[i + 1] = g; out[i + 2] = bl; out[i + 3] = a;
  };
  let n = 0;
  const total = w * h;
  while (n < total && p < b.length) {
    if (rle) {
      const hdr = b[p++];
      const cnt = (hdr & 0x7f) + 1;
      if (hdr & 0x80) { for (let k = 0; k < cnt && n < total; k++) put(n++ * 4, p); p += px; }
      else for (let k = 0; k < cnt && n < total; k++) { put(n++ * 4, p); p += px; }
    } else { put(n++ * 4, p); p += px; }
  }
  const top = (desc & 0x20) !== 0, right = (desc & 0x10) !== 0;
  if (!top || right) {
    const fixed = new Uint8ClampedArray(out.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const sy = top ? y : h - 1 - y, sx = right ? w - 1 - x : x;
      const s = (y * w + x) * 4, d = (sy * w + sx) * 4;
      fixed[d] = out[s]; fixed[d + 1] = out[s + 1]; fixed[d + 2] = out[s + 2]; fixed[d + 3] = out[s + 3];
    }
    return { w, h, rgba: fixed };
  }
  return { w, h, rgba: out };
}
