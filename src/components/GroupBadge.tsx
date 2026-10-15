import type { GroupColor } from "../api/types";

/** The Group's initial square: the one place its colour appears. */
export default function GroupBadge({ name, color, small }: { name: string; color: GroupColor; small?: boolean }) {
  const initial = Array.from(name.trim())[0]?.toUpperCase() ?? "";
  return (
    <span
      className={small ? "group-badge group-badge-small" : "group-badge"}
      style={{ backgroundColor: `var(--color-group-${color})` }}
      aria-hidden="true"
    >
      {initial}
    </span>
  );
}
