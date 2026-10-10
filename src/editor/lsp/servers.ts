/** Language -> server mapping. Server ids match src-tauri/src/lsp/mod.rs SPECS. */
export const SERVER_FOR_LANGUAGE: Record<string, string> = {
  gdscript: "godot",
  rust: "rust-analyzer",
  typescript: "typescript",
  javascript: "typescript",
  python: "pyright",
  go: "gopls",
  java: "jdtls",
};
export const LANGUAGE_ID_FOR: Record<string, string> = { typescript: "typescript", javascript: "javascript" };
export const LSP_LANGUAGES = Object.keys(SERVER_FOR_LANGUAGE);
export const SERVER_LABEL: Record<string, string> = {
  godot: "GDScript", "rust-analyzer": "Rust", typescript: "TypeScript", pyright: "Python", gopls: "Go", jdtls: "Java",
};

/** Project-root markers per server (nearest ancestor of the file, bounded by the project root). */
export const ROOT_MARKERS: Record<string, string[]> = {
  godot: ["project.godot"],
  "rust-analyzer": ["Cargo.toml"],
  typescript: ["tsconfig.json", "package.json"],
  pyright: ["pyrightconfig.json", "pyproject.toml", "setup.py", "requirements.txt"],
  gopls: ["go.mod"],
  jdtls: ["pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle"],
};
