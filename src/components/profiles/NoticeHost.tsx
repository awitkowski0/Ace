import { useStore } from "../../lib/store";
import { noticeStore } from "./notice";

/** Bottom-right notifications: transient toasts and one balloon with buttons (IntelliJ notification style). */
export function NoticeHost() {
  const { toasts, balloon } = useStore(noticeStore);
  if (!toasts.length && !balloon) return null;
  return (
    <div className="ap-notices" data-testid="notices">
      {balloon && (
        <div className={"ap-balloon " + (balloon.kind ?? "info")} data-testid="balloon" data-id={balloon.id}>
          <div className="ap-balloon-text">{balloon.text}</div>
          <div className="ap-balloon-actions">
            {balloon.actions.map((a) => <button key={a.label} className={a.primary ? "link primary" : "link"} onClick={() => void a.run()}>{a.label}</button>)}
          </div>
        </div>
      )}
      {toasts.map((t) => <div key={t.id} className={"ap-toast " + t.kind} data-testid="toast">{t.text}</div>)}
    </div>
  );
}
