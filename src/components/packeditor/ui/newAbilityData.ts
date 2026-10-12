/** Making a new ability on disk (a copy of one, or a blank script), and naming it in the pack's lang file. */
import { fs } from "../../../lib/ipc";
import { abilityLangKeys, abilityTargetPath, addLangEntries, blankAbility, newLangText, retitleAbility, titleFromName } from "../core/newAbility";
import { packRoot } from "../core/kinds";
import { clearCatalogCache } from "./data";
import { clearLangCache, exists, readText } from "./resolve";

/** Abilities created this session whose display name isn't in the lang file yet, by file path: the ability view offers to add it. */
export const awaitingLang = new Map<string, { id: string; title: string; root: string }>();

/**
 * Create ability `name` in the same pack as `fromPath` (any file of that pack's data/<ns>/):
 * `<resources root>/data/<ns>/abilities/<folder>/<name>.<ext>`, a copy of `sourcePath` with its title replaced, or the blank
 * script when `sourcePath` is null. Refuses to overwrite. Clears the catalog cache; resolves the new file's path.
 */
export async function createAbility(host: string, fromPath: string, name: string, folder: string, sourcePath: string | null): Promise<{ path: string; title: string }> {
  const pr = packRoot(fromPath);
  if (!pr) throw new Error("Not a pack file");
  const ext = sourcePath?.endsWith(".json") ? "json" : "js";
  const title = titleFromName(name);
  let content: string;
  if (sourcePath) {
    const src = await readText(host, sourcePath);
    if (src === null) throw new Error(`Couldn't read ${sourcePath}`);
    content = retitleAbility(src, title, ext);
  } else {
    content = blankAbility(title);
  }
  const path = abilityTargetPath(pr.root, pr.ns, folder, name, ext);
  for (const e of ["js", "json"] as const) {
    if (await exists(host, abilityTargetPath(pr.root, pr.ns, folder, name, e))) throw new Error(`${folder ? folder + "/" : ""}${name}.${e} already exists`);
  }
  await fs.writeFile({ host, path }, content);
  clearCatalogCache();
  return { path, title };
}

/** The pack's lang file: where an ability's display name goes (`ability.thematic.<id>` lives in thematic's lang, whatever the ability's namespace). */
export const langPath = (root: string) => `${root}/assets/thematic/lang/en_us.json`;

/** Add the HUD and menu names of ability `id` to the pack's lang file as a text edit that leaves the rest alone. */
export async function addAbilityLang(host: string, root: string, id: string, title: string): Promise<string> {
  const path = langPath(root);
  const entries = Object.fromEntries(abilityLangKeys(id).map((k) => [k, title]));
  const cur = await readText(host, path);
  await fs.writeFile({ host, path }, cur === null ? newLangText(entries) : addLangEntries(cur, entries));
  clearLangCache();
  return path;
}
