import { invoke } from "../../lib/ipc";

/** System clipboard via Rust (NSPasteboard): the webview refuses writes that are not tied to a user gesture (OSC 52). */
export async function clipboardWrite(text: string): Promise<void> {
  try {
    await invoke("clipboard_write", { text });
  } catch {
    await navigator.clipboard?.writeText(text).catch(() => {});
  }
}
export const clipboardRead = (): Promise<string> => invoke<string>("clipboard_read").catch(() => navigator.clipboard?.readText().catch(() => "") ?? "");

export function utf8ToBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
export function base64ToUtf8(b64: string): string {
  const bin = atob(b64.replace(/\s+/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** Ghostty's clipboard-paste-protection: text that could run commands the user did not see. */
export function isUnsafePaste(text: string, bracketed: boolean): boolean {
  if (text.includes("\x1b[201~")) return true;
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) return true;
  return !bracketed && /[\r\n]/.test(text.replace(/[\r\n]+$/, ""));
}
