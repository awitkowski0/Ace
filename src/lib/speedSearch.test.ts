import { describe, expect, it } from "vitest";
import { firstFrom, isSpeedSearchLive, matchAll, matchName, setSpeedSearchLive, SS_IDLE, speedSearchWants, stepSpeedSearch, type SSKey, type SSState } from "./speedSearch";

const hl = (p: string, t: string) => matchName(p, t)?.map(([a, b]) => t.slice(a, b)) ?? null;

describe("matchName", () => {
  it("empty pattern matches, no ranges", () => expect(matchName("", "x")).toEqual([]));
  it("prefix, case-insensitive", () => expect(hl("ma", "Main.kt")).toEqual(["Ma"]));
  it("plain substring mid-word (leading *)", () => expect(hl("ain", "Main.kt")).toEqual(["ain"]));
  it("camel humps", () => {
    expect(hl("wsa", "WebSlingAnimation.java")).toEqual(["W", "S", "A"]);
    expect(hl("WSA", "WebSlingAnimation.java")).toEqual(["W", "S", "A"]);
    expect(hl("wesa", "WebSlingAnimation.java")).toEqual(["We", "S", "A"]);
  });
  it("underscores and dots are word boundaries", () => {
    expect(hl("wsa", "web_sling.animation.json")).toEqual(["w", "s", "a"]);
    expect(hl("sl.an", "web_sling.animation.json")).toEqual(["sl", ".an"]);
    expect(hl("ation.j", "web_sling.animation.json")).toEqual(["ation.j"]);
  });
  it("uppercase pattern char needs a hump", () => {
    expect(matchName("Sa", "swing_animation")).not.toBeNull();
    expect(matchName("Ain", "Main.kt")).toBeNull();
  });
  it("wildcard", () => {
    expect(hl("web*json", "web_sling.animation.json")).toEqual(["web", "json"]);
    expect(hl("w*n", "web_sling.animation.json")).toEqual(["w", "n"]);
    expect(matchName("json*web", "web_sling.animation.json")).toBeNull();
    expect(hl("web json", "web_sling.animation.json")).toEqual(["web", "json"]);
  });
  it("does not match scattered mid-word letters", () => {
    expect(matchName("mn", "Main.kt")).toBeNull();
    expect(matchName("zz", "Main.kt")).toBeNull();
    expect(matchName("kta", "Main.kt")).toBeNull();
  });
  it("digits are boundaries", () => expect(hl("v2", "model_v2.geo.json")).toEqual(["v2"]));
  it("acronyms", () => expect(hl("xp", "XMLParser.java")).toEqual(["X", "P"]));
  it("prefers word starts over earlier mid-word hits", () => expect(matchName("sw", "aswing_sw")![0]).toEqual([7, 9]));
  it("merges adjacent ranges", () => expect(matchName("web", "web_sling")).toEqual([[0, 3]]));
  it("longer pattern is never a wider match than its prefix", () => {
    const names = ["web_sling.animation.json", "WebSlingAnimation.java", "Main.kt", "a_b_c", "XMLParser", "foo.bar.baz"];
    for (const p of ["w", "ws", "wsa", "ain", "a_b", "xp", "o.b", "ba"]) for (const n of names) if (matchName(p + "z", n) && matchName(p, n) == null) throw new Error(p + n);
  });
});

describe("matchAll", () => {
  it("indexes and narrowing by candidates", () => {
    const texts = ["alpha", "beta", "alphabet", "gamma"];
    const all = matchAll("al", texts);
    expect([...all.keys()]).toEqual([0, 2]);
    expect([...matchAll("alp", texts, all.keys()).keys()]).toEqual([0, 2]);
    expect(matchAll("", texts).size).toBe(0);
  });
});

const ev = (key: string, o: object = {}) => ({ key, ...o });
function run(texts: string[], keys: (string | SSKey)[], sel = 0) {
  let s: SSState = SS_IDLE;
  let cur = sel;
  let activated = false;
  let handledAll: boolean[] = [];
  for (const k of keys) {
    const e = typeof k === "string" ? ev(k) : k;
    const r = stepSpeedSearch(s, e, { sel: cur, matchesFor: (q) => [...matchAll(q, texts).keys()] });
    s = r.state; handledAll.push(r.handled);
    if (r.select != null) cur = r.select;
    if (r.activate) activated = true;
  }
  return { s, cur, activated, handledAll };
}
const T = ["Assets", "build.gradle", "src", "main", "Main.kt", "MainView.kt", "Zed.txt"];

describe("stepSpeedSearch", () => {
  it("typing starts search and selects the first match at/after selection", () => {
    expect(run(T, ["m"], 0).cur).toBe(3);
    expect(run(T, ["m"], 4).cur).toBe(4);
    expect(run(T, ["m"], 5).cur).toBe(5);
  });
  it("wraps to the top when nothing after selection", () => expect(run(T, ["a"], 6).cur).toBe(0));
  it("refines while typing and keeps the selection when still matching", () => {
    const r = run(T, ["m", "a", "i", "n", "v"], 0);
    expect(r.s).toEqual({ active: true, query: "mainv" });
    expect(r.cur).toBe(5);
  });
  it("no match: selection unchanged, search stays open", () => {
    const r = run(T, ["q", "q"], 2);
    expect(r.s.query).toBe("qq"); expect(r.cur).toBe(2);
  });
  it("down/up move between matches only, wrapping", () => {
    expect(run(T, ["m", "ArrowDown"], 0).cur).toBe(4);
    expect(run(T, ["m", "ArrowDown", "ArrowDown"], 0).cur).toBe(5);
    expect(run(T, ["m", "ArrowDown", "ArrowDown", "ArrowDown"], 0).cur).toBe(3);
    expect(run(T, ["m", "ArrowUp"], 0).cur).toBe(5);
    expect(run(T, ["m", "ArrowUp", "ArrowUp"], 0).cur).toBe(4);
  });
  it("home/end go to first/last match", () => {
    expect(run(T, ["m", "End"], 0).cur).toBe(5);
    expect(run(T, ["m", "End", "Home"], 0).cur).toBe(3);
  });
  it("backspace edits, closing when empty", () => {
    expect(run(T, ["m", "a", "Backspace"], 0).s.query).toBe("m");
    expect(run(T, ["m", "Backspace"], 0).s.active).toBe(false);
  });
  it("Escape closes and keeps the selection", () => {
    const r = run(T, ["m", "Escape"], 0);
    expect(r.s.active).toBe(false); expect(r.cur).toBe(3); expect(r.activated).toBe(false);
  });
  it("Enter activates and closes", () => {
    const r = run(T, ["z", "Enter"], 0);
    expect(r.activated).toBe(true); expect(r.s.active).toBe(false); expect(r.cur).toBe(6);
  });
  it("space never starts a search but extends one", () => {
    expect(run(T, [" "]).s.active).toBe(false);
    expect(run(["a b", "ab"], ["a", " ", "b"]).s.query).toBe("a b");
  });
  it("modifiers do not start it; other shortcuts close it and pass through", () => {
    expect(run(T, [{ key: "m", metaKey: true } as any]).s.active).toBe(false);
    expect(run(T, [{ key: "m", ctrlKey: true } as any]).handledAll).toEqual([false]);
    const r = run(T, ["m", { key: "k", metaKey: true } as any]);
    expect(r.s.active).toBe(false); expect(r.handledAll).toEqual([true, false]);
    expect(run(T, ["m", "ArrowLeft"]).s.active).toBe(false);
  });
  it("inactive: navigation keys are not handled", () => {
    for (const k of ["ArrowDown", "Enter", "Backspace", "Escape", "Home"]) expect(run(T, [k]).handledAll).toEqual([false]);
  });
  it("shift+letter starts (uppercase)", () => expect(run(T, [{ key: "R", shiftKey: true }]).s.query).toBe("R"));
});

describe("speedSearchWants (dispatcher yield)", () => {
  const on: SSState = { active: true, query: "a" };
  it("when idle only printable non-space starts", () => {
    expect(speedSearchWants(SS_IDLE, ev("p"))).toBe(true);
    expect(speedSearchWants(SS_IDLE, ev(" "))).toBe(false);
    expect(speedSearchWants(SS_IDLE, ev("Enter"))).toBe(false);
  });
  it("when active bare nav keys and printables", () => {
    for (const k of ["Enter", "Backspace", "Escape", "ArrowUp", "ArrowDown", "Home", "End", "x", " "]) expect(speedSearchWants(on, ev(k))).toBe(true);
    expect(speedSearchWants(on, ev("F6"))).toBe(false);
    expect(speedSearchWants(on, ev("Escape", { shiftKey: true }))).toBe(true);
    expect(speedSearchWants(on, ev("x", { metaKey: true }))).toBe(false);
  });
});

describe("misc", () => {
  it("firstFrom", () => { expect(firstFrom([2, 5], 3)).toBe(5); expect(firstFrom([2, 5], 6)).toBe(2); expect(firstFrom([], 0)).toBeNull(); });
  it("live counter", () => { setSpeedSearchLive(true); expect(isSpeedSearchLive()).toBe(true); setSpeedSearchLive(false); expect(isSpeedSearchLive()).toBe(false); });
});

describe("performance", () => {
  it("17k names: full search and incremental narrowing stay cheap", () => {
    const names = Array.from({ length: 17000 }, (_, i) => `asset_${i}_${["web_sling", "WalkCycle", "idle.pose", "Hammer_Model"][i % 4]}.${["json", "png"][i % 2]}`);
    const t0 = performance.now();
    let m = matchAll("w", names);
    for (const q of ["wa", "wal", "walk"]) m = matchAll(q, names, m.keys());
    const full = matchAll("walkcy", names);
    const dt = performance.now() - t0;
    expect(m.size).toBeGreaterThan(0);
    expect(full.size).toBeGreaterThan(0);
    expect(dt).toBeLessThan(400);
  });
});
