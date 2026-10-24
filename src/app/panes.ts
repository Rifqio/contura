// Ruling 5 of UX step 3: Tab stays in the grid (Excel), so F6 and Shift+F6 move focus between the window's panes, as
// in Windows apps (File Explorer, Office, Edge). A pane is an element marked `data-pane`; one holding other panes on
// screen gives way to them. Focus goes back to where it last was in a pane, else to its `data-pane-focus` element,
// else to its first control.

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

const shown = (el: Element) => !el.closest("[hidden]") && !el.closest("[inert]");

/** The panes on screen, in page order: those holding no other pane on screen. */
function panes(root: ParentNode): HTMLElement[] {
  const all = Array.from(root.querySelectorAll<HTMLElement>("[data-pane]")).filter(shown);
  return all.filter((p) => !all.some((q) => q !== p && p.contains(q)));
}

const last = new WeakMap<HTMLElement, HTMLElement>();

/** Keeps, for each pane, the element focus was last in, so F6 returns there. */
export function rememberPaneFocus(doc: Document): () => void {
  const onFocus = (e: FocusEvent) => {
    const el = e.target as HTMLElement | null;
    const pane = el?.closest?.<HTMLElement>("[data-pane]");
    if (el && pane && el !== pane) last.set(pane, el);
  };
  doc.addEventListener("focusin", onFocus);
  return () => doc.removeEventListener("focusin", onFocus);
}

function focusIn(pane: HTMLElement) {
  const before = last.get(pane);
  const target =
    (before && before.isConnected && pane.contains(before) && shown(before) ? before : null) ??
    Array.from(pane.querySelectorAll<HTMLElement>("[data-pane-focus]")).find(shown) ??
    Array.from(pane.querySelectorAll<HTMLElement>(FOCUSABLE)).find(shown) ??
    null;
  if (target) return target.focus();
  if (!pane.hasAttribute("tabindex")) pane.tabIndex = -1;
  pane.focus();
}

/** Moves focus to the next pane (`1`) or the previous one (`-1`), wrapping; false when there is none. */
export function cyclePane(dir: 1 | -1, root: ParentNode = document): boolean {
  const list = panes(root);
  if (list.length === 0) return false;
  const active = document.activeElement;
  const at = list.findIndex((p) => active && p.contains(active));
  const next = at < 0 ? (dir === 1 ? 0 : list.length - 1) : (at + dir + list.length) % list.length;
  focusIn(list[next]);
  return true;
}
