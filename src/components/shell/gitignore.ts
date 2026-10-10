/** Minimal .gitignore matcher (enough for tree colouring: anchored/unanchored, dir-only, negation, *, ?, **, [..]). */
export interface IgnoreRule { re: RegExp; negate: boolean; dirOnly: boolean }

function globToRegex(glob: string, anchored: boolean): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // "**/" = any dirs (incl. none); trailing "/**" or "**" = anything
        if (glob[i + 2] === "/") { re += "(?:.*/)?"; i += 2; }
        else { re += ".*"; i += 1; }
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "[") {
      const j = glob.indexOf("]", i + 2);
      if (j > 0) { re += "[" + glob.slice(i + 1, j).replace(/^!/, "^") + "]"; i = j; } else re += "\\[";
    } else if (c === "\\" && i + 1 < glob.length) { re += glob[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
    else re += c.replace(/[.*+?^${}()|[\]\\/]/g, (m) => (m === "/" ? "/" : "\\" + m));
  }
  return new RegExp((anchored ? "^" : "^(?:.*/)?") + re + "$");
}

export function parseGitignore(text: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (let line of text.split(/\r?\n/)) {
    line = line.replace(/(?<!\\)\s+$/, "");
    if (!line || line.startsWith("#")) continue;
    let negate = false;
    if (line.startsWith("!")) { negate = true; line = line.slice(1); }
    let dirOnly = false;
    if (line.endsWith("/")) { dirOnly = true; line = line.slice(0, -1); }
    const anchored = line.includes("/");
    if (line.startsWith("/")) line = line.slice(1);
    if (!line) continue;
    rules.push({ re: globToRegex(line, anchored), negate, dirOnly });
  }
  return rules;
}

/** `rel` is slash-separated relative to the .gitignore's directory. Ancestors being ignored ignores the whole subtree. */
export function isIgnored(rules: IgnoreRule[], rel: string, isDir: boolean): boolean {
  const parts = rel.split("/");
  for (let i = 1; i <= parts.length; i++) {
    const sub = parts.slice(0, i).join("/");
    const dir = i < parts.length || isDir;
    let ignored = false;
    for (const r of rules) if ((!r.dirOnly || dir) && r.re.test(sub)) ignored = !r.negate;
    if (ignored) return true;
  }
  return false;
}
