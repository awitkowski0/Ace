// Hot swap settings: per project in `.ace/config.json`, section `hotswap` (docs/GRADLE.md). Default: everything off.
import { repoSection, ensureRepoConfig } from "../../../lib/repoConfig";

export interface HotswapCfg { onSave?: boolean }
const section = repoSection<HotswapCfg>("hotswap");

export const hotswapOnSave = (): boolean => section.get()?.onSave === true;
export const subscribeHotswapCfg = section.subscribe;
/** Writes `.ace/config.json` -> `"hotswap": { "onSave": true|false }` (the file/dir is created on the first write). */
export async function setHotswapOnSave(on: boolean) {
  ensureRepoConfig();
  await section.set({ ...(section.get() ?? {}), onSave: on });
}
