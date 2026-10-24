/**
 * The WebView's own right-click menu (Back, Forward, Reload; Refresh and Print in WebView2) is never shown: Reload
 * restarts the whole app and drops unsaved work. Where Contura has a menu, its handler opens it and prevents the
 * default first; everywhere else the guard prevents it. Text fields keep the WebView menu for Cut, Copy and Paste.
 */

/** A place where the WebView's Cut, Copy and Paste menu is wanted: a field you can type in, or a code editor. */
function typable(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest(".cm-content")) return true;
  const field = target.closest("input, textarea, [contenteditable]");
  if (!field) return false;
  if (field instanceof HTMLTextAreaElement) return !field.readOnly && !field.disabled;
  if (field instanceof HTMLInputElement) {
    const texty = ["text", "search", "url", "email", "tel", "password", "number", ""].includes(field.type);
    return texty && !field.readOnly && !field.disabled;
  }
  return field.getAttribute("contenteditable") !== "false";
}

/** Installs the guard on `doc`; returns the function that removes it. */
export function installContextMenuGuard(doc: Document = document): () => void {
  const onContextMenu = (e: MouseEvent) => {
    if (!e.defaultPrevented && !typable(e.target)) e.preventDefault();
  };
  // Bubble phase on the document: Contura's own menus (React handlers on the root) run first.
  doc.addEventListener("contextmenu", onContextMenu);
  return () => doc.removeEventListener("contextmenu", onContextMenu);
}
