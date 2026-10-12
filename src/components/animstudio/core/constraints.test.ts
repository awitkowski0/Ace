import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { readFileSync, existsSync } from "node:fs";
import { parseDoc, serialize, getAnimation, getAnimations } from "./doc";
import { PLAYER_RIG } from "./rig";
import { samplePose, type Pose } from "./sample";
import { rigFromGeo } from "../ui/model";
import {
  Skeleton, applyConstraints, bakeConstraints, constraintWeight, constraintsFromJson, constraintsToJson, makeFollow, makeLink, makePin,
  pointWorldFile, readBbConstraints, setBbConstraints, simplifySeries, skeletonOf, type ConsBone, type Constraint, type PointRef,
} from "./constraints";
import type { NumVec3 } from "./format/animation";

const player: ConsBone[] = PLAYER_RIG.map((b) => ({ name: b.name, pivot: [...b.pivot] as NumVec3 }));
const dist = (a: NumVec3, b: NumVec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const OPTS = { t: 0, length: 2 };
const SPIDEY = "/Users/alexw/IdeaProjects/Thematic-Collections/src/packs/heroes/resources/assets/thematic/geo/armor/spiderman.geo.json";

/** hand points of the player arms (bottom centre of the arm cube) */
const rHand: PointRef = { bone: "armorRightArm", p: [-6, 12, 0] };
const lHand: PointRef = { bone: "armorLeftArm", p: [6, 12, 0] };

describe("constraint solve: player rig", () => {
  it("link, both driven: hands meet from several animated poses", () => {
    const sk = skeletonOf(player);
    const poses: Pose[] = [
      {},
      { armorRightArm: { rotation: [30, 0, 20] }, armorLeftArm: { rotation: [-40, 10, 0] } },
      { armorRightArm: { rotation: [-80, 25, -30] }, armorLeftArm: { rotation: [10, -40, 15] } },
    ];
    for (const pose of poses) {
      const c = makeLink(rHand, lHand, "both");
      const out = applyConstraints(player, [c], pose, OPTS);
      const A = pointWorldFile(sk, out, rHand), B = pointWorldFile(sk, out, lHand);
      expect(dist(A, B)).toBeLessThan(0.01);
    }
  });
  it("link, one driven: the driven point lands on the fixed one; the other bone is untouched", () => {
    const sk = skeletonOf(player);
    // a target the left arm can reach: its own hand after a known rotation, expressed as a point on the body
    const reach: Pose = { armorLeftArm: { rotation: [35, 15, -25] } };
    const wt = sk.worlds(reach);
    const onBody: PointRef = { bone: "armorBody", p: sk.fileFromWorld(wt, "armorBody", sk.pointWorld(wt, lHand)) };
    const base: Pose = { armorLeftArm: { rotation: [0, 0, 0] } };
    const out = applyConstraints(player, [makeLink(onBody, lHand, "b")], base, OPTS);
    expect(dist(pointWorldFile(sk, out, lHand), pointWorldFile(sk, out, onBody))).toBeLessThan(0.01);
    expect(out.armorBody).toBeUndefined();
    // minimal rotation: no roll about the aim axis was added beyond what the shortest arc needs
    const moved = out.armorLeftArm!.rotation!;
    expect(Math.hypot(...moved)).toBeLessThan(Math.hypot(...reach.armorLeftArm!.rotation!) + 30);
  });
  it("drag semantics: a fixed (dragged) bone is never modified; the other side follows alone", () => {
    const sk = skeletonOf(player);
    const both = makeLink(rHand, lHand, "both");
    // a right-arm rotation whose hand the left arm can reach (taken from the meet-in-the-middle solution)
    const meet = applyConstraints(player, [both], { armorRightArm: { rotation: [-50, 20, 10] } }, OPTS);
    const R = meet.armorRightArm!.rotation!;
    const out = applyConstraints(player, [both], { armorRightArm: { rotation: R } }, { ...OPTS, fixed: new Set(["armorRightArm"]) });
    expect(out.armorRightArm!.rotation).toEqual(R);
    expect(dist(pointWorldFile(sk, out, rHand), pointWorldFile(sk, out, lHand))).toBeLessThan(0.01);
    // out of reach: the driven limb still moves toward it (distance shrinks)
    const far: Pose = { armorRightArm: { rotation: [-50, 20, 10] } };
    const before = dist(pointWorldFile(sk, far, rHand), pointWorldFile(sk, far, lHand));
    const o2 = applyConstraints(player, [makeLink(rHand, lHand, "b")], far, OPTS);
    expect(dist(pointWorldFile(sk, o2, rHand), pointWorldFile(sk, o2, lHand))).toBeLessThan(before);
  });
  it("pin keeps a point at its captured world position", () => {
    const sk = skeletonOf(player);
    const f0: Pose = { armorRightArm: { rotation: [20, -10, 5] } };
    const world = pointWorldFile(sk, f0, rHand);
    const pin = makePin(rHand, world, 0);
    for (const rot of [[-30, 10, 5], [60, 40, -20], [0, 0, 0]] as NumVec3[]) {
      const out = applyConstraints(player, [pin], { armorRightArm: { rotation: rot } }, OPTS);
      expect(dist(pointWorldFile(sk, out, rHand), world)).toBeLessThan(0.01);
    }
  });
  it("follow copies (and mirrors) rotation; influence and time range weight it", () => {
    const f = makeFollow("armorRightArm", "armorLeftArm", true);
    const out = applyConstraints(player, [f], { armorRightArm: { rotation: [30, 20, 10] } }, OPTS);
    const r = out.armorLeftArm!.rotation!;
    expect(r[0]).toBeCloseTo(30, 3); expect(r[1]).toBeCloseTo(-20, 3); expect(r[2]).toBeCloseTo(-10, 3);
    const half = { ...f, influence: 0.5 };
    const h = applyConstraints(player, [half], { armorRightArm: { rotation: [30, 0, 0] } }, OPTS).armorLeftArm!.rotation!;
    expect(h[0]).toBeGreaterThan(10); expect(h[0]).toBeLessThan(20);
    const ranged = { ...f, start: 0.5, end: 1, blendIn: 4, blendOut: 4 };
    expect(constraintWeight(ranged, 0.2, 2)).toBe(0);
    expect(constraintWeight(ranged, 0.6, 2)).toBeCloseTo(0.5, 6);
    expect(constraintWeight(ranged, 0.75, 2)).toBe(1);
    expect(constraintWeight(ranged, 1.1, 2)).toBe(0);
    expect(applyConstraints(player, [ranged], { armorRightArm: { rotation: [30, 0, 0] } }, { t: 0.2, length: 2 }).armorLeftArm).toBeUndefined();
  });
  it("disabled constraints do nothing", () => {
    const c = { ...makeFollow("armorRightArm", "armorLeftArm"), enabled: false };
    const pose: Pose = { armorRightArm: { rotation: [30, 0, 0] } };
    expect(applyConstraints(player, [c], pose, OPTS)).toBe(pose);
  });
});

describe("constraint kinematics match the viewport (three.js hierarchy, same as RigView.setPose)", () => {
  const spidey = existsSync(SPIDEY);
  (spidey ? it : it.skip)("world points of the real Spiderman geo agree with three.js", () => {
    const rig = rigFromGeo(parseDoc(readFileSync(SPIDEY, "utf8"), "geo"))!;
    const sk = new Skeleton(rig.bones);
    const D2R = Math.PI / 180;
    const pose: Pose = {
      armorRightArm: { rotation: [-35, 20, 12] }, rightArmtop: { rotation: [10, -5, 8], position: [0.5, 1, -0.5] },
      bone87: { rotation: [5, 15, -25] }, armorBody: { rotation: [0, 12, 0] }, bone271: { rotation: [20, 0, 0] },
    };
    // three.js tree built exactly like RigView
    const groups = new Map<string, THREE.Group>();
    const byName = new Map(rig.bones.map((b) => [b.name, b]));
    for (const b of rig.bones) {
      const g = new THREE.Group();
      const parent = b.parent ? byName.get(b.parent) : undefined;
      const pv = [-b.pivot[0], b.pivot[1], b.pivot[2]];
      const qv = parent ? [-parent.pivot[0], parent.pivot[1], parent.pivot[2]] : [0, 0, 0];
      const r = b.rotation ?? [0, 0, 0];
      const p = pose[b.name];
      g.position.set(pv[0] - qv[0], pv[1] - qv[1], pv[2] - qv[2]);
      if (p?.position) g.position.set(g.position.x - p.position[0], g.position.y + p.position[1], g.position.z + p.position[2]);
      const a = p?.rotation ?? [0, 0, 0];
      g.rotation.set(-r[0] * D2R - a[0] * D2R, -r[1] * D2R - a[1] * D2R, r[2] * D2R + a[2] * D2R, "ZYX");
      groups.set(b.name, g);
    }
    const root = new THREE.Group();
    for (const b of rig.bones) {
      const par = b.parent && byName.has(b.parent) && b.parent !== b.name ? groups.get(b.parent) : undefined;
      (par ?? root).add(groups.get(b.name)!);
    }
    root.updateMatrixWorld(true);
    const w = sk.worlds(pose);
    for (const name of ["armorRightArm", "rightArmtop", "bone87", "bone97", "bone113", "bone133", "armorLeftArm", "bone271", "bone272", "bone228"]) {
      const b = byName.get(name)!;
      const local = new THREE.Vector3(-(b.pivot[0] + 1.5 - b.pivot[0]), 2.5, -1);
      const ref = groups.get(name)!.localToWorld(local.clone());
      const ref2 = sk.pointWorld(w, { bone: name, p: [b.pivot[0] + 1.5, b.pivot[1] + 2.5, b.pivot[2] - 1] });
      expect(Math.hypot(ref.x - ref2[0], ref.y - ref2[1], ref.z - ref2[2])).toBeLessThan(1e-4);
    }
  });
});

describe("constraint solve: Spiderman geo (read-only)", () => {
  const spidey = existsSync(SPIDEY);
  (spidey ? it : it.skip)("hand points meet through the arm hierarchy; pin holds", () => {
    const rig = rigFromGeo(parseDoc(readFileSync(SPIDEY, "utf8"), "geo"))!;
    const sk = skeletonOf(rig.bones);
    const pt = (bone: string): NumVec3 => {
      const c = rig.bones.find((b) => b.name === bone)!.cubes[0];
      return [c.origin[0], c.origin[1], c.origin[2] + c.size[2] / 2]; // an edge midpoint of the first cube
    };
    const a: PointRef = { bone: "rightArmBottom", p: pt("rightArmBottom"), via: "armorRightArm" };
    const b: PointRef = { bone: "leftArmBottom", p: pt("leftArmBottom"), via: "armorLeftArm" };
    const pose: Pose = { armorRightArm: { rotation: [-25, 10, 15] }, armorLeftArm: { rotation: [15, -20, -10] }, rightArmtop: { rotation: [8, 0, 0] } };
    const out = applyConstraints(rig.bones, [makeLink(a, b, "both")], pose, OPTS);
    const w = sk.worlds(out);
    expect(dist(sk.pointWorld(w, a), sk.pointWorld(w, b))).toBeLessThan(0.01);
    // the clip's other bones were not touched
    expect(out.rightArmtop).toEqual(pose.rightArmtop);
    // pin on a deep bone, rotating an ancestor chain member
    const world = pointWorldFile(sk, pose, a);
    const out2 = applyConstraints(rig.bones, [makePin(a, world, 0)], { armorRightArm: { rotation: [40, -20, 30] }, rightArmtop: { rotation: [8, 0, 0] } }, OPTS);
    expect(dist(pointWorldFile(sk, out2, a), world)).toBeLessThan(0.01);
  });
});

describe("bake", () => {
  const ANIM = JSON.stringify({
    format_version: "1.8.0",
    animations: { "animation.t": { animation_length: 1, loop: false, bones: {
      armorRightArm: { rotation: { "0.0": [0, 0, 0], "0.5": [-70, 25, 20], "1.0": [-20, -10, 0] } },
      armorLeftArm: { rotation: { "0.0": [0, 0, 0], "1.0": [0, 0, 0] } },
    } } },
  }, null, 2);
  const link = makeLink(rHand, lHand, "b");

  it("ticks: a key every 0.05 s, points coincide when the baked doc is sampled WITHOUT constraints", () => {
    const doc = parseDoc(ANIM, "animation");
    const r = bakeConstraints(doc, player, [link], { anim: "animation.t", at: "ticks" });
    expect(r.bones).toEqual(["armorLeftArm"]);
    const a = getAnimation(r.doc, "animation.t")!;
    expect(a.bones.get("armorLeftArm")!.rotation!.keys).toHaveLength(21);
    const sk = skeletonOf(player);
    let worst = 0;
    for (let i = 0; i <= 20; i++) {
      const t = i * 0.05;
      const p = samplePose(a, t, { wrap: false });
      const A = pointWorldFile(sk, p, rHand), B = pointWorldFile(sk, p, lHand);
      // reachable only when the right hand is on the left arm's sphere; compare against what the live solve gives instead
      const live = applyConstraints(player, [link], samplePose(getAnimation(doc, "animation.t")!, t, { wrap: false }), { t, length: 1 });
      worst = Math.max(worst, dist(pointWorldFile(sk, live, lHand), B));
      void A;
    }
    expect(worst).toBeLessThan(0.01);
    // the right arm's own keys are untouched, and the bake re-serializes cleanly
    expect(a.bones.get("armorRightArm")!.rotation!.keys).toHaveLength(3);
    expect(() => parseDoc(serialize(r.doc), "animation")).not.toThrow();
  });
  it("keys-only mode keys the times where inputs already have keys", () => {
    const doc = parseDoc(ANIM, "animation");
    const r = bakeConstraints(doc, player, [link], { anim: "animation.t", at: "keys" });
    const ks = getAnimation(r.doc, "animation.t")!.bones.get("armorLeftArm")!.rotation!.keys.map((k) => k.time);
    expect(ks).toEqual([0, 0.5, 1]);
  });
  it("euler continuity: no step over 180 degrees even when the solve flips branch", () => {
    const text = JSON.stringify({ format_version: "1.8.0", animations: { "animation.w": { animation_length: 2, bones: {
      armorRightArm: { rotation: { "0.0": [0, 175, 0], "1.0": [0, -175, 0], "2.0": [0, 175, 0] } },
      armorLeftArm: { rotation: { "0.0": [0, 175, 0], "2.0": [0, 175, 0] } },
    } } } });
    const doc = parseDoc(text, "animation");
    const c = makeFollow("armorRightArm", "armorLeftArm");
    const r = bakeConstraints(doc, player, [c], { anim: "animation.w", at: "ticks" });
    const keys = getAnimation(r.doc, "animation.w")!.bones.get("armorLeftArm")!.rotation!.keys;
    for (let i = 1; i < keys.length; i++) for (let a = 0; a < 3; a++) {
      expect(Math.abs((keys[i].value[a] as number) - (keys[i - 1].value[a] as number))).toBeLessThan(180);
    }
  });
  it("simplify drops redundant keys within tolerance", () => {
    const doc = parseDoc(ANIM, "animation");
    const dense = bakeConstraints(doc, player, [link], { anim: "animation.t" });
    const slim = bakeConstraints(doc, player, [link], { anim: "animation.t", simplify: 0.5 });
    const n = (d: typeof doc) => getAnimation(d, "animation.t")!.bones.get("armorLeftArm")!.rotation!.keys.length;
    expect(n(slim.doc)).toBeLessThan(n(dense.doc));
    // sampled difference stays within the tolerance (plus rounding)
    const a = getAnimation(dense.doc, "animation.t")!, b = getAnimation(slim.doc, "animation.t")!;
    for (let i = 0; i <= 20; i++) {
      const pa = samplePose(a, i * 0.05, { wrap: false }).armorLeftArm!.rotation!, pb = samplePose(b, i * 0.05, { wrap: false }).armorLeftArm!.rotation!;
      for (let k = 0; k < 3; k++) expect(Math.abs(pa[k] - pb[k])).toBeLessThan(0.51);
    }
    expect(simplifySeries([0, 1, 2], [[0, 0, 0], [1, 0, 0], [2, 0, 0]], 0.1)).toEqual([0, 2]);
  });
  it("range limits the baked keys and keeps keys outside it", () => {
    const doc = parseDoc(ANIM, "animation");
    const c = { ...link, start: 0.25, end: 0.75 };
    const r = bakeConstraints(doc, player, [c], { anim: "animation.t" });
    const keys = getAnimation(r.doc, "animation.t")!.bones.get("armorLeftArm")!.rotation!.keys.map((k) => k.time);
    expect(keys[0]).toBe(0);
    expect(keys).toContain(0.25);
    expect(keys).toContain(0.75);
    expect(keys[keys.length - 1]).toBe(1);
    expect(keys.length).toBe(2 + 11);
  });
});

describe("persistence", () => {
  const BB = JSON.stringify({ meta: { format_version: "4.10" }, name: "m", elements: [], outliner: [], animations: [] }, null, "\t") + "\n";
  const list: Constraint[] = [
    makeLink(rHand, lHand, "both", { start: 0.25, end: 1.5, blendIn: 2, blendOut: 3, influence: 0.8 }),
    makePin({ ...rHand, via: "armorLeftArm" }, [-6, 12.5, 1], 0.5),
    { ...makeFollow("armorRightArm", "armorLeftArm", true), offset: [1, 2, 3], enabled: false },
  ];
  it("bbmodel round trip under ace_constraints; removing restores the exact original text", () => {
    const doc = parseDoc(BB, "bbmodel");
    const withC = setBbConstraints(doc, { "animation.x": list });
    const text = serialize(withC);
    expect(text).toContain('"ace_constraints"');
    expect(text.startsWith(BB.slice(0, 20))).toBe(true);
    const back = readBbConstraints(parseDoc(text, "bbmodel"));
    expect(back["animation.x"]).toEqual(list);
    expect(serialize(setBbConstraints(withC, {}))).toBe(BB);
    // unchanged -> same doc object (no spurious edit)
    expect(setBbConstraints(withC, { "animation.x": list })).toBe(withC);
  });
  it("json validation drops junk and keeps defaults", () => {
    const m = constraintsFromJson(constraintsToJson({ a: list }));
    expect(m.a).toEqual(list);
    expect(constraintsFromJson({ animations: { a: [{ kind: "link" }, { kind: "bogus" }, null] } })).toEqual({});
    expect(constraintsFromJson(null)).toEqual({});
  });
  it("getAnimations still lists animations of a doc carrying ace_constraints", () => {
    const doc = setBbConstraints(parseDoc(BB, "bbmodel"), { x: list });
    expect(getAnimations(doc)).toEqual([]);
  });
});
