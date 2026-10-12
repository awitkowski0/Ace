import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createBridge } from "../src/bridge";
import { ctxFor, makeFixture, run } from "./fixtures";
import { startFakeAce } from "./fakeAce";

describe("without Ace", () => {
  it("studio tools say Ace isn't running", async () => {
    const f = makeFixture();
    const ctx = ctxFor(f.root, createBridge(`${f.root}/nope.sock`));
    for (const [n, a] of [["studio_state", {}], ["studio_screenshot", { t: 0.5 }], ["studio_set_time", { t: 1 }], ["run_game", {}]] as const) {
      const r = await run(ctx, n, a as never);
      expect(r.isError, n).toBe(true);
      expect(r.str, n).toMatch(/Ace isn't running/);
    }
  });
});

describe("with a (fake) Ace bridge", () => {
  it("routes edits of an open file through Ace instead of disk; returns screenshots as images", async () => {
    const f = makeFixture();
    const ace = await startFakeAce(`${f.root}/ace.sock`);
    try {
      const ctx = ctxFor(f.root, createBridge(ace.sock));
      const onDisk = readFileSync(f.mini, "utf8");
      // not open in Ace -> disk
      const dry = await run(ctx, "set_loop", { file: f.mini, anim: "web_air", loop: false, dry_run: true });
      expect(dry.str).toContain("DRY RUN");
      expect(ace.calls.filter((c) => c.op === "apply_text")).toHaveLength(0);
      // open (with an unsaved buffer that differs from disk) -> edit goes to the buffer
      ace.open.set(f.mini, onDisk.replace('"0.5"', '"0.55"'));
      const r = await run(ctx, "set_loop", { file: f.mini, anim: "web_air", loop: false });
      expect(r.str).toContain("Applied to the open Ace editor");
      expect(readFileSync(f.mini, "utf8")).toBe(onDisk);
      const applied = ace.calls.find((c) => c.op === "apply_text")!;
      expect(applied.args.text).toContain('"loop": false');
      expect(applied.args.text).toContain('"0.55"'); // built on the live buffer, not on disk
      expect(applied.args.label).toMatch(/^Claude:/);

      const shot = await run(ctx, "studio_screenshot", { frames: 2 });
      expect(shot.content[0]).toMatchObject({ type: "image", mimeType: "image/png" });
      expect(shot.str).toContain("t=0, 0.5s");
      const st = await run(ctx, "studio_state", {});
      expect(st.str).toContain("web_air");
    } finally { await ace.close(); }
  });
});
