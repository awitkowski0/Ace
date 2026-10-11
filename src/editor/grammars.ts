/**
 * Richer Monarch grammars for languages that have no language server in Ace (Java: no jdtls on this machine).
 * Token names are generic (keyword, keyword.<control word>, type.identifier, function, function.declaration, variable.predefined,
 * variable.field, constant, namespace, annotation, comment.doc.tag, operator ...) so every colour scheme styles them (src/theme/build.ts).
 * Built-in grammars are cloned from monaco's own definition and registered eagerly, which replaces the lazy factory.
 */
import * as monaco from "monaco-editor";
import type { languages } from "monaco-editor";

type Rule = languages.IMonarchLanguageRule;

type Lang = languages.IMonarchLanguage & { keywords: string[]; tokenizer: Record<string, Rule[]> };

/** Java `root` + `qualified` states (monaco's own lexer constants - @digits, @escapes, @symbols ... - are reused through the cloned language object). */
export function javaTokenizer(): Record<string, Rule[]> {
  return {
    root: [
      { include: "@whitespace" } as Rule,
      // package / import: dotted names; lower-case segments are packages (namespace), Capitalised are types
      [/\b(?:import|package)\b/, { token: "keyword", next: "@qualified" }],
      // `new Foo(` / `new Foo<>(`: Foo is a type, not a call
      [/(new)(\s+)([A-Za-z_$][\w$.]*)/, ["keyword.new", "", "type.identifier"]],
      // `Type name(` and `Type<..> name(`: method / constructor declaration (the word before must not be a statement keyword)
      [/(?!(?:return|new|throw|else|case|assert|yield|instanceof|do|goto|import|package)\b)([A-Za-z_$][\w$.]*(?:\[\])*)(\s+)([A-Za-z_$][\w$]*)(?=\s*\()/,
        [{ cases: { "@keywords": "keyword", "@default": "type.identifier" } }, "", "function.declaration"]],
      [/(>)(\s+)([A-Za-z_$][\w$]*)(?=\s*\()/, ["delimiter", "", "function.declaration"]],
      // `.name(` call, `.NAME` constant, `.Name` type, `.name` field
      [/(\.)(\s*)([A-Za-z_$][\w$]*)(?=\s*\()/, ["delimiter", "", "function"]],
      [/(::)(\s*)([A-Za-z_$][\w$]*)/, ["operator", "", "function"]],
      [/(\.)([A-Z][A-Z0-9_]+)\b/, ["delimiter", "constant"]],
      [/(\.)([A-Z][\w$]*)/, ["delimiter", "type.identifier"]],
      [/(\.)([a-z_$][\w$]*)/, ["delimiter", "variable.field"]],
      // plain `name(` call
      [/[A-Za-z_$][\w$]*(?=\s*\()/, { cases: { "this|super": "variable.predefined", "@keywords": { token: "keyword.$0" }, "@default": "function" } }],
      // identifiers: this/super, keywords, CONSTANTS, Types, others
      [/[A-Za-z_$][\w$]*/, { cases: { "this|super": "variable.predefined", "@keywords": { token: "keyword.$0" }, "[A-Z][A-Z0-9_]+": "constant", "[A-Z].*": "type.identifier", "@default": "identifier" } }],
      [/[{}()\[\]]/, "@brackets"],
      [/@\s*(?!interface\b)[a-zA-Z_$][\w$.]*/, "annotation"],
      [/->|::/, "operator"],
      [/@symbols/, "operator"],
      [/[<>]/, "operator"],
      [/(@digits)[eE]([\-+]?(@digits))?[fFdD]?/, "number.float"],
      [/(@digits)\.(@digits)([eE][\-+]?(@digits))?[fFdD]?/, "number.float"],
      [/0[xX](@hexdigits)[Ll]?/, "number.hex"],
      [/0(@octaldigits)[Ll]?/, "number.octal"],
      [/0[bB](@binarydigits)[Ll]?/, "number.binary"],
      [/(@digits)[fFdD]/, "number.float"],
      [/(@digits)[lL]?/, "number"],
      [/[;,.]/, "delimiter"],
      [/"([^"\\]|\\.)*$/, "string.invalid"],
      [/"""/, "string", "@multistring"],
      [/"/, "string", "@string"],
      [/'[^\\']'/, "string"],
      [/(')(@escapes)(')/, ["string", "string.escape", "string"]],
      [/'/, "string.invalid"],
    ],
    qualified: [
      [/\s+/, ""],
      [/\bstatic\b/, "keyword.static"],
      [/[a-z_$][\w$]*(?=\s*\.)/, "namespace"],
      [/[A-Z][A-Z0-9_]+\b/, "constant"],
      [/[A-Z][\w$]*/, "type.identifier"],
      [/[a-z_$][\w$]*/, "namespace"],
      [/\*/, "operator"],
      [/[.]/, "delimiter"],
      [/;/, { token: "delimiter", next: "@pop" }],
    ],
  };
}

async function patchJava() {
  const { language } = (await import("monaco-editor/languages/definitions/java/java")) as { language: Lang };
  const mine = javaTokenizer();
  if (!language.keywords.includes("null")) language.keywords = [...language.keywords, "null"];
  const javadoc: Rule[] = [
    [/\{@[a-zA-Z]+/, "comment.doc.tag"],
    [/@[a-zA-Z]+/, "comment.doc.tag"],
    [/[^\/*@{]+/, "comment.doc"],
    [/[@{]/, "comment.doc"],
    [/\/\*/, "comment.doc.invalid"],
    [/\*\//, "comment.doc", "@pop"],
    [/[\/*]/, "comment.doc"],
  ];
  monaco.languages.setMonarchTokensProvider("java", { ...language, tokenizer: { ...language.tokenizer, ...mine, javadoc } } as languages.IMonarchLanguage);
}

/** Resolved before the first editor mounts (monacoSetup.keymapReady). */
export async function patchBuiltinGrammars() {
  await patchJava();
}
