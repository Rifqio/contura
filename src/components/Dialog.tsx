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
}

/** A modal dialog: Escape closes it, focus moves in on open and back on close, Tab stays inside. */
export default function Dialog({ title, onClose, children, size = "form", wide, className, badge, lead, icon, subtitle }: Props) {
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
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) {
        e.preventDefault();
        close.current();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

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
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
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
          <button type="button" className="icon-button dialog-close" aria-label="Close" onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>
        {children}
      </div>
    </div>,
    document.body,
  );
}
