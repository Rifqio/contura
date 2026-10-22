/**
 * P11-37: no tooltip outlives its trigger. The WebView keeps a native `title` tooltip (and the feature bar's CSS
 * tooltip keeps `:hover`) after a click that opens something else, a scroll, or the window losing focus. The guard
 * takes the hover text off the control under the pointer at those moments and gives it back once the pointer leaves.
 */

/** The control a tooltip belongs to: one with a `title`, a held one, or a feature button's `data-tip`. */
const TIPPED = "[title], [data-title-held], [data-tip]";

/** Installs the guard on `doc` and `win`; returns the function that removes it and puts every title back. */
export function installTooltipGuard(doc: Document = document, win: Window = window): () => void {
  /** The control under the pointer that has a tooltip. */
  let hovered: HTMLElement | null = null;
  const held = new Set<HTMLElement>();

  const tipped = (target: EventTarget | null): HTMLElement | null =>
    target instanceof Element ? (target.closest(TIPPED) as HTMLElement | null) : null;

  const hide = (el: HTMLElement | null) => {
    if (!el) return;
    const title = el.getAttribute("title");
    if (title !== null) {
      el.setAttribute("data-title-held", title);
      el.removeAttribute("title");
    }
    el.setAttribute("data-tip-off", "");
    held.add(el);
  };

  const restore = (el: HTMLElement) => {
    const title = el.getAttribute("data-title-held");
    el.removeAttribute("data-title-held");
    // React may have set a new title meanwhile; that one wins.
    if (title !== null && !el.hasAttribute("title")) el.setAttribute("title", title);
    el.removeAttribute("data-tip-off");
    held.delete(el);
  };

  const leave = () => {
    for (const el of [...held]) if (el !== hovered) restore(el);
  };

  const onOver = (e: Event) => {
    const next = tipped(e.target);
    if (next === hovered) return;
    hovered = next;
    leave();
  };
  const onOut = (e: Event) => {
    // Out of the window: nothing is hovered any more.
    if ((e as PointerEvent).relatedTarget === null) {
      hovered = null;
      leave();
    }
  };
  const onDown = (e: Event) => hide(tipped(e.target));
  /**
   * Only a scroll that moves the hovered control counts: the box scrolled holds it. A box scrolled on its own beside it
   * (the assistant's thread following a streamed answer under the Stop button) leaves its hover text alone. A control
   * already held is not written again, so a stream of scroll events writes nothing.
   */
  const onScroll = (e: Event) => {
    if (!hovered || held.has(hovered)) return;
    const t = e.target;
    const box = t instanceof Document ? t.documentElement : t instanceof Element ? t : null;
    if (box?.contains(hovered)) hide(hovered);
  };
  const onBlur = () => hide(hovered);

  doc.addEventListener("pointerover", onOver, true);
  doc.addEventListener("pointerout", onOut, true);
  doc.addEventListener("pointerdown", onDown, true);
  doc.addEventListener("scroll", onScroll, true);
  win.addEventListener("blur", onBlur);
  return () => {
    doc.removeEventListener("pointerover", onOver, true);
    doc.removeEventListener("pointerout", onOut, true);
    doc.removeEventListener("pointerdown", onDown, true);
    doc.removeEventListener("scroll", onScroll, true);
    win.removeEventListener("blur", onBlur);
    hovered = null;
    for (const el of [...held]) restore(el);
  };
}
