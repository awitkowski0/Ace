/** Test hooks for scripts/qa/themes.mjs (`await __qa.themes()`). */
import { SCHEMES, effectiveScheme, previewScheme, schemeById, schemeStore, setScheme } from "./index";
import { cssVars, monacoTheme, termTheme } from "./build";

const cssVar = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

export const themeQa = {
  list: () => SCHEMES.map((s) => ({ id: s.id, name: s.name, dark: s.dark })),
  state: () => ({ ...schemeStore.get(), effective: effectiveScheme().id }),
  set: (id: string) => setScheme(id),
  preview: (id: string | null) => previewScheme(id),
  cssVar,
  /** what the given scheme should look like once applied (computed from the registry) */
  expected: (id: string) => { const sc = schemeById(id); return { css: cssVars(sc), editorBg: monacoTheme(sc).colors["editor.background"], term: termTheme(sc) }; },
  vars: (names: string[]) => Object.fromEntries(names.map((n) => [n, cssVar(n)])),
  /** Monaco-side facts: the active theme's editor background and a few rule colours, read from the live theme service */
  async monaco() {
    const { monaco } = await import("../editor/monacoSetup");
    const bg = getComputedStyle(document.querySelector(".monaco-editor-background") ?? document.body).backgroundColor;
    return { bg, editors: monaco.editor.getEditors().length };
  },
  /** tokenize `text` with `lang`'s grammar: per line [{text, type}] (token names carry the language suffix, e.g. keyword.java) */
  async tokenize(lang: string, text: string) {
    const { monaco } = await import("../editor/monacoSetup");
    const m = monaco.editor.createModel("", lang); // forces the (lazy) grammar to load
    m.dispose();
    await new Promise((r) => setTimeout(r, 200));
    const lines = text.split("\n");
    return monaco.editor.tokenize(text, lang).map((toks, i) =>
      toks.map((t, k) => ({ text: lines[i].slice(t.offset, toks[k + 1]?.offset ?? lines[i].length), type: t.type })));
  },
  /** rendered colour/style of the first visible token whose text is exactly `word` in the active editor */
  colorOf(word: string, nth = 0) {
    const spans = [...document.querySelectorAll(".monaco-editor .view-line span span")].filter((e) => e.textContent === word);
    const el = spans[nth] as HTMLElement | undefined;
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { color: cs.color, italic: cs.fontStyle === "italic", strike: cs.textDecorationLine.includes("line-through"), cls: el.className };
  },
  /** every distinct rendered token (text -> color) in the active editor view */
  rendered() {
    const out: Record<string, string> = {};
    for (const e of document.querySelectorAll(".monaco-editor .view-line span span")) { const t = e.textContent; if (t?.trim()) out[t] = getComputedStyle(e).color; }
    return out;
  },
  /** screenshots on real projects: keep the Godot LSP from auto-starting (in memory only, localStorage untouched) */
  noAutoGodot: async () => { (await import("../editor/lsp/state")).lspSettings.set({ autoGodot: false }); return 1; },
  lsp: async () => (await import("../editor/lsp/manager")).qaHooks,
};
