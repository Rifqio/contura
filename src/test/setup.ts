import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// jsdom has no CSS.escape; the WebView does. Control characters become hex escapes, other non-word characters a
// backslash, as the spec does (leading digits are not needed for attribute values).
if (typeof globalThis.CSS === "undefined" || typeof globalThis.CSS.escape !== "function") {
  const escape = (value: string) =>
    String(value).replace(/[\0-\x1f\x7f]|[^\w\u0080-￿-]/g, (ch) => (ch <= "\x1f" || ch === "\x7f" ? `\\${ch.charCodeAt(0).toString(16)} ` : `\\${ch}`));
  globalThis.CSS = { ...(globalThis.CSS ?? {}), escape } as typeof CSS;
}
