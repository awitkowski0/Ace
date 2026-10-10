import { openUrl } from "@tauri-apps/plugin-opener";

/** Open an http(s)/mailto URL in the system browser (never inside the webview). Resolves true if the scheme is allowed. */
export async function openExternal(url: string): Promise<boolean> {
  if (!/^(https?:|mailto:)/i.test(url)) return false;
  await openUrl(url).catch(() => {});
  return true;
}
