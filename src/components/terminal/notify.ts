/** Desktop notifications from OSC 9 / OSC 777, only while Atelier is not the focused app. */
export interface QaHooks { notify?: (title: string, body: string) => boolean | void; openUrl?: (uri: string) => void }
export const qaHooks: QaHooks = {};

/** Returns true when a notification was (or, under test, would have been) shown. */
export async function desktopNotify(title: string, body: string): Promise<boolean> {
  if (document.hasFocus()) return false;
  if (qaHooks.notify) {
    if (qaHooks.notify(title, body) !== false) return true; // tests record and suppress the real thing
  }
  try {
    const n = await import("@tauri-apps/plugin-notification");
    let ok = await n.isPermissionGranted();
    if (!ok) ok = (await n.requestPermission()) === "granted";
    if (ok) n.sendNotification({ title, body });
    return ok;
  } catch {
    return false;
  }
}
