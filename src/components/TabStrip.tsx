import { useEffect, useRef } from "react";
import type { ConnectionConfig, Group } from "../api/types";
import { hintFor, withHint } from "../commands/keymap";
import { useCommandKeys, useKeymap } from "../commands/useCommandKeys";
import { type AnyTab, type WorkTab, tabKey } from "../shell/tabs";
import DbMark from "./DbMark";
import { groupStyle } from "./GroupBadge";
import Icon, { type IconName } from "./Icon";
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
    case "query":
      return t.doc.name;
    case "savedQueries":
      return "Saved Queries";
    case "object":
      return t.selection.path.name;
  }
}

const isDirty = (t: WorkTab) => t.kind === "query" && t.doc.savedId !== null && t.doc.text !== t.doc.savedText;

/** The kind icon before the title; query tabs show only their database mark (C5). */
function iconOf(t: AnyTab): IconName | null {
  switch (t.kind) {
    case "home":
      return "grid";
    case "settings":
      return "gear";
    case "schema":
      return "layers";
    case "query":
      return null;
    case "savedQueries":
      return "bookmark";
    case "object":
      return t.selection.kind === "table" ? "table" : t.selection.kind === "view" ? "view" : t.selection.kind === "trigger" ? "trigger" : "routine";
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
  /** Lets a query tab show the Production or Read-only mark of its Connection. */
  connections?: ConnectionConfig[];
  /** Table tabs (by key) whose grid has Pending Edits. */
  dirtyKeys?: ReadonlySet<string>;
  /** Lets a tab draw in its Connection's Group hue. */
  groups?: Group[];
}

/** The open tabs of the window and its place, in the title bar. Ctrl+W closes, Ctrl+Tab and Ctrl+Shift+Tab move. */
export default function TabStrip({ tabs, active, onSelect, onClose, onNew, connections = [], dirtyKeys, groups = [] }: Props) {
  const { map } = useKeymap();
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
          const work = t.kind === "query" || t.kind === "object";
          const isSaved = t.kind === "query" && t.doc.savedId !== null;
          const dirty = work && (isDirty(t) || (t.kind === "object" && !!dirtyKeys?.has(t.key)));
          const cid = t.kind === "query" ? t.doc.connectionId : t.kind === "object" ? t.selection.connectionId : null;
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
                {t.kind === "query" && owner && <DbMark dialect={owner.dialect} open size={14} label={null} />}
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
    </div>
  );
}
