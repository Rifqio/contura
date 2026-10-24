/**
 * The one tooltip. The WebView's own `title` tooltip is drawn by the system: it hangs over the right-click menu a tab
 * opens, it is cut at the window's edge, and it stays after a click that opens something else. So a control's `title`
 * is taken off the control while the pointer is on it and drawn here, after the usual short delay, inside the window.
 * It is hidden by a button press, a context menu, a key, a scroll or the window losing focus, and the `title` comes
 * back once the pointer leaves. The feature bar's CSS tooltip (`data-tip`) keeps `:hover`, so those are held off the
 * same way.
 */

/** The control a tooltip belongs to: one with a `title`, a held one, or a feature button's `data-tip`. */
const TIPPED = "[title], [data-title-held], [data-tip]";

/** The wait before a tooltip shows, as on Windows; moving to a neighbour right after one shows at once. */
const DELAY = 500;
const NEIGHBOUR = 300;
/** The room left between a tooltip and the window's edge. */
const MARGIN = 4;
const GAP = 6;

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Where a tooltip of `tip` size goes: centred under `anchor`, above it when there is no room below, and pushed back
 * inside the `vw` x `vh` window on every side.
 */
export function placeTip(anchor: Box, tip: { width: number; height: number }, vw: number, vh: number): { left: number; top: number } {
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, Math.max(lo, hi)));
  const left = clamp(anchor.left + anchor.width / 2 - tip.width / 2, MARGIN, vw - tip.width - MARGIN);
  const below = anchor.top + anchor.height + GAP;
  const above = anchor.top - GAP - tip.height;
  const top = below + tip.height + MARGIN <= vh || above < MARGIN ? below : above;
  return { left, top: clamp(top, MARGIN, vh - tip.height - MARGIN) };
}

/** Installs the tooltip on `doc` and `win`; returns the function that removes it and puts every title back. */
export function installTooltipGuard(doc: Document = document, win: Window = window): () => void {
  /** The control under the pointer that has a tooltip. */
  let hovered: HTMLElement | null = null;
  /** The control whose tooltip a press, menu, key or scroll put away until the pointer leaves it. */
  let off: HTMLElement | null = null;
  const held = new Set<HTMLElement>();
  let tip: HTMLElement | null = null;
  let timer: number | undefined;
  let lastShown = -Infinity;
  /**
   * A mouse button is down (a press, a drag of a column header or a selection): no tooltip shows until it is up, and a
   * control first reached while it was down stays without one until the pointer moves after the release.
   */
  let pressed = false;
  let passedWhilePressed = new Set<HTMLElement>();
  let releasedAt: { x: number; y: number } | null = null;

  const tipped = (target: EventTarget | null): HTMLElement | null =>
    target instanceof Element ? (target.closest(TIPPED) as HTMLElement | null) : null;

  /** The `title` leaves the control so the system draws nothing; its text waits in `data-title-held`. */
  const take = (el: HTMLElement) => {
    const title = el.getAttribute("title");
    if (title !== null) {
      el.setAttribute("data-title-held", title);
      el.removeAttribute("title");
      // An icon-only control took its name from the title: it keeps it while the title is away.
      if (!el.hasAttribute("aria-label") && !el.hasAttribute("aria-labelledby") && !el.textContent?.trim()) {
        el.setAttribute("aria-label", title);
        el.setAttribute("data-label-held", "");
      }
    }
    held.add(el);
    watch();
  };

  /** A title React writes while the control is held is taken at once, so the system tooltip never draws. */
  const mo = new MutationObserver((records) => {
    for (const r of records) {
      const el = r.target as HTMLElement;
      if (!held.has(el) || !el.hasAttribute("title")) continue;
      take(el);
      const text = el.getAttribute("data-title-held");
      if (tip && el === hovered && text) tip.textContent = text;
    }
  });
  const watch = () => {
    mo.disconnect();
    for (const el of held) mo.observe(el, { attributes: true, attributeFilter: ["title"] });
  };

  /** The tooltip is the control's description for as long as it shows. */
  let described: { el: HTMLElement; prior: string | null } | null = null;
  const clearTip = () => {
    win.clearTimeout(timer);
    timer = undefined;
    if (described) {
      if (described.prior === null) described.el.removeAttribute("aria-describedby");
      else described.el.setAttribute("aria-describedby", described.prior);
      described = null;
    }
    if (tip) {
      tip.remove();
      tip = null;
      // A neighbour's tooltip is quick for a moment after this one was last on screen.
      lastShown = Date.now();
    }
  };

  const show = (el: HTMLElement) => {
    timer = undefined;
    // React may have written a new title since the pointer arrived; that is the text to show.
    take(el);
    const text = el.getAttribute("data-title-held");
    if (!text || !el.isConnected || off === el) return;
    const node = doc.createElement("div");
    node.className = "app-tip";
    node.id = "app-tip";
    node.setAttribute("role", "tooltip");
    node.textContent = text;
    doc.body.append(node);
    const a = el.getBoundingClientRect();
    const t = node.getBoundingClientRect();
    const at = placeTip({ left: a.left, top: a.top, width: a.width, height: a.height }, t, doc.documentElement.clientWidth || win.innerWidth, doc.documentElement.clientHeight || win.innerHeight);
    node.style.left = `${Math.round(at.left)}px`;
    node.style.top = `${Math.round(at.top)}px`;
    tip = node;
    const prior = el.getAttribute("aria-describedby");
    described = { el, prior };
    el.setAttribute("aria-describedby", prior ? `${prior} ${node.id}` : node.id);
  };

  const hide = (el: HTMLElement | null) => {
    if (!el) return;
    take(el);
    if (el === hovered) {
      clearTip();
      off = el;
    }
    // A feature button's CSS tooltip is held off by the attribute.
    if (el.hasAttribute("data-tip") && !el.hasAttribute("data-tip-off")) el.setAttribute("data-tip-off", "");
  };

  const restore = (el: HTMLElement) => {
    const title = el.getAttribute("data-title-held");
    el.removeAttribute("data-title-held");
    // React may have set a new title meanwhile; that one wins.
    if (title !== null && !el.hasAttribute("title")) el.setAttribute("title", title);
    el.removeAttribute("data-tip-off");
    if (el.hasAttribute("data-label-held")) {
      el.removeAttribute("data-label-held");
      el.removeAttribute("aria-label");
    }
    held.delete(el);
    watch();
    mo.takeRecords();
  };

  const leave = () => {
    clearTip();
    for (const el of [...held]) if (el !== hovered) restore(el);
    if (off !== hovered) off = null;
  };

  const onOver = (e: Event) => {
    const next = tipped(e.target);
    if (next === hovered) return;
    hovered = next;
    leave();
    if (!next) return;
    take(next);
    if (pressed) {
      // Passed over while the button is down (a dragged column header over the others): held off.
      hide(next);
      passedWhilePressed.add(next);
      return;
    }
    if (next.hasAttribute("data-tip")) return;
    const quick = Date.now() - lastShown < NEIGHBOUR;
    timer = win.setTimeout(() => show(next), quick ? 0 : DELAY);
  };
  const onOut = (e: Event) => {
    // Out of the window: nothing is hovered any more.
    if ((e as PointerEvent).relatedTarget === null) {
      hovered = null;
      off = null;
      leave();
    }
  };
  const putAway = () => hide(hovered);
  /** A control that went away (a toast timing out) takes its tooltip with it. */
  const onMove = (e: Event) => {
    const m = e as PointerEvent;
    // The first real move after a release ends the hold on what the press passed over: its tooltip may show again.
    if (releasedAt && (m.clientX !== releasedAt.x || m.clientY !== releasedAt.y)) {
      releasedAt = null;
      const back = passedWhilePressed;
      passedWhilePressed = new Set();
      if (hovered && back.has(hovered) && off === hovered) {
        off = null;
        hovered.removeAttribute("data-tip-off");
        const el = hovered;
        if (!el.hasAttribute("data-tip")) timer = win.setTimeout(() => show(el), DELAY);
      }
    }
    if (tip && hovered && !hovered.isConnected) {
      hovered = null;
      off = null;
      leave();
    }
  };
  const onDown = (e: Event) => {
    if ((e as MouseEvent).button === 0) {
      pressed = true;
      releasedAt = null;
    }
    hide(tipped(e.target));
  };
  const onUp = (e: Event) => {
    if (!pressed) return;
    pressed = false;
    const m = e as MouseEvent;
    releasedAt = { x: m.clientX, y: m.clientY };
  };
  /**
   * Only a scroll that moves the hovered control counts: the box scrolled holds it. A box scrolled on its own beside it
   * (the assistant's thread following a streamed answer under the Stop button) leaves its tooltip alone. A control
   * already put away is not written again, so a stream of scroll events writes nothing.
   */
  const onScroll = (e: Event) => {
    if (!hovered || off === hovered) return;
    const t = e.target;
    const box = t instanceof Document ? t.documentElement : t instanceof Element ? t : null;
    if (box?.contains(hovered)) hide(hovered);
  };

  const opts = true;
  const listeners: [EventTarget, string, EventListener][] = [
    [doc, "pointerover", onOver],
    [doc, "pointerout", onOut],
    [doc, "pointermove", onMove],
    [doc, "pointerdown", onDown],
    [doc, "mousedown", onDown],
    [win, "pointerup", onUp],
    [win, "mouseup", onUp],
    [doc, "contextmenu", putAway],
    [doc, "keydown", putAway],
    [doc, "scroll", onScroll],
  ];
  for (const [target, name, fn] of listeners) target.addEventListener(name, fn, opts);
  win.addEventListener("blur", putAway);
  // A release the window never saw (focus moved away mid-press) must not hold tooltips off for good.
  const unpress = () => (pressed = false);
  win.addEventListener("blur", unpress);
  return () => {
    win.removeEventListener("blur", unpress);
    for (const [target, name, fn] of listeners) target.removeEventListener(name, fn, opts);
    win.removeEventListener("blur", putAway);
    clearTip();
    hovered = null;
    off = null;
    for (const el of [...held]) restore(el);
    mo.disconnect();
  };
}
