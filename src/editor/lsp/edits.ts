/** WorkspaceEdit application: open models via Monaco, other files via fs read/write. Lazy (imports monaco). */
import { monaco } from "../monacoSetup";
import { fs, local } from "../../lib/ipc";
import { uriToPath } from "./state";
import type { Json, Rng } from "./client";

interface TextEdit { range: Rng; newText: string }

export function applyTextEdits(text: string, edits: TextEdit[]): string {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  const off = (p: { line: number; character: number }) => Math.min((starts[p.line] ?? text.length) + p.character, text.length);
  const sorted = edits.map((e) => ({ s: off(e.range.start), e: off(e.range.end), t: e.newText })).sort((a, b) => b.s - a.s || b.e - a.e);
  let out = text;
  for (const e of sorted) out = out.slice(0, e.s) + e.t + out.slice(e.e);
  return out;
}

export async function applyWorkspaceEdit(edit: Json): Promise<void> {
  const byPath = new Map<string, TextEdit[]>();
  const add = (uri: string, es: TextEdit[]) => {
    const p = uriToPath(uri);
    byPath.set(p, [...(byPath.get(p) ?? []), ...es]);
  };
  if (edit.documentChanges) {
    for (const dc of edit.documentChanges) if (dc.textDocument) add(dc.textDocument.uri, dc.edits);
  } else if (edit.changes) {
    for (const [uri, es] of Object.entries<TextEdit[]>(edit.changes)) add(uri, es);
  }
  for (const [path, edits] of byPath) {
    const model = monaco.editor.getModel(monaco.Uri.file(path));
    if (model) {
      model.pushStackElement();
      model.pushEditOperations([], edits.map((e) => ({
        range: new monaco.Range(e.range.start.line + 1, e.range.start.character + 1, e.range.end.line + 1, e.range.end.character + 1),
        text: e.newText,
      })), () => null);
      model.pushStackElement();
    } else {
      const text = await fs.readFile(local(path));
      await fs.writeFile(local(path), applyTextEdits(text, edits));
    }
  }
}
