import type { Group, GroupId } from "../api/types";
import { hintFor } from "../commands/keymap";
import type { CommandId } from "../commands/registry";
import { useKeymap } from "../commands/useCommandKeys";
import type { Place } from "../shell/tabs";
import GroupBadge from "./GroupBadge";
import Icon from "./Icon";
import Menu, { type MenuItem } from "./Menu";

export type { Place } from "../shell/tabs";

/** The places in menu order (PR7): Groups by name, then Ungrouped. Ctrl+1 to Ctrl+9 open them in this order. */
export function menuPlaces(groups: Group[]): Place[] {
  const byName = [...groups].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return [...byName.map((g): Place => ({ kind: "group", groupId: g.id })), { kind: "ungrouped" }];
}

interface Props {
  groups: Group[];
  place: Place;
  /** How many Connections there are in all; with none the switcher says No Group. */
  connectionCount: number;
  onHome: () => void;
  onOpenGroup: (id: GroupId) => void;
  onOpenUngrouped: () => void;
  onNewGroup(): void;
  onSettings(): void;
}

/** The title bar's Group switcher: the current Group's square and name, and a menu of Home, the places, New Group and Settings. */
export default function GroupSwitcher({ groups, place, connectionCount, onHome, onOpenGroup, onOpenUngrouped, onNewGroup, onSettings }: Props) {
  const { map } = useKeymap();
  const current = place.kind === "group" ? groups.find((g) => g.id === place.groupId) : undefined;
  const currentName = current?.name ?? (connectionCount === 0 ? "No Group" : "Ungrouped");
  const numberKey = (n: number) => (n <= 9 ? (hintFor(map, `group.open.${n}` as CommandId) ?? undefined) : undefined);

  const placeItems: MenuItem[] = menuPlaces(groups).map((p, i) => {
    if (p.kind === "ungrouped") {
      return {
        key: "ungrouped",
        label: "Ungrouped",
        shortcut: numberKey(i + 1),
        current: place.kind === "ungrouped",
        icon: <GroupBadge name="" color={null} />,
        onSelect: onOpenUngrouped,
      };
    }
    const g = groups.find((x) => x.id === p.groupId)!;
    return {
      key: g.id,
      label: g.name,
      shortcut: numberKey(i + 1),
      current: place.kind === "group" && place.groupId === g.id,
      icon: <GroupBadge id={g.id} name={g.name} color={g.color} size={16} />,
      onSelect: () => onOpenGroup(g.id),
    };
  });

  const items: MenuItem[] = [
    {
      key: "home",
      label: "Home",
      shortcut: hintFor(map, "home.open") ?? undefined,
      icon: <Icon name="grid" />,
      onSelect: onHome,
    },
    { key: "groups-heading", label: "Groups", heading: "Groups", separatorBefore: true },
    ...placeItems,
    {
      key: "new-group",
      label: "New Group...",
      separatorBefore: true,
      icon: <Icon name="plus" />,
      onSelect: onNewGroup,
    },
    {
      key: "settings",
      label: "Settings",
      shortcut: hintFor(map, "settings.open") ?? undefined,
      icon: <Icon name="gear" />,
      onSelect: onSettings,
    },
  ];

  return (
    <Menu
      label="Groups"
      items={items}
      trigger={(props) => (
        <button type="button" className="group-switcher" aria-label={`Switch Group, current ${currentName}`} {...props}>
          <GroupBadge id={current?.id} name={current?.name ?? ""} color={current?.color ?? null} />
          <span className="group-switcher-name">{currentName}</span>
          <Icon name="chevronDown" size={14} className="group-switcher-chevron" />
        </button>
      )}
    />
  );
}
