/**
 * Animation Studio actions (docs/ANIMSTUDIO.md, docs/STUDIO-KEYMAP.md). Keys come from the data table in ui/keymap.ts and the
 * handlers live in ui/tools/actions.ts. All are `context: "editor"` and only enabled while a Studio pane owns DOM focus (and
 * focus is not in a text field), so Monaco keeps ⌘Z / ⌘D / ⌫ / letters in text mode and Ace's IntelliJ keys are untouched
 * outside the Studio. Imported eagerly from src/modules.ts: no Monaco / three here.
 */
import { suppressEditorWhen } from "../../editor/editorRegistry";
import { focusedStudio } from "./ui/studios";
import { registerStudioActions } from "./ui/tools/actions";

// the hidden Monaco editor of a Studio tab must not receive editor actions (⌘D duplicate line ...) while the Studio has focus
suppressEditorWhen(() => !!focusedStudio({ allowInputs: true }));

registerStudioActions();
