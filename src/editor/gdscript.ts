import type * as Monaco from "monaco-editor";

const keywords = ["if", "elif", "else", "for", "while", "match", "when", "break", "continue", "pass", "return", "class",
  "class_name", "extends", "is", "in", "as", "self", "super", "signal", "func", "static", "const", "enum", "var", "await",
  "yield", "assert", "breakpoint", "preload", "and", "or", "not", "void", "set", "get"];
const types = ["int", "float", "bool", "String", "StringName", "NodePath", "Vector2", "Vector2i", "Vector3", "Vector3i",
  "Vector4", "Rect2", "Transform2D", "Transform3D", "Basis", "Quaternion", "Color", "Array", "Dictionary", "Callable",
  "Signal", "RID", "Object", "Node", "Node2D", "Node3D", "Control", "Resource", "RefCounted", "PackedScene",
  "PackedStringArray", "PackedByteArray", "PackedInt32Array", "PackedFloat32Array", "PackedVector2Array", "Variant"];
const constants = ["true", "false", "null", "PI", "TAU", "INF", "NAN"];
const builtins = ["print", "prints", "printerr", "push_error", "push_warning", "len", "range", "str", "load", "min", "max",
  "abs", "clamp", "lerp", "randf", "randi", "randomize", "is_instance_valid", "get_node", "get_tree"];

export function registerGdscript(monaco: typeof Monaco) {
  monaco.languages.register({ id: "gdscript", extensions: [".gd"], aliases: ["GDScript", "gdscript"] });
  monaco.languages.setLanguageConfiguration("gdscript", {
    comments: { lineComment: "#" },
    brackets: [["{", "}"], ["[", "]"], ["(", ")"]],
    autoClosingPairs: [
      { open: "{", close: "}" }, { open: "[", close: "]" }, { open: "(", close: ")" },
      { open: '"', close: '"', notIn: ["string"] }, { open: "'", close: "'", notIn: ["string"] },
    ],
    surroundingPairs: [{ open: "{", close: "}" }, { open: "[", close: "]" }, { open: "(", close: ")" }, { open: '"', close: '"' }, { open: "'", close: "'" }],
    indentationRules: { increaseIndentPattern: /:\s*(#.*)?$/, decreaseIndentPattern: /^\s*(elif|else)\b.*:\s*$/ },
    onEnterRules: [{ beforeText: /:\s*(#.*)?$/, action: { indentAction: monaco.languages.IndentAction.Indent } }],
    folding: { offSide: true },
  });
  monaco.languages.setMonarchTokensProvider("gdscript", {
    keywords, types, constants, builtins,
    tokenizer: {
      root: [
        [/#.*$/, "comment"],
        [/@[A-Za-z_]\w*/, "annotation"],
        [/\b(func)(\s+)([A-Za-z_]\w*)/, ["keyword", "", "function"]],
        [/\b(class_name|class|extends|signal|enum)(\s+)([A-Za-z_]\w*)/, ["keyword", "", "type"]],
        [/[$%]"[^"]*"/, "variable.predefined"],
        [/[$%][A-Za-z_][\w/]*/, "variable.predefined"],
        [/[&^]"/, { token: "string", next: "@dqstring" }],
        [/"""/, { token: "string", next: "@tqstring" }],
        [/"/, { token: "string", next: "@dqstring" }],
        [/'/, { token: "string", next: "@sqstring" }],
        [/0[xX][0-9a-fA-F_]+/, "number"],
        [/0[bB][01_]+/, "number"],
        [/\d[\d_]*\.?[\d_]*([eE][-+]?\d+)?/, "number"],
        [/[A-Za-z_]\w*(?=\s*\()/, { cases: { "@keywords": "keyword", "@builtins": "predefined", "@default": "function" } }],
        [/[A-Za-z_]\w*/, { cases: { "@keywords": "keyword", "@types": "type", "@constants": "constant", "@default": "identifier" } }],
        [/[-+*/%=<>!&|^~?:.,;]+/, "operator"],
        [/[{}()[\]]/, "delimiter"],
      ],
      dqstring: [[/[^\\"]+/, "string"], [/\\./, "string.escape"], [/"/, { token: "string", next: "@pop" }]],
      sqstring: [[/[^\\']+/, "string"], [/\\./, "string.escape"], [/'/, { token: "string", next: "@pop" }]],
      tqstring: [[/[^"]+/, "string"], [/"""/, { token: "string", next: "@pop" }], [/"/, "string"]],
    },
  } as Monaco.languages.IMonarchLanguage);
}
