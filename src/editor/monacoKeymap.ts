/**
 * Applies src/keymap/monacoPolicy.ts to the live Monaco instance: every default binding that IntelliJ binds to something
 * else (or nothing) is removed via a "-command" keybinding rule; the surviving strokes are published to the dispatcher so
 * it never swallows keys Monaco still owns (native copy/paste, caret movement, widget keys).
 */
import type * as Monaco from "monaco-editor";
import keymap from "../keymap/intellij-macos.json";
import { audit, EXTERNAL_IMPLEMENTED, isRemoved, keptStrokes, type Decision } from "../keymap/monacoPolicy";
import { numericKeybinding, readMonacoDefaults } from "../keymap/monacoDefaults";
import { IMPLEMENTED_IDS } from "./editorActionDefs";
import { monacoKept } from "../actions/keymap";

export let monacoDecisions: Decision[] = [];

export async function applyMonacoKeymapPolicy(monaco: typeof Monaco) {
  const defaults = await readMonacoDefaults();
  monacoDecisions = audit(defaults, keymap, new Set([...IMPLEMENTED_IDS, ...EXTERNAL_IMPLEMENTED]));
  monaco.editor.addKeybindingRules(
    monacoDecisions.filter(isRemoved).map((d) => ({ keybinding: numericKeybinding(d.binding.chords), command: `-${d.binding.command}` })),
  );
  monacoKept.clear();
  keptStrokes(monacoDecisions).forEach((s) => monacoKept.add(s));
}
