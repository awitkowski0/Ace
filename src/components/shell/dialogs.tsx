import { useEffect, useRef, useState } from "react";
import { createStore, useStore } from "../../lib/store";
import { focusEditor } from "../../editor/editorRegistry";

type Dlg =
  | { kind: "prompt"; title: string; initial: string; okLabel: string; resolve: (v: string | null) => void }
  | { kind: "confirm"; title: string; message: string; okLabel: string; resolve: (v: boolean) => void }
  | { kind: "choice"; title: string; message: string; buttons: ChoiceButton[]; checkbox?: string; resolve: (v: ChoiceResult) => void };

export interface ChoiceButton { label: string; value: string | null; primary?: boolean }
export interface ChoiceResult { value: string | null; checked: boolean }
const dlgStore = createStore<{ dlg: Dlg | null }>({ dlg: null });

export const promptDialog = (o: { title: string; initial?: string; okLabel?: string }) =>
  new Promise<string | null>((resolve) =>
    dlgStore.set({ dlg: { kind: "prompt", title: o.title, initial: o.initial ?? "", okLabel: o.okLabel ?? "OK", resolve } }),
  );
export const confirmDialog = (o: { title: string; message: string; okLabel?: string }) =>
  new Promise<boolean>((resolve) =>
    dlgStore.set({ dlg: { kind: "confirm", title: o.title, message: o.message, okLabel: o.okLabel ?? "OK", resolve } }),
  );

/** Multi-button dialog (IntelliJ "Open Project: This Window / New Window / Cancel", "Save / Don't Save / Cancel").
 * Esc = the button whose value is null (Cancel); Enter = the primary button. Optional "remember" checkbox. */
export const choiceDialog = (o: { title: string; message: string; buttons: ChoiceButton[]; checkbox?: string }) =>
  new Promise<ChoiceResult>((resolve) => dlgStore.set({ dlg: { kind: "choice", ...o, resolve } }));

export function DialogHost() {
  const { dlg } = useStore(dlgStore);
  const [val, setVal] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (dlg?.kind === "prompt") {
      setVal(dlg.initial);
      setTimeout(() => {
        input.current?.focus();
        const dot = dlg.initial.lastIndexOf(".");
        input.current?.setSelectionRange(0, dot > 0 ? dot : dlg.initial.length);
      }, 0);
    }
  }, [dlg]);
  const [checked, setChecked] = useState(false);
  useEffect(() => setChecked(false), [dlg]);
  if (!dlg) return null;
  const finishChoice = (value: string | null) => {
    if (dlg.kind !== "choice") return;
    dlgStore.set({ dlg: null });
    dlg.resolve({ value, checked });
    setTimeout(focusEditor, 0);
  };
  const close = (ok: boolean) => {
    if (dlg.kind === "choice") return finishChoice(ok ? dlg.buttons.find((b) => b.primary)?.value ?? null : null);
    dlgStore.set({ dlg: null });
    if (dlg.kind === "prompt") dlg.resolve(ok ? val : null);
    else dlg.resolve(ok);
    setTimeout(focusEditor, 0);
  };
  return (
    <div className="dialog-backdrop" onMouseDown={() => close(false)}>
      <div
        className="dialog"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") close(false);
          if (e.key === "Enter" && dlg.kind !== "choice") close(true);
        }}
      >
        <div className="dialog-title">{dlg.title}</div>
        {dlg.kind === "prompt" ? (
          <input ref={input} className="dialog-input" value={val} onChange={(e) => setVal(e.target.value)} spellCheck={false} />
        ) : (
          <div className="dialog-msg">{dlg.message}</div>
        )}
        {dlg.kind === "choice" && dlg.checkbox && (
          <label className="dialog-check"><input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} /> {dlg.checkbox}</label>
        )}
        {dlg.kind === "choice" ? (
          <div className="dialog-buttons">
            {dlg.buttons.map((b) => (
              <button key={b.label} className={b.primary ? "primary" : undefined} autoFocus={b.primary} onClick={() => finishChoice(b.value)}>{b.label}</button>
            ))}
          </div>
        ) : (
          <div className="dialog-buttons">
            <button onClick={() => close(false)}>Cancel</button>
            <button className="primary" autoFocus={dlg.kind === "confirm"} onClick={() => close(true)}>{dlg.okLabel}</button>
          </div>
        )}
      </div>
    </div>
  );
}
