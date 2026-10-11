const BY_EXT: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json", jsonc: "json", css: "css", scss: "scss", less: "less", html: "html", htm: "html", md: "markdown",
  markdown: "markdown", rs: "rust", py: "python", java: "java", kt: "kotlin", kts: "kotlin", go: "go", sh: "shell",
  bash: "shell", zsh: "shell", yaml: "yaml", yml: "yaml", xml: "xml", sql: "sql", c: "c", h: "c", cpp: "cpp", hpp: "cpp",
  cs: "csharp", rb: "ruby", php: "php", swift: "swift", lua: "lua", gradle: "groovy", toml: "ini", properties: "ini",
  // Godot
  gd: "gdscript", tscn: "ini", tres: "ini", godot: "ini", cfg: "ini", import: "ini", gdshader: "glsl", gdshaderinc: "glsl", glsl: "glsl", fsh: "glsl", vsh: "glsl", frag: "glsl", vert: "glsl", snbt: "snbt",
  mcmeta: "json", bbmodel: "json", pose: "json", mcfunction: "plaintext", lang: "ini", svg: "xml", csv: "plaintext", tsv: "plaintext",
};
const BY_NAME: Record<string, string> = { Dockerfile: "dockerfile", Makefile: "makefile", "project.godot": "ini" };

export function languageFor(name: string): string {
  if (BY_NAME[name]) return BY_NAME[name];
  const i = name.lastIndexOf(".");
  return i >= 0 ? (BY_EXT[name.slice(i + 1).toLowerCase()] ?? "plaintext") : "plaintext";
}
