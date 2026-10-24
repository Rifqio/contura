import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import Icon, { type IconName } from "./Icon";

interface Props {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /**
   * DN 10.12 widths: confirm 420, form 560 (the default), model 640, wide 760 for previews and
   * long values, large 860 for the export and Mermaid dialogs.
   */
  size?: "confirm" | "form" | "model" | "wide" | "large";
  /** The same as `size="wide"`. */
  wide?: boolean;
  /** An extra class on the panel, for a dialog with its own width. */
  className?: string;
  /** Shown after the title, before the close button, such as a Production tag. */
  badge?: ReactNode;
  /** Shown before the title, such as the database mark. */
  lead?: ReactNode;
  /** An icon before the title, after `lead`. */
  icon?: IconName;
  /** Subtle text after the title. */
  subtitle?: ReactNode;
  /**
   * A form with changes: a click outside does nothing, and Escape or the close button ask
   * "Discard your changes?" first. Leave it off for dialogs with nothing to lose.
   */
  dirty?: boolean;
}

/** A modal dialog: Escape closes it, focus moves in on open and back on close, Tab stays inside. */
export default function Dialog({ title, onClose, children, size = "form", wide, className, badge, lead, icon, subtitle, dirty = false }: Props) {
  const width = `dialog-size-${wide ? "wide" : size}`;
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);

  // Read while rendering, before any child with autoFocus takes focus on commit: an effect
  // would see that child as the opener and leave focus on <body> after closing.
  const [previous] = useState(() => document.activeElement as HTMLElement | null);
  useEffect(() => {
    const first = panel.current?.querySelector<HTMLElement>("input, select, textarea, [data-autofocus]");
    (first ?? panel.current)?.focus();
    return () => previous?.focus?.();
  }, [previous]);

  // On the document, so Escape works even when focus has fallen to <body>.
  const [asking, setAsking] = useState(false);
  const returnTo = useRef<HTMLElement | null>(null);
  const wasAsking = useRef(false);
  /** Opens the discard question, remembering the field to give focus back to. */
  const ask = useRef(() => {
    const at = document.activeElement as HTMLElement | null;
    returnTo.current = at && panel.current?.contains(at) ? at : null;
    setAsking(true);
  });
  const close = useRef(onClose);
  close.current = onClose;
  const state = useRef({ dirty, asking });
  state.current = { dirty, asking };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) {
        e.preventDefault();
        if (state.current.asking) setAsking(false);
        else if (state.current.dirty) ask.current();
        else close.current();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  const asked = asking && dirty;
  const requestClose = () => (dirty ? ask.current() : onClose());
  // A question left open when the form turns clean must not come back with the next change.
  useEffect(() => {
    if (!dirty) setAsking(false);
  }, [dirty]);
  // The bar's buttons leave with it: focus goes back to the field that had it, so the Tab trap holds.
  useEffect(() => {
    if (wasAsking.current && !asked) (returnTo.current ?? panel.current)?.focus();
    wasAsking.current = asked;
  }, [asked]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key !== "Tab" || !panel.current) return;
    // Filter in tree order: some DOM engines return a selector list grouped by selector.
    const focusable = Array.from(panel.current.querySelectorAll<HTMLElement>("*")).filter((el) =>
      el.matches("button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea, [tabindex='0']"),
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const atStart = document.activeElement === first || document.activeElement === panel.current;
    if (e.shiftKey && atStart) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  return createPortal(
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && !dirty && onClose()}>
      <div
        ref={panel}
        className={["dialog", width, className].filter(Boolean).join(" ")}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <header className="dialog-header">
          {lead}
          {icon && <Icon name={icon} className="dialog-icon" />}
          <h2 id={titleId}>{title}</h2>
          {subtitle && <span className="dialog-subtitle">{subtitle}</span>}
          {badge}
          <button type="button" className="icon-button dialog-close" aria-label="Close" onClick={requestClose}>
            <Icon name="close" />
          </button>
        </header>
        {children}
        {asked && (
          <div className="dialog-discard" role="alert">
            <span>Discard your changes?</span>
            <span className="spacer" />
            <button type="button" className="button" data-autofocus autoFocus onClick={() => setAsking(false)}>
              Keep editing
            </button>
            <button type="button" className="button" onClick={onClose}>
              Discard
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
