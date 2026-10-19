// The new tab menu (item 34, frame NewTab): each kind of new tab with its large feature icon on a tile, its name
// and one line on what it is, in two sections, Write and Draw. Arrow keys move, Enter picks, Escape or a press
// outside closes.
import { type KeyboardEvent, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import FeatureIcon, { type FeatureIconName } from "./FeatureIcon";
import { useDismiss } from "./useDismiss";

export interface NewTabItem {
  key: string;
  icon: FeatureIconName;
  label: string;
  description: string;
  shortcut?: string | null;
  disabledWhy?: string | null;
  onSelect(): void;
}

export interface NewTabSection {
  title: string;
  items: NewTabItem[];
}

export default function NewTabMenu({
  sections,
  onClose,
  anchor,
}: {
  sections: NewTabSection[];
  onClose(): void;
  /** The button that opened it: the menu hangs under it, and pressing it again toggles. */
  anchor?: React.RefObject<HTMLElement | null>;
}) {
  const box = anchor?.current?.getBoundingClientRect();
  const width = 372;
  const place = box ? { left: Math.max(8, Math.min(box.left, window.innerWidth - width - 8)), top: box.bottom + 4 } : { left: 8, top: 44 };
  const root = useRef<HTMLDivElement>(null);
  useDismiss(true, anchor ? [root, anchor] : [root], onClose);
  // Arrow keys reach the rows that are off too, so their reason can be read; a click or Enter on one does nothing.
  const rows = () => Array.from(root.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ?? []);
  useEffect(() => {
    const all = rows();
    (all.find((r) => r.getAttribute("aria-disabled") !== "true") ?? all[0])?.focus();
  }, []);
  const onKey = (e: KeyboardEvent) => {
    const all = rows();
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    const go = (i: number) => {
      e.preventDefault();
      all[(i + all.length) % all.length]?.focus();
    };
    if (e.key === "ArrowDown") go(at + 1);
    else if (e.key === "ArrowUp") go(at < 0 ? -1 : at - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(all.length - 1);
    else if (e.key === "Tab") {
      e.preventDefault();
      onClose();
    }
  };
  // Portalled at the window level, so no clipping title bar cuts it off.
  return createPortal(
    <div ref={root} className="new-tab-menu" role="menu" aria-label="New tab" style={place} onKeyDown={onKey}>
      {sections.map((s, i) => (
        <div key={s.title} role="group" aria-label={s.title} className="new-tab-section">
          {i > 0 && <hr className="menu-separator" />}
          <div className="new-tab-title" aria-hidden="true">
            {s.title}
          </div>
          {s.items.map((it) => (
            <button
              key={it.key}
              type="button"
              role="menuitem"
              className="new-tab-item"
              aria-label={it.label}
              aria-description={it.disabledWhy ?? it.description}
              aria-disabled={it.disabledWhy ? true : undefined}
              aria-keyshortcuts={it.shortcut ?? undefined}
              title={it.disabledWhy ?? undefined}
              onClick={() => {
                if (it.disabledWhy) return;
                onClose();
                it.onSelect();
              }}
            >
              <span className="new-tab-tile">
                <FeatureIcon name={it.icon} size={28} />
              </span>
              <span className="new-tab-text">
                <span className="new-tab-label">{it.label}</span>
                <span className="new-tab-desc">{it.disabledWhy ?? it.description}</span>
              </span>
              {it.shortcut && <span className="kbd new-tab-key">{it.shortcut}</span>}
            </button>
          ))}
        </div>
      ))}
    </div>,
    document.body,
  );
}
