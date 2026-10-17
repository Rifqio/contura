import type { ReactNode } from "react";
import type { Group } from "../api/types";
import GroupBadge from "../components/GroupBadge";
import Icon from "../components/Icon";

interface Props {
  group: Group | undefined;
  placeName: string;
  /** A window tab is on top: the sidebar stays mounted but hidden, so its tree keeps where you were. */
  hidden: boolean;
  empty: boolean;
  notice: string | null;
  onEditGroup(): void;
  onNewConnection(): void;
  /** The tree. */
  children: ReactNode;
}

export default function PlaceSidebar({ group, placeName, hidden, empty, notice, onEditGroup, onNewConnection, children }: Props) {
  return (
    <aside className="side" aria-label={`${placeName} Connections`} hidden={hidden}>
      <div className="side-header">
        {/* Layout A and D19: the Group square (its image when set) before the name. */}
        <GroupBadge id={group?.id} name={group?.name ?? ""} color={group?.color ?? null} />
        <h2 className="side-title">{placeName}</h2>
        {group && (
          <button
            type="button"
            className="icon-button"
            aria-label={`Edit ${group.name}`}
            title="Edit Group"
            onClick={() => onEditGroup()}
          >
            <Icon name="edit" />
          </button>
        )}
        <button
          type="button"
          className="icon-button"
          aria-label="New Connection"
          title="New Connection"
          onClick={() => onNewConnection()}
        >
          <Icon name="plus" />
        </button>
      </div>
      {empty && (
        <div className="side-empty">
          <p className="muted">No Connections in {placeName} yet.</p>
          <button
            type="button"
            className="button button-small"
            onClick={() => onNewConnection()}
          >
            New Connection
          </button>
        </div>
      )}
      {/* Home shows the notice itself while it is the tab on top. */}
      {notice && !hidden && (
        <p className="error-text side-notice" role="alert">
          {notice}
        </p>
      )}
      {children}
    </aside>
  );
}
