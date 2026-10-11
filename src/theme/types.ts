/** Complete colour scheme = UI variables + editor syntax roles + terminal palette. Hex values have no leading #. */
export interface Ui {
  bg: string;          // editor background (--bg-editor)
  chrome: string;      // toolbar, stripes, tool windows, status bar
  popup: string;
  hover: string;
  selected: string;
  input: string;
  border: string;
  borderStrong: string;
  fg: string;          // UI + editor body text
  fgDim: string;
  fgFaint: string;
  accent: string;
  accentBg: string;
  /** editor selection / current-line highlight */
  selection: string;
  lineHl: string;
  /** text colour on `accentBg` (primary buttons, toggles) */
  onAccent?: string;
}
/** A syntax colour: "rrggbb" or "rrggbb/i" (italic) "/b" (bold) "/bi" */
export type Tok = string;
export interface Syn {
  text: Tok; comment: Tok; docComment: Tok; docTag: Tok;
  keyword: Tok; control: Tok; operator: Tok; punct: Tok;
  type: Tok; typeParam: Tok; iface: Tok; enumT: Tok; ns: Tok;
  fnDecl: Tok; call: Tok; field: Tok; param: Tok; local: Tok;
  constant: Tok; enumMember: Tok;
  number: Tok; string: Tok; escape: Tok; regexp: Tok;
  annotation: Tok; macro: Tok; self: Tok;
  tag: Tok; attr: Tok; key: Tok; invalid: Tok;
}
export interface Scheme {
  id: string;
  name: string;
  /** one-line character, shown in the Settings page */
  blurb: string;
  dark: boolean;
  ui: Ui;
  /** replacements for --nord0..--nord15 (Nord's role order: bg, raised, selected, faint, fg x3, teal, cyan, blue, deep blue, red, orange, yellow, green, purple) */
  slots: string[];
  syn: Syn;
  /** terminal ANSI: red, green, yellow, blue, magenta, cyan (normal); brights are derived */
  ansi: [string, string, string, string, string, string];
  /** use this Monaco theme data verbatim (Nord = the original theme, as is) */
  verbatimMonaco?: boolean;
}
