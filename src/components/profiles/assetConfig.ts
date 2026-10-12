/** Applies the `assets` section of `.ace/config.json` (docs/PROFILES.md) to the asset classifier and tells the tree when it changes. */
import { createStore } from "../../lib/store";
import { repoConfigStore } from "../../lib/repoConfig";
import { NO_RULES, parseAssetRules, setAssetRules, type AssetRules } from "./assets";

export const assetRulesStore = createStore<{ rules: AssetRules; raw: string }>({ rules: NO_RULES, raw: "" });

function apply() {
  const section = repoConfigStore.get().raw.assets;
  const raw = section === undefined ? "" : JSON.stringify(section);
  if (raw === assetRulesStore.get().raw) return;
  const rules = raw ? parseAssetRules(section) : NO_RULES;
  setAssetRules(rules);
  assetRulesStore.set({ rules, raw });
}
repoConfigStore.subscribe(apply);
apply();
