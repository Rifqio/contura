import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import type { Group } from "../api/types";
import GroupBadge from "../components/GroupBadge";
import Icon from "../components/Icon";
import InlineName from "../components/InlineName";
import { UNGROUPED_NAME_LIMIT, keepTextUnselected, usePlaceRename } from "../components/renamePlace";

interface Props {
  group: Group | undefined;
  /** Every Group, so a new name for Ungrouped can be checked against them. */
  groups: Group[];
  placeName: string;
  /** A window tab is on top: the sidebar stays mounted but hidden, so its tree keeps where you were. */
  hidden: boolean;
  empty: boolean;
  notice: string | null;
  onEditGroup(): void;
  /** The Group was renamed in place: the lists reload. */
  onRenamed(): void;
  onNewConnection(): void;
  /** The tree. */
  children: ReactNode;
}

export default function PlaceSidebar({ group, groups, placeName, hidden, empty, notice, onEditGroup, onRenamed, onNewConnection, children }: Props) {
  const placeId = group?.id ?? null;
  /** The place being renamed, bound when the edit opens; null while not editing. */
  const [editing, setEditing] = useState<{ group: Group | null; name: string } | null>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const commit = usePlaceRename(editing?.group ?? null, groups, onRenamed);
  // The sidebar outlives a place switch (Ctrl+2, the switcher): an edit open then is cancelled, never saved to the new place.
  const current = editing && (editing.group?.id ?? null) === placeId ? editing : null;
  useEffect(() => setEditing(null), [placeId]);

  function open() {
    setEditing({ group: group ?? null, name: placeName });
  }

  function close(refocus: boolean) {
    setEditing(null);
    // After Enter or Esc the heading takes focus back, so F2 and Tab carry on from it.
    if (refocus) requestAnimationFrame(() => title.current?.focus());
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "F2") {
      e.preventDefault();
      open();
    }
  }

  return (
    <aside className="side" aria-label={`${placeName} Connections`} hidden={hidden}>
      <div className="side-header">
        {/* Layout A and D19: the Group square (its image when set) before the name. */}
        <GroupBadge id={group?.id} name={group?.name ?? ""} color={group?.color ?? null} />
        {current ? (
          <InlineName
            value={current.name}
            label={`Rename ${current.name}`}
            maxLength={current.group ? undefined : UNGROUPED_NAME_LIMIT}
            onCommit={commit}
            onClose={close}
          />
        ) : (
          <h2
            ref={title}
            className="side-title rename-label"
            tabIndex={0}
            title="Double-click or press F2 to rename"
            aria-keyshortcuts="F2"
            onMouseDown={keepTextUnselected}
            onDoubleClick={open}
            onKeyDown={onKeyDown}
          >
            {placeName}
          </h2>
        )}
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
