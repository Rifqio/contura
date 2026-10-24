/**
 * G1: puts text on the system clipboard. The app has no Tauri clipboard plugin, so this is the WebView's clipboard,
 * as every other copy in Contura uses. False when it refuses.
 */
export function writeClipboard(text: string): Promise<boolean> {
  if (!navigator.clipboard) return Promise.resolve(false);
  return navigator.clipboard.writeText(text).then(
    () => true,
    () => false,
  );
}

/** The clipboard's text for the menu's Paste; null when the WebView refuses or has none. */
export async function readClipboard(): Promise<string | null> {
  try {
    return (await navigator.clipboard?.readText()) ?? null;
  } catch {
    return null;
  }
}
