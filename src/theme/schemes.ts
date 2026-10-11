/**
 * Scheme registry. Each scheme is complete: UI variables, syntax roles (token + semantic), terminal palette.
 * Syntax colours must reach 4.5:1 and body text 7:1 against the editor background (schemes.test.ts enforces it).
 * Palettes of third-party themes (One Dark, Dracula, Tokyo Night, Catppuccin, Gradianto, JetBrains defaults) are approximations
 * from their public colour tables; Gradianto's gradient backgrounds are flattened.
 */
import type { Scheme, Syn, Ui } from "./types";

const NORD_UI: Ui = {
  bg: "2e3440", chrome: "2b303b", popup: "2b303b", hover: "3b4252", selected: "434c5e", input: "3b4252", border: "3b4252", borderStrong: "232831",
  fg: "d8dee9", fgDim: "8b95a8", fgFaint: "616e88", accent: "88c0d0", accentBg: "5e81ac", selection: "434c5e", lineHl: "3b4252",
};
const NORD_SLOTS = ["2e3440", "3b4252", "434c5e", "4c566a", "d8dee9", "e5e9f0", "eceff4", "8fbcbb", "88c0d0", "81a1c1", "5e81ac", "bf616a", "d08770", "ebcb8b", "a3be8c", "b48ead"];

const nordVivid: Syn = {
  text: "d8dee9", comment: "92a0bb/i", docComment: "8fc4a8/i", docTag: "b3ecc9/bi",
  keyword: "c792ea", control: "ff7a93", operator: "8fcbe6", punct: "b4bfd3",
  type: "3ddcc3", typeParam: "8be9d0/i", iface: "5fe3a1", enumT: "f2c26b", ns: "a9bdd6",
  fnDecl: "ffd166", call: "6ec1ff", field: "ff9e64", param: "f2a6e0", local: "d8dee9",
  constant: "ffb347", enumMember: "ffb347/i", number: "9ea7ff", string: "a3e08c", escape: "5eead4", regexp: "f2a65a",
  annotation: "d9e36e", macro: "e58fff", self: "ff9db0/i", tag: "7fb5ff", attr: "ffb86b", key: "7ec8ff", invalid: "ff6b86",
};

const intellijDark: Syn = {
  text: "bcbec4", comment: "8a8e96", docComment: "7fa98a/i", docTag: "8fbf9d/bi",
  keyword: "cf8e6d", control: "cf8e6d", operator: "bcbec4", punct: "bcbec4",
  type: "bcbec4", typeParam: "16baac", iface: "bcbec4", enumT: "bcbec4", ns: "bcbec4",
  fnDecl: "56a8f5", call: "bcbec4", field: "c77dbb", param: "bcbec4", local: "bcbec4",
  constant: "c77dbb/i", enumMember: "c77dbb/i", number: "2aacb8", string: "6aab73", escape: "cf8e6d", regexp: "6aab73",
  annotation: "b3ae60", macro: "b3ae60", self: "cf8e6d", tag: "d5b778", attr: "bcbec4", key: "c77dbb", invalid: "f75464",
};

const darcula: Syn = {
  text: "b3c0cf", comment: "999999/i", docComment: "7aa869/i", docTag: "8fbf7a/bi",
  keyword: "d4833a", control: "d4833a", operator: "b3c0cf", punct: "b3c0cf",
  type: "b3c0cf", typeParam: "20b0b5", iface: "b3c0cf", enumT: "b3c0cf", ns: "b3c0cf",
  fnDecl: "ffc66d", call: "b3c0cf", field: "ab8bc0", param: "b3c0cf", local: "b3c0cf",
  constant: "ab8bc0/i", enumMember: "ab8bc0/i", number: "6897bb", string: "7da568", escape: "d4833a", regexp: "7da568",
  annotation: "bbb529", macro: "bbb529", self: "b585b0", tag: "e8bf6a", attr: "bababa", key: "ab8bc0", invalid: "ff6b68",
};

const oneDark: Syn = {
  text: "b4bbc7", comment: "8a93a3/i", docComment: "8fa0b5/i", docTag: "b0bdd0/bi",
  keyword: "d18af0", control: "e87fe0", operator: "56c8d8", punct: "b6bdca",
  type: "f0cc7a", typeParam: "f0cc7a/i", iface: "7fe0b0", enumT: "f0cc7a", ns: "abb2bf",
  fnDecl: "4fb8ff", call: "61afef", field: "f07178", param: "f4a47a/i", local: "e8949b",
  constant: "e8b070", enumMember: "e8b070/i", number: "e8b070", string: "a5e075", escape: "56c8d8", regexp: "56c8d8",
  annotation: "f0cc7a", macro: "d18af0", self: "f07178/i", tag: "f07178", attr: "e8b070", key: "f07178", invalid: "ff5f6d",
};

const dracula: Syn = {
  text: "f8f8f2", comment: "8e9ccf/i", docComment: "9fb0e6/i", docTag: "c0ceff/bi",
  keyword: "ff79c6", control: "ff79c6", operator: "ff79c6", punct: "f8f8f2",
  type: "8be9fd/i", typeParam: "8be9fd/i", iface: "8be9fd/i", enumT: "8be9fd", ns: "f8f8f2",
  fnDecl: "50fa7b", call: "50fa7b", field: "f8f8f2", param: "ffb86c/i", local: "f8f8f2",
  constant: "bd93f9", enumMember: "bd93f9/i", number: "bd93f9", string: "f1fa8c", escape: "ff79c6", regexp: "ff5555",
  annotation: "50fa7b", macro: "ff79c6", self: "bd93f9/i", tag: "ff79c6", attr: "50fa7b", key: "8be9fd", invalid: "ff5555",
};

const tokyoNight: Syn = {
  text: "c0caf5", comment: "7f8ab8/i", docComment: "8a96c8/i", docTag: "a9b4e6/bi",
  keyword: "bb9af7", control: "bb9af7", operator: "89ddff", punct: "a9b1d6",
  type: "2ac3de", typeParam: "2ac3de/i", iface: "7dcfff", enumT: "2ac3de", ns: "c0caf5",
  fnDecl: "7aa2f7", call: "7aa2f7", field: "73daca", param: "e0af68", local: "c0caf5",
  constant: "ff9e64", enumMember: "ff9e64/i", number: "ff9e64", string: "9ece6a", escape: "89ddff", regexp: "b4f9f8",
  annotation: "e0af68", macro: "7dcfff", self: "f7768e/i", tag: "f7768e", attr: "bb9af7", key: "7aa2f7", invalid: "f7768e",
};

const catppuccin: Syn = {
  text: "cdd6f4", comment: "9399b2/i", docComment: "9ea4c0/i", docTag: "b4bbd8/bi",
  keyword: "cba6f7", control: "cba6f7", operator: "89dceb", punct: "9399b2",
  type: "f9e2af", typeParam: "f9e2af/i", iface: "94e2d5", enumT: "f9e2af", ns: "b4befe",
  fnDecl: "89b4fa", call: "89b4fa", field: "b4befe", param: "eba0ac/i", local: "cdd6f4",
  constant: "fab387", enumMember: "fab387/i", number: "fab387", string: "a6e3a1", escape: "f5c2e7", regexp: "f5c2e7",
  annotation: "f9e2af", macro: "74c7ec", self: "f38ba8/i", tag: "89b4fa", attr: "f9e2af", key: "89b4fa", invalid: "f38ba8",
};

const deepOcean: Syn = {
  text: "d3e6f3", comment: "7fa6bf/i", docComment: "86b6cf/i", docTag: "a8d8ef/bi",
  keyword: "5ee6f0", control: "ff8fb0", operator: "7fd1e8", punct: "a9c5d6",
  type: "ffd580", typeParam: "ffd580/i", iface: "8ff0c4", enumT: "ffd580", ns: "a9c5d6",
  fnDecl: "82aaff", call: "6bc3ff", field: "c3a6ff", param: "ff9f7a/i", local: "d3e6f3",
  constant: "ffb86b", enumMember: "ffb86b/i", number: "ffb86b", string: "8fe388", escape: "5ee6f0", regexp: "f2e394",
  annotation: "f2e394", macro: "ff8fb0", self: "ff8fb0/i", tag: "6bc3ff", attr: "c3a6ff", key: "6bc3ff", invalid: "ff5c7a",
};

const natureGreen: Syn = {
  text: "d6e8d2", comment: "86ad90/i", docComment: "8fbc9a/i", docTag: "b0e0ba/bi",
  keyword: "7ee787", control: "ff9e80", operator: "7fd8c8", punct: "b0c8b0",
  type: "b8e86a", typeParam: "b8e86a/i", iface: "6fe3d0", enumT: "e8d36a", ns: "b0c8b0",
  fnDecl: "6cc9f0", call: "5ab8e0", field: "f0b6d8", param: "ffcc80/i", local: "d6e8d2",
  constant: "ffb74d", enumMember: "ffb74d/i", number: "ffab91", string: "f2d388", escape: "7fd8c8", regexp: "ffcc80",
  annotation: "e8d36a", macro: "f0b6d8", self: "ff9e80/i", tag: "7ee787", attr: "ffcc80", key: "6cc9f0", invalid: "ff6e6e",
};

const intellijLight: Syn = {
  text: "080808", comment: "6e6e6e/i", docComment: "4f6b45/i", docTag: "3b6b2a/bi",
  keyword: "0033b3", control: "0033b3", operator: "080808", punct: "080808",
  type: "080808", typeParam: "007e8a", iface: "080808", enumT: "080808", ns: "080808",
  fnDecl: "00627a", call: "080808", field: "871094", param: "080808", local: "080808",
  constant: "871094/i", enumMember: "871094/i", number: "1750eb", string: "067d17", escape: "0037a6", regexp: "067d17",
  annotation: "7f6b00", macro: "7f6b00", self: "0033b3", tag: "0033b3", attr: "174ad4", key: "871094", invalid: "c4001c",
};

export const SCHEMES: Scheme[] = [
  {
    id: "nord-vivid", name: "Nord Vivid", dark: true, blurb: "Nord's slate UI, saturated syntax with a distinct hue per role",
    ui: { ...NORD_UI, fgDim: "98a4ba" }, slots: NORD_SLOTS, syn: nordVivid, ansi: ["ea7f8a", "a3e08c", "f2c26b", "6ea8ff", "c792ea", "5ed4e0"],
  },
  {
    id: "nord", name: "Nord", dark: true, blurb: "The original muted Nord scheme (nord-jetbrains)",
    ui: NORD_UI, slots: NORD_SLOTS, verbatimMonaco: true,
    syn: { ...nordVivid, comment: "616e88/i", keyword: "81a1c1", control: "81a1c1", type: "8fbcbb", fnDecl: "88c0d0", call: "88c0d0", number: "b48ead", string: "a3be8c" },
    ansi: ["bf616a", "a3be8c", "ebcb8b", "81a1c1", "b48ead", "88c0d0"],
  },
  {
    id: "intellij-dark", name: "IntelliJ Dark (New UI)", dark: true, blurb: "JetBrains New UI Dark: orange keywords, blue declarations, purple fields",
    ui: {
      bg: "1e1f22", chrome: "2b2d30", popup: "2b2d30", hover: "393b40", selected: "2e436e", input: "2b2d30", border: "393b40", borderStrong: "1e1f22",
      fg: "dfe1e5", fgDim: "9da0a8", fgFaint: "6f737a", accent: "548af7", accentBg: "3574f0", selection: "214283", lineHl: "26282e",
    },
    slots: ["1e1f22", "2b2d30", "393b40", "4e5157", "bcbec4", "dfe1e5", "f0f1f2", "16baac", "56a8f5", "548af7", "3574f0", "f75464", "cf8e6d", "f2c55c", "5fb865", "c77dbb"],
    syn: intellijDark, ansi: ["f75464", "5fb865", "f2c55c", "56a8f5", "c77dbb", "2aacb8"],
  },
  {
    id: "darcula", name: "Darcula", dark: true, blurb: "Classic JetBrains Darcula: warm grey, orange keywords, yellow function names",
    ui: {
      bg: "2b2b2b", chrome: "3c3f41", popup: "3c3f41", hover: "4e5254", selected: "4b6eaf", input: "45494a", border: "323232", borderStrong: "2b2b2b",
      fg: "e0e4e8", fgDim: "a8b0b8", fgFaint: "808890", accent: "589df6", accentBg: "4b6eaf", selection: "214283", lineHl: "323232",
    },
    slots: ["2b2b2b", "3c3f41", "4e5254", "606366", "a9b7c6", "d0d8e0", "e8ecef", "20b0b5", "589df6", "6897bb", "4b6eaf", "ff6b68", "cc7832", "ffc66d", "6a8759", "9876aa"],
    syn: darcula, ansi: ["ff6b68", "7da568", "ffc66d", "6897bb", "ab8bc0", "20b0b5"],
  },
  {
    id: "one-dark-vivid", name: "One Dark Vivid", dark: true, blurb: "Atom One Dark with brighter, more separated colours",
    ui: {
      bg: "282c34", chrome: "21252b", popup: "21252b", hover: "2c313a", selected: "3a3f4b", input: "1d2026", border: "181a1f", borderStrong: "181a1f",
      fg: "d7dae0", fgDim: "9aa2b1", fgFaint: "6b7385", accent: "61afef", accentBg: "3b6fb0", selection: "3e4451", lineHl: "2c313c",
    },
    slots: ["282c34", "2c313a", "3e4451", "5c6370", "abb2bf", "d7dae0", "e6e9ee", "56c8d8", "61afef", "4fb8ff", "3b6fb0", "f07178", "e8b070", "f0cc7a", "a5e075", "d18af0"],
    syn: oneDark, ansi: ["f07178", "a5e075", "f0cc7a", "61afef", "d18af0", "56c8d8"],
  },
  {
    id: "dracula", name: "Dracula", dark: true, blurb: "Purple-black with pink keywords and green functions",
    ui: {
      bg: "282a36", chrome: "21222c", popup: "21222c", hover: "343746", selected: "44475a", input: "343746", border: "191a21", borderStrong: "191a21",
      fg: "f8f8f2", fgDim: "b0b6d0", fgFaint: "8087a8", accent: "bd93f9", accentBg: "6c4fb0", selection: "44475a", lineHl: "303341",
    },
    slots: ["282a36", "343746", "44475a", "6272a4", "f8f8f2", "fcfcf8", "ffffff", "8be9fd", "8be9fd", "bd93f9", "6c4fb0", "ff5555", "ffb86c", "f1fa8c", "50fa7b", "ff79c6"],
    syn: dracula, ansi: ["ff5555", "50fa7b", "f1fa8c", "bd93f9", "ff79c6", "8be9fd"],
  },
  {
    id: "tokyo-night", name: "Tokyo Night", dark: true, blurb: "Deep indigo night with blue functions and orange numbers",
    ui: {
      bg: "1a1b26", chrome: "16161e", popup: "16161e", hover: "292e42", selected: "33467c", input: "20222f", border: "101014", borderStrong: "101014",
      fg: "c0caf5", fgDim: "8b94c2", fgFaint: "6870a0", accent: "7aa2f7", accentBg: "3d59a1", selection: "283457", lineHl: "1f2335",
    },
    slots: ["1a1b26", "292e42", "33467c", "565f89", "a9b1d6", "c0caf5", "d5dbfa", "73daca", "7dcfff", "7aa2f7", "3d59a1", "f7768e", "ff9e64", "e0af68", "9ece6a", "bb9af7"],
    syn: tokyoNight, ansi: ["f7768e", "9ece6a", "e0af68", "7aa2f7", "bb9af7", "7dcfff"],
  },
  {
    id: "catppuccin-mocha", name: "Catppuccin Mocha", dark: true, blurb: "Soft pastel mocha: mauve keywords, blue functions, peach numbers",
    ui: {
      bg: "1e1e2e", chrome: "181825", popup: "181825", hover: "313244", selected: "45475a", input: "313244", border: "11111b", borderStrong: "11111b",
      fg: "cdd6f4", fgDim: "a6adc8", fgFaint: "7f849c", accent: "89b4fa", accentBg: "4a68b0", selection: "45475a", lineHl: "27273a",
    },
    slots: ["1e1e2e", "313244", "45475a", "585b70", "bac2de", "cdd6f4", "e0e6fb", "94e2d5", "89dceb", "89b4fa", "4a68b0", "f38ba8", "fab387", "f9e2af", "a6e3a1", "cba6f7"],
    syn: catppuccin, ansi: ["f38ba8", "a6e3a1", "f9e2af", "89b4fa", "f5c2e7", "94e2d5"],
  },
  {
    id: "gradianto-deep-ocean", name: "Gradianto Deep Ocean", dark: true, blurb: "Navy-teal depths with aqua keywords (gradient flattened)",
    ui: {
      bg: "0f2233", chrome: "0b1a28", popup: "0b1a28", hover: "17334a", selected: "1f4766", input: "132b40", border: "0a1722", borderStrong: "07111a",
      fg: "d3e6f3", fgDim: "8fb0c6", fgFaint: "628299", accent: "5ee6f0", accentBg: "1f7f93", selection: "1f4766", lineHl: "143048",
    },
    slots: ["0f2233", "17334a", "1f4766", "3a6280", "bcd4e4", "d3e6f3", "e6f2fa", "8ff0c4", "5ee6f0", "6bc3ff", "1f7f93", "ff5c7a", "ffb86b", "ffd580", "8fe388", "c3a6ff"],
    syn: deepOcean, ansi: ["ff5c7a", "8fe388", "ffd580", "6bc3ff", "c3a6ff", "5ee6f0"],
  },
  {
    id: "gradianto-nature-green", name: "Gradianto Nature Green", dark: true, blurb: "Forest-dark green with lime types and mint keywords (gradient flattened)",
    ui: {
      bg: "10261c", chrome: "0b1c14", popup: "0b1c14", hover: "1a3a2b", selected: "245640", input: "143124", border: "0a1710", borderStrong: "06100a",
      fg: "d6e8d2", fgDim: "93b59a", fgFaint: "66896f", accent: "5bd97a", accentBg: "2a7a47", selection: "245640", lineHl: "163226",
    },
    slots: ["10261c", "1a3a2b", "245640", "3d6b50", "bdd4ba", "d6e8d2", "e8f4e5", "6fe3d0", "6cc9f0", "5ab8e0", "2a7a47", "ff6e6e", "ffb74d", "e8d36a", "7ee787", "f0b6d8"],
    syn: natureGreen, ansi: ["ff6e6e", "7ee787", "e8d36a", "6cc9f0", "f0b6d8", "6fe3d0"],
  },
  {
    id: "intellij-light", name: "IntelliJ Light", dark: false, blurb: "JetBrains New UI Light: blue keywords, teal function names, purple fields",
    ui: {
      bg: "ffffff", chrome: "f7f8fa", popup: "ffffff", hover: "ebecf0", selected: "d5e1ff", input: "ffffff", border: "dfe1e5", borderStrong: "c9ccd6",
      fg: "080808", fgDim: "55585f", fgFaint: "6c707e", accent: "3574f0", accentBg: "3574f0", selection: "a6d2ff", lineHl: "f5f8fe", onAccent: "ffffff",
    },
    slots: ["ffffff", "f7f8fa", "dfe1e5", "a8adbd", "2b2d30", "1b1c1f", "080808", "007e8a", "00627a", "0033b3", "3574f0", "c4001c", "b25000", "7f6b00", "067d17", "871094"],
    syn: intellijLight, ansi: ["c4001c", "067d17", "7f6b00", "0033b3", "871094", "007e8a"],
  },
];

export const DEFAULT_SCHEME = "nord-vivid";
export const schemeById = (id: string | null | undefined): Scheme => SCHEMES.find((s) => s.id === id) ?? SCHEMES.find((s) => s.id === DEFAULT_SCHEME)!;
