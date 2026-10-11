import { openUrl } from "@tauri-apps/plugin-opener";

/** Open an http(s)/mailto URL in the system browser (never inside the webview). Resolves true if the scheme is allowed. */
export async function openExternal(url: string): Promise<boolean> {
  if (!/^(https?:|mailto:)/i.test(url)) return false;
  const qa = (window as unknown as { __qaExternal?: string[] }).__qaExternal; // automation: record instead of launching a browser
  if (qa) { qa.push(url); return true; }
  await openUrl(url).catch(() => {});
  return true;
}
