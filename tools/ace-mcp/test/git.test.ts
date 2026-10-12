import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ctxFor, run, tmpRoot } from "./fixtures";

const sh = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
const ASSET = "src/main/resources/assets/mod/animations/armor/a.animation.json";
const TEX = "src/main/resources/assets/mod/textures/item/t.png";

function setup() {
  const base = tmpRoot("ace-git-");
  const bare = `${base}/remote.git`;
  sh(base, "init", "--bare", "-b", "main", bare);
  const mk = (n: string) => { const d = `${base}/${n}`; sh(base, "clone", bare, d); sh(d, "config", "user.name", "t"); sh(d, "config", "user.email", "t@t"); return d; };
  const a = mk("a");
  mkdirSync(`${a}/src/main/resources/assets/mod/animations/armor`, { recursive: true });
  mkdirSync(`${a}/src/main/resources/assets/mod/textures/item`, { recursive: true });
  writeFileSync(`${a}/${ASSET}`, '{"format_version":"1.8.0","animations":{}}\n');
  writeFileSync(`${a}/README.md`, "hi\n");
  sh(a, "add", "-A"); sh(a, "commit", "-m", "init"); sh(a, "push", "-u", "origin", "HEAD:main");
  sh(a, "branch", "-M", "main"); sh(a, "push", "-u", "origin", "main");
  const b = mk("b");
  return { base, a, b, bare };
}

describe("asset git tools (temp repo + bare remote)", () => {
  it("asset_status splits assets from code", async () => {
    const { a } = setup();
    const ctx = ctxFor(a);
    writeFileSync(`${a}/${ASSET}`, '{"format_version":"1.8.0","animations":{"x":{}}}\n');
    writeFileSync(`${a}/README.md`, "changed\n");
    const s = await run(ctx, "asset_status", {});
    expect(s.str).toContain("1 changed asset file(s)");
    expect(s.str).toContain(ASSET);
    expect(s.str).toContain("1 other changed file(s)");
    expect(s.str).toContain("suggested message:");
  });

  it("save_assets_to_git: preview without confirm, refuses code, commits only listed paths and pushes with confirm", async () => {
    const { a, bare } = setup();
    const ctx = ctxFor(a);
    writeFileSync(`${a}/${ASSET}`, '{"format_version":"1.8.0","animations":{"x":{}}}\n');
    writeFileSync(`${a}/README.md`, "changed\n");
    writeFileSync(`${a}/${TEX}`, "png");
    const head0 = sh(a, "rev-parse", "HEAD");
    const preview = await run(ctx, "save_assets_to_git", { message: "Add x animation", files: [ASSET], push: true });
    expect(preview.str).toContain("PREVIEW");
    expect(sh(a, "rev-parse", "HEAD")).toBe(head0);
    const code = await run(ctx, "save_assets_to_git", { message: "nope", files: ["README.md"], confirm: true });
    expect(code.isError).toBe(true);
    expect(code.str).toContain("non-asset");
    const ok = await run(ctx, "save_assets_to_git", { message: "Add x animation", files: [ASSET, TEX], push: true, confirm: true });
    expect(ok.str).toContain("Committed 2 file(s)");
    expect(ok.str).toContain("Pushed");
    expect(sh(a, "show", "--stat", "--format=%s", "HEAD")).toContain("Add x animation");
    expect(sh(a, "status", "--porcelain")).toBe("M README.md");
    expect(sh(bare, "log", "-1", "--format=%s", "main")).toBe("Add x animation");
  });

  it("get_latest: fast-forwards over local changes via a tagged stash (never pop), keeps them", async () => {
    const { a, b } = setup();
    // teammate pushes a new commit
    writeFileSync(`${a}/src/main/resources/assets/mod/animations/armor/b.animation.json`, "{}\n");
    sh(a, "add", "-A"); sh(a, "commit", "-m", "teammate"); sh(a, "push");
    // b has local changes in a tracked and an untracked file
    writeFileSync(`${b}/README.md`, "mine\n");
    mkdirSync(`${b}/src/main/resources/assets/mod/textures/item`, { recursive: true });
    writeFileSync(`${b}/${TEX}`.replace("t.png", "u.png"), "x");
    sh(b, "stash", "push", "-m", "somebody elses stash", "--", "README.md"); // pre-existing user stash must survive
    writeFileSync(`${b}/README.md`, "mine\n");
    const ctx = ctxFor(b);
    const r = await run(ctx, "get_latest", {});
    expect(r.str).toContain("got 1 commit");
    expect(readFileSync(`${b}/README.md`, "utf8")).toBe("mine\n");
    expect(readFileSync(`${b}/src/main/resources/assets/mod/animations/armor/b.animation.json`, "utf8")).toBe("{}\n");
    expect(sh(b, "stash", "list")).toMatch(/somebody elses stash/);
    expect(sh(b, "stash", "list").split("\n").length).toBe(1); // ours was dropped, theirs remains
    const again = await run(ctx, "get_latest", {});
    expect(again.str).toContain("up to date");
  });

  it("switch_branch creates and switches, carrying changes", async () => {
    const { a } = setup();
    const ctx = ctxFor(a);
    writeFileSync(`${a}/README.md`, "wip\n");
    const c = await run(ctx, "switch_branch", { branch: "assets/me/topic", create: true });
    expect(c.str).toContain("Created and switched");
    expect(sh(a, "rev-parse", "--abbrev-ref", "HEAD")).toBe("assets/me/topic");
    const s = await run(ctx, "switch_branch", { branch: "main" });
    expect(s.str).toContain("Now on main");
    expect(readFileSync(`${a}/README.md`, "utf8")).toBe("wip\n");
    expect(sh(a, "stash", "list")).toBe("");
  });
});
