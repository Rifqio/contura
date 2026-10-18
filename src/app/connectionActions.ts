import { clearQueryHistory, closeConnection, deleteConnection, errorText, moveConnection } from "../api/client";
import type { ConnectionId, GroupId } from "../api/types";

export interface ConnectionActionsEnv {
  openIds: ReadonlySet<ConnectionId>;
  /** With `then`, a Discard waits for that next ask and applies only on its yes. */
  confirmLeave(keys: string[], opts?: { then?(): Promise<boolean> }): Promise<boolean>;
  tableKeys(only?: ConnectionId): string[];
  openTracked(id: ConnectionId): Promise<void>;
  markClosed(id: ConnectionId): void;
  reload(): Promise<void>;
  setActiveId(id: ConnectionId): void;
  newQuery(id: ConnectionId): void;
  setNotice(text: string | null): void;
  /** Query History was cleared: App bumps historyRefresh. */
  historyCleared(): void;
  /** Jobs running on the Connection: asks to cancel them (useJobsGuard); false keeps it. */
  confirmJobs?(id: ConnectionId): Promise<boolean>;
  /** A move takes its running Import tabs out of the place: asks about each (Q43); false keeps it. */
  confirmImports?(id: ConnectionId): Promise<boolean>;
}

export function connectionActions(env: ConnectionActionsEnv) {
  /** Opens a new tab on the Connection (a query, a Visual Query), then opens the Connection when it is closed. */
  async function newTabOn(id: ConnectionId, make: (id: ConnectionId) => void) {
    env.setActiveId(id);
    make(id);
    if (env.openIds.has(id)) return;
    await env.openTracked(id).catch(() => {});
  }

  const newQueryOn = (id: ConnectionId) => newTabOn(id, env.newQuery);

  /** Opens a Connection from the tree; its row says Failed, with the reason, when it does not open. */
  async function openFromTree(id: ConnectionId) {
    env.setActiveId(id);
    env.setNotice(null);
    await env.openTracked(id).catch(() => {});
  }

  // Closing, deleting or moving a Connection closes its table tabs: their edits are asked about first (D4).
  async function closeFromTree(id: ConnectionId) {
    if (!(await env.confirmLeave(env.tableKeys(id)))) return;
    if (env.confirmJobs && !(await env.confirmJobs(id))) return;
    try {
      await closeConnection(id);
      env.markClosed(id);
    } catch (e) {
      env.setNotice(errorText(e));
    }
  }

  async function moveFromTree(id: ConnectionId, to: GroupId | null) {
    // The running imports ask comes before any Discard is applied, so its No keeps the edits.
    const imports = env.confirmImports;
    const keys = env.tableKeys(id);
    if (!(await (imports ? env.confirmLeave(keys, { then: () => imports(id) }) : env.confirmLeave(keys)))) return;
    try {
      await moveConnection(id, to);
      await env.reload();
    } catch (e) {
      env.setNotice(errorText(e));
    }
  }

  async function deleteFromTree(id: ConnectionId) {
    if (!(await env.confirmLeave(env.tableKeys(id)))) return;
    if (env.confirmJobs && !(await env.confirmJobs(id))) return;
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

  return { newQueryOn, newTabOn, openFromTree, closeFromTree, moveFromTree, deleteFromTree, clearHistoryFromTree };
}
