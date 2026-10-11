// Generates the scratch project for assets.mjs: every viewer type, built from code / ffmpeg / sips, plus a few small samples copied
// OUT of the real repos (never modified). Everything lives under the given dir.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import os from "node:os";

const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
/** RGBA png from a pixel function (x, y) => [r,g,b,a] */
export function png(w, h, px) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 4 + 1); raw[o] = 0; const p = px(x, y); raw.set(p, o + 1 + x * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
export const PIXEL = (x, y) => (x === 0 && y === 0 ? [255, 0, 0, 255] : x === 1 && y === 0 ? [0, 255, 0, 255] : x === 2 && y === 0 ? [0, 0, 255, 128] : x === 15 && y === 15 ? [255, 255, 0, 255] : ((x + y) & 1 ? [90, 90, 90, 255] : [160, 160, 160, 255]));

function nbtBytes() {
  const s = (t) => { const b = Buffer.from(t); const l = Buffer.alloc(2); l.writeUInt16BE(b.length); return Buffer.concat([l, b]); };
  const i32 = (n) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
  return zlib.gzipSync(Buffer.concat([
    Buffer.from([10]), s(""),
    Buffer.from([3]), s("DataVersion"), i32(3465),
    Buffer.from([9]), s("size"), Buffer.from([3]), i32(3), i32(4), i32(5), i32(6),
    Buffer.from([10]), s("author"), Buffer.from([8]), s("name"), s("Alex"), Buffer.from([0]),
    Buffer.from([11]), s("blocks"), i32(2), i32(7), i32(9),
    Buffer.from([0]),
  ]));
}

function glb() {
  const pos = [], nor = [], uv = [], idx = [];
  const faces = [[[0, 0, 1], [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]]], [[0, 0, -1], [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]]], [[1, 0, 0], [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]]],
    [[-1, 0, 0], [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]]], [[0, 1, 0], [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]]], [[0, -1, 0], [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]]]];
  faces.forEach(([n, vs], f) => { vs.forEach((v, k) => { pos.push(...v); nor.push(...n); uv.push(k === 1 || k === 2 ? 1 : 0, k >= 2 ? 1 : 0); }); idx.push(f * 4, f * 4 + 1, f * 4 + 2, f * 4, f * 4 + 2, f * 4 + 3); });
  const f32 = (a) => Buffer.from(new Float32Array(a).buffer);
  const u16 = Buffer.from(new Uint16Array(idx).buffer);
  const times = f32([0, 1, 2]);
  const rots = f32([0, 0, 0, 1, 0, 0.7071, 0, 0.7071, 0, 1, 0, 0]);
  const img = png(2, 2, (x, y) => [x * 255, y * 255, 128, 255]);
  const parts = [f32(pos), f32(nor), f32(uv), u16, times, rots, img];
  const views = []; let off = 0; const chunks = [];
  for (const p of parts) { views.push({ buffer: 0, byteOffset: off, byteLength: p.length }); const pad = (4 - (p.length % 4)) % 4; chunks.push(p, Buffer.alloc(pad)); off += p.length + pad; }
  const bin = Buffer.concat(chunks);
  const json = {
    asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: "Cube", mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0 } }], textures: [{ source: 0, sampler: 0 }], samplers: [{ magFilter: 9728, minFilter: 9728 }], images: [{ bufferView: 6, mimeType: "image/png" }],
    animations: [{ name: "Spin", samplers: [{ input: 4, output: 5, interpolation: "LINEAR" }], channels: [{ sampler: 0, target: { node: 0, path: "rotation" } }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 24, type: "VEC3", min: [-1, -1, -1], max: [1, 1, 1] }, { bufferView: 1, componentType: 5126, count: 24, type: "VEC3" }, { bufferView: 2, componentType: 5126, count: 24, type: "VEC2" },
      { bufferView: 3, componentType: 5123, count: 36, type: "SCALAR" }, { bufferView: 4, componentType: 5126, count: 3, type: "SCALAR", min: [0], max: [2] }, { bufferView: 5, componentType: 5126, count: 3, type: "VEC4" },
    ],
    bufferViews: views, buffers: [{ byteLength: bin.length }],
  };
  let js = Buffer.from(JSON.stringify(json)); js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
  const hdr = Buffer.alloc(12); hdr.write("glTF"); hdr.writeUInt32LE(2, 4); hdr.writeUInt32LE(12 + 8 + js.length + 8 + bin.length, 8);
  const c = (t, d) => { const h = Buffer.alloc(8); h.writeUInt32LE(d.length); h.write(t, 4); return Buffer.concat([h, d]); };
  return Buffer.concat([hdr, c("JSON", js), c("BIN\0", bin)]);
}

const sh = (cmd, args) => execFileSync(cmd, args, { stdio: "ignore" });

export function makeFixtures(dir, { realRepos = true } = {}) {
  const w = (rel, data) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); return p; };
  const out = {};
  w("img/pixel.png", png(16, 16, PIXEL));
  w("img/anim.png", png(16, 48, (x, y) => [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255]][Math.floor(y / 16)]));
  w("img/anim.png.mcmeta", JSON.stringify({ animation: { frametime: 1, frames: [0, 1, 2] } }, null, 2));
  w("img/big.png", png(1600, 1200, (x, y) => [x % 256, y % 256, (x + y) % 256, 255]));
  w("img/tex.png", png(16, 16, PIXEL));
  w("img/tex.png.import", '[remap]\n\nimporter="texture"\ntype="CompressedTexture2D"\npath="res://.godot/imported/tex.png-abc.ctex"\n\n[params]\n\ncompress/mode=0\nmipmaps/generate=false\nprocess/fix_alpha_border=true\n');
  w("img/vector.svg", '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="48" viewBox="0 0 64 48"><rect width="64" height="48" fill="#5e81ac"/><circle cx="32" cy="24" r="14" fill="#ebcb8b"/></svg>');
  sh("sips", ["-s", "format", "jpeg", path.join(dir, "img/big.png"), "--out", path.join(dir, "img/photo.jpg")]);
  w("docs/img/pic.png", png(16, 16, PIXEL));
  w("docs/other.md", "# Other\n\nYou followed the link.\n");
  const long = Array.from({ length: 120 }, (_, i) => `## Section ${i + 1}\n\nParagraph ${i + 1}. Lorem ipsum dolor sit amet, consectetur adipiscing elit.\n`).join("\n");
  w("docs/readme.md", `# Title\n\nSome *emphasis* and a [relative link](other.md) and an [external](https://example.com/x) and [anchor](#section-3).\n\n![pic](img/pic.png)\n\n| Name | Qty |\n| ---- | --- |\n| Apple | 3 |\n| Pear | 10 |\n\n- [x] done\n- [ ] todo\n\n\`\`\`js\nconst answer = 42;\nconsole.log(answer);\n\`\`\`\n\n<script>window.__pwned = 1</script>\n<img src="x" onerror="window.__pwned = 2">\n\n${long}`);
  const wavP = path.join(dir, "audio/tone.wav");
  fs.mkdirSync(path.dirname(wavP), { recursive: true });
  const lav = (rate, ch, secs, hz) => ["-f", "lavfi", "-i", `sine=frequency=${hz}:sample_rate=${rate}:duration=${secs}`, "-af", `volume=0.08${ch === 2 ? ",pan=stereo|c0=c0|c1=0.5*c0" : ""}`];
  sh("ffmpeg", ["-y", "-loglevel", "error", ...lav(22050, 1, 1.5, 440), "-c:a", "pcm_s16le", wavP]);
  sh("ffmpeg", ["-y", "-loglevel", "error", ...lav(44100, 2, 2, 330), "-c:a", "libvorbis", path.join(dir, "audio/tone.ogg")]);
  sh("ffmpeg", ["-y", "-loglevel", "error", ...lav(48000, 1, 1, 550), "-c:a", "pcm_s16be", path.join(dir, "audio/tone.aiff")]);
  sh("ffmpeg", ["-y", "-loglevel", "error", ...lav(44100, 2, 1.2, 660), "-c:a", "libmp3lame", path.join(dir, "audio/tone.mp3")]);
  w("models/box.glb", glb());
  const tex = "data:image/png;base64," + png(16, 16, PIXEL).toString("base64");
  w("models/block.bbmodel", JSON.stringify({
    meta: { format_version: "4.10", model_format: "free", box_uv: false }, name: "block", resolution: { width: 16, height: 16 },
    elements: [
      { name: "base", type: "cube", uuid: "u1", from: [0, 0, 0], to: [16, 4, 16], origin: [8, 0, 8], rotation: [0, 0, 0], faces: Object.fromEntries(["north", "east", "south", "west", "up", "down"].map((f) => [f, { uv: [0, 0, 16, 16], texture: 0 }])) },
      { name: "post", type: "cube", uuid: "u2", from: [6, 4, 6], to: [10, 14, 10], origin: [8, 4, 8], rotation: [0, 45, 0], faces: Object.fromEntries(["north", "east", "south", "west", "up", "down"].map((f) => [f, { uv: [0, 0, 8, 8], texture: 0 }])) },
    ],
    outliner: ["u1", { name: "grp", origin: [8, 4, 8], rotation: [0, 0, 0], uuid: "g1", children: ["u2"] }],
    textures: [{ name: "pixel.png", source: tex, width: 16, height: 16, uv_width: 16, uv_height: 16 }],
  }, null, 2));
  w("data/table.csv", "id,name,score\n" + Array.from({ length: 200 }, (_, i) => `${i + 1},"item ${200 - i}, quoted",${(i * 37) % 101}`).join("\n") + "\n");
  w("data/struct.nbt", nbtBytes());
  w("data/plain.snbt", '{\n\tname: "Alex"\n\tcount: 3b\n\tlist: [1, 2, 3]\n}\n');
  w("bin/unknown.xyz", Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2, 3, 0, 0, 0xff, 0xfe, ...Array.from({ length: 300 }, (_, i) => (i * 7) & 255)]));
  w("bin/native.class", Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 65]));
  w("big/huge.log", Array.from({ length: 140000 }, (_, i) => `line ${i} ${"x".repeat(50)}`).join("\n"));
  w("shaders/test.fsh", "#version 150\nuniform sampler2D Sampler0;\nin vec2 texCoord0;\nout vec4 fragColor;\nvoid main() {\n  fragColor = texture(Sampler0, texCoord0); // sample\n}\n");
  w("shaders/fx.gdshader", "shader_type canvas_item;\nuniform vec4 tint : source_color = vec4(1.0);\nvoid fragment() {\n  COLOR = texture(TEXTURE, UV) * tint;\n}\n");
  w("shaders/common.gdshaderinc", "float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }\n");
  w("scene.tscn", '[gd_scene format=3]\n\n[node name="Root" type="Node2D"]\nposition = Vector2(1, 2)\n');
  w("pack.mcmeta", '{"pack":{"pack_format":15,"description":"x"}}\n');
  w("notes.txt", "plain text\n");
  // video + zip/jar
  fs.mkdirSync(path.join(dir, "video"), { recursive: true });
  sh("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=64x64:rate=10:duration=1", "-pix_fmt", "yuv420p", "-c:v", "libx264", path.join(dir, "video/clip.mp4")]);
  const zdir = fs.mkdtempSync(path.join(os.tmpdir(), "ace-zip-"));
  fs.mkdirSync(path.join(zdir, "assets/mod"), { recursive: true });
  fs.writeFileSync(path.join(zdir, "assets/mod/lang.json"), '{"hello":"world"}\n');
  fs.writeFileSync(path.join(zdir, "assets/mod/pixel.png"), png(16, 16, PIXEL));
  fs.writeFileSync(path.join(zdir, "META-INF.txt"), "manifest\n");
  fs.mkdirSync(path.join(dir, "arc"), { recursive: true });
  execFileSync("zip", ["-qr", path.join(dir, "arc/sample.jar"), "."], { cwd: zdir });
  fs.copyFileSync(path.join(dir, "arc/sample.jar"), path.join(dir, "arc/sample.zip"));
  fs.rmSync(zdir, { recursive: true, force: true });
  // a few real samples copied out of the repos (read-only)
  if (realRepos) {
    const home = os.homedir();
    const cp = (src, rel) => { try { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.copyFileSync(src, path.join(dir, rel)); out[rel] = true; } catch { /* repo not present */ } };
    cp(path.join(home, "thematic-kyf/assets/fonts/VT323-Regular.ttf"), "fonts/VT323-Regular.ttf");
    cp(path.join(home, "thematic-kyf/assets/audio/sfx/ui_click.ogg"), "audio/ui_click.ogg");
  }
  return out;
}
