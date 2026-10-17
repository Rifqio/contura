import { useState } from "react";
import { errorText, openConnection } from "../api/client";
import type { ConnectionConfig, ConnectionId } from "../api/types";
import type { ConnectionOpenStatus } from "../sidebar/OneTree";

export interface ConnectionLifecycle {
  openIds: ReadonlySet<ConnectionId>;
  /** Server versions reported when each Connection opened (R3), for the status bar. */
  versions: ReadonlyMap<ConnectionId, string>;
  /** Opens in flight and failed: the tree row says "Connecting..." or "Failed" (frames 10b, 10c). */
  openStatus: ReadonlyMap<ConnectionId, ConnectionOpenStatus>;
  setStatus(id: ConnectionId, status: ConnectionOpenStatus | null): void;
  openTracked(id: ConnectionId): Promise<void>;
  markOpened(id: ConnectionId, version: unknown): void;
  markClosed(id: ConnectionId): void;
  lost(id: ConnectionId): void;
}

export function useConnectionLifecycle(opts: {
  connections: ConnectionConfig[];
  /** After a Connection's state is dropped: App drops its schema cache entry and its table tabs. */
  onClosed(id: ConnectionId): void;
  /** After `lost` closed it: App shows the notice. */
  onLost(id: ConnectionId): void;
}): ConnectionLifecycle {
  const [openIds, setOpenIds] = useState<ReadonlySet<ConnectionId>>(new Set());
  const [versions, setVersions] = useState<ReadonlyMap<ConnectionId, string>>(new Map());
  const [openStatus, setOpenStatus] = useState<ReadonlyMap<ConnectionId, ConnectionOpenStatus>>(new Map());

  function setStatus(id: ConnectionId, status: ConnectionOpenStatus | null) {
    setOpenStatus((m) => {
      if (!status && !m.has(id)) return m;
      const next = new Map(m);
      if (status) next.set(id, status);
      else next.delete(id);
      return next;
    });
  }

  /**
   * Opens a Connection, its tree row saying "Connecting..." meanwhile and "Failed" after a failure
   * (the reason in the row's tooltip and, for a query tab, in its result area). Throws the failure.
   */
  async function openTracked(id: ConnectionId) {
    setStatus(id, { s: "connecting" });
    try {
      markOpened(id, await openConnection(id));
    } catch (e) {
      setStatus(id, { s: "failed", error: errorText(e, opts.connections.find((c) => c.id === id)?.dialect) });
      throw e;
    }
  }

  /** Marks the Connection open and keeps the server version it reported. */
  function markOpened(id: ConnectionId, version: unknown) {
    setStatus(id, null);
    setOpenIds((ids) => new Set(ids).add(id));
    if (typeof version === "string" && version) setVersions((v) => new Map(v).set(id, version));
  }

  function markClosed(id: ConnectionId) {
    setStatus(id, null);
    setVersions((v) => {
      if (!v.has(id)) return v;
      const next = new Map(v);
      next.delete(id);
      return next;
    });
    setOpenIds((ids) => {
      const next = new Set(ids);
      next.delete(id);
      return next;
    });
    opts.onClosed(id);
  }

  function lost(id: ConnectionId) {
    markClosed(id);
    opts.onLost(id);
  }

  return { openIds, versions, openStatus, setStatus, openTracked, markOpened, markClosed, lost };
}
