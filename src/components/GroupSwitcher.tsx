import type { Group, GroupId } from "../api/types";
import GroupBadge from "./GroupBadge";
import Icon from "./Icon";
import Menu, { type MenuItem } from "./Menu";

/** Where the window is: Home, a Group, or the Ungrouped Connections. */
export type Place = { kind: "home" } | { kind: "group"; groupId: GroupId } | { kind: "ungrouped" };

interface Props {
  groups: Group[];
  place: Place;
  onHome: () => void;
  onOpenGroup: (id: GroupId) => void;
  onOpenUngrouped: () => void;
}

/** The title bar's Group switcher: the current Group's square and name, and a menu of every Group plus Home. */
export default function GroupSwitcher({ groups, place, onHome, onOpenGroup, onOpenUngrouped }: Props) {
  const current = place.kind === "group" ? groups.find((g) => g.id === place.groupId) : undefined;
  const currentName = current?.name ?? (place.kind === "ungrouped" ? "Ungrouped" : "Home");

  const items: MenuItem[] = [
    {
      key: "home",
      label: "Home",
      content: (
        <>
          <Icon name="home" />
          Home
        </>
      ),
      onSelect: onHome,
    },
    ...groups.map((g, i) => ({
      key: g.id,
      label: g.name,
      separatorBefore: i === 0,
      content: (
        <>
          <GroupBadge name={g.name} color={g.color} small />
          {g.name}
        </>
      ),
      onSelect: () => onOpenGroup(g.id),
    })),
    { key: "ungrouped", label: "Ungrouped", separatorBefore: true, onSelect: onOpenUngrouped },
  ];

  return (
    <Menu
      label="Groups"
      items={items}
      trigger={(props) => (
        <button type="button" className="group-switcher" aria-label={`Switch Group, current ${currentName}`} {...props}>
          {current ? (
            <GroupBadge name={current.name} color={current.color} />
          ) : (
            <Icon name={place.kind === "ungrouped" ? "database" : "home"} />
          )}
          <span>{currentName}</span>
          <Icon name="chevronDown" className="muted" />
        </button>
      )}
    />
  );
}
