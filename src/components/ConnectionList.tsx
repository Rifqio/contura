import { useState } from "react";
import {
  clearQueryHistory,
  closeConnection,
  connectionTarget,
  deleteConnection,
  errorText,
  moveConnection,
  openConnection,
  shortenPath,
} from "../api/client";
import type { ConnectionConfig, ConnectionId, Group, GroupId } from "../api/types";
import DialectTag from "./DialectTag";
import GroupBadge from "./GroupBadge";
import Icon from "./Icon";
import Menu, { type MenuItem } from "./Menu";

interface Props {
  /** The Group whose Connections to show; null shows the Ungrouped ones. */
  groupId: GroupId | null;
  groups: Group[];
  connections: ConnectionConfig[];
  openIds: ReadonlySet<ConnectionId>;
  activeId: ConnectionId | null;
  onActivate: (id: ConnectionId) => void;
  onOpened: (id: ConnectionId) => void;
  onClosed: (id: ConnectionId) => void;
  onEdit: (connection: ConnectionConfig) => void;
  /** A Connection moved or was deleted; reload the list. */
  onChanged: () => void;
  /** Opens a query tab on the Connection. */
  onNewQuery?: (id: ConnectionId) => void;
  onHistoryCleared?: (id: ConnectionId) => void;
}

export default function ConnectionList({
  groupId,
  groups,
  connections,
  openIds,
  activeId,
  onActivate,
  onOpened,
  onClosed,
  onEdit,
  onChanged,
  onNewQuery,
  onHistoryCleared,
}: Props) {
  const [busy, setBusy] = useState<ReadonlySet<ConnectionId>>(new Set());
  const [errors, setErrors] = useState<Record<ConnectionId, string>>({});
  const [confirmDelete, setConfirmDelete] = useState<ConnectionId | null>(null);
  const [confirmClear, setConfirmClear] = useState<ConnectionId | null>(null);

  const mine = connections.filter((c) => c.groupId === groupId);

  async function run(c: ConnectionConfig, action: () => Promise<void>) {
    const id = c.id;
    setBusy((ids) => new Set(ids).add(id));
    setErrors((all) => {
      const rest = { ...all };
      delete rest[id];
      return rest;
    });
    try {
      await action();
    } catch (e) {
      setErrors((all) => ({ ...all, [id]: errorText(e, c.dialect) }));
    } finally {
      setBusy((ids) => {
        const next = new Set(ids);
        next.delete(id);
        return next;
      });
    }
  }

  const open = (c: ConnectionConfig) =>
    run(c, async () => {
      await openConnection(c.id);
      onOpened(c.id);
    });

  const close = (c: ConnectionConfig) =>
    run(c, async () => {
      await closeConnection(c.id);
      onClosed(c.id);
    });

  const move = (c: ConnectionConfig, to: GroupId | null) =>
    run(c, async () => {
      await moveConnection(c.id, to);
      onChanged();
    });

  const remove = (c: ConnectionConfig) =>
    run(c, async () => {
      await deleteConnection(c.id);
      setConfirmDelete(null);
      onClosed(c.id);
      onChanged();
    });

  const clearHistory = (c: ConnectionConfig) =>
    run(c, async () => {
      await clearQueryHistory(c.id);
      setConfirmClear(null);
      onHistoryCleared?.(c.id);
    });

  function menuItems(c: ConnectionConfig): MenuItem[] {
    const items: MenuItem[] = [
      ...(onNewQuery ? [{ key: "new-query", label: "New query", onSelect: () => onNewQuery(c.id) }] : []),
      { key: "edit", label: "Edit", onSelect: () => onEdit(c) },
    ];
    const targets: { id: GroupId | null; label: string; group?: Group }[] = [
      ...(c.groupId !== null ? [{ id: null, label: "Ungrouped" }] : []),
      ...groups.filter((g) => g.id !== c.groupId).map((g) => ({ id: g.id, label: g.name, group: g })),
    ];
    targets.forEach((t, i) =>
      items.push({
        key: `move-${t.id ?? "ungrouped"}`,
        label: `Move to ${t.label}`,
        separatorBefore: i === 0,
        content: (
          <>
            {t.group && <GroupBadge name={t.group.name} color={t.group.color} small />}
            Move to {t.label}
          </>
        ),
        onSelect: () => move(c, t.id),
      }),
    );
    items.push({
      key: "clear-history",
      label: "Clear Query History",
      separatorBefore: true,
      onSelect: () => setConfirmClear(c.id),
    });
    items.push({
      key: "delete",
      label: "Delete",
      danger: true,
      separatorBefore: true,
      onSelect: () => setConfirmDelete(c.id),
    });
    return items;
  }

  if (mine.length === 0) return null;

  return (
    <ul className="connection-list" aria-label="Connections">
      {mine.map((c) => {
        const isOpen = openIds.has(c.id);
        return (
          <li key={c.id} className="connection-item">
            <div className={c.id === activeId ? "connection-row connection-row-active" : "connection-row"}>
              <button
                type="button"
                className="connection-name"
                aria-current={c.id === activeId ? "true" : undefined}
                onClick={() => (isOpen ? onActivate(c.id) : open(c))}
                disabled={busy.has(c.id)}
              >
                <Icon name="database" />
                <span className="connection-text">
                  <span className="connection-title">{c.name}</span>
                  <span className="connection-meta">
                    <DialectTag dialect={c.dialect} />
                    <span className="connection-sub" title={connectionTarget(c)}>
                      {busy.has(c.id) ? "Working…" : isOpen ? "Open" : shortenPath(connectionTarget(c))}
                    </span>
                  </span>
                </span>
              </button>
              <button
                type="button"
                className="button button-small"
                disabled={busy.has(c.id)}
                onClick={() => (isOpen ? close(c) : open(c))}
                aria-label={isOpen ? `Close ${c.name}` : `Open ${c.name}`}
              >
                {isOpen ? "Close" : "Open"}
              </button>
              <Menu
                label={`Actions for ${c.name}`}
                align="end"
                items={menuItems(c)}
                trigger={(props) => (
                  <button type="button" className="icon-button" aria-label={`More actions for ${c.name}`} {...props}>
                    <Icon name="more" />
                  </button>
                )}
              />
            </div>
            {errors[c.id] && (
              <p className="error-text item-message" role="alert">
                {errors[c.id]}
              </p>
            )}
            {confirmClear === c.id && (
              <div className="confirm item-message" role="alert">
                <p>Clear the Query History of {c.name}? Saved Queries are kept.</p>
                <div className="confirm-actions">
                  <button type="button" className="button button-small" autoFocus onClick={() => setConfirmClear(null)}>
                    Keep it
                  </button>
                  <button
                    type="button"
                    className="button button-small button-danger-fill"
                    disabled={busy.has(c.id)}
                    onClick={() => clearHistory(c)}
                  >
                    Clear
                  </button>
                </div>
              </div>
            )}
            {confirmDelete === c.id && (              <div className="confirm item-message" role="alert">
                <p>Delete {c.name}? Its saved password is removed too. This cannot be undone.</p>
                <div className="confirm-actions">
                  <button
                    type="button"
                    className="button button-small"
                    autoFocus
                    onClick={() => setConfirmDelete(null)}
                  >
                    Keep it
                  </button>
                  <button
                    type="button"
                    className="button button-small button-danger-fill"
                    disabled={busy.has(c.id)}
                    onClick={() => remove(c)}
                  >
                    Delete {c.name}
                  </button>
                </div>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
