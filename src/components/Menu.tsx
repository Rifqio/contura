import { useEffect, useRef, useState, type ReactNode } from "react";

export interface MenuItem {
  key: string;
  label: string;
  content?: ReactNode;
  danger?: boolean;
  separatorBefore?: boolean;
  onSelect: () => void;
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
}

/** A menu button. Arrow keys move between items, Escape closes and returns focus. */
export default function Menu({ trigger, items, label, align = "start" }: Props) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    list.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
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

  function onListKey(e: React.KeyboardEvent) {
    const entries = Array.from(list.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? []);
    const at = entries.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      entries[(at + 1) % entries.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      entries[(at - 1 + entries.length) % entries.length]?.focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      entries[0]?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      entries[entries.length - 1]?.focus();
    }
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
      {open && (
        <div
          ref={list}
          className={align === "end" ? "menu menu-end" : "menu"}
          role="menu"
          aria-label={label}
          onKeyDown={onListKey}
        >
          {items.map((item) => (
            <div key={item.key} role="none">
              {item.separatorBefore && <hr className="menu-separator" />}
              <button
                type="button"
                role="menuitem"
                aria-label={item.label}
                className={item.danger ? "menu-item menu-item-danger" : "menu-item"}
                onClick={() => {
                  close();
                  item.onSelect();
                }}
              >
                {item.content ?? item.label}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
