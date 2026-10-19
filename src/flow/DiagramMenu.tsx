// The right-click menu of a diagram (a Recent row, a diagram tab): its file actions. Drawn in a portal at the
// pointer, so no scrolling or clipping container around the row cuts it off.
import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Icon from "../components/Icon";
import { type MenuItem, MenuList } from "../components/Menu";
import { useDismiss } from "../components/useDismiss";

/** What a diagram menu can do; the owner (App) runs it through useDiagramFileActions. */
export interface DiagramMenuActions {
  rename(name: string): void;
  saveCopy(name: string): void;
  remove(name: string): void;
}

/** Open (when given), Rename..., Save a copy as..., Delete... */
export function diagramMenuItems(name: string, actions: DiagramMenuActions, open?: () => void): MenuItem[] {
  return [
    ...(open ? [{ key: "open", label: "Open", icon: <Icon name="flow" />, onSelect: open }] : []),
    { key: "rename", label: "Rename...", icon: <Icon name="edit" />, onSelect: () => actions.rename(name) },
    { key: "copy", label: "Save a copy as...", icon: <Icon name="save" />, onSelect: () => actions.saveCopy(name) },
    { key: "delete", label: "Delete...", icon: <Icon name="trash" />, danger: true, separatorBefore: true, onSelect: () => actions.remove(name) },
  ];
}

export interface PlacedMenuState {
  x: number;
  y: number;
  label: string;
  items: MenuItem[];
}

/** A menu at a point, kept inside the window; a click outside, Escape or a pick closes it. Every right-click menu uses it. */
export function PlacedMenu({ menu, onClose }: { menu: PlacedMenuState; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState({ x: menu.x, y: menu.y });
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (!box || box.height === 0) return;
    const x = Math.max(4, Math.min(menu.x, window.innerWidth - box.width - 4));
    const y = Math.max(4, Math.min(menu.y, window.innerHeight - box.height - 4));
    if (x !== at.x || y !== at.y) setAt({ x, y });
    // Measured once per opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menu]);
  // A press anywhere else (a canvas too, which stops its own events) or Escape closes it.
  useDismiss(true, [ref], onClose);
  return createPortal(
    <div ref={ref} className="tree-menu" style={{ left: at.x, top: at.y }}>
      <MenuList items={menu.items} label={menu.label} onClose={onClose} />
    </div>,
    document.body,
  );
}
