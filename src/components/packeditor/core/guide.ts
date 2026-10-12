/**
 * Guide book entries and categories (assets/<ns>/guide/<book>/<lang>/{entries,categories}/**.json): the page types and their
 * fields (GuideSchema.java) and the inline markup (GuideMarkup.java), for a page-by-page editor with a live preview.
 */

export type FieldKind = "markup" | "markups" | "text" | "texts" | "item" | "items" | "id" | "ids" | "int" | "bool" | "objects";
export interface GuideField { name: string; kind: FieldKind; required: boolean; doc: string }
export interface PageType { name: string; dynamic: boolean; doc: string; fields: GuideField[] }

const f = (name: string, kind: FieldKind, required: boolean, doc: string): GuideField => ({ name, kind, required, doc });
const TITLE = f("title", "markup", false, "Heading above the page.");
const TEXT = f("text", "markup", false, "Body text.");
const REQUIRES = f("requires", "text", false, "`op`: only shown to a reader who can run operator commands.");

export const ENTRY_FIELDS: GuideField[] = [
  f("name", "text", true, "Shown name."), f("category", "id", true, "The category it sits in."), f("icon", "item", false, "Item id."),
  f("sort", "int", false, "Order within the category, lowest first."), REQUIRES,
];
export const CATEGORY_FIELDS: GuideField[] = [
  f("name", "text", true, "Shown name."), f("description", "markup", false, "Line under the name."), f("icon", "item", false, "Item id."),
  f("sort", "int", false, "Order among siblings, lowest first."), f("parent", "id", false, "A category id; makes this a child of it."), REQUIRES,
];

export const PAGE_TYPES: PageType[] = [
  { name: "text", dynamic: false, doc: "Heading and body text.", fields: [TITLE, TEXT] },
  { name: "spotlight", dynamic: false, doc: "One item shown large, with text.", fields: [f("item", "item", true, "Item id, optionally followed by SNBT."), TITLE, TEXT] },
  { name: "crafting", dynamic: false, doc: "A recipe by id.", fields: [f("recipe", "id", true, "Recipe id."), f("recipe2", "id", false, "A second recipe on the same page."), TITLE, TEXT] },
  { name: "image", dynamic: false, doc: "One or more pictures.", fields: [f("images", "ids", true, "Texture ids, e.g. thematic:textures/guide/ruin.png."), f("border", "bool", false, "Frame the picture."), TITLE, TEXT] },
  { name: "figure", dynamic: false, doc: "A suit or creature shown large.", fields: [f("suit", "id", false, "A suit item id."), f("entity", "id", false, "An entity type id, when it is not a suit."), f("name", "text", false, "Caption."), TEXT] },
  { name: "structure", dynamic: false, doc: "A structure template drawn as a model the reader can turn.", fields: [f("structure", "id", true, "Template id."), f("worldgen", "id", false, "The worldgen structure charted under the model."), TITLE, TEXT] },
  { name: "ore", dynamic: true, doc: "An ore with a chart of the Y levels it generates at.", fields: [f("item", "items", true, "Comma-separated item ids."), f("blocks", "ids", false, "Ore blocks to chart."), TITLE, TEXT] },
  { name: "links", dynamic: false, doc: "A list of entries to jump to.", fields: [f("entries", "ids", true, "Entry ids."), TITLE, TEXT] },
  { name: "suit_recipe", dynamic: true, doc: "How a suit is crafted, read from its recipe.", fields: [f("suit", "id", true, "Suit item id."), TITLE, TEXT, f("link_recipe", "bool", false, "Link to the Suit Bench.")] },
  { name: "suit_stats", dynamic: true, doc: "A suit's stat block.", fields: [f("suit", "id", true, "Suit item id."), TITLE] },
  { name: "suit_abilities", dynamic: true, doc: "A suit's abilities, read from the suit.", fields: [f("suit", "id", true, "Suit item id."), TITLE] },
  { name: "ability_data", dynamic: true, doc: "An ability's rules and numbers.", fields: [
    f("rules_text", "markup", false, "One-line summary."), f("rules_steps", "markups", false, "What happens, in order."),
    f("damage_context", "markup", false, "Where the damage figure comes from."), f("damage_note", "markup", false, "A footnote on damage."),
    f("ability", "id", false, "Ability id when it differs from the entry's."), f("relevant_effects", "ids", false, "Status effects worth listing."),
    f("hide_stats", "bool", false, "Leave out the number table."), f("include_stats", "texts", false, "Only these stats."), f("exclude_stats", "texts", false, "Not these stats."),
  ] },
  { name: "passive_description", dynamic: true, doc: "A passive's description and its effects.", fields: [f("description", "markup", true, "What it does."), f("relevant_effects", "ids", false, "Status effects it relates to.")] },
  { name: "ability_keybinds", dynamic: true, doc: "The keys an ability uses.", fields: [TITLE, f("bindings", "objects", true, "{action, keys[], note} rows.")] },
  { name: "ability_animation_api", dynamic: true, doc: "Animation previews for an ability.", fields: [TITLE, f("animations", "objects", true, "{id, label} rows.")] },
  { name: "ability_items", dynamic: true, doc: "Items an ability equips.", fields: [TITLE, TEXT, f("items", "ids", true, "Item ids.")] },
];
export const pageType = (name: unknown) => PAGE_TYPES.find((t) => t.name === name);

// ---------------------------------------------------------------- markup

export interface Run { text: string; bold: boolean; italic: boolean; color: number; link: string | null }

const NAMES = ["black", "dark_blue", "dark_green", "dark_aqua", "dark_red", "dark_purple", "gold", "gray", "dark_gray", "blue", "green", "aqua", "red", "light_purple", "yellow", "white"];
const RGB = [0x000000, 0x0000aa, 0x00aa00, 0x00aaaa, 0xaa0000, 0xaa00aa, 0xffaa00, 0xaaaaaa, 0x555555, 0x5555ff, 0x55ff55, 0x55ffff, 0xff5555, 0xff55ff, 0xffff55, 0xffffff];

export function markupColor(spec: string): number {
  const s = spec.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(s)) return parseInt(s.slice(1), 16);
  if (/^#[0-9a-f]{3}$/.test(s)) {
    const v = parseInt(s.slice(1), 16);
    return (((v >> 8) & 15) * 17) << 16 | (((v >> 4) & 15) * 17) << 8 | (v & 15) * 17;
  }
  const i = NAMES.indexOf(s);
  return i >= 0 ? RGB[i] : -1;
}

/** GuideMarkup.parse */
export function parseMarkup(source: string | undefined | null): Run[] {
  const out: Run[] = [];
  if (source) run(source.replace(/\\n/g, "\n"), false, false, -1, null, out);
  return out;
}

function run(s: string, bold: boolean, italic: boolean, color: number, link: string | null, out: Run[]) {
  let text = "";
  let lineStart = true;
  const flush = () => { if (text) out.push({ text, bold, italic, color, link }); text = ""; };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && i + 1 < s.length) { text += s[++i]; lineStart = false; }
    else if (c === "\n") { flush(); out.push({ text: "\n", bold: false, italic: false, color: -1, link: null }); lineStart = true; }
    else if (c === "-" && lineStart && s[i + 1] === " ") { text += "•"; lineStart = false; }
    else if (c === "*") {
      flush();
      if (s[i + 1] === "*") { bold = !bold; i++; } else italic = !italic;
      lineStart = false;
    } else if (c === "{" && s.indexOf("}", i) > i) {
      const end = s.indexOf("}", i);
      const spec = s.slice(i + 1, end);
      const parsed = spec === "/" ? -1 : markupColor(spec);
      if (spec === "/" || parsed >= 0) { flush(); color = parsed; i = end; } else text += c;
      lineStart = false;
    } else if (c === "[" && link === null) {
      const mid = closing(s, i);
      const close = mid < 0 ? -1 : s.indexOf(")", mid);
      if (close > 0) {
        flush();
        run(s.slice(i + 1, mid), bold, italic, color, s.slice(mid + 2, close).trim(), out);
        i = close;
      } else text += c;
      lineStart = false;
    } else {
      text += c;
      if (c !== " ") lineStart = false;
    }
  }
  flush();
}

function closing(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") { i++; continue; }
    if (c === "[") depth++;
    else if (c === "]") { depth--; if (depth === 0) return s[i + 1] === "(" ? i : -1; }
  }
  return -1;
}

export const plainMarkup = (s: string | undefined) => parseMarkup(s).map((r) => (r.text === "\n" ? " " : r.text)).join("").replace(/\s+/g, " ").trim();

/** Is this a guide entry/category file? (…/guide/<book>/<lang>/(entries|categories)/….json) */
export function guideKind(path: string): "entry" | "category" | null {
  const m = /\/guide\/[^/]+\/[^/]+\/(entries|categories)\/.+\.json$/.exec(path.replace(/\\/g, "/"));
  return m ? (m[1] === "entries" ? "entry" : "category") : null;
}
