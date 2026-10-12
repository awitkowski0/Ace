/**
 * One-time localStorage migration from the pre-rename "atelier" key names. Imported FIRST in main.tsx so it runs before any
 * store reads localStorage. Every `atelier.<rest>` key is copied to `ace.<rest>` when the new key is absent (same for the
 * panel-layout keys `react-resizable-panels:atelier:<rest>`). The old keys are kept, so rolling back to an old build loses nothing.
 */
const COPIES: Array<[string, string]> = [
  ["atelier.", "ace."],
  ["react-resizable-panels:atelier:", "react-resizable-panels:ace:"],
];

export function migrateStorage(ls: Pick<Storage, "length" | "key" | "getItem" | "setItem">): number {
  let n = 0;
  try {
    const keys: string[] = [];
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      if (k) keys.push(k);
    }
    for (const k of keys) {
      for (const [from, to] of COPIES) {
        if (!k.startsWith(from)) continue;
        const nk = to + k.slice(from.length);
        if (ls.getItem(nk) !== null) break;
        const v = ls.getItem(k);
        if (v !== null) { ls.setItem(nk, v); n++; }
        break;
      }
    }
  } catch {
    // storage unavailable or full: nothing to migrate, the app starts with defaults
  }
  return n;
}

try { migrateStorage(localStorage); } catch { /* no localStorage */ }
