/** Test helpers (node only). Not part of the public API. */
/** The MAIN Thematic checkout (the -spidey worktree is stale). READ ONLY: another session edits it; tests copy what they need. */
export const THEMATIC_MAIN = "/Users/alexw/IdeaProjects/Thematic-Collections";
export const THEMATIC_ROOTS = [THEMATIC_MAIN + "/src"];
export const WEB_ANIM_REL = "src/common/resources/assets/thematic/animations/armor/web_sling.animation.json";
export const WEB_POSES_REL = "src/packs/heroes/resources/assets/thematic/poses/web.json";

/**
 * Read-only temp copies of the web kit (animation file + pose set) laid out like the real tree, so path-based discovery works.
 * null when the main checkout does not have them (callers skip).
 */
export async function webKitCopy(): Promise<{ dir: string; anim: string; poses: string; animText: string; posesText: string } | null> {
  const fs = await nodeFs();
  const os = await import("node:os" as string);
  const pathMod = await import("node:path" as string);
  const a = `${THEMATIC_MAIN}/${WEB_ANIM_REL}`, p = `${THEMATIC_MAIN}/${WEB_POSES_REL}`;
  if (!fs.existsSync(a) || !fs.existsSync(p)) return null;
  const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), "ace-webkit-"));
  const animText = fs.readFileSync(a, "utf8"), posesText = fs.readFileSync(p, "utf8");
  const anim = `${dir}/${WEB_ANIM_REL}`, poses = `${dir}/${WEB_POSES_REL}`;
  for (const [f, t] of [[anim, animText], [poses, posesText]] as const) {
    fs.mkdirSync(pathMod.dirname(f), { recursive: true });
    fs.writeFileSync(f, t);
  }
  return { dir, anim, poses, animText, posesText };
}
export const BB_ROOTS = ["/Users/alexw/IdeaProjects/Thematic-Collections/guns", "/Users/alexw/IdeaProjects/Thematic-Collections/src"];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function nodeFs(): Promise<any> {
  return await import("node:fs" as string);
}

/** Recursively collect files ending in one of `suffixes`, skipping build/ and .claude/. */
export async function walk(root: string, suffixes: string[]): Promise<string[]> {
  const fs = await nodeFs();
  const out: string[] = [];
  if (!fs.existsSync(root)) return out;
  const rec = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === "build" || e.name === ".claude" || e.name === "node_modules" || e.name === ".git") continue;
      const p = d + "/" + e.name;
      if (e.isDirectory()) rec(p);
      else if (suffixes.some((s) => e.name.endsWith(s))) out.push(p);
    }
  };
  rec(root);
  return out;
}
