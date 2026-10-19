import { useEffect, useRef, useState } from "react";
import type { ConnectionConfig, Group } from "../api/types";
import { hintFor, withHint } from "../commands/keymap";
import { useCommandKeys, useKeymap } from "../commands/useCommandKeys";
import { type DiagramMenuActions, diagramMenuItems, PlacedMenu, type PlacedMenuState } from "../flow/DiagramMenu";
import { useUnsavedFlows } from "../flow/flowRegistry";
import { type AnyTab, isUnsaved, tabConnectionId, tabKey } from "../shell/tabs";
import DbMark from "./DbMark";
import { groupStyle } from "./GroupBadge";
import Icon, { type IconName } from "./Icon";
import Menu from "./Menu";
import SafetyTag from "./SafetyTag";

export type { Selection, WorkTab } from "../shell/tabs";

const basename = (p: string) => p.split(/[\\/]/).pop() ?? p;

export function tabName(t: AnyTab): string {
  switch (t.kind) {
    case "home":
      return "Home";
    case "settings":
      return "Settings";
    case "schema":
      return t.doc.path ? basename(t.doc.path) : "untitled.dbml";
    case "flow":
      return `${t.name}.flow`;
    case "transfer":
    case "compare":
      return t.title;
    case "query":
    case "visual":
      return t.doc.name;
    case "savedQueries":
      return "Saved Queries";
    case "object":
      return t.selection.path.name;
    case "design":
      // D23: "New table" until it is created.
      return t.target.kind === "alter" ? `${t.target.path.name} design` : "New table";
    case "import":
      return `Import into ${t.target.kind === "table" ? t.target.path.name : t.target.database}`;
    case "lineage":
      return `${t.path.name} lineage`;
  }
}

/** The kind icon before the title; query tabs show only their database mark (C5). */
function iconOf(t: AnyTab): IconName | null {
  switch (t.kind) {
    case "home":
      return "grid";
    case "settings":
      return "gear";
    case "schema":
      return "layers";
    case "flow":
      return "flow";
    case "transfer":
      return "swap";
    case "compare":
      return "columns";
    case "query":
      return null;
    case "visual":
      return "visualQuery";
    case "savedQueries":
      return "bookmark";
    case "object":
      return t.selection.kind === "table" ? "table" : t.selection.kind === "view" ? "view" : t.selection.kind === "trigger" ? "trigger" : "routine";
    case "design":
      return "edit";
    case "import":
      return "import";
    case "lineage":
      return "flow";
  }
}

interface Props {
  /** Every tab, in strip order. */
  tabs: AnyTab[];
  /** The active tab's key; null when none is. */
  active: string | null;
  onSelect(key: string): void;
  onClose(key: string): void;
  onNew(): void;
  /** The chevron menu's New Visual Query (D10). */
  onNewVisual?(): void;
  /** False while no Connection is open: New Visual Query is off and says why. */
  newVisualReady?: boolean;
  /** The chevron menu's New diagram (frame 6+.6). */
  onNewDiagram?(): void;
  /** A diagram tab's right-click menu: Rename, Save a copy as, Delete. */
  diagramActions?: DiagramMenuActions;
  /** Lets a query tab show the Production or Read-only mark of its Connection. */
  connections?: ConnectionConfig[];
  /** Table and design tabs (by key) with Pending Edits or an unapplied design. */
  dirtyKeys?: ReadonlySet<string>;
  /** Lets a tab draw in its Connection's Group hue. */
  groups?: Group[];
}

/** The open tabs of the window and its place, in the title bar. Ctrl+W closes, Ctrl+Tab and Ctrl+Shift+Tab move. */
export default function TabStrip({
  tabs,
  active,
  onSelect,
  onClose,
  onNew,
  onNewVisual,
  newVisualReady = true,
  onNewDiagram,
  diagramActions,
  connections = [],
  dirtyKeys,
  groups = [],
}: Props) {
  const { map } = useKeymap();
  /** Diagram tabs whose save is still to come or failed. */
  const unsavedFlows = useUnsavedFlows();
  const [menu, setMenu] = useState<PlacedMenuState | null>(null);
  const keys = tabs.map(tabKey);
  const list = useRef<HTMLDivElement>(null);
  // NF1: the strip scrolls without a bar; the active tab is brought into view when it is picked or opened.
  useEffect(() => {
    if (active === null) return;
    const el = Array.from(list.current?.querySelectorAll<HTMLElement>(".work-tab") ?? []).find((t) => t.dataset.key === active);
    el?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [active, tabs.length]);
  const step = (by: number) => {
    if (keys.length === 0) return;
    const at = active === null ? -1 : keys.indexOf(active);
    const next = at < 0 ? (by > 0 ? 0 : keys.length - 1) : (at + by + keys.length) % keys.length;
    onSelect(keys[next]);
  };
  useCommandKeys({
    "tab.close": () => {
      if (active !== null && keys.includes(active)) onClose(active);
    },
    "tab.next": () => step(1),
    "tab.previous": () => step(-1),
  });
  return (
    // Bare drag regions: Tauri drags only on direct clicks, so the tabs and buttons inside stay clickable.
    <div className="tab-strip" data-tauri-drag-region>
      <div
        role="tablist"
        aria-label="Open tabs"
        className="tab-list"
        data-tauri-drag-region
        ref={list}
        // With no scrollbar, the wheel scrolls the strip sideways.
        onWheel={(e) => {
          const el = e.currentTarget;
          if (e.deltaX === 0 && e.deltaY !== 0 && el.scrollWidth > el.clientWidth) el.scrollLeft += e.deltaY;
        }}
      >
        {tabs.map((t) => {
          const key = tabKey(t);
          const on = key === active;
          const name = tabName(t);
          const isSaved = (t.kind === "query" || t.kind === "visual") && t.doc.savedId !== null;
          const dirty =
            isUnsaved(t) || ((t.kind === "object" || t.kind === "design") && !!dirtyKeys?.has(t.key)) || (t.kind === "flow" && unsavedFlows.has(t.name));
          const cid = tabConnectionId(t);
          const owner = cid === null ? undefined : connections.find((c) => c.id === cid);
          // R8: the chip shows PROD; the spoken name keeps the word.
          const label = [
            name,
            dirty ? "unsaved changes" : null,
            owner?.production ? "Production" : null,
            owner?.readOnly ? "Read-only" : null,
          ]
            .filter(Boolean)
            .join(", ");
          const group = owner?.groupId ? groups.find((g) => g.id === owner.groupId) : undefined;
          const icon = iconOf(t);
          // A Saved Query's tab shows no kind word; its tooltip says what it is and where it opens.
          const tip = isSaved && owner ? `${name}, Saved Query on ${owner.name}` : name;
          return (
            <div
              key={key}
              data-key={key}
              className={on ? "work-tab work-tab-on" : "work-tab"}
              style={groupStyle(group?.color)}
              // A middle click closes the tab under the pointer; holding it down must not start autoscroll.
              onMouseDown={(e) => {
                if (e.button === 1) e.preventDefault();
              }}
              onAuxClick={(e) => {
                if (e.button !== 1) return;
                e.preventDefault();
                onClose(key);
              }}
              onContextMenu={
                t.kind === "flow" && diagramActions
                  ? (e) => {
                      e.preventDefault();
                      setMenu({ x: e.clientX, y: e.clientY, label: `${t.name}.flow`, items: diagramMenuItems(t.name, diagramActions) });
                    }
                  : undefined
              }
            >
              <button
                type="button"
                role="tab"
                aria-selected={on}
                aria-label={label}
                className="work-tab-button"
                title={tip}
                onClick={() => onSelect(key)}
              >
                {icon && <Icon name={icon} size={14} />}
                {(t.kind === "query" || t.kind === "visual") && owner && <DbMark dialect={owner.dialect} open size={14} label={null} />}
                {owner && <SafetyTag connection={owner} small />}
                <span className="work-tab-name">{name}</span>
                {dirty && (
                  <span className="work-tab-unsaved" role="img" aria-label="Unsaved changes">
                    *
                  </span>
                )}
              </button>
              <button
                type="button"
                className="icon-button work-tab-close"
                aria-label={`Close ${name}`}
                title={withHint(`Close ${name}`, on ? hintFor(map, "tab.close") : null)}
                onClick={() => onClose(key)}
              >
                <Icon name="close" size={14} />
              </button>
            </div>
          );
        })}
      </div>
      <button type="button" className="icon-button" aria-label="New query" title={withHint("New query", hintFor(map, "query.new"))} onClick={onNew}>
        <Icon name="plus" />
      </button>
      {onNewVisual && (
        // D10: the other kinds of new tab, beside New query.
        <Menu
          label="More new tabs"
          align="end"
          trigger={(p) => (
            <button type="button" {...p} className="icon-button tab-strip-more" aria-label="More new tabs" title="More new tabs">
              <Icon name="chevronDown" size={14} />
            </button>
          )}
          items={[
            { key: "query", label: "New query", icon: <Icon name="fileQuery" />, shortcut: hintFor(map, "query.new") ?? undefined, onSelect: onNew },
            {
              key: "visual",
              label: "New Visual Query",
              icon: <Icon name="visualQuery" />,
              disabled: !newVisualReady,
              title: newVisualReady ? undefined : "Open a Connection first",
              onSelect: onNewVisual,
            },
            ...(onNewDiagram
              ? [{ key: "diagram", label: "New diagram", icon: <Icon name="flow" />, shortcut: hintFor(map, "flow.new") ?? undefined, onSelect: onNewDiagram }]
              : []),
          ]}
        />
      )}
      {menu && <PlacedMenu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  );
}
