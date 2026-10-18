import { createElement } from "react";
import type { ConnectionConfig, Group, GroupId } from "../api/types";
import GroupBadge from "../components/GroupBadge";
import Icon, { type IconName } from "../components/Icon";
import type { MenuItem } from "../components/Menu";

export interface ConnectionMenuActions {
  /** Close when open, Open when closed. */
  toggleOpen(): void;
  newQuery(): void;
  /** Opens a Visual Query tab on the Connection, opening it first when closed. */
  newVisualQuery(): void;
  newSchemaModel(): void;
  edit(): void;
  duplicate(): void;
  copyHost(): void;
  refresh(): void;
  move(to: GroupId | null): void;
  newGroup(): void;
  clearHistory(): void;
  remove(): void;
}

export interface ConnectionMenuContext {
  open: boolean;
  groups: Group[];
  /** Key hints from the keymap, so a rebind changes them; absent when unbound. */
  newQueryKey?: string;
  refreshKey?: string;
}

const icon = (name: IconName) => createElement(Icon, { name });

/** The Connection row menu (frame 7), for right-click and the More button. */
export function connectionMenu(c: ConnectionConfig, ctx: ConnectionMenuContext, act: ConnectionMenuActions): MenuItem[] {
  const groups = [...ctx.groups].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  const moveTo: MenuItem[] = [
    ...groups.map(
      (g): MenuItem => ({
        key: `move-${g.id}`,
        label: g.name,
        icon: createElement(GroupBadge, { id: g.id, name: g.name, color: g.color }),
        disabled: g.id === c.groupId,
        hint: g.id === c.groupId ? "current" : undefined,
        onSelect: () => act.move(g.id),
      }),
    ),
    {
      key: "move-ungrouped",
      label: "Ungrouped",
      icon: createElement(GroupBadge, { name: "", color: null }),
      disabled: c.groupId === null,
      hint: c.groupId === null ? "current" : undefined,
      onSelect: () => act.move(null),
    },
    { key: "new-group", label: "New Group...", icon: icon("folderPlus"), separatorBefore: true, onSelect: act.newGroup },
  ];
  return [
    ctx.open
      ? { key: "close", label: "Close Connection", icon: icon("unplug"), onSelect: act.toggleOpen }
      : { key: "open", label: "Open Connection", icon: icon("plug"), onSelect: act.toggleOpen },
    { key: "new-query", label: "New query", icon: icon("fileQuery"), shortcut: ctx.newQueryKey, onSelect: act.newQuery },
    { key: "new-visual", label: "New Visual Query", icon: icon("visualQuery"), onSelect: act.newVisualQuery },
    { key: "new-model", label: "New Schema Model...", icon: icon("layers"), onSelect: act.newSchemaModel },
    { key: "edit", label: "Edit Connection...", icon: icon("edit"), separatorBefore: true, onSelect: act.edit },
    { key: "duplicate", label: "Duplicate", icon: icon("duplicate"), onSelect: act.duplicate },
    { key: "copy-host", label: c.dialect === "sqlite" ? "Copy file path" : "Copy host", icon: icon("copy"), onSelect: act.copyHost },
    {
      key: "refresh",
      label: "Refresh schema",
      icon: icon("refresh"),
      shortcut: ctx.refreshKey,
      disabled: !ctx.open,
      onSelect: act.refresh,
    },
    { key: "move", label: "Move to Group", icon: icon("folder"), submenu: moveTo },
    {
      key: "clear-history",
      label: "Clear Query History...",
      icon: icon("history"),
      separatorBefore: true,
      onSelect: act.clearHistory,
    },
    {
      key: "delete",
      label: "Delete Connection...",
      icon: icon("trash"),
      shortcut: "Del",
      danger: true,
      separatorBefore: true,
      onSelect: act.remove,
    },
  ];
}
