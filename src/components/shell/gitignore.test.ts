import { describe, expect, it } from "vitest";
import { isIgnored, parseGitignore } from "./gitignore";

describe("gitignore matcher", () => {
  const rules = parseGitignore(`# comment
.godot/
build/
*.log
/out
!keep.log
**/node_modules
docs/*.tmp
`);
  it("dir-only patterns", () => {
    expect(isIgnored(rules, ".godot", true)).toBe(true);
    expect(isIgnored(rules, ".godot/imported/a.png", false)).toBe(true);
    expect(isIgnored(rules, "src/build", true)).toBe(true);
    expect(isIgnored(rules, "build", false)).toBe(false); // a FILE named build
  });
  it("globs, anchoring and negation", () => {
    expect(isIgnored(rules, "a/b/x.log", false)).toBe(true);
    expect(isIgnored(rules, "keep.log", false)).toBe(false);
    expect(isIgnored(rules, "out", true)).toBe(true);
    expect(isIgnored(rules, "sub/out", true)).toBe(false);
    expect(isIgnored(rules, "web/node_modules/x", false)).toBe(true);
    expect(isIgnored(rules, "docs/a.tmp", false)).toBe(true);
    expect(isIgnored(rules, "docs/sub/a.tmp", false)).toBe(false);
    expect(isIgnored(rules, "src/main.rs", false)).toBe(false);
  });
});
