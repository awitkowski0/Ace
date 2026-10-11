import { describe, expect, it } from "vitest";
import { compareCells, detectDelimiter, parseCsv, sortedIndex } from "./csv";
import { parseMcmeta, schedule, sheetLayout } from "./mcmeta";
import { boxUv, parseBbmodel } from "./bbmodel";
import { decide, providerFor, refine, TEXT_LIMIT } from "./registry";
import { parseNbt } from "./nbt";
import { resolveRelative, slug } from "./markdown";
import { decodeTga, sniffImage } from "./imageInfo";
import { listZip, readEntry } from "./zip";

describe("registry", () => {
  it("picks viewers by extension", () => {
    expect(decide("a.png").viewer).toBe("image");
    expect(decide("a.OGG").viewer).toBe("audio");
    expect(decide("model.glb").viewer).toBe("model");
    expect(decide("x.nbt").viewer).toBe("nbt");
    expect(decide("x.jar").viewer).toBe("archive");
    expect(decide("x.class").viewer).toBe("binary");
    expect(decide("README.md")).toMatchObject({ dual: "markdown" });
    expect(decide("data.csv")).toMatchObject({ dual: "csv" });
    expect(decide("icon.svg")).toMatchObject({ dual: "svg" });
    expect(decide("rock.png.mcmeta")).toMatchObject({ dual: "mcmeta" });
    expect(decide("a.ts")).toMatchObject({ needsProbe: false });
    expect(decide("weird.xyz").needsProbe).toBe(true);
    expect(providerFor("Makefile")).toBeNull();
  });
  it("refines with the probe: binary, too large, force", () => {
    const d = decide("weird.xyz");
    expect(refine(d, { size: 10, binary: true }).viewer).toBe("binary");
    expect(refine(d, { size: TEXT_LIMIT + 1, binary: false }).viewer).toBe("toolarge");
    expect(refine(d, { size: TEXT_LIMIT + 1, binary: false }, true).viewer).toBeUndefined();
    expect(refine(d, { size: 10, binary: true }, true).viewer).toBeUndefined();
    expect(refine(decide("a.png"), { size: 1, binary: true }).viewer).toBe("image");
  });
});

describe("csv", () => {
  it("parses quotes, escaped quotes, embedded newlines and CRLF", () => {
    expect(parseCsv('a,b\r\n"x,1","he said ""hi"""\n"l1\nl2",z')).toEqual([["a", "b"], ["x,1", 'he said "hi"'], ["l1\nl2", "z"]]);
  });
  it("detects delimiters", () => {
    expect(detectDelimiter("a;b;c\n1;2;3", "csv")).toBe(";");
    expect(detectDelimiter("a\tb", "tsv")).toBe("\t");
    expect(detectDelimiter("single", "csv")).toBe(",");
  });
  it("sorts numerically, naturally, empties last, stable", () => {
    const rows = [["b", "10"], ["a", "9"], ["c", ""], ["d", "9"]];
    expect(sortedIndex(rows, 1, 1)).toEqual([1, 3, 0, 2]);
    expect(sortedIndex(rows, 1, -1)).toEqual([0, 1, 3, 2]);
    expect(sortedIndex(rows, 0, 0)).toEqual([0, 1, 2, 3]);
    expect(compareCells("item2", "item10")).toBeLessThan(0);
  });
});

describe("mcmeta", () => {
  it("parses animation with per-frame times", () => {
    const a = parseMcmeta('{"animation":{"frametime":2,"interpolate":true,"frames":[0,{"index":1,"time":5},2]}}')!;
    expect(a.interpolate).toBe(true);
    expect(schedule(a, 3)).toEqual([{ index: 0, ticks: 2 }, { index: 1, ticks: 5 }, { index: 2, ticks: 2 }]);
    expect(sheetLayout(a, 16, 48)).toMatchObject({ fw: 16, fh: 16, total: 3 });
    expect(parseMcmeta("{}")).toBeNull();
    expect(parseMcmeta("nope")).toBeNull();
    expect(schedule(parseMcmeta('{"animation":{}}')!, 4)).toHaveLength(4);
  });
});

describe("bbmodel", () => {
  it("parses cubes, groups and box-uv", () => {
    const m = parseBbmodel(JSON.stringify({
      resolution: { width: 32, height: 32 },
      elements: [{ uuid: "a", name: "c", from: [0, 0, 0], to: [2, 3, 4], box_uv: true, uv_offset: [0, 0] }, { type: "mesh", uuid: "m" }],
      outliner: [{ name: "g", origin: [1, 1, 1], children: ["a"] }],
      textures: [{ name: "t", source: "data:image/png;base64,AA==" }],
    }));
    expect(m.cubes.size).toBe(1);
    expect(m.skipped).toBe(1);
    expect(m.cubes.get("a")!.faces.north!.uv).toEqual(boxUv([0, 0], [2, 3, 4]).north);
    expect((m.root[0] as { children: unknown[] }).children).toEqual(["a"]);
    expect(m.textures[0].uvW).toBe(32);
  });
});

describe("nbt", () => {
  const u16 = (n: number) => [n >> 8, n & 255];
  const str = (s: string) => [...u16(s.length), ...new TextEncoder().encode(s)];
  it("reads a big-endian compound with nested list", async () => {
    const bytes = new Uint8Array([
      10, ...str("root"),
      3, ...str("n"), 0, 0, 1, 0, // int 256
      8, ...str("s"), ...str("hi"),
      9, ...str("l"), 1, 0, 0, 0, 2, 5, 6, // list of 2 bytes
      0,
    ]);
    const r = await parseNbt(bytes);
    expect(r.root.name).toBe("root");
    expect(r.root.children!.map((c) => [c.name, c.value ?? c.count])).toEqual([["n", "256"], ["s", '"hi"'], ["l", 2]]);
    expect(r.endian).toBe("big");
  });
  it("rejects non-NBT", async () => {
    await expect(parseNbt(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow(/NBT/);
  });
});

describe("markdown helpers", () => {
  it("resolves relative paths", () => {
    expect(resolveRelative("/a/b", "../img/x.png")).toBe("/a/img/x.png");
    expect(resolveRelative("/a/b", "./c.md")).toBe("/a/b/c.md");
    expect(resolveRelative("/a/b", "/abs.md")).toBe("/abs.md");
    expect(slug("Hello, World! 2")).toBe("hello-world-2");
  });
});

describe("images", () => {
  it("sniffs png header", () => {
    const b = new Uint8Array(40); b.set([0x89, 0x50, 0x4e, 0x47]); b[24] = 8; b[25] = 6;
    expect(sniffImage(b, "png")).toEqual({ format: "PNG", depth: "32-bit RGBA" });
  });
  it("decodes an uncompressed 2x1 truecolour TGA (bottom-left origin)", () => {
    const h = new Uint8Array(18); h[2] = 2; h[12] = 2; h[14] = 1; h[16] = 24; h[17] = 0;
    const t = decodeTga(new Uint8Array([...h, 0, 0, 255, 255, 0, 0]))!; // BGR: red, blue
    expect([...t.rgba]).toEqual([255, 0, 0, 255, 0, 0, 255, 255]);
  });
});

describe("zip", () => {
  it("lists and reads stored entries", async () => {
    // hand-built zip with one stored file "a.txt" = "hello"
    const name = new TextEncoder().encode("a.txt"), data = new TextEncoder().encode("hello");
    const w = (n: number, b: number) => Array.from({ length: b }, (_, i) => (n >> (8 * i)) & 255);
    const local = [...w(0x04034b50, 4), ...w(20, 2), ...w(0, 2), ...w(0, 2), ...w(0, 4), ...w(0, 4), ...w(5, 4), ...w(5, 4), ...w(name.length, 2), ...w(0, 2), ...name, ...data];
    const cd = [...w(0x02014b50, 4), ...w(20, 2), ...w(20, 2), ...w(0, 2), ...w(0, 2), ...w(0, 4), ...w(0, 4), ...w(5, 4), ...w(5, 4), ...w(name.length, 2), ...w(0, 2), ...w(0, 2), ...w(0, 2), ...w(0, 2), ...w(0, 4), ...w(0, 4), ...name];
    const eocd = [...w(0x06054b50, 4), ...w(0, 2), ...w(0, 2), ...w(1, 2), ...w(1, 2), ...w(cd.length, 4), ...w(local.length, 4), ...w(0, 2)];
    const file = new Uint8Array([...local, ...cd, ...eocd]);
    const read = async (o: number, l: number) => file.slice(o, o + l);
    const es = await listZip(file.length, read);
    expect(es.map((e) => e.name)).toEqual(["a.txt"]);
    expect(new TextDecoder().decode(await readEntry(es[0], read))).toBe("hello");
  });
});
