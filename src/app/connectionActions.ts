import { clearQueryHistory, closeConnection, deleteConnection, errorText, moveConnection } from "../api/client";
import type { ConnectionId, GroupId } from "../api/types";

export interface ConnectionActionsEnv {
  openIds: ReadonlySet<ConnectionId>;
  confirmLeave(keys: string[]): Promise<boolean>;
  tableKeys(only?: ConnectionId): string[];
  openTracked(id: ConnectionId): Promise<void>;
  markClosed(id: ConnectionId): void;
  reload(): Promise<void>;
  setActiveId(id: ConnectionId): void;
  newQuery(id: ConnectionId): void;
  setNotice(text: string | null): void;
  /** Query History was cleared: App bumps historyRefresh. */
  historyCleared(): void;
}

export function connectionActions(env: ConnectionActionsEnv) {
  async function newQueryOn(id: ConnectionId) {
    env.setActiveId(id);
    env.newQuery(id);
    if (env.openIds.has(id)) return;
    await env.openTracked(id).catch(() => {});
  }

  /** Opens a Connection from the tree; its row says Failed, with the reason, when it does not open. */
  async function openFromTree(id: ConnectionId) {
    env.setActiveId(id);
    env.setNotice(null);
    await env.openTracked(id).catch(() => {});
  }

  // Closing, deleting or moving a Connection closes its table tabs: their edits are asked about first (D4).
  async function closeFromTree(id: ConnectionId) {
    if (!(await env.confirmLeave(env.tableKeys(id)))) return;
    try {
      await closeConnection(id);
      env.markClosed(id);
    } catch (e) {
      env.setNotice(errorText(e));
    }
  }

  async function moveFromTree(id: ConnectionId, to: GroupId | null) {
    if (!(await env.confirmLeave(env.tableKeys(id)))) return;
    try {
      await moveConnection(id, to);
      await env.reload();
    } catch (e) {
      env.setNotice(errorText(e));
    }
  }

  async function deleteFromTree(id: ConnectionId) {
    if (!(await env.confirmLeave(env.tableKeys(id)))) return;
    try {
      await deleteConnection(id);
      env.markClosed(id);
      await env.reload();
    } catch (e) {
      env.setNotice(errorText(e));
    }
  }

  async function clearHistoryFromTree(id: ConnectionId) {
    try {
      await clearQueryHistory(id);
      env.historyCleared();
    } catch (e) {
      env.setNotice(errorText(e));
    }
  }

  return { newQueryOn, openFromTree, closeFromTree, moveFromTree, deleteFromTree, clearHistoryFromTree };
}
