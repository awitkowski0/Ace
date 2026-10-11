/**
 * LSP semantic tokens -> Monaco. Pure (no monaco import): the server's legend + delta-encoded data are mapped onto Ace's own fixed
 * legend (src/theme/semanticRoles.ts), one token type per (role x declaration/static/deprecated) so the colour scheme (Monaco theme
 * rules `sem.<role>[.declaration][.static][.deprecated]`) decides colours and styles. Tokens that map to nothing (operators,
 * punctuation, strings, comments ...) are dropped, which leaves the Monarch colouring of those ranges untouched.
 */
import { SEM_LEGEND_TYPES, semName, type SemRole } from "../../theme/semanticRoles";

export interface ServerLegend { tokenTypes: string[]; tokenModifiers: string[] }
export interface SemToken { line: number; start: number; len: number; role: SemRole; decl: boolean; stat: boolean; deprecated: boolean }

const TYPE_ROLE: Record<string, SemRole | null> = {
  namespace: "namespace", module: "namespace",
  class: "class", struct: "class", union: "class", record: "class", type: "type", typeAlias: "type", builtinType: "type", selfTypeKeyword: "type", selfType: "type",
  interface: "interface", trait: "interface", enum: "enum", typeParameter: "typeParameter", generic: "typeParameter", lifetime: "lifetime",
  parameter: "parameter", constParameter: "parameter", variable: "variable", property: "property", field: "property", enumMember: "enumMember", event: "property",
  function: "function", method: "method", macro: "macro", decorator: "decorator", attribute: "decorator", builtinAttribute: "decorator", derive: "decorator", deriveHelper: "decorator",
  annotation: "decorator", keyword: "keyword", selfKeyword: "self", boolean: "keyword",
  formatSpecifier: "escape", escapeSequence: "escape", invalidEscapeSequence: "escape",
  // everything else (operator, punctuation, bracket, comma, string, number, comment, regexp, unresolvedReference, label, modifier ...) is left to the grammar
};
const DECL = new Set(["declaration", "definition"]);

export interface MapOptions {
  /** source text of a token (needed for `self` / ALL_CAPS refinement); optional */
  text?: (line: number, start: number, len: number) => string;
}

/** Map one server token to Ace's role, or null to drop it. */
export function mapToken(type: string, mods: Set<string>, text?: string): { role: SemRole; decl: boolean; stat: boolean; deprecated: boolean } | null {
  let role = TYPE_ROLE[type] ?? null;
  if (!role) return null;
  if (role === "keyword" && mods.has("controlFlow")) role = "control";
  if (role === "parameter" && text && (text === "self" || text === "cls")) role = "self";
  if (role === "variable") {
    if (mods.has("readonly") || mods.has("constant") || (text !== undefined && /^[A-Z][A-Z0-9_]+$/.test(text))) role = "constant";
  }
  if (role === "property" && mods.has("static") && mods.has("readonly")) role = "constant";
  return { role, decl: [...mods].some((m) => DECL.has(m)), stat: mods.has("static"), deprecated: mods.has("deprecated") };
}

const IDX = new Map(SEM_LEGEND_TYPES.map((n, i) => [n, i]));

/** Decode LSP relative data (5 ints per token), map, drop the unmapped, and re-encode against Ace's legend. */
export function remapSemanticTokens(data: ArrayLike<number>, legend: ServerLegend, opts: MapOptions = {}): Uint32Array {
  const out: number[] = [];
  let line = 0, ch = 0, pl = 0, pc = 0;
  const modNames = legend.tokenModifiers;
  for (let i = 0; i + 4 < data.length; i += 5) {
    const dl = data[i];
    line += dl;
    ch = dl === 0 ? ch + data[i + 1] : data[i + 1];
    const len = data[i + 2];
    const type = legend.tokenTypes[data[i + 3]];
    if (!type || len <= 0) continue;
    const bits = data[i + 4];
    const mods = new Set<string>();
    for (let b = 0; bits >>> b; b++) if ((bits >>> b) & 1 && modNames[b]) mods.add(modNames[b]);
    const m = mapToken(type, mods, opts.text?.(line, ch, len));
    if (!m) continue;
    const idx = IDX.get(semName(m.role, { declaration: m.decl, static: m.stat, deprecated: m.deprecated }));
    if (idx === undefined) continue;
    out.push(line - pl, line === pl ? ch - pc : ch, len, idx, 0);
    pl = line; pc = ch;
  }
  return Uint32Array.from(out);
}

/** Decoded view of Ace-legend data (test hook / unit tests). */
export function decodeAce(data: ArrayLike<number>): { line: number; start: number; len: number; type: string }[] {
  const res: { line: number; start: number; len: number; type: string }[] = [];
  let line = 0, ch = 0;
  for (let i = 0; i + 4 < data.length; i += 5) {
    line += data[i];
    ch = data[i] === 0 ? ch + data[i + 1] : data[i + 1];
    res.push({ line, start: ch, len: data[i + 2], type: SEM_LEGEND_TYPES[data[i + 3]] });
  }
  return res;
}
