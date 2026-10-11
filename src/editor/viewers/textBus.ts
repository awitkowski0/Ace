/** Live text of Monaco-backed docs for rendered views (Markdown preview, CSV table, SVG). EditorArea feeds `emitText`. */
import { useEffect, useState } from "react";
import { editorStore } from "../store";

const subs = new Map<string, Set<() => void>>();
export const emitText = (key: string) => subs.get(key)?.forEach((f) => f());
export const subscribeText = (key: string, f: () => void) => {
  let s = subs.get(key);
  if (!s) subs.set(key, (s = new Set()));
  s.add(f);
  return () => s!.delete(f);
};

let getModelText: (key: string) => string | undefined = () => undefined;
export const installTextGetter = (f: typeof getModelText) => (getModelText = f);

/** Current text of a doc: the live Monaco model if mounted, else the last loaded/saved text. Debounced. */
export function useDocText(key: string, debounceMs = 120): string {
  const read = () => getModelText(key) ?? editorStore.get().docs[key]?.saved ?? "";
  const [text, setText] = useState(read);
  useEffect(() => {
    setText(read());
    let t: number | undefined;
    const un = subscribeText(key, () => {
      clearTimeout(t);
      t = window.setTimeout(() => setText(read()), debounceMs);
    });
    return () => { un(); clearTimeout(t); };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  // external reload replaces `saved`
  const saved = editorStore.get().docs[key]?.saved;
  useEffect(() => { setText(read()); }, [saved]); // eslint-disable-line react-hooks/exhaustive-deps
  return text;
}
