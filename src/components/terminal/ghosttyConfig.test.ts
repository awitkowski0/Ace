import { describe, expect, it } from "vitest";
import { parseConfigText, resolveThemeName, settingsFromGhostty } from "./ghosttyConfig";
import { parseThemeText } from "./themes";

describe("ghostty config", () => {
  it("maps the supported subset", () => {
    const s = settingsFromGhostty(parseConfigText(`# c\ntheme = Dracula\nfont-family = "Fira Code"\nfont-size = 15\ncursor-style = bar\nscrollback-limit = 20000000\ncopy-on-select = false\nmacos-option-as-alt = left\nclipboard-read = allow\npalette = 1=#ff0000\nbackground = #101010\nunknown = x`));
    expect(s).toMatchObject({ theme: "Dracula", fontSize: 15, cursorStyle: "bar", scrollback: 20000, copyOnSelect: false, optionAsAlt: true, clipboardRead: "allow" });
    expect(s.fontFamily).toContain('"Fira Code"');
    expect(s.colorOverrides).toEqual({ p1: "#ff0000", background: "#101010" });
  });
  it("resolves light/dark theme pairs", () => {
    expect(resolveThemeName("light:Solarized Light,dark:Nord", true)).toBe("Nord");
    expect(resolveThemeName("light:Solarized Light,dark:Nord", false)).toBe("Solarized Light");
    expect(resolveThemeName("Nord", true)).toBe("Nord");
  });
  it("parses a Ghostty theme file", () => {
    const t = parseThemeText("palette = 0=#3b4252\npalette = 1=#bf616a\nbackground = #2e3440\nforeground = #d8dee9\ncursor-color = #eceff4\nselection-background = #eceff4\nselection-foreground = #4c566a");
    expect(t).toMatchObject({ black: "#3b4252", red: "#bf616a", background: "#2e3440", cursor: "#eceff4", selectionForeground: "#4c566a" });
  });
});
