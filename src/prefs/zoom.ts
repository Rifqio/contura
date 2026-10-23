import { setInterfaceSize } from "../api/client";

/**
 * Asks the Core to apply an interface size: it zooms the whole webview, so text and controls grow and the CSS
 * viewport shrinks with them, and raises the window's minimum so the page never gets under 1024 x 480 CSS pixels,
 * growing the window first when it is smaller than that. The Core applies the saved size when it builds the window,
 * before the first paint; this follows later changes. Outside Tauri (tests, a plain browser) it does nothing.
 */
export function applyInterfaceSize(size: number): void {
  try {
    setInterfaceSize(size).catch(() => {
      // The window keeps its zoom; the next start applies the saved size.
    });
  } catch {
    // Not in a Tauri window.
  }
}
