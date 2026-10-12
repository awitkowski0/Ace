import { describe, expect, it } from "vitest";
import { groupByBone, multiKeyTargets, valueDelta } from "./multikey";

const R = (bone: string, time: number) => ({ bone, channel: "rotation" as const, time });
const P = (bone: string, time: number) => ({ bone, channel: "position" as const, time });

describe("multiKeyTargets", () => {
  it("needs two selected keys and the playhead on one of the dragged channel", () => {
    const ks = [R("a", 0), R("a", 0.5), P("a", 0)];
    expect(multiKeyTargets(ks, "rotation", 0.5)).toEqual([R("a", 0), R("a", 0.5)]);
    expect(multiKeyTargets(ks, "rotation", 0.25)).toBeNull();
    expect(multiKeyTargets([R("a", 0)], "rotation", 0)).toBeNull();
    expect(multiKeyTargets(ks, "scale", 0)).toBeNull();
    expect(multiKeyTargets([R("a", 0), P("a", 0)], "rotation", 0)).toBeNull();
  });
  it("tolerates float noise in the time", () => {
    expect(multiKeyTargets([R("a", 0.1), R("b", 0.1)], "rotation", 0.1 + 1e-6)).toHaveLength(2);
  });
});
describe("valueDelta / groupByBone", () => {
  it("rounds", () => { expect(valueDelta([1, 2, 3], [11.00001, 2, 0])).toEqual([10, 0, -3]); });
  it("groups", () => { expect([...groupByBone([R("a", 0), R("b", 0), R("a", 1)]).keys()]).toEqual(["a", "b"]); });
});
