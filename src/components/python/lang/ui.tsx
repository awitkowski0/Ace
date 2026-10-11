import { useStore } from "../../../lib/store";
import { clearNote, noteStore } from "./note";

/** Transient message of the Python language tools (failed Reformat Code / Optimize Imports). */
export function LangNoteWidget() {
  const { text } = useStore(noteStore);
  if (!text) return null;
  return <span className="sb-item sb-lsp warn" data-testid="py-lang-note" title="Click to dismiss" onClick={clearNote}>{text}</span>;
}
