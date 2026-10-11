import type * as Monaco from "monaco-editor";

const keywords = ["class", "class_name", "extends", "signal", "func", "static", "const", "enum", "var", "yield", "assert",
  "breakpoint", "preload", "void", "set", "get"];
/** flow control: coloured apart from declaration keywords */
const control = ["if", "elif", "else", "for", "while", "match", "when", "break", "continue", "pass", "return", "await"];
/** word operators */
const wordOps = ["is", "in", "as", "and", "or", "not"];
const types = ["int", "float", "bool", "String", "StringName", "NodePath", "Vector2", "Vector2i", "Vector3", "Vector3i",
  "Vector4", "Rect2", "Transform2D", "Transform3D", "Basis", "Quaternion", "Color", "Array", "Dictionary", "Callable",
  "Signal", "RID", "Object", "Node", "Node2D", "Node3D", "Control", "Resource", "RefCounted", "PackedScene",
  "PackedStringArray", "PackedByteArray", "PackedInt32Array", "PackedFloat32Array", "PackedVector2Array", "Variant"];
const constants = ["PI", "TAU", "INF", "NAN"];
const literals = ["true", "false", "null"];
const builtins = ["print", "prints", "printerr", "push_error", "push_warning", "len", "range", "str", "load", "min", "max",
  "abs", "clamp", "lerp", "randf", "randi", "randomize", "is_instance_valid", "get_node", "get_tree", "assert", "await",
  "preload", "typeof", "is_instance_of", "str_to_var", "var_to_str", "type_string", "sign", "signf", "floor", "ceil", "round", "sqrt", "pow",
  "sin", "cos", "tan", "deg_to_rad", "rad_to_deg", "randf_range", "randi_range", "snapped", "wrapf", "wrapi", "move_toward", "lerp_angle", "is_equal_approx", "is_zero_approx"];

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
    keywords, control, wordOps, literals, types, constants, builtins,
    tokenizer: {
      root: [
        [/##.*$/, "comment.doc"],
        [/#.*$/, "comment"],
        // member level (column 0): `@export var speed: float`, `@onready var n: Node`, `var x`, `const NAME`, `static var`
        [/^(@[A-Za-z_]\w*(?:\([^)]*\))?)(\s+)(var|const)(\s+)([A-Za-z_]\w*)(\s*)(:)(\s*)([A-Za-z_][\w.]*)/, ["annotation", "", "keyword", "", "variable.field", "", "delimiter", "", "type.identifier"]],
        [/^(@[A-Za-z_]\w*(?:\([^)]*\))?)(\s+)(var|const)(\s+)([A-Za-z_]\w*)/, ["annotation", "", "keyword", "", "variable.field"]],
        [/^(static)(\s+)(var)(\s+)([A-Za-z_]\w*)/, ["keyword", "", "keyword", "", "variable.field"]],
        [/^(var)(\s+)([A-Za-z_]\w*)(\s*)(:)(\s*)([A-Za-z_][\w.]*)/, ["keyword", "", "variable.field", "", "delimiter", "", "type.identifier"]],
        [/^(var)(\s+)([A-Za-z_]\w*)/, ["keyword", "", "variable.field"]],
        [/^(const)(\s+)([A-Za-z_]\w*)(\s*)(:)(\s*)([A-Za-z_][\w.]*)/, ["keyword", "", "constant", "", "delimiter", "", "type.identifier"]],
        [/^(const)(\s+)([A-Za-z_]\w*)/, ["keyword", "", "constant"]],
        // locals
        [/\b(var)(\s+)([A-Za-z_]\w*)(\s*)(:)(\s*)([A-Za-z_][\w.]*)/, ["keyword", "", "variable", "", "delimiter", "", "type.identifier"]],
        [/\b(var)(\s+)([A-Za-z_]\w*)/, ["keyword", "", "variable"]],
        [/\b(const)(\s+)([A-Za-z_]\w*)(\s*)(:)(\s*)([A-Za-z_][\w.]*)/, ["keyword", "", "constant", "", "delimiter", "", "type.identifier"]],
        [/\b(const)(\s+)([A-Za-z_]\w*)/, ["keyword", "", "constant"]],
        [/\b(signal)(\s+)([A-Za-z_]\w*)/, ["keyword", "", "signal"]],
        [/\b(enum)(\s+)([A-Za-z_]\w*)/, ["keyword", "", "type.enum"]],
        [/\b(class_name|class)(\s+)([A-Za-z_]\w*)/, ["keyword", "", "type.identifier"]],
        [/\b(extends)(\s+)([A-Za-z_][\w.]*)/, ["keyword", "", "type.identifier"]],
        [/\bfunc\b/, { token: "keyword", next: "@funcName" }],
        { include: "@expr" } as Monaco.languages.IMonarchLanguageRule,
      ],
      funcName: [
        [/\s+/, ""],
        [/[A-Za-z_]\w*/, { token: "function.declaration", switchTo: "@funcParen" }],
        [/./, { token: "", next: "@pop" }],
      ],
      funcParen: [
        [/\s+/, ""],
        [/\(/, { token: "delimiter", switchTo: "@params" }],
        [/./, { token: "", next: "@pop" }],
      ],
      params: [
        [/\s+/, ""],
        [/[A-Za-z_]\w*/, { token: "variable.parameter", switchTo: "@afterParam" }],
        [/\)/, { token: "delimiter", next: "@pop" }],
      ],
      afterParam: [
        [/\s+/, ""],
        [/:=/, { token: "operator", switchTo: "@pdefault" }],
        [/:/, { token: "delimiter", switchTo: "@ptype" }],
        [/=/, { token: "operator", switchTo: "@pdefault" }],
        [/,/, { token: "delimiter", switchTo: "@params" }],
        [/\)/, { token: "delimiter", next: "@pop" }],
      ],
      ptype: [
        [/\s+/, ""],
        [/[A-Za-z_][\w.]*/, "type.identifier"],
        [/[\[\]]/, "delimiter"],
        [/=/, { token: "operator", switchTo: "@pdefault" }],
        [/,/, { token: "delimiter", switchTo: "@params" }],
        [/\)/, { token: "delimiter", next: "@pop" }],
      ],
      pdefault: [
        [/,/, { token: "delimiter", switchTo: "@params" }],
        [/\)/, { token: "delimiter", next: "@pop" }],
        [/[(\[{]/, { token: "delimiter", next: "@nested" }],
        { include: "@expr" } as Monaco.languages.IMonarchLanguageRule,
      ],
      nested: [
        [/[(\[{]/, { token: "delimiter", next: "@nested" }],
        [/[)\]}]/, { token: "delimiter", next: "@pop" }],
        { include: "@expr" } as Monaco.languages.IMonarchLanguageRule,
      ],
      expr: [
        [/@[A-Za-z_]\w*/, "annotation"],
        // node paths: $Player/Sprite, $"../x", %UniqueName; StringName &"x" and NodePath ^"x"
        [/[$%]"[^"]*"/, "tag.node"],
        [/[$%][A-Za-z_][\w/]*/, "tag.node"],
        [/[&^]"/, { token: "string.name", next: "@dqstring" }],
        [/"""/, { token: "string", next: "@tqstring" }],
        [/r?"/, { token: "string", next: "@dqstring" }],
        [/r?'/, { token: "string", next: "@sqstring" }],
        [/0[xX][0-9a-fA-F_]+/, "number.hex"],
        [/0[bB][01_]+/, "number.binary"],
        [/(?:\d[\d_]*)?\.\d[\d_]*(?:[eE][-+]?\d+)?|\d[\d_]*[eE][-+]?\d+/, "number.float"],
        [/\d[\d_]*\.?/, "number"],
        // `-> Type`, `as Type`, `is Type`, `: Type` after a declaration
        [/(->)(\s*)([A-Za-z_]\w*)/, ["operator", "", "type.identifier"]],
        [/\b(as|is)(\s+)([A-Za-z_]\w*)/, ["keyword.operator", "", "type.identifier"]],
        // member access: `.name(` call, `.NAME` constant, `.Name` type, `.name` property
        [/(\.)(\s*)([A-Za-z_]\w*)(?=\s*\()/, ["delimiter", "", "function"]],
        [/(\.)([A-Z][A-Z0-9_]+)\b/, ["delimiter", "constant"]],
        [/(\.)([A-Z]\w*)/, ["delimiter", "type.identifier"]],
        [/(\.)([A-Za-z_]\w*)/, ["delimiter", "variable.field"]],
        // `Vector3(` constructors are types; builtin and user calls
        [/[A-Z]\w*(?=\s*\()/, "type.identifier"],
        [/[A-Za-z_]\w*(?=\s*\()/, { cases: { "@control": "keyword.control", "@keywords": "keyword", "@wordOps": "keyword.operator", "@builtins": "predefined", "@default": "function" } }],
        [/[A-Za-z_]\w*/, {
          cases: {
            "self|super": "variable.predefined",
            "@literals": "keyword",
            "@control": "keyword.control",
            "@wordOps": "keyword.operator",
            "@keywords": "keyword",
            "@types": "type.identifier",
            "@constants": "constant",
            "[A-Z][A-Z0-9_]+": "constant",
            "[A-Z]\\w*": "type.identifier",
            "@default": "identifier",
          },
        }],
        [/->|:=|[-+*/%=<>!&|^~?]+/, "operator"],
        [/[:.,;]/, "delimiter"],
        [/[{}()[\]]/, "delimiter"],
      ],
      dqstring: [[/[^\\"]+/, "string"], [/\\./, "string.escape"], [/"/, { token: "string", next: "@pop" }]],
      sqstring: [[/[^\\']+/, "string"], [/\\./, "string.escape"], [/'/, { token: "string", next: "@pop" }]],
      tqstring: [[/[^"\\]+/, "string"], [/\\./, "string.escape"], [/"""/, { token: "string", next: "@pop" }], [/"/, "string"]],
    },
  } as Monaco.languages.IMonarchLanguage);
}
