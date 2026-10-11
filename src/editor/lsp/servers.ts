/** Language -> server mapping. Server ids match src-tauri/src/lsp/mod.rs SPECS. */
export const SERVER_FOR_LANGUAGE: Record<string, string> = {
  gdscript: "godot",
  rust: "rust-analyzer",
  typescript: "typescript",
  javascript: "typescript",
  python: "basedpyright",
  go: "gopls",
  java: "jdtls",
};
export const LANGUAGE_ID_FOR: Record<string, string> = { typescript: "typescript", javascript: "javascript" };
export const LSP_LANGUAGES = Object.keys(SERVER_FOR_LANGUAGE);
export const SERVER_LABEL: Record<string, string> = {
  godot: "GDScript", "rust-analyzer": "Rust", typescript: "TypeScript", pyright: "Python", basedpyright: "Python", gopls: "Go", jdtls: "Java",
};

/** Project-root markers per server (nearest ancestor of the file, bounded by the project root). */
export const ROOT_MARKERS: Record<string, string[]> = {
  godot: ["project.godot"],
  "rust-analyzer": ["Cargo.toml"],
  typescript: ["tsconfig.json", "package.json"],
  pyright: ["pyrightconfig.json", "pyproject.toml", "setup.py", "requirements.txt"],
  basedpyright: ["pyrightconfig.json", "pyproject.toml", "setup.py", "requirements.txt"],
  gopls: ["go.mod"],
  jdtls: ["pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle"],
};

/**
 * How to launch the server of a language when that depends on project state (Python: basedpyright/pyright from the selected
 * interpreter's bin dir, plus the `workspace/configuration` answers). A resolver returning null means "no server available".
 */
export interface Launch {
  /** Rust SPEC id (`lsp_start` serverId) */
  serverId: string;
  bin?: string;
  pathPrepend?: string[];
  /** answers `workspace/configuration` for one requested section */
  settings?: (section: string | undefined, scopeUri?: string) => unknown;
}
export type LaunchResolver = (rootPath: string) => Promise<Launch | null>;
const resolvers = new Map<string, LaunchResolver>();
export const setLaunchResolver = (lang: string, fn: LaunchResolver) => { resolvers.set(lang, fn); };
export const launchResolver = (lang: string) => resolvers.get(lang);

/** Extra code actions (ruff quick fixes ...) merged into Show Context Actions (⌥↵). */
export interface ExtraIntention { title: string; run: () => Promise<void> | void }
export type IntentionProvider = (ctx: { path: string; range: { start: { line: number; character: number }; end: { line: number; character: number } }; language: string }) => ExtraIntention[];
const intentionProviders: IntentionProvider[] = [];
export const addIntentionProvider = (p: IntentionProvider) => { intentionProviders.push(p); };
export const intentionProviderList = () => intentionProviders;
