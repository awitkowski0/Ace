/**
 * The validators vs a line-for-line port of WebSlingAnimationsJsonTest (main checkout,
 * src/test/java/bond/thematic/mod/abilities/swing/WebSlingAnimationsJsonTest.java) run over the SAME real file. Whatever the Java test would
 * fail on, the validators must report as an error of the matching code, and the other way round. Reads a temp copy of the main checkout.
 */
import { describe, expect, it } from "vitest";
import { parseDoc } from "../doc";
import { parsePoseSet } from "./poseSet";
import { validateSpidey } from "./validate";
import { webKitCopy } from "../testutil";

type Vec = number[];
const TOL = 1e-3;
const DEFAULT_PIVOT = 0.9;
/** WebSlingAnimationsJsonTest.keys(): a bare [x,y,z] is one key at 0.0; an object is a map of time -> vector | {vector}. */
function keys(channel: unknown): Map<number, Vec> {
  const out = new Map<number, Vec>();
  if (Array.isArray(channel)) { out.set(0, channel as Vec); return out; }
  for (const [t, v] of Object.entries(channel as Record<string, unknown>)) {
    const vec = Array.isArray(v) ? (v as Vec) : ((v as { vector?: Vec }).vector ?? undefined);
    if (vec) out.set(Number(t), vec);
  }
  return out;
}
const value = (ks: Map<number, Vec>, t: number) => { for (const [k, v] of ks) if (Math.abs(k - t) < TOL) return v; return undefined; };

function javaFailures(anims: Record<string, any>) {
  const grid = new Set<string>(), wrap = new Set<string>(), loop = new Set<string>(), hinge = new Set<string>();
  for (const [name, clip] of Object.entries(anims)) {
    const length: number = clip.animation_length;
    if (Math.abs(Math.round(length * 20) / 20 - length) > TOL) grid.add(`${name}|length`);
    for (const [bone, b] of Object.entries<any>(clip.bones ?? {})) {
      for (const [channel, c] of Object.entries<any>(b)) {
        for (const [t] of keys(c)) {
          if (Math.abs(Math.round(t * 20) - t * 20) > TOL) grid.add(`${name}|${bone}|${channel}|${t}`);
          if (t > length + TOL) grid.add(`${name}|${bone}|${channel}|${t}|past`);
        }
      }
      if (b.rotation) {
        const sorted = [...keys(b.rotation)].sort((x, y) => x[0] - y[0]).map((x) => x[1]);
        for (let i = 1; i < sorted.length; i++) for (let ax = 0; ax < 3; ax++) if (Math.abs(sorted[i][ax] - sorted[i - 1][ax]) > 180) wrap.add(`${name}|${bone}`);
      }
    }
    if (clip.loop === true) {
      for (const [bone, b] of Object.entries<any>(clip.bones ?? {})) {
        for (const [channel, c] of Object.entries<any>(b)) {
          const ks = keys(c);
          if (ks.size < 2) continue;
          const f = value(ks, 0), l = value(ks, length);
          if (!f || !l || [0, 1, 2].some((i) => Math.abs(f[i] - l[i]) > TOL)) loop.add(`${name}|${bone}|${channel}`);
        }
      }
    }
    const pivot = clip.bones?.swing_pivot?.position ? value(keys(clip.bones.swing_pivot.position), 0) : undefined;
    const expected = ({ web_climb: 0, web_crawl: 1.3, web_cling: 1.3, web_wall_hold: 1.3, web_hook: 1.3, web_wall_run: 0.15, web_perch_back: 0.7 } as Record<string, number>)[name] ?? DEFAULT_PIVOT;
    if (!pivot || Math.abs(DEFAULT_PIVOT + pivot[1] / 16 - expected) > TOL) hinge.add(name);
  }
  return { grid, wrap, loop, hinge };
}

describe("validators match WebSlingAnimationsJsonTest on the real web_sling.animation.json", async () => {
  const kit = await webKitCopy();
  it.skipIf(!kit)("same failures, same places", () => {
    const raw = JSON.parse(kit!.animText).animations as Record<string, any>;
    const java = javaFailures(raw);
    const doc = parseDoc(kit!.animText, "animation");
    const set = parsePoseSet(kit!.posesText, "web", kit!.poses);
    const errs = validateSpidey(doc, [set]).filter((p) => p.severity === "error");
    const by = (code: string) => errs.filter((p) => p.code === code);
    expect(new Set(by("loop-open").map((p) => `${p.anim}|${p.bone}|${p.channel}`))).toEqual(java.loop);
    expect(new Set(by("rotation-wrap").map((p) => `${p.anim}|${p.bone}`))).toEqual(java.wrap);
    const grid = new Set([...by("off-grid").map((p) => `${p.anim}|${p.bone}|${p.channel}|${p.time}`), ...by("length-off-grid").map((p) => `${p.anim}|length`), ...by("key-past-length").map((p) => `${p.anim}|${p.bone}|${p.channel}|${p.time}|past`)]);
    expect(grid).toEqual(java.grid);
    expect(new Set([...by("wrong-hinge"), ...by("no-swing-pivot")].map((p) => p.anim))).toEqual(java.hinge);
    // nothing else is an error on the real file
    const known = new Set(["loop-open", "rotation-wrap", "off-grid", "length-off-grid", "key-past-length", "wrong-hinge", "no-swing-pivot"]);
    expect(errs.filter((p) => !known.has(p.code)).map((p) => `${p.code} ${p.anim} ${p.message}`)).toEqual([]);
  });
});
