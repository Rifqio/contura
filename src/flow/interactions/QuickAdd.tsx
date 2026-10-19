// "Add and connect" (motion design answer 1A): a flow released on empty canvas opens this menu where it ended.
// Each item adds a node there, already connected; its key picks it (P, S, E on a data flow). Esc or a click
// away cancels, and the line pulls back into its port. Portalled to the window, so the clipped canvas never
// cuts it off.
import { type KeyboardEvent, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import Icon from "../../components/Icon";
import type { DiagramKind } from "../../lang/flow/model";
import { ADD_TOOLS, type AddTool } from "../FlowToolbar";

/** The kind's add tools as menu items: "Add data store" reads "Data store" here. */
export function quickItems(kind: DiagramKind): { label: string; tool: AddTool }[] {
  return ADD_TOOLS[kind]
    .filter((t) => t.kind !== "group")
    .map((t) => {
      const word = t.label.replace(/^Add (a )?/, "");
      return { label: word.charAt(0).toUpperCase() + word.slice(1), tool: t };
    });
}

interface Props {
  kind: DiagramKind;
  /** Where the line ended, in window coordinates. */
  at: { x: number; y: number };
  onPick(tool: AddTool): void;
  onCancel(): void;
}

export default function QuickAdd({ kind, at, onPick, onCancel }: Props) {
  const menu = useRef<HTMLDivElement>(null);
  const items = quickItems(kind);
  const latest = useRef(onCancel);
  latest.current = onCancel;

  useEffect(() => {
    menu.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    const away = (e: MouseEvent) => {
      if (!menu.current?.contains(e.target as Node)) latest.current();
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, []);

  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const pick = items.find((i) => i.tool.key === e.key.toUpperCase());
    if (pick) {
      e.preventDefault();
      onPick(pick.tool);
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const all = [...(menu.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
      const i = all.indexOf(document.activeElement as HTMLElement);
      all[(i + (e.key === "ArrowDown" ? 1 : -1) + all.length) % all.length]?.focus();
    } else if (e.key === "Tab") {
      e.preventDefault();
      onCancel();
    }
  };

  return createPortal(
    <div className="tree-menu flow-quick" style={{ left: Math.max(0, Math.min(at.x + 6, window.innerWidth - 240)), top: Math.max(0, Math.min(at.y + 6, window.innerHeight - 160)) }}>
      <div ref={menu} className="menu" role="menu" aria-label="Add and connect" onKeyDown={onKey}>
        <div className="menu-heading" role="presentation">
          Add and connect
        </div>
        {items.map(({ label, tool }) => (
          <button key={tool.key} type="button" role="menuitem" className="menu-item" aria-keyshortcuts={tool.key} onClick={() => onPick(tool)}>
            <span className="menu-icon">
              <Icon name={tool.icon} size={14} />
            </span>
            <span className="menu-label">{label}</span>
            <span className="menu-shortcut">{tool.key}</span>
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}
