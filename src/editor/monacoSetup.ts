/** Loaded lazily (via EditorArea's dynamic import). Configures Monaco offline: local bundle, lazy workers, Nord, GDScript. */
import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import CssWorker from "monaco-editor/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker?worker";
import { registerGdscript } from "./gdscript";
import { registerGameSyntax } from "./viewers/syntax";
import { MONACO_THEME, monacoThemeData, registerSchemeApplier } from "../theme";
import { patchBuiltinGrammars } from "./grammars";
import { applyMonacoKeymapPolicy } from "./monacoKeymap";
import { openExternal } from "../lib/external";

(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker(_: string, label: string) {
    // Workers are constructed on demand only (first use of that language).
    if (label === "json") return new JsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new CssWorker();
    if (label === "html" || label === "handlebars" || label === "razor") return new HtmlWorker();
    if (label === "typescript" || label === "javascript") return new TsWorker();
    return new EditorWorker();
  },
};

loader.config({ monaco });
// Hover / document links: http(s) and mailto go to the system browser through tauri-plugin-opener (window.open does nothing in the webview).
monaco.editor.registerLinkOpener({ open: (uri) => openExternal(uri.toString(true)) });
registerGdscript(monaco);
registerGameSyntax(monaco);
// Colour scheme (src/theme): the active scheme's data lives under the fixed name "nord" (diff/find editors hard-code it); every switch re-defines it.
registerSchemeApplier(() => {
  monaco.editor.defineTheme(MONACO_THEME, monacoThemeData());
  monaco.editor.setTheme(MONACO_THEME);
});

// IntelliJ keymap parity: strip Monaco default keybindings IntelliJ binds differently (see docs/KEYMAP-AUDIT.md).
// Awaited by EditorArea before the first editor mounts so no keystroke ever reaches an un-audited Monaco.
export const keymapReady = Promise.all([
  applyMonacoKeymapPolicy(monaco).catch((e) => console.error("monaco keymap policy failed", e)),
  patchBuiltinGrammars().catch((e) => console.error("grammar patch failed", e)), // richer Monarch grammars (Java ...) before any model exists
]).then(() => undefined);

export { monaco };
