/** Markdown -> sanitized HTML with `data-line` anchors on top-level blocks (for editor/preview scroll sync). Heavy deps load lazily. */
let libs: Promise<{ marked: typeof import("marked"); purify: typeof import("dompurify").default }> | undefined;
const load = () => (libs ??= Promise.all([import("marked"), import("dompurify")]).then(([marked, p]) => ({ marked, purify: p.default })));

export async function renderMarkdown(text: string): Promise<string> {
  const { marked, purify } = await load();
  const m = new marked.Marked({ gfm: true });
  const tokens = m.lexer(text);
  let line = 0;
  let html = "";
  for (const tok of tokens) {
    const startLine = line + 1;
    line += (tok.raw.match(/\n/g) ?? []).length;
    if (tok.type === "space") continue;
    const one = Object.assign([tok], { links: tokens.links }) as unknown as typeof tokens;
    const h = m.parser(one);
    html += h.replace(/^(\s*)<([a-zA-Z][\w-]*)/, `$1<$2 data-line="${startLine}"`);
  }
  return purify.sanitize(html, { ADD_ATTR: ["data-line", "target"], FORBID_TAGS: ["style", "form"], FORBID_ATTR: ["style"] });
}

export const slug = (s: string) =>
  s.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s+/g, "-");

/** Resolve a relative path against the markdown file's directory (handles ./ and ../). */
export function resolveRelative(dir: string, rel: string): string {
  if (rel.startsWith("/")) return rel;
  const out = dir.split("/").filter(Boolean);
  for (const seg of rel.split("/")) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return "/" + out.join("/");
}
export const isExternal = (u: string) => /^[a-z][a-z0-9+.-]*:/i.test(u) || u.startsWith("//");
