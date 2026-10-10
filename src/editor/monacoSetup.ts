/** Loaded lazily (via EditorArea's dynamic import). Configures Monaco offline: local bundle, lazy workers, Nord, GDScript. */
import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import CssWorker from "monaco-editor/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker?worker";
import { registerGdscript } from "./gdscript";
import { nordTheme } from "./nordTheme";

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
registerGdscript(monaco);
monaco.editor.defineTheme("nord", nordTheme);
monaco.editor.setTheme("nord");

export { monaco };
