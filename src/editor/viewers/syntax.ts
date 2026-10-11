/** Lightweight Monarch grammars for the game-dev file types Monaco doesn't know (GLSL shaders, Godot shaders, SNBT). */
import type * as Monaco from "monaco-editor";

const glslKeywords = ["if", "else", "for", "while", "do", "break", "continue", "return", "discard", "switch", "case", "default", "struct", "const", "uniform", "varying",
  "attribute", "in", "out", "inout", "flat", "smooth", "highp", "mediump", "lowp", "precision", "layout", "centroid", "invariant",
  // Godot shading language
  "shader_type", "render_mode", "group_uniforms", "instance", "global", "varying", "hint_color", "source_color", "hint_range", "hint_normal", "hint_albedo",
  "filter_linear", "filter_nearest", "repeat_enable", "repeat_disable", "vertex", "fragment", "light", "start", "process", "sky", "fog"];
const glslTypes = ["void", "bool", "int", "uint", "float", "double", "vec2", "vec3", "vec4", "ivec2", "ivec3", "ivec4", "uvec2", "uvec3", "uvec4", "bvec2", "bvec3", "bvec4",
  "mat2", "mat3", "mat4", "mat2x2", "mat3x3", "mat4x4", "sampler2D", "sampler3D", "samplerCube", "sampler2DArray", "isampler2D", "usampler2D", "sampler2DShadow"];
const glslBuiltins = ["radians", "degrees", "sin", "cos", "tan", "asin", "acos", "atan", "pow", "exp", "log", "exp2", "log2", "sqrt", "inversesqrt", "abs", "sign", "floor", "ceil",
  "fract", "mod", "min", "max", "clamp", "mix", "step", "smoothstep", "length", "distance", "dot", "cross", "normalize", "reflect", "refract", "texture", "texture2D", "textureLod",
  "texelFetch", "dFdx", "dFdy", "fwidth", "transpose", "inverse", "determinant", "round", "trunc", "mat", "lessThan", "greaterThan", "equal", "any", "all", "not",
  "gl_Position", "gl_FragColor", "gl_FragCoord", "gl_FragData", "gl_VertexID", "gl_InstanceID", "gl_PointSize",
  // Godot
  "UV", "COLOR", "ALBEDO", "ALPHA", "NORMAL", "VERTEX", "TIME", "MODEL_MATRIX", "VIEW_MATRIX", "PROJECTION_MATRIX", "SCREEN_UV", "FRAGCOORD", "TEXTURE", "NORMAL_MAP", "ROUGHNESS", "METALLIC", "EMISSION"];

export function registerGameSyntax(monaco: typeof Monaco) {
  const has = (id: string) => monaco.languages.getLanguages().some((l) => l.id === id);
  if (!has("glsl")) monaco.languages.register({ id: "glsl", extensions: [".glsl", ".fsh", ".vsh", ".frag", ".vert", ".geom", ".comp", ".gdshader", ".gdshaderinc", ".shader"], aliases: ["GLSL", "glsl", "Godot Shader"] });
  monaco.languages.setLanguageConfiguration("glsl", {
    comments: { lineComment: "//", blockComment: ["/*", "*/"] },
    brackets: [["{", "}"], ["[", "]"], ["(", ")"]],
    autoClosingPairs: [{ open: "{", close: "}" }, { open: "[", close: "]" }, { open: "(", close: ")" }, { open: '"', close: '"' }],
    folding: { markers: { start: /^\s*#\s*(if|ifdef|ifndef)/, end: /^\s*#\s*endif/ } },
  });
  monaco.languages.setMonarchTokensProvider("glsl", {
    keywords: glslKeywords, typeKeywords: glslTypes, builtins: glslBuiltins,
    tokenizer: {
      root: [
        [/\/\/.*$/, "comment"],
        [/\/\*/, "comment", "@comment"],
        [/^\s*#\s*\w+/, "keyword.directive"],
        [/\d*\.\d+([eE][-+]?\d+)?[fF]?|\d+[eE][-+]?\d+[fF]?|\d+\.[fF]?/, "number.float"],
        [/0[xX][0-9a-fA-F]+[uU]?/, "number.hex"],
        [/\d+[uUfF]?/, "number"],
        [/"([^"\\]|\\.)*"/, "string"],
        [/[A-Za-z_]\w*/, { cases: { "@keywords": "keyword", "@typeKeywords": "type", "@builtins": "predefined", "@default": "identifier" } }],
        [/[{}()[\]]/, "@brackets"],
        [/[-+*/%=<>!&|^~?:.,;]+/, "operator"],
      ],
      comment: [[/[^/*]+/, "comment"], [/\*\//, "comment", "@pop"], [/[/*]/, "comment"]],
    },
  } as Monaco.languages.IMonarchLanguage);

  if (!has("snbt")) monaco.languages.register({ id: "snbt", extensions: [".snbt"], aliases: ["SNBT", "snbt"] });
  monaco.languages.setLanguageConfiguration("snbt", {
    brackets: [["{", "}"], ["[", "]"]],
    autoClosingPairs: [{ open: "{", close: "}" }, { open: "[", close: "]" }, { open: '"', close: '"' }, { open: "'", close: "'" }],
    comments: { lineComment: "#" },
  });
  monaco.languages.setMonarchTokensProvider("snbt", {
    tokenizer: {
      root: [
        [/#.*$/, "comment"],
        [/"([^"\\]|\\.)*"/, "string"],
        [/'([^'\\]|\\.)*'/, "string"],
        [/[A-Za-z_][\w.+-]*(?=\s*:)/, "key"],
        [/\b(true|false)\b/, "constant"],
        [/-?\d+(\.\d+)?([eE][-+]?\d+)?[bBsSlLfFdD]?/, "number"],
        [/\b[BIL](?=;)/, "type"],
        [/[A-Za-z_][\w.+-]*/, "string"],
        [/[{}[\]]/, "@brackets"],
        [/[:,;]/, "delimiter"],
      ],
    },
  } as Monaco.languages.IMonarchLanguage);
}
