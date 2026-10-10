import { openUrl } from "@tauri-apps/plugin-opener";

/** Open an http(s)/mailto URL in the system browser (never inside the webview). */
export function openExternal(url: string): Promise<void> {
  if (!/^(https?:|mailto:)/i.test(url)) return Promise.resolve();
  return openUrl(url).catch(() => {});
}
