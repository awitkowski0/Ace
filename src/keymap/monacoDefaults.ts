/** Reads Monaco's default keybindings from the live registry (the same registry the editor resolves against). */
import { ourKeyName, seqOf, type MonacoBinding, type RawChord } from "./monacoPolicy";
import { detectPlatform } from "../lib/platform";

export async function readMonacoDefaults(): Promise<MonacoBinding[]> {
  const [{ KeybindingsRegistry }, { KeyCodeUtils }] = await Promise.all([
    import("monaco-editor/platform/keybinding/common/keybindingsRegistry.js"),
    import("monaco-editor/base/common/keyCodes.js"),
  ]);
  // Decided at call time (not import time) so it follows the platform Monaco itself just resolved.
  const mac = detectPlatform(navigator.userAgent, navigator.platform).mac;
  const out: MonacoBinding[] = [];
  for (const it of KeybindingsRegistry.getDefaultKeybindings() as any[]) {
    const raw = it.keybinding?.chords as any[] | undefined;
    if (!it.command || !raw?.length || it.command.startsWith("-")) continue;
    // Monaco's CtrlCmd is metaKey on mac and ctrlKey elsewhere. Off mac, Monaco's Ctrl chords are our ⌘ ("meta");
    // Monaco's WinCtrl (metaKey) is dropped because Windows keys never reach Atelier shortcuts (see keystroke.ts).
    const chords: RawChord[] = raw.map((c) => ({
      ctrl: mac ? !!c.ctrlKey : false, alt: !!c.altKey, shift: !!c.shiftKey, meta: mac ? !!c.metaKey : !!c.ctrlKey, keyCode: c.keyCode,
      key: ourKeyName(KeyCodeUtils.toString(c.keyCode)),
    }));
    out.push({ command: it.command, when: it.when?.serialize?.() ?? null, chords, seq: seqOf(chords) });
  }
  return out;
}

/** Monaco numeric keybinding for a removal rule (macOS: Cmd = KeyMod.CtrlCmd, Ctrl = KeyMod.WinCtrl). */
export function numericKeybinding(chords: RawChord[]): number {
  const one = (c: RawChord) => c.keyCode | (c.meta ? 2048 : 0) | (c.shift ? 1024 : 0) | (c.alt ? 512 : 0) | (c.ctrl ? 256 : 0);
  if (chords.length === 1) return one(chords[0]);
  return (one(chords[0]) | (one(chords[1]) << 16)) >>> 0; // KeyChord(first, second)
}
