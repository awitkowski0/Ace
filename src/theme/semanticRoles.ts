/** Shared by the Monaco theme builder and the LSP semantic-token mapper: the role ids a semantic token can end up with. */
import type { Syn } from "./types";

/** role -> Syn colour key */
export const SEM_ROLES = {
  namespace: "ns", class: "type", struct: "type", type: "type", interface: "iface", enum: "enumT", typeParameter: "typeParam",
  parameter: "param", variable: "local", property: "field", enumMember: "enumMember", function: "call", method: "call", macro: "macro",
  keyword: "keyword", control: "control", decorator: "annotation", constant: "constant", self: "self", lifetime: "typeParam",
  escape: "escape", field: "field",
} as const satisfies Record<string, keyof Syn>;
export type SemRole = keyof typeof SEM_ROLES;
/** roles whose declaration site has its own colour (IntelliJ colours function declarations, calls stay plain) */
export const DECL_COLOR: Partial<Record<SemRole, keyof Syn>> = { function: "fnDecl", method: "fnDecl" };
export const VARIANT_MODS = ["declaration", "static", "deprecated"] as const;
export type VariantMod = (typeof VARIANT_MODS)[number];

/** `sem.function.declaration.static` ... : modifiers in canonical order */
export function semName(role: SemRole, mods: Partial<Record<VariantMod, boolean>>): string {
  return "sem." + role + VARIANT_MODS.filter((m) => mods[m]).map((m) => "." + m).join("");
}
/** every token type id the Monaco legend declares (no modifiers: they are folded into the name) */
export const SEM_LEGEND_TYPES: string[] = (() => {
  const out: string[] = [];
  for (const r of Object.keys(SEM_ROLES) as SemRole[]) {
    for (let m = 0; m < 8; m++) out.push(semName(r, { declaration: !!(m & 1), static: !!(m & 2), deprecated: !!(m & 4) }));
  }
  return out;
})();
