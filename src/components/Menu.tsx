import { type CSSProperties, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import Icon from "./Icon";

export interface MenuItem {
  key: string;
  label: string;
  /** Sits in the 16 px icon slot; the slot is always there so labels line up. */
  icon?: ReactNode;
  /** A key hint in the right column, in the Code micro face. */
  shortcut?: string;
  /** Quiet text in the right column, where a shortcut would go. */
  hint?: string;
  /** A second line under the label that says what the action does (a 48 px row). */
  description?: string;
  /** Makes the row a non-interactive group heading showing this text. */
  heading?: string;
  /** The chosen row of a choice menu: the selected-row look, no check mark. */
  current?: boolean;
  /** Makes the row a checkable item (`menuitemcheckbox`) with a check mark in the icon slot when on. */
  checked?: boolean;
  disabled?: boolean;
  /** The row's tooltip, such as why it is off. */
  title?: string;
  danger?: boolean;
  separatorBefore?: boolean;
  /** Opens to the right with the right arrow. */
  submenu?: MenuItem[];
  onSelect?: () => void;
}

interface ListProps {
  items: MenuItem[];
  label: string;
  onClose: () => void;
  style?: CSSProperties;
  className?: string;
  /** 24 px rows instead of 28. */
  compact?: boolean;
  /** Set on a submenu: the left arrow and Escape call it to give focus back to the parent row. */
  onBack?: () => void;
  /** A submenu opened by the pointer leaves focus where it is. */
  focusFirst?: boolean;
}

/** The popover itself, exported for right-click menus placed with `style`. */
export function MenuList({ items, label, onClose, style, className, compact, onBack, focusFirst = true }: ListProps) {
  const list = useRef<HTMLDivElement>(null);
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const [sub, setSub] = useState<{ key: string; focus: boolean } | null>(null);

  const entries = () =>
    Array.from(list.current?.querySelectorAll<HTMLElement>("[role=menuitem]:not(:disabled), [role=menuitemcheckbox]:not(:disabled)") ?? []).filter(
      (el) => el.closest("[role=menu]") === list.current,
    );

  useEffect(() => {
    if (focusFirst) entries()[0]?.focus();
    // Runs once on mount: a list focuses its first row when it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function backFromSub(key: string) {
    setSub(null);
    rows.current.get(key)?.focus();
  }

  function onKey(e: React.KeyboardEvent) {
    const all = entries();
    const at = all.indexOf(document.activeElement as HTMLElement);
    const move = (to: number) => {
      e.preventDefault();
      e.stopPropagation();
      all[(to + all.length) % all.length]?.focus();
    };
    if (e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (onBack) onBack();
      else onClose();
    } else if (e.key === "ArrowDown") move(at + 1);
    else if (e.key === "ArrowUp") move(at < 0 ? -1 : at - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(all.length - 1);
    else if (e.key === "ArrowLeft" && onBack) {
      e.preventDefault();
      e.stopPropagation();
      onBack();
    } else if (e.key === "ArrowRight") {
      const key = [...rows.current].find(([, el]) => el === document.activeElement)?.[0];
      const item = items.find((i) => i.key === key);
      if (item?.submenu && !item.disabled) {
        e.preventDefault();
        e.stopPropagation();
        setSub({ key: item.key, focus: true });
      }
    }
  }

  // A menu with nothing in it would be an empty shadowed box that no outside press or resize can explain.
  if (items.length === 0) return null;
  const classes = ["menu", compact ? "menu-compact" : "", className ?? ""].filter(Boolean).join(" ");
  return (
    <div ref={list} className={classes} role="menu" aria-label={label} style={style} onKeyDown={onKey}>
      {items.map((item) => {
        if (item.heading !== undefined) {
          return (
            <div key={item.key} role="presentation">
              {item.separatorBefore && <hr className="menu-separator" />}
              <div className="menu-heading">{item.heading}</div>
            </div>
          );
        }
        const open = sub?.key === item.key;
        const right = item.submenu ? (
          <span className="menu-right">
            {/* What the submenu has chosen (a colour's name), before its chevron. */}
            {item.hint && <span className="menu-hint">{item.hint}</span>}
            <Icon name="chevronRight" size={14} className="menu-chevron" />
          </span>
        ) : item.shortcut ? (
          <span className="menu-shortcut">{item.shortcut}</span>
        ) : item.hint ? (
          <span className="menu-hint">{item.hint}</span>
        ) : null;
        const cls = [
          "menu-item",
          item.danger ? "menu-item-danger" : "",
          item.current ? "menu-item-current" : "",
          item.description ? "menu-item-described" : "",
        ]
          .filter(Boolean)
          .join(" ");
        return (
          <div key={item.key} role="none" className={item.submenu ? "menu-sub-anchor" : undefined}>
            {item.separatorBefore && <hr className="menu-separator" />}
            <button
              type="button"
              role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
              aria-checked={item.checked}
              ref={(el) => {
                if (el) rows.current.set(item.key, el);
                else rows.current.delete(item.key);
              }}
              aria-label={item.label}
              aria-description={item.description}
              aria-current={item.current ? "true" : undefined}
              aria-haspopup={item.submenu ? "menu" : undefined}
              aria-expanded={item.submenu ? open : undefined}
              disabled={item.disabled}
              title={item.title}
              className={cls}
              onMouseEnter={() => {
                if (item.submenu && !item.disabled) setSub({ key: item.key, focus: false });
                else if (sub) {
                  // A submenu closing under the pointer must not take its focused row with it.
                  setSub(null);
                  if (list.current?.contains(document.activeElement) && document.activeElement !== rows.current.get(item.key))
                    rows.current.get(item.key)?.focus();
                }
              }}
              onClick={() => {
                if (item.submenu) {
                  setSub({ key: item.key, focus: true });
                  return;
                }
                onClose();
                item.onSelect?.();
              }}
            >
              <span className="menu-icon">{item.checked ? <Icon name="check" size={14} /> : item.icon}</span>
              {item.description ? (
                <span className="menu-label">
                  <span className="menu-label-line">{item.label}</span>
                  <span className="menu-description">{item.description}</span>
                </span>
              ) : (
                <span className="menu-label">{item.label}</span>
              )}
              {right}
            </button>
            {open && item.submenu && (
              <MenuList
                items={item.submenu}
                label={item.label}
                onClose={onClose}
                onBack={() => backFromSub(item.key)}
                compact={compact}
                className="menu-sub"
                focusFirst={sub.focus}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

/** A right-click menu at a point (a result tab, a cell, a grid header), kept inside the window. */
/** How long after opening a point menu a scroll is still taken as part of its opening. */
export const SETTLE_MS = 150;

/**
 * `onClose` runs on Esc, Tab or a chosen item (and may give focus back to where the menu came from); `onDismiss` on a
 * press outside or a scroll, which leave focus where the press landed, as native menus do.
 */
export function PointMenu({
  x,
  y,
  items,
  onClose,
  onDismiss,
  label,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
  onDismiss: () => void;
  label: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState({ x, y });
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (!box || box.height === 0) return;
    setAt({ x: Math.max(4, Math.min(x, window.innerWidth - box.width - 4)), y: Math.max(4, Math.min(y, window.innerHeight - box.height - 4)) });
  }, [x, y]);
  // A press outside, or any scroll under the menu (the grid, a pane, the page), closes it: a fixed menu must not float
  // over something else than what it was opened on.
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useEffect(() => {
    const away = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) dismiss.current();
    };
    // A scroll that the opening itself caused (the press that opened it bringing a cell or column into view) arrives
    // a frame later; only scrolls after the menu has settled close it.
    let armed = false;
    const settle = window.setTimeout(() => (armed = true), SETTLE_MS);
    const scrolled = (e: Event) => {
      if (armed) away(e);
    };
    document.addEventListener("mousedown", away);
    window.addEventListener("scroll", scrolled, true);
    return () => {
      window.clearTimeout(settle);
      document.removeEventListener("mousedown", away);
      window.removeEventListener("scroll", scrolled, true);
    };
  }, []);
  return (
    <div ref={ref} className="tree-menu" style={{ left: at.x, top: at.y }}>
      <MenuList items={items} label={label} onClose={onClose} compact />
    </div>
  );
}

interface Props {
  /** Renders the trigger button; spread the given props onto it. */
  trigger: (props: {
    "aria-haspopup": "menu";
    "aria-expanded": boolean;
    onClick: () => void;
    onKeyDown: (e: React.KeyboardEvent) => void;
    ref: React.Ref<HTMLButtonElement>;
  }) => ReactNode;
  items: MenuItem[];
  label: string;
  align?: "start" | "end";
  compact?: boolean;
}

/** A menu button. Arrow keys move between items, Escape closes and returns focus. */
export default function Menu({ trigger, items, label, align = "start", compact }: Props) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  function close() {
    setOpen(false);
    button.current?.focus();
  }

  return (
    <div className="menu-root" ref={root}>
      {trigger({
        "aria-haspopup": "menu",
        "aria-expanded": open,
        onClick: () => setOpen((o) => !o),
        onKeyDown: (e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
          }
        },
        ref: button,
      })}
      {open && <MenuList items={items} label={label} onClose={close} compact={compact} className={align === "end" ? "menu-end" : undefined} />}
    </div>
  );
}
